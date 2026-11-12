import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../index.js";
import { englishTargets, getTranslationPreferences } from "../roles.js";

const FAMILY_GROUP = -1003208961624;

function setup(t) {
  // Execute the production SQL against SQLite instead of mocking query results.
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync(new URL("../migrations/0001_user_roles.sql", import.meta.url), "utf8"));
  sql.exec(readFileSync(new URL("../migrations/0002_group_people.sql", import.meta.url), "utf8"));
  const wrap = (query, args = []) => ({
    bind: (...values) => wrap(query, values),
    first: async () => sql.prepare(query).get(...args) || null,
    all: async () => ({ results: sql.prepare(query).all(...args) }),
    run: async () => sql.prepare(query).run(...args),
  });
  const env = {
    ALLOWED_USER_ID: "1",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
    OPENAI_API_KEY: "test-api-key",
    ROLE_DB: {
      prepare: wrap,
      async batch(statements) {
        sql.exec("BEGIN");
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          sql.exec("COMMIT");
          return results;
        } catch (error) { sql.exec("ROLLBACK"); throw error; }
      },
    },
  };
  const calls = [];
  let modelText = "translated";
  let modelResponses = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body, headers: options.headers });
    if (url === "https://api.openai.com/v1/responses") {
      return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: modelResponses.shift() ?? modelText }] }] });
    }
    assert.match(url, /^https:\/\/api.telegram.org\/bottest-token\/(sendMessage|leaveChat)$/);
    return Response.json({ ok: true, result: {} });
  };
  t.after(() => { globalThis.fetch = originalFetch; sql.close(); });
  async function deliver(message, { secret = env.TELEGRAM_WEBHOOK_SECRET } = {}) {
    const tasks = [];
    const response = await worker.fetch(new Request("https://bot.test", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
      body: JSON.stringify({ update_id: 1, message }),
    }), env, { waitUntil(task) { tasks.push(task); } });
    await Promise.all(tasks);
    return response;
  }
  const owner = (extra) => ({ message_id: 10, from: { id: 1 }, chat: { id: 1, type: "private" }, ...extra });
  const group = (id, text) => ({ message_id: 20, from: { id }, chat: { id: FAMILY_GROUP, type: "supergroup" }, text });
  const rows = () => sql.prepare("SELECT * FROM group_people WHERE chat_id = ? ORDER BY user_id").all(String(FAMILY_GROUP));
  const apiCalls = () => calls.filter((call) => call.url.includes("api.openai.com"));
  return { env, sql, calls, owner, group, deliver, rows, apiCalls,
    setModelText(value) { modelText = value; },
    setModelResponses(...values) { modelResponses = values; },
  };
}

test("owner gets native people picker without an OpenAI request", async (t) => {
  const h = setup(t);
  await h.deliver(h.owner({ text: "/settings" }));
  const keyboard = h.calls[0].body.reply_markup.keyboard.flat();
  assert.equal(keyboard[0].request_users.user_is_bot, false);
  assert.equal(keyboard[0].request_users.max_quantity, 10);
  assert.notEqual(keyboard[0].request_users.request_id, keyboard[1].request_users.request_id);
  assert.equal(h.apiCalls().length, 0);
});

test("picker saves multiple roles, lists them, changes and removes them", async (t) => {
  const h = setup(t);
  await h.deliver(h.owner({ users_shared: { request_id: 1, users: [
    { user_id: 20, first_name: "Helper A" }, { user_id: 21, first_name: "Helper B" },
  ] } }));
  assert.equal(h.rows().length, 2);
  assert.ok(h.rows().every((row) => row.role === "helper"));
  await h.deliver(h.owner({ text: "/roles" }));
  assert.match(h.calls.at(-1).body.text, /Helper A — helper \(20\)/);
  await h.deliver(h.owner({ users_shared: { request_id: 2, users: [{ user_id: 20, first_name: "Renamed" }] } }));
  assert.equal(h.rows()[0].role, "family");
  assert.equal(h.rows()[0].display_name, "Renamed");
  await h.deliver(h.owner({ users_shared: { request_id: 3, users: [{ user_id: 21 }] } }));
  assert.equal(h.rows().length, 1);
  assert.equal(h.apiCalls().length, 0);
});

