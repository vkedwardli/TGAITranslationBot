import { GoogleGenerativeAI } from "@google/generative-ai";

// Helper function to send a message using the Telegram Bot API
async function sendMessage(token, chatId, text, replyToMessageId) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: text,
  };
  if (replyToMessageId) {
    payload.reply_to_message_id = replyToMessageId;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    console.error("Error sending message:", await response.text());
  }
  return response.json();
}

// Helper function to leave a chat
async function leaveChat(token, chatId) {
  const url = `https://api.telegram.org/bot${token}/leaveChat`;
  const payload = {
    chat_id: chatId,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    console.error("Error leaving chat:", await response.text());
  }
  return response.json();
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("OK", { status: 200 });
    }

    try {
      const genAI = new GoogleGenerativeAI(env.GOOGLE_GENERATIVE_AI_API_KEY);
      const token = env.TELEGRAM_BOT_TOKEN;
      const update = await request.json();

      const handleUpdate = async () => {
        if (update.message) {
          const msg = update.message;
          const chatId = msg.chat.id;
          const text = msg.text;
          const chatType = msg.chat.type;
          const userId = msg.from.id;

          if (!text) return;

          const isGroup = chatType === "group" || chatType === "supergroup";
          const isAllowedPrivate =
            chatType === "private" && userId.toString() === env.ALLOWED_USER_ID;

          if (!(isGroup || isAllowedPrivate)) {
            if (chatType === "private") {
              await sendMessage(
                token,
                chatId,
                "Sorry, I can only be used in groups or by my owner in a private chat."
              );
            }
            return;
          }

          try {
            const model = genAI.getGenerativeModel({
              model: "gemini-2.5-flash",
            });
            const prompt = `Auto-translate between English and Cantonese. Provide only the translated text.\n\nInput: \`\`\`\n${text}\n\`\`\``;
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const translation = response.text();
            await sendMessage(token, chatId, translation, msg.message_id);
          } catch (error) {
            console.error("ERROR calling Gemini or sending message:", error);
            await sendMessage(
              token,
              chatId,
              "Sorry, there was an error processing your message."
            );
          }
        } else if (update.my_chat_member) {
          const myChatMember = update.my_chat_member;
          if (
            myChatMember.new_chat_member &&
            myChatMember.new_chat_member.status === "member" &&
            myChatMember.new_chat_member.user.is_bot &&
            myChatMember.from.id.toString() !== env.ALLOWED_USER_ID
          ) {
            await sendMessage(
              myChatMember.chat.id,
              "Sorry, I can only be added to groups by my owner."
            );
            await leaveChat(token, myChatMember.chat.id);
          }
        }
      };

      ctx.waitUntil(handleUpdate());
      return new Response("OK", { status: 200 });
    } catch (e) {
      console.error("FATAL ERROR in fetch handler:", e);
      return new Response("Error", { status: 500 });
    }
  },
};
