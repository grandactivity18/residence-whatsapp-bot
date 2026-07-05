import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

await loadEnvFile(path.join(__dirname, ".env"));

const config = {
  port: Number(process.env.PORT || 3000),
  whatsappToken: process.env.WHATSAPP_TOKEN || "",
  phoneNumberId: process.env.PHONE_NUMBER_ID || "",
  verifyToken: process.env.VERIFY_TOKEN || "local-dev-token",
  graphVersion: process.env.GRAPH_API_VERSION || "v20.0",
  adminPanelToken: process.env.ADMIN_PANEL_TOKEN || "admin",
  adminPhoneNumber: normalizePhone(process.env.ADMIN_PHONE_NUMBER || ""),
  aiEnabled: String(process.env.AI_ENABLED || "false").toLowerCase() === "true",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
  openaiBaseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "")
};

const hall = JSON.parse(await readFile(path.join(__dirname, "banquet-info.json"), "utf8"));
await ensureStorage();

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") {
      return sendJson(res, 200, {
        ok: true,
        service: "WhatsApp banquet assistant",
        webhook: "/webhook",
        adminPanel: "/admin?token=YOUR_ADMIN_PANEL_TOKEN"
      });
    }

    if (req.method === "GET" && url.pathname === "/webhook") {
      return verifyWebhook(url, res);
    }

    if (req.method === "POST" && url.pathname === "/webhook") {
      await handleWebhook(req);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/admin") {
      if (!isAdmin(url, req)) return sendText(res, 401, "Неверный токен администратора.");
      return sendHtml(res, renderAdminPanel(config.adminPanelToken));
    }

    if (req.method === "GET" && url.pathname === "/api/sessions") {
      if (!isAdmin(url, req)) return sendJson(res, 401, { error: "Unauthorized" });
      const sessions = await readSessions();
      return sendJson(res, 200, Object.values(sessions).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    }

    if (req.method === "POST" && url.pathname === "/api/reply") {
      if (!isAdmin(url, req)) return sendJson(res, 401, { error: "Unauthorized" });
      const body = await readJson(req);
      const to = normalizePhone(body.to || "");
      const text = String(body.text || "").trim();
      if (!to || !text) return sendJson(res, 400, { error: "Нужны поля to и text" });
      await sendWhatsAppText(to, text);
      await saveMessage(to, "admin", text, { handoff: true });
      return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Server error" });
  }
}).listen(config.port, () => {
  console.log(`WhatsApp banquet assistant is running on http://localhost:${config.port}`);
});

async function handleWebhook(req) {
  const payload = await readJson(req);
  const messages = payload?.entry?.flatMap((entry) =>
    entry?.changes?.flatMap((change) => change?.value?.messages || []) || []
  ) || [];

  for (const message of messages) {
    if (message.type !== "text") continue;
    const from = normalizePhone(message.from);
    const text = message.text?.body?.trim() || "";
    await saveMessage(from, "client", text);
    await answerClient(from, text);
  }
}

async function answerClient(from, text) {
  const sessions = await readSessions();
  const session = sessions[from] || {};
  const intent = detectIntent(text);

  if (session.handoff && intent !== "menu") {
    await notifyAdmin(from, text);
    return;
  }

  if (intent === "admin") {
    await handoffToAdmin(from, text || "Клиент попросил администратора.");
    return;
  }

  if (intent === "hall") return sendWhatsAppText(from, hallInfoText());
  if (intent === "menu") return sendMenu(from);
  if (intent.startsWith("menu:")) return sendWhatsAppText(from, menuDetailText(intent.replace("menu:", "")));
  if (intent === "price") return sendWhatsAppText(from, priceText());
  if (intent === "date") return sendWhatsAppText(from, dateText());
  if (intent === "faq") return sendWhatsAppText(from, faqText());

  if (config.aiEnabled && config.openaiApiKey) {
    const aiAnswer = await createAiAnswer(from, text);
    if (aiAnswer.handoff) {
      await markHandoff(from, true);
      await sendWhatsAppText(from, aiAnswer.text);
      await notifyAdmin(from, text);
      return;
    }

    await sendWhatsAppText(from, aiAnswer.text);
    return;
  }

  await sendWhatsAppText(from, mainMenuText());
}