test("forged webhook cannot set a role or call OpenAI", async (t) => {
  const h = setup(t);
  const response = await h.deliver(h.owner({ text: "/helper 20 Name" }), { secret: "wrong" });
  assert.equal(response.status, 401);
  assert.equal(h.rows().length, 0);
  assert.equal(h.calls.length, 0);
});

test("other users and group messages cannot modify roles", async (t) => {
  const h = setup(t);
  await h.deliver(h.owner({ from: { id: 2 }, text: "/helper 20 Name" }));
  await h.deliver({ ...h.group(1), users_shared: { request_id: 1, users: [{ user_id: 20 }] } });
  await h.deliver(h.group(1, "/family 20 Name"));
  assert.equal(h.rows().length, 0);
  assert.match(h.calls[0].body.text, /authorized/);
});

test("invalid IDs and selection requests cannot corrupt assignments", async (t) => {
  const h = setup(t);
  await h.deliver(h.owner({ text: "/helper @someone" }));
  await h.deliver(h.owner({ users_shared: { request_id: 99, users: [{ user_id: 20 }] } }));
  await h.deliver(h.owner({ users_shared: { request_id: 1, users: [{ user_id: -20 }] } }));
  assert.equal(h.rows().length, 0);
  assert.equal(h.apiCalls().length, 0);
});

