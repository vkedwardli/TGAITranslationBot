# Telegram translation bot

A Cloudflare Worker translates authorized Telegram group messages through OpenAI.

## Assign people in private chat

The owner configured by `ALLOWED_USER_ID` can send `/settings` to
[@GrampianTranslationBot](https://t.me/GrampianTranslationBot), tap **Assign helper**,
and select up to ten people with Telegram's people picker. Everyone else is family
automatically. Tap **Needs English help** to tag a person who needs Cantonese
translations of other people's English messages.

Roles and English-help tags are independent and persist per group and Telegram
user ID in the `ROLE_DB` D1 database. Private setup currently manages the configured
family/helper group (`FAMILY_HELPER_GROUP_ID` in `groups.js`).

- `/roles`: show helpers and people tagged for English help. Everyone else is family.
- `/helper`: assign helpers.
- `/family`: restore the default family role without changing English help.
- `/englishhelp`, `/noenglishhelp`: enable or remove English help independently.
- `/remove`: reset both the role and English-help setting.
- `/helper USER_ID Name` or `/family USER_ID Name`: assign by numeric ID.
- All commands accept `USER_ID Name` or open the corresponding people picker.
- Reply a setup command to a forwarded message to configure its original
  sender. If Telegram hides that sender's ID, use the people picker instead.
- `/cancel`: hide setup buttons.

Commands and selections are handled directly, without OpenAI calls.
Only the owner can configure roles, and only in private chat.

The saved role sets the default direction in the translation prompt, including
ambiguous short messages: family → Indonesian; helper → Cantonese. Everyone
without a helper assignment is family. Explicit source-language rules below
override that default, and English help adds a target only for English messages.

| Input | Translation |
| --- | --- |
| Indonesian | Spoken Cantonese in Traditional Chinese |
| Written Chinese (Traditional or Simplified) / Cantonese | Indonesian |
| English, helper | Cantonese |
| English, family member | Indonesian |
| English, family member with another person tagged for English help | Indonesian + Cantonese |

The sender's own English-help tag does not trigger an extra translation. A helper's
English already produces Cantonese, so it is never added twice. Multiple tagged
people still produce only one Cantonese translation. Tags in other groups do not
apply. Mixed messages follow their main language and sentence grammar. Cantonese
with names or borrowed English words (for example `Tintin, 麻煩你送飯`, `幫我check吓`,
`email畀你`, `幾點lunch`, `食buffet`) produces Indonesian only. The extra Cantonese
translation is reserved for messages that are primarily English. Indonesian
with English loanwords still produces Cantonese only. Both translations use one
OpenAI request.

When the prose is Chinese after ignoring URLs, single-letter labels and
alphanumeric codes (such as `1號A`, `1A`, `A12`), code fixes the target to
Indonesian before calling OpenAI, without a settings lookup. Labels are ignored
only for detection and retained in the model's input. Standard written
Chinese has the same destination as colloquial Cantonese. The model receives a
short prompt with one target language. A Chinese response, even with these labels, triggers one
corrective retry; if that also fails, the bot returns an error instead of posting
the paraphrase. This script check allows Chinese names within a translation; it
does not verify translation quality or fully identify the output language.
Mixed scripts continue to use the main-language rules above.

Messages containing only links, emoji, numbers or punctuation are skipped before
any translation API call. A link accompanied by a written comment is translated,
keeping the original URL. Readable hyperlink labels also remain eligible for
translation. Verbatim model echoes are not posted back to Telegram.

The group migration preserves previously assigned roles. The legacy role table and
sync triggers are retained to capture updates from the old worker during rollout.

The separate `english-cantonese` group and ordinary owner private messages use
English ↔ Cantonese translation. Roles do not grant access to additional groups.
Their Chinese text is fixed to English using the same check.

## Development and deployment

Use Node.js 22.13 or newer for the tests, which execute the production schema
and queries against SQLite and mock external API calls.

```sh
npm install
npm test
npx wrangler d1 migrations apply ROLE_DB --local
npm run dev
```

Set `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `ALLOWED_USER_ID`, and
`TELEGRAM_WEBHOOK_SECRET` in `.dev.vars` for local development. Runtime secrets
are managed in Cloudflare. POST requests must carry the matching
`X-Telegram-Bot-Api-Secret-Token` header.

For deployment:

```sh
npx wrangler d1 migrations apply ROLE_DB --remote
npm run deploy
```

Register the Telegram webhook using `setWebhook` with the deployed worker URL
and `secret_token` equal to `TELEGRAM_WEBHOOK_SECRET`. When initially enabling
webhook authentication on an existing bot, set the runtime secret and update
the Telegram webhook before deploying code that requires the header. Keep
pending updates when updating the webhook.