async function handoffToAdmin(from, reason) {
  await markHandoff(from, true);
  await sendWhatsAppText(from, [
    "Передаю вас администратору.",
    "Пожалуйста, напишите дату мероприятия, количество гостей и удобное время для связи."
  ].join("\n"));
  await notifyAdmin(from, reason);
}

function detectIntent(rawText) {
  const text = rawText.toLowerCase();
  if (includesAny(text, ["вариант 1", "28000", "28 000"])) return "menu:Вариант 1";
  if (includesAny(text, ["вариант 2", "24000", "24 000"])) return "menu:Вариант 2";
  if (includesAny(text, ["вариант 3", "21000", "21 000"])) return "menu:Вариант 3";
  if (["1", "зал"].includes(text) || includesAny(text, ["банкет", "адрес", "вместим", "зал"])) return "hall";
  if (["2", "меню"].includes(text) || includesAny(text, ["еда", "блюд", "кухня", "стол", "варианты"])) return "menu";
  if (["3", "цены"].includes(text) || includesAny(text, ["цена", "стоим", "прайс", "сколько"])) return "price";
  if (["4", "дата"].includes(text) || includesAny(text, ["свобод", "бронь", "заброни", "дат"])) return "date";
  if (["5", "админ"].includes(text) || includesAny(text, ["администратор", "менеджер", "оператор", "человек", "позвоните"])) return "admin";
  if (["6", "вопрос"].includes(text) || includesAny(text, ["торт", "оформ", "декоратор", "ведущ", "диджей", "музык", "до скольки", "faq"])) return "faq";
  return "unknown";
}

function mainMenuText() {
  return [
    `Здравствуйте! Это ${hall.hallName}.`,
    "Я помогу быстро узнать основную информацию.",
    "",
    "Выберите раздел цифрой:",
    "1. Банкетный зал",
    "2. Меню",
    "3. Цены",
    "4. Проверить дату",
    "5. Связаться с администратором",
    "6. Частые вопросы"
  ].join("\n");
}

function hallInfoText() {
  const capacity = hall.capacity.maxGuests
    ? `Вместимость: от ${hall.capacity.minGuests} до ${hall.capacity.maxGuests} гостей.`
    : "Точную вместимость зала уточняет администратор.";

  return [
    hall.hallName,
    `Адрес: ${hall.address}`,
    `График: ${hall.workingHours}`,
    capacity,
    hall.capacity.description,
    "",
    `Есть: ${hall.features.join(", ")}.`,
    "",
    "Чтобы узнать меню, отправьте 2. Чтобы поговорить с администратором, отправьте 5."
  ].join("\n");
}

function menuText() {
  return [
    "Меню RESIDENCE на 2026 год:",
    "",
    ...hall.menus.map((menu) => `${menu.name} - ${menu.pricePerGuest} за гостя`),
    "",
    "Для подробного состава напишите: 28 000, 24 000 или 21 000.",
    "Для брони даты отправьте 5."
  ].join("\n");
}

async function sendMenu(to) {
  await sendWhatsAppText(to, menuText());

  if (hall.menuImageUrl) {
    await sendWhatsAppImage(to, hall.menuImageUrl, "Меню банкетного зала");
  }
}

function menuDetailText(menuName) {
  const menu = hall.menus.find((item) => item.name === menuName);
  if (!menu) return menuText();

  const sections = Object.values(menu.sections || {})
    .map((items) => items.map((item) => `- ${item}`).join("\n"))
    .join("\n\n");

  return [
    `${menu.name} - ${menu.pricePerGuest} за гостя`,
    menu.title,
    "",
    sections || menu.items.map((item) => `- ${item}`).join("\n"),
    "",
    hall.booking.deposit,
    "Для проверки даты или брони отправьте 5."
  ].join("\n");
}

function priceText() {
  return [
    "Стоимость зависит от выбранного варианта меню:",
    "",
    ...hall.menus.map((menu) => `${menu.name}: ${menu.pricePerGuest}`),
    "",
    hall.booking.deposit,
    "Для точного расчета отправьте 5 и напишите дату + количество гостей."
  ].join("\n");
}