test("forwarded user identity is used; hidden identities never assign the owner", async (t) => {
  const h = setup(t);
  await h.deliver(h.owner({ text: "/helper", reply_to_message: {
    from: { id: 1 }, forward_origin: { type: "user", sender_user: { id: 30, first_name: "Forwarded person" } },
  } }));
  assert.equal(h.rows()[0].user_id, "30");
  await h.deliver(h.owner({ text: "/family", reply_to_message: {
    from: { id: 1 }, forward_origin: { type: "hidden_user", sender_user_name: "Hidden" },
  } }));
  assert.equal(h.rows().length, 1);
  assert.match(h.calls.at(-1).body.text, /hasn't shared/);
});

test("saved role routes English without names, metadata, or extra AI calls", async (t) => {
  const h = setup(t);
  await h.deliver(h.owner({ text: "/helper 20 Private name" }));
  await h.deliver(h.group(20, "Yes madam"));
  let request = h.apiCalls().at(-1).body;
  assert.match(request.instructions, /^The sender is a helper\. Translate into Cantonese by default/);
  assert.match(request.instructions, /For English messages, translate only into Cantonese\./);
  assert.doesNotMatch(request.instructions, /Private name/);
  assert.equal(request.input, "Yes madam");
  assert.equal(request.reasoning.effort, "none");
  assert.equal(h.calls.at(-1).body.reply_to_message_id, 20);
  await h.deliver(h.owner({ text: "/family 20 Private name" }));
  await h.deliver(h.group(20, "Please cook dinner"));
  request = h.apiCalls().at(-1).body;
  assert.match(request.instructions, /^The sender is a family member\. Translate into Indonesian by default/);
  assert.match(request.instructions, /For English messages, translate only into Indonesian\./);
  assert.match(request.instructions, /Indonesian messages translate ONLY into Cantonese/);
  assert.match(request.instructions, /Chinese\/Cantonese messages translate ONLY into Indonesian/);
  assert.equal(h.apiCalls().length, 2);
});

test("unassigned users get the documented fallback; legacy group keeps its policy", async (t) => {
  const h = setup(t);
  await h.deliver(h.group(99, "Hello"));
  assert.match(h.apiCalls()[0].body.instructions, /^The sender is a family member\. Translate into Indonesian by default/);
  assert.match(h.apiCalls()[0].body.instructions, /messages, translate only into Indonesian\./);
  await h.deliver({ ...h.group(99, "Hello"), chat: { id: -1002107386075, type: "supergroup" } });
  assert.match(h.apiCalls()[1].body.instructions, /Auto-translate between English and Cantonese/);
});

test("unauthorized groups and bot messages never call OpenAI", async (t) => {
  const h = setup(t);
  await h.deliver({ ...h.group(99, "Hello"), chat: { id: -999, type: "supergroup" } });
  await h.deliver({ ...h.group(99, "Hello"), from: { id: 99, is_bot: true } });
  assert.equal(h.calls.length, 0);
});

test("English-help flag and helper role can be set and removed independently", async (t) => {
  const h = setup(t);
  await h.deliver(h.owner({ text: "/helper 20 Person" }));
  await h.deliver(h.owner({ users_shared: { request_id: 4, users: [{ user_id: 20, first_name: "Person" }] } }));
  assert.equal(h.rows()[0].role, "helper");
  assert.equal(h.rows()[0].needs_english_help, 1);
  await h.deliver(h.owner({ text: "/family 20 Person" }));
  assert.equal(h.rows()[0].role, "family");
  assert.equal(h.rows()[0].needs_english_help, 1);
  await h.deliver(h.owner({ text: "/roles" }));
  assert.match(h.calls.at(-1).body.text, /Person — family; needs English help/);
  await h.deliver(h.owner({ text: "/helper 20 Person" }));
  await h.deliver(h.owner({ users_shared: { request_id: 5, users: [{ user_id: 20, first_name: "Person" }] } }));
  assert.equal(h.rows()[0].role, "helper");
  assert.equal(h.rows()[0].needs_english_help, 0);
  assert.equal(h.apiCalls().length, 0);
});

test("English help adds Cantonese only for other senders and never duplicates it", async (t) => {
  const h = setup(t);
  const targetsFor = async (id, chatId = FAMILY_GROUP) => englishTargets(await getTranslationPreferences(h.env, chatId, id));
  assert.deepEqual(await targetsFor(40), ["Indonesian"]);
  await h.deliver(h.owner({ text: "/helper 20 Helper" }));
  assert.deepEqual(await targetsFor(20), ["Cantonese"]);
  await h.deliver(h.owner({ text: "/englishhelp 30 Grandma" }));
  assert.deepEqual(await targetsFor(40), ["Indonesian", "Cantonese"]);
  assert.deepEqual(await targetsFor(30), ["Indonesian"]);
  assert.deepEqual(await targetsFor(20), ["Cantonese"]);
  // Another group does not inherit either the helper role or audience tags.
  assert.deepEqual(await targetsFor(20, -999), ["Indonesian"]);
  assert.deepEqual(await targetsFor(40, -999), ["Indonesian"]);
  await h.deliver(h.owner({ text: "/englishhelp 40 Relative" }));
  assert.deepEqual(await targetsFor(30), ["Indonesian", "Cantonese"]);
  await h.deliver(h.owner({ text: "/noenglishhelp 40 Relative" }));
  assert.deepEqual(await targetsFor(30), ["Indonesian"]);
});

test("additional Cantonese is requested in the same API call and only for English", async (t) => {
  const h = setup(t);
  await h.deliver(h.owner({ text: "/englishhelp 30 Grandma" }));
  await h.deliver(h.group(40, "Please cook dinner"));
  assert.equal(h.apiCalls().length, 1);
  const prompt = h.apiCalls()[0].body.instructions;
  assert.match(prompt, /For English messages, translate into Indonesian, then Cantonese/);
  assert.match(prompt, /Indonesian messages translate ONLY into Cantonese/);
  assert.match(prompt, /Chinese\/Cantonese messages translate ONLY into Indonesian/);
  assert.match(prompt, /ONLY when the message is primarily English/);
  assert.doesNotMatch(prompt, /Grandma/);
  await h.deliver(h.group(30, "Please cook dinner"));
  assert.match(h.apiCalls()[1].body.instructions, /English messages, translate only into Indonesian/);
});

test("English-help settings in other groups are excluded from routing and listing", async (t) => {
  const h = setup(t);
  h.sql.prepare(`INSERT INTO group_people (chat_id, user_id, role, needs_english_help, display_name)
    VALUES (?, ?, 'helper', 1, 'Other group')`).run("-999", "20");
  const preferences = await getTranslationPreferences(h.env, FAMILY_GROUP, 40);
  assert.equal(preferences.englishHelpForOthers, false);
  await h.deliver(h.owner({ text: "/roles" }));
  assert.doesNotMatch(h.calls.at(-1).body.text, /Other group/);
  await h.deliver(h.owner({ text: "/remove 20 Person" }));
  assert.equal(h.sql.prepare("SELECT count(*) AS n FROM group_people WHERE chat_id = '-999'").get().n, 1);
});

test("non-owner cannot change English assistance, and resetting restores defaults", async (t) => {
  const h = setup(t);
  await h.deliver(h.owner({ from: { id: 2 }, users_shared: { request_id: 4, users: [{ user_id: 30 }] } }));
  assert.equal(h.rows().length, 0);
  await h.deliver(h.owner({ text: "/helper 20 Person" }));
  await h.deliver(h.owner({ text: "/englishhelp 20 Person" }));
  await h.deliver(h.owner({ text: "/remove 20 Person" }));
  assert.deepEqual(await getTranslationPreferences(h.env, FAMILY_GROUP, 20), { role: "family", englishHelpForOthers: false });
});

test("migration preserves existing assignments and changes during deployment", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(readFileSync(new URL("../migrations/0001_user_roles.sql", import.meta.url), "utf8"));
    db.exec("INSERT INTO user_roles (user_id, role, display_name) VALUES ('20', 'helper', 'Existing helper')");
    db.exec(readFileSync(new URL("../migrations/0002_group_people.sql", import.meta.url), "utf8"));
    assert.equal(db.prepare("SELECT role FROM group_people WHERE chat_id = ? AND user_id = '20'").get(String(FAMILY_GROUP)).role, "helper");
    db.exec("UPDATE user_roles SET role = 'family' WHERE user_id = '20'");
    assert.equal(db.prepare("SELECT role FROM group_people WHERE user_id = '20'").get().role, "family");
    db.exec("INSERT INTO user_roles (user_id, role, display_name) VALUES ('30', 'helper', 'Late helper')");
    assert.equal(db.prepare("SELECT role FROM group_people WHERE user_id = '30'").get().role, "helper");
    db.exec("DELETE FROM user_roles WHERE user_id = '30'");
    assert.equal(db.prepare("SELECT role FROM group_people WHERE user_id = '30'").get().role, "family");
  } finally { db.close(); }
});

