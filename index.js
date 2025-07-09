require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// replace the value below with the Telegram token you receive from @BotFather
const token = process.env.TELEGRAM_BOT_TOKEN;
// replace the value below with your Google Generative AI API key
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENERATIVE_AI_API_KEY);

// Create a bot that uses 'polling' to fetch new updates
const bot = new TelegramBot(token, { polling: true });

bot.on("new_chat_members", async (msg) => {
  const botInfo = await bot.getMe();
  const botWasAdded = msg.new_chat_members.some(
    (member) => member.id === botInfo.id
  );

  if (botWasAdded && msg.from.id !== 15008795) {
    bot.sendMessage(
      msg.chat.id,
      "Sorry, I can only be added to groups by my owner."
    );
    bot.leaveChat(msg.chat.id);
  }
});

// Listen for any kind of message.
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const chatType = msg.chat.type;
  const userId = msg.from.id;

  if (!text) {
    return;
  }

  const isGroup = chatType === "group" || chatType === "supergroup";
  const isAllowedPrivate = chatType === "private" && userId === 15008795;

  if (!(isGroup || isAllowedPrivate)) {
    if (chatType === "private") {
      bot.sendMessage(
        chatId,
        "Sorry, I can only be used in groups or by my owner in a private chat."
      );
    }
    return;
  }

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = `Detect the language of the following text. If it is English, translate it to Cantonese. If it is Cantonese, translate it to English. Do not provide any additional information, explanations, or engage in conversation. Just provide the translation.\n\nText to translate: "${text}"`;
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const translation = response.text();
    bot.sendMessage(chatId, translation, {
      reply_to_message_id: msg.message_id,
    });
  } catch (error) {
    console.error("ERROR:", error);
    bot.sendMessage(
      chatId,
      "Sorry, there was an error processing your message."
    );
  }
});