function dateText() {
  return [
    hall.booking.dateCheckText,
    "",
    "Формат: 25.08.2026, 80 гостей, свадьба.",
    "После этого администратор проверит дату и ответит вам."
  ].join("\n");
}

function faqText() {
  return [
    "Частые вопросы:",
    "",
    hall.faq.map((item) => `${item.question}\n${item.answer}`).join("\n\n")
  ].join("\n");
}

async function createAiAnswer(from, clientText) {
  const sessions = await readSessions();
  const messages = sessions[from]?.messages || [];
  const historySource = messages.at(-1)?.role === "client" && messages.at(-1)?.text === clientText
    ? messages.slice(0, -1)
    : messages;
  const history = historySource.slice(-8).map((message) => ({
    role: message.role === "client" ? "user" : "assistant",
    content: message.text
  }));

  const systemPrompt = [
    "You are a WhatsApp assistant for banquet hall RESIDENCE.",
    "Answer in Russian, briefly, politely and naturally.",
    "Use only the banquet hall data provided below.",
    "Do not invent free dates, discounts, exact availability, legal promises, or services that are not listed.",
    "If the client wants to book, check a date, negotiate details, get a call, or talk to a human, set handoff to true.",
    "If information is missing, say that an administrator will clarify it and set handoff to true.",
    "Return only valid JSON with fields: text, handoff.",
    "",
    `Banquet hall data: ${JSON.stringify(hall)}`
  ].join("\n");

  try {
    const response = await fetch(`${config.openaiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.openaiModel,
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          ...history,
          { role: "user", content: clientText }
        ]
      })
    });

    if (!response.ok) {
      const details = await response.text();
      console.error(`AI API error ${response.status}: ${details}`);
      return { text: mainMenuText(), handoff: false };
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(content);
    const text = String(parsed.text || "").trim();

    if (!text) return { text: mainMenuText(), handoff: false };
    return { text, handoff: Boolean(parsed.handoff) };
  } catch (error) {
    console.error("AI answer failed:", error);
    return { text: mainMenuText(), handoff: false };
  }
}

async function notifyAdmin(clientPhone, clientText) {
  if (!config.adminPhoneNumber) return;
  const adminText = [
    "Новый запрос в банкетный зал RESIDENCE.",
    `Клиент: +${clientPhone}`,
    `Сообщение: ${clientText}`,
    "",
    `Ответить можно в панели: /admin?token=${config.adminPanelToken}`
  ].join("\n");
  await sendWhatsAppText(config.adminPhoneNumber, adminText);
}

async function sendWhatsAppText(to, text) {
  console.log(`WA -> ${to}: ${text}`);

  if (!config.whatsappToken || !config.phoneNumberId) {
    console.log("Message was not sent: WHATSAPP_TOKEN or PHONE_NUMBER_ID is not configured.");
    return;
  }

  const response = await fetch(`https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.whatsappToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body: text }
    })
  });

  if (!response.ok) {
    const details = await response.text();
    console.error(`WhatsApp API error ${response.status}: ${details}`);
  }
}