test("link-only messages and captions skip both settings lookup and external APIs", async (t) => {
  const h = setup(t);
  h.env.ROLE_DB.prepare = () => { throw new Error("No database lookup expected"); };
  const link = "https://www.threads.com/share/BBLr8S3LA9";
  await h.deliver(h.group(40, link));
  await h.deliver({ ...h.group(40), caption: link, caption_entities: [{ type: "url", offset: 0, length: link.length }] });
  await h.deliver(h.group(40, `👍 ${link}`));
  assert.equal(h.calls.length, 0);
});

test("comments alongside links still translate and preserve the complete input", async (t) => {
  const h = setup(t);
  const link = "https://www.threads.com/share/BBLr8S3LA9";
  const text = `幫我睇吓 ${link}`;
  await h.deliver({ ...h.group(40, text), entities: [{ type: "url", offset: text.indexOf(link), length: link.length }] });
  assert.equal(h.apiCalls().length, 1);
  assert.equal(h.apiCalls()[0].body.input, text);
  assert.equal(h.calls.at(-1).body.text, "translated");
});

test("verbatim model echoes do not produce duplicate Telegram messages", async (t) => {
  const h = setup(t);
  h.setModelText("Tintin");
  await h.deliver(h.group(40, "Tintin"));
  assert.equal(h.apiCalls().length, 1);
  assert.equal(h.calls.length, 1);
});

