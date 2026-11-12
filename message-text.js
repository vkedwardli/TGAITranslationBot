// Telegram entity offsets and JavaScript string offsets both use UTF-16 units.
// Strip URL entities only for local checks, never from the model's input.
function textWithoutUrls(message) {
  const hasText = typeof message.text === "string" && message.text.length > 0;
  let text = hasText ? message.text : (message.caption || "");
  const entities = (hasText ? message.entities : message.caption_entities) || [];
  const urls = entities.filter((entity) => entity.type === "url")
    .sort((a, b) => b.offset - a.offset);
  for (const { offset, length } of urls) {
    if (Number.isInteger(offset) && Number.isInteger(length) && offset >= 0 && length > 0) {
      text = text.slice(0, offset) + " ".repeat(length) + text.slice(offset + length);
    }
  }
  // Fallback for updates without entities; stop at common prose punctuation so
  // a comment following a link is still translated. Readable text_link labels stay.
  text = text.replace(/(?:https?:\/\/|www\.)[^\s<>，。！？；：、“”‘’]+/giu, " ");
  return text;
}

export function hasTranslatableText(message) {
  return /\p{L}/u.test(textWithoutUrls(message));
}

// Letter labels and alphanumeric codes aren't evidence of English prose.
// Normalize full-width labels for detection only; preserve the original input.
// Actual Latin words/names still use the role-aware translation prompt.
export function isChineseWithLabels(message) {
  const prose = textWithoutUrls(message).normalize("NFKC")
    .replace(/[a-z0-9]+/gi, (token) => {
      const isLabel = /^[a-z]$/i.test(token);
      const isCode = /[a-z]/i.test(token) && /[0-9]/.test(token);
      return isLabel || isCode ? " " : token;
    });
  const letters = prose.match(/\p{L}/gu) || [];
  return letters.length > 0 && letters.every((letter) => /\p{Script=Han}/u.test(letter));
}