async function sendWhatsAppImage(to, imageUrl, caption = "") {
  console.log(`WA image -> ${to}: ${imageUrl}`);

  if (!config.whatsappToken || !config.phoneNumberId) {
    console.log("Image was not sent: WHATSAPP_TOKEN or PHONE_NUMBER_ID is not configured.");
    return;
  }

  const response = await fetch(`https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.whatsappToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "image",
      image: { link: imageUrl, caption }
    })
  });

  if (!response.ok) {
    const details = await response.text();
    console.error(`WhatsApp image API error ${response.status}: ${details}`);
  }
}

async function saveMessage(phone, role, text, extra = {}) {
  const sessions = await readSessions();
  const previous = sessions[phone] || { phone, handoff: false, messages: [] };
  sessions[phone] = {
    ...previous,
    ...extra,
    phone,
    updatedAt: new Date().toISOString(),
    messages: [
      ...(previous.messages || []),
      { role, text, at: new Date().toISOString() }
    ].slice(-50)
  };
  await writeSessions(sessions);
}

async function markHandoff(phone, handoff) {
  const sessions = await readSessions();
  sessions[phone] = {
    ...(sessions[phone] || { phone, messages: [] }),
    phone,
    handoff,
    updatedAt: new Date().toISOString()
  };
  await writeSessions(sessions);
}

async function ensureStorage() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(SESSIONS_FILE)) await writeFile(SESSIONS_FILE, "{}", "utf8");
}

async function readSessions() {
  await ensureStorage();
  return JSON.parse(await readFile(SESSIONS_FILE, "utf8"));
}

async function writeSessions(sessions) {
  await writeFile(SESSIONS_FILE, JSON.stringify(sessions, null, 2), "utf8");
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function verifyWebhook(url, res) {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === config.verifyToken) {
    return sendText(res, 200, challenge || "");
  }

  sendText(res, 403, "Forbidden");
}

function isAdmin(url, req) {
  const token = url.searchParams.get("token") || req.headers["x-admin-token"];
  return token === config.adminPanelToken;
}

function renderAdminPanel(token) {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Администратор RESIDENCE</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #f6f5f2; color: #1f2933; }
    main { max-width: 980px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 24px; margin: 0 0 18px; }
    .session { background: #fff; border: 1px solid #ddd8ce; border-radius: 8px; padding: 16px; margin-bottom: 14px; }
    .top { display: flex; justify-content: space-between; gap: 16px; align-items: center; }
    .phone { font-weight: 700; }
    .badge { font-size: 12px; padding: 4px 8px; border-radius: 999px; background: #e9f7ef; color: #17643a; }
    .messages { margin: 12px 0; display: grid; gap: 8px; }
    .message { padding: 8px 10px; border-radius: 6px; background: #f4f4f4; }
    .admin { background: #e8f0ff; }
    textarea { width: 100%; min-height: 72px; box-sizing: border-box; padding: 10px; border-radius: 6px; border: 1px solid #c9c2b8; resize: vertical; }
    button { margin-top: 8px; padding: 10px 14px; border: 0; border-radius: 6px; background: #126c57; color: white; cursor: pointer; }
    button:hover { background: #0f5b49; }
    .empty { color: #667085; }
  </style>
</head>
<body>
<main>
  <h1>Диалоги с клиентами</h1>
  <div id="sessions" class="empty">Загрузка...</div>
</main>
<script>
const token = ${JSON.stringify(token)};
async function loadSessions() {
  const response = await fetch('/api/sessions', { headers: { 'x-admin-token': token } });
  const sessions = await response.json();
  const root = document.querySelector('#sessions');
  if (!sessions.length) {
    root.innerHTML = '<p class="empty">Пока нет обращений.</p>';
    return;
  }
  root.innerHTML = sessions.map(session => \`
    <section class="session">
      <div class="top">
        <div class="phone">+\${session.phone}</div>
        <div class="badge">\${session.handoff ? 'нужен администратор' : 'автоответчик'}</div>
      </div>
      <div class="messages">
        \${(session.messages || []).slice(-8).map(message => \`
          <div class="message \${message.role === 'admin' ? 'admin' : ''}">
            <strong>\${message.role === 'admin' ? 'Администратор' : 'Клиент'}:</strong>
            \${escapeHtml(message.text)}
          </div>
        \`).join('')}
      </div>
      <textarea placeholder="Ответ клиенту"></textarea>
      <button onclick="reply('\${session.phone}', this)">Отправить</button>
    </section>
  \`).join('');
}
async function reply(to, button) {
  const textarea = button.previousElementSibling;
  const text = textarea.value.trim();
  if (!text) return;
  button.disabled = true;
  await fetch('/api/reply', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': token },
    body: JSON.stringify({ to, text })
  });
  textarea.value = '';
  button.disabled = false;
  await loadSessions();
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
}
loadSessions();
setInterval(loadSessions, 10000);
</script>
</body>
</html>`;
}

function includesAny(text, words) {
  return words.some((word) => text.includes(word));
}

async function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;

  const lines = (await readFile(filePath, "utf8")).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function normalizePhone(phone) {
  return String(phone).replace(/\D/g, "");
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function sendHtml(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}