test("written Chinese fixes the target to Indonesian regardless of roles or English help", async (t) => {
  const h = setup(t);
  await h.deliver(h.owner({ text: "/helper 20 Helper" }));
  await h.deliver(h.owner({ text: "/englishhelp 30 Grandma" }));
  // These messages need neither a settings query nor a language detection call.
  h.env.ROLE_DB.prepare = () => { throw new Error("No database lookup expected"); };
  const examples = [
    ["婷婷你現在過來1號巴士站站等", "Tintin, sekarang datang dan tunggu di halte bus nomor 1."],
    ["衣服等我回來才洗", "Tunggu sampai saya pulang baru cuci bajunya."],
    ["衣服等我回来才洗", "Tunggu sampai saya pulang baru cuci bajunya."],
    ["衫等我返嚟先洗。", "Tunggu sampai saya pulang baru cuci bajunya."],
  ];
  for (const id of [40, 20, 30]) {
    for (const [text, expected] of examples) {
      h.setModelText(expected);
      await h.deliver(h.group(id, text));
      const request = h.apiCalls().at(-1).body;
      assert.match(request.instructions, /^Translate this Chinese message into Indonesian only\./);
      assert.doesNotMatch(request.instructions, /For English messages|Use natural spoken Cantonese/);
      assert.equal(request.input, text);
      assert.equal(h.calls.at(-1).body.text, expected);
      assert.equal(h.calls.at(-1).body.reply_to_message_id, 20);
    }
  }
  assert.equal(h.apiCalls().length, 12);
});

test("Chinese captions keep their links and Chinese names in an Indonesian answer", async (t) => {
  const h = setup(t);
  const link = "example.com/bus/1";
  const caption = `婷婷你現在過來1號巴士站站等 ${link}`;
  const expected = `婷婷, sekarang datang dan tunggu di halte bus nomor 1. ${link}`;
  h.setModelText(expected);
  await h.deliver({ ...h.group(40), caption,
    caption_entities: [{ type: "url", offset: caption.indexOf(link), length: link.length }],
  });
  assert.match(h.apiCalls()[0].body.instructions, /^Translate this Chinese message into Indonesian only\./);
  assert.equal(h.apiCalls()[0].body.input, caption);
  assert.equal(h.apiCalls().length, 1);
  assert.equal(h.calls.at(-1).body.text, expected);
});

test("Chinese paraphrases and echoes are retried once before replying", async (t) => {
  const h = setup(t);
  const input = "衣服等我回來才洗";
  const expected = "Tunggu sampai saya pulang baru cuci bajunya.";
  for (const badOutput of ["衫等我返嚟先洗。", input]) {
    h.setModelResponses(badOutput, expected);
    await h.deliver(h.group(40, input));
    assert.match(h.apiCalls().at(-1).body.instructions, /answer must be in Indonesian/);
    assert.equal(h.apiCalls().at(-1).body.input, input);
    assert.equal(h.calls.at(-1).body.text, expected);
  }
  assert.equal(h.apiCalls().length, 4);
  const replies = h.calls.filter((call) => call.url.endsWith("/sendMessage"));
  assert.deepEqual(replies.map((call) => call.body.text), [expected, expected]);
});

test("persistent Chinese paraphrases with URLs are never sent and retries are bounded", async (t) => {
  const h = setup(t);
  t.mock.method(console, "error", () => {});
  h.setModelText("婷婷你而家過嚟1號巴士站等。 https://example.com/bus/1");
  await h.deliver(h.group(40, "婷婷你現在過來1號巴士站站等 https://example.com/bus/1"));
  assert.equal(h.apiCalls().length, 2);
  const replies = h.calls.filter((call) => call.url.endsWith("/sendMessage"));
  assert.equal(replies.length, 1);
  assert.equal(replies[0].body.text, "Sorry, there was an error processing your message.");
});

