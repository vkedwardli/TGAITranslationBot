import test from "node:test";
import assert from "node:assert/strict";
import { isChineseWithLabels, hasTranslatableText } from "../message-text.js";

test("skip links and nonlinguistic messages", () => {
  for (const text of [
    "", "   ", "👍😁", "...?!", "12:30", "https://www.threads.com/share/BBLr8S3LA9",
    "HTTPS://example.com/a", "www.example.com", "👍 https://example.com/x 🙏",
    "https://example.com\nhttps://example.org", "https://example.com/中文",
  ]) assert.equal(hasTranslatableText({ text }), false, text);
  const text = "example.com/share/ABC";
  assert.equal(hasTranslatableText({ text, entities: [{ type: "url", offset: 0, length: text.length }] }), false);
});

test("URL entities use UTF-16 offsets and preserve surrounding prose", () => {
  const link = "example.com/share/ABC";
  const text = `👍 ${link}，幫我睇吓`;
  assert.equal(hasTranslatableText({ text, entities: [{ type: "url", offset: 3, length: link.length }] }), true);
  assert.equal(hasTranslatableText({ text: `👍 ${link}`, entities: [{ type: "url", offset: 3, length: link.length }] }), false);
  const caption = `😇 ${link} ${link}`;
  assert.equal(hasTranslatableText({ caption, caption_entities: [
    { type: "url", offset: 3, length: link.length },
    { type: "url", offset: 4 + link.length, length: link.length },
  ] }), false);
});

test("keep comments, readable link labels, short replies and Cantonese code mixing", () => {
  for (const text of [
    "幫我睇吓 https://example.com", "https://example.com，幫我睇吓",
    "Please check https://example.com", "好", "Ya", "幫我check吓", "email畀你", "幾點lunch", "食buffet",
  ]) assert.equal(hasTranslatableText({ text }), true, text);
  assert.equal(hasTranslatableText({ text: "請睇呢篇", entities: [{ type: "text_link", offset: 0, length: 4, url: "https://example.com" }] }), true);
});

test("written Chinese and Cantonese share a script regardless of digits, emoji and links", () => {
  for (const text of [
    "婷婷你現在過來1號巴士站站等", "衣服等我回來才洗", "衣服等我回来才洗",
    "衫等我返嚟先洗。", "好", "👍 12:30返嚟", "幫我睇吓 https://example.com/abc",
  ]) assert.equal(isChineseWithLabels({ text }), true, text);
  const caption = "👍 example.com/abc，請看";
  assert.equal(isChineseWithLabels({ caption, caption_entities: [{ type: "url", offset: 3, length: 15 }] }), true);
});

test("Chinese shortcut excludes empty text, mixed scripts and Latin-only sources", () => {
  for (const text of [
    "", "12:30 👍", "https://example.com/中文", "Tintin, 衣服等我回來才洗",
    "幫我check吓", "email畀你", "幾點lunch", "食buffet", "Please ask 太太 to call me.",
    "Saya sudah check email, nyonya.", "はい", "한국어",
  ]) assert.equal(isChineseWithLabels({ text }), false, text);
});

test("stop labels and route codes do not make Chinese prose English", () => {
  for (const text of [
    "婷婷去1號A巴士站站等我", "婷婷5分鐘後去1號巴士站等我",
    "婷婷去1號A巴士站等我。", "去1A巴士站等我", "去A12巴士站等我",
    "去 A 出口等我", "去B2出口等我", "去１號Ａ巴士站等我", "去1號a巴士站等我",
  ]) assert.equal(isChineseWithLabels({ text }), true, text);
});

test("labels cannot hide actual English or Indonesian prose or invent Chinese prose", () => {
  for (const text of [
    "A", "1A", "A12 👍", "去 A exit", "Please ask 太太 to wait at stop 1A.",
    "Tolong tunggu di halte 1A, 婷婷.", "婷婷, tunggu saya di halte 1A.",
    "幫我check吓A12", "Tintin, 去1號A巴士站等我", "A12 https://example.com/中文",
  ]) assert.equal(isChineseWithLabels({ text }), false, text);
});