test("written Chinese in the English/Cantonese group and owner private chat targets English", async (t) => {
  const h = setup(t);
  for (const message of [
    { ...h.group(40, "衣服等我回來才洗"), chat: { id: -1002107386075, type: "supergroup" } },
    h.owner({ text: "衣服等我回來才洗" }),
  ]) {
    h.setModelText("Wait until I get back before washing the clothes.");
    await h.deliver(message);
    assert.match(h.apiCalls().at(-1).body.instructions, /^Translate this Chinese message into English only\./);
  }
  assert.equal(h.apiCalls().length, 2);
});

test("mixed scripts retain grammar-based routing and conditional Cantonese style", async (t) => {
  const h = setup(t);
  await h.deliver(h.owner({ text: "/englishhelp 30 Grandma" }));
  for (const text of ["Tintin, 衣服等我回來才洗", "幫我check吓", "Please ask 太太 to call me."]) {
    await h.deliver(h.group(40, text));
    const prompt = h.apiCalls().at(-1).body.instructions;
    assert.match(prompt, /main language from sentence grammar/);
    assert.match(prompt, /standard written Chinese/);
    assert.match(prompt, /For English messages, translate into Indonesian, then Cantonese/);
    assert.match(prompt, /Only when Cantonese is a target/);
  }
  assert.equal(h.apiCalls().length, 3);
});

test("Chinese bus-stop labels force Indonesian and reject the reported Chinese paraphrase", async (t) => {
  const h = setup(t);
  await h.deliver(h.owner({ text: "/helper 20 Helper" }));
  await h.deliver(h.owner({ text: "/englishhelp 30 Grandma" }));
  const input = "婷婷去1號A巴士站站等我";
  const badOutput = "婷婷去1號A巴士站等我。";
  const expected = "Tingting, pergi ke halte bus nomor 1A dan tunggu saya.";
  h.setModelResponses(badOutput, expected);
  await h.deliver(h.group(30, input));
  assert.equal(h.apiCalls().length, 2);
  for (const { body } of h.apiCalls()) {
    assert.match(body.instructions, /^Translate this Chinese message into Indonesian only\./);
    assert.equal(body.input, input);
  }
  assert.equal(h.calls.at(-1).body.text, expected);
  assert.ok(!h.calls.some((call) => call.url.endsWith("/sendMessage") && call.body.text === badOutput));
  h.setModelText("Tingting, pergi ke halte bus nomor 1 dalam 5 menit untuk menunggu saya.");
  await h.deliver(h.group(30, "婷婷5分鐘後去1號巴士站等我"));
  assert.equal(h.apiCalls().length, 3);
  assert.match(h.apiCalls()[2].body.instructions, /^Translate this Chinese message into Indonesian only\./);
});

test("a repeated Chinese response with a stop label is blocked after one retry", async (t) => {
  const h = setup(t);
  t.mock.method(console, "error", () => {});
  h.setModelText("婷婷去1號A巴士站等我。");
  await h.deliver(h.group(30, "婷婷去1號A巴士站站等我"));
  assert.equal(h.apiCalls().length, 2);
  assert.equal(h.calls.at(-1).body.text, "Sorry, there was an error processing your message.");
});

test("role defaults also cover ambiguous mixed messages while retaining language overrides", async (t) => {
  const h = setup(t);
  await h.deliver(h.owner({ text: "/helper 20 Helper" }));
  await h.deliver(h.owner({ text: "/englishhelp 30 Grandma" }));
  for (const [id, sender, target] of [[20, "helper", "Cantonese"], [40, "family member", "Indonesian"]]) {
    await h.deliver(h.group(id, "OK 1A"));
    const prompt = h.apiCalls().at(-1).body.instructions;
    assert.ok(prompt.startsWith(`The sender is a ${sender}. Translate into ${target} by default, including ambiguous short messages.`));
    assert.match(prompt, /Chinese\/Cantonese messages translate ONLY into Indonesian/);
    assert.match(prompt, /Indonesian messages translate ONLY into Cantonese/);
  }
  assert.equal(h.apiCalls().length, 2);
  assert.match(h.apiCalls()[1].body.instructions, /For English messages, translate into Indonesian, then Cantonese/);
});
