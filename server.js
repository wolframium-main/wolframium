// Wolframium: весь сайт в одном файле. Страница, чтение записей и запись по паролю.
// Записи хранятся в приватном Vercel Blob, пароль задаётся переменной WRITE_PASSWORD.
import { createServer } from "node:http";
// Хранение записей: один JSON-файл в приватном хранилище Vercel Blob.
import { get, put, BlobPreconditionFailedError, BlobNotFoundError } from "@vercel/blob";
import { createHash, timingSafeEqual } from "node:crypto";

const PATH = "notebook/entries.json";

// Первая запись. Показывается, пока в хранилище ещё ничего не сохранено.
const SEED = [
  { id: "e1", date: "2026-10-03", text: "Я и сам до конца не понимаю, зачем он мне нужен.", quote: true },
];

async function readEntries() {
  let res;
  try {
    res = await get(PATH, { access: "private", useCache: false });
  } catch (err) {
    if (err instanceof BlobNotFoundError) return { entries: SEED, etag: null };
    throw err;
  }
  if (!res || res.statusCode !== 200 || !res.stream) return { entries: SEED, etag: null };
  let entries;
  try {
    entries = JSON.parse(await new Response(res.stream).text());
  } catch {
    entries = [];
  }
  return { entries: Array.isArray(entries) ? entries : [], etag: res.blob.etag };
}

async function writeEntries(entries, etag) {
  const options = {
    access: "private",
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: "application/json",
    cacheControlMaxAge: 60,
  };
  if (etag) options.ifMatch = etag;
  await put(PATH, JSON.stringify(entries), options);
}

// Прочитать, изменить, записать. Если файл успели поменять из другого окна, пробуем ещё раз.
async function mutate(change) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { entries, etag } = await readEntries();
    const next = change(entries);
    try {
      await writeEntries(next, etag);
      return next;
    } catch (err) {
      if (!(err instanceof BlobPreconditionFailedError) || attempt === 2) throw err;
    }
  }
}

function passwordIsSet() {
  return Boolean(process.env.WRITE_PASSWORD);
}

// Пароль приходит в заголовке Authorization: Bearer <пароль, закодированный encodeURIComponent>.
async function authorized(request) {
  const expected = process.env.WRITE_PASSWORD;
  if (!expected) return false;
  const header = request.headers.get("authorization") || "";
  let given = "";
  try {
    given = header.startsWith("Bearer ") ? decodeURIComponent(header.slice(7)) : "";
  } catch {
    given = "";
  }
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  const ok = timingSafeEqual(a, b);
  if (!ok) await new Promise(r => setTimeout(r, 800)); // замедляем подбор пароля
  return ok;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}


const MAX_LENGTH = 20000;
const isDate = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// Все записи. Читать может любой гость.
async function entriesGET() {
  try {
    const { entries } = await readEntries();
    return json({ entries });
  } catch (err) {
    console.error(err);
    return json({ error: "Не удалось прочитать записи" }, 500);
  }
}

// Новая запись. Только с паролем.
async function entriesPOST(request) {
  if (!passwordIsSet()) return json({ error: "На Vercel не задан WRITE_PASSWORD" }, 500);
  if (!(await authorized(request))) return json({ error: "Пароль не подошёл" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Пустой запрос" }, 400);
  }
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return json({ error: "Запись пустая" }, 400);
  if (text.length > MAX_LENGTH) return json({ error: "Запись слишком длинная" }, 400);

  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    date: isDate(body.date) ? body.date : new Date().toISOString().slice(0, 10),
    text,
  };

  try {
    const entries = await mutate(list => [entry, ...list]);
    return json({ entries });
  } catch (err) {
    console.error(err);
    return json({ error: "Не удалось сохранить" }, 500);
  }
}

// Вычеркнуть запись. Только с паролем.
async function entriesDELETE(request) {
  if (!passwordIsSet()) return json({ error: "На Vercel не задан WRITE_PASSWORD" }, 500);
  if (!(await authorized(request))) return json({ error: "Пароль не подошёл" }, 401);

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return json({ error: "Не указано, что вычеркнуть" }, 400);

  try {
    const entries = await mutate(list => list.filter(e => e.id !== id));
    return json({ entries });
  } catch (err) {
    console.error(err);
    return json({ error: "Не удалось вычеркнуть" }, 500);
  }
}


async function authPOST(request) {
  if (!passwordIsSet()) return json({ error: "На Vercel не задан WRITE_PASSWORD" }, 500);
  if (!(await authorized(request))) return json({ error: "Пароль не подошёл" }, 401);
  return json({ ok: true });
}

const PAGE = "<!doctype html>\n<html lang=\"ru\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<title>Wolframium</title>\n<meta name=\"description\" content=\"Здесь то, что происходит в моей жизни, и то, что у меня на уме.\">\n<link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='4' fill='%23FBFCFD'/%3E%3Ctext x='16' y='24' font-family='cursive' font-size='22' font-weight='700' text-anchor='middle' fill='%232B3F8C'%3EW%3C/text%3E%3C/svg%3E\">\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n<link rel=\"stylesheet\" href=\"https://fonts.googleapis.com/css2?family=Caveat:wght@500;700&family=Literata:ital,opsz,wght@0,7..72,400;1,7..72,400&display=swap\">\n<style>\n/* Лист из тетради в клетку. Красные поля слева, даты на полях, записи справа. */\n:root {\n  --paper: #FBFCFD;\n  --grid: #DCE5F0;\n  --margin: #E07A7A;\n  --pen: #2B3F8C;\n  --text: #26304A;\n  --pencil: #7D869B;\n  --hand: \"Caveat\", \"Segoe Print\", cursive;\n  --serif: \"Literata\", \"PT Serif\", Georgia, serif;\n  color-scheme: light;\n}\n* { box-sizing: border-box; }\nhtml { background: var(--paper); }\nbody {\n  margin: 0;\n  background-color: var(--paper);\n  background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px);\n  background-size: 24px 24px;\n  color: var(--text);\n  font: 400 19px/1.65 var(--serif);\n  padding-inline: 16px;\n  padding-block: calc(72px + env(safe-area-inset-top, 0px)) calc(64px + env(safe-area-inset-bottom, 0px));\n  min-height: 100vh;\n  position: relative;\n}\n.margin-line { position: absolute; top: 0; bottom: 0; width: 1.5px; background: var(--margin); left: calc(max(16px, 50% - 380px) + 108px); }\n.sheet { max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; gap: 56px; position: relative; }\n.row { display: flex; flex-wrap: wrap; gap: 4px 24px; align-items: baseline; }\n.side { flex: 0 0 96px; font: 500 24px/1.2 var(--hand); color: var(--pen); font-variant-numeric: tabular-nums; }\n.side.faint { color: var(--pencil); font-size: 22px; }\n.main { flex: 999 1 320px; min-width: 0; display: flex; flex-direction: column; gap: 10px; }\nh1 { margin: 0; font: 700 72px/1 var(--hand); color: var(--pen); }\n.about { margin: 0; max-width: 34em; }\n\n.stream { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 48px; }\n.entry p { margin: 0; max-width: 34em; white-space: pre-line; overflow-wrap: anywhere; }\n.entry.quote p { font-size: 22px; font-style: italic; }\n.message { font: 500 22px/1.3 var(--hand); color: var(--pencil); }\n\n.composer textarea, .login input {\n  width: 100%; font: 400 19px/1.65 var(--serif); color: var(--text);\n  background: transparent; border: none; border-bottom: 1.5px dashed var(--pencil);\n  padding: 4px 0 8px; outline: none; border-radius: 0;\n}\n.composer textarea { min-height: 96px; resize: none; overflow: hidden; }\n.composer textarea::placeholder, .login input::placeholder { color: var(--pencil); font-style: italic; }\n.composer textarea:focus, .login input:focus { border-bottom-color: var(--pen); }\n.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 20px; }\n.pen-btn {\n  min-height: 44px; padding: 2px 14px; cursor: pointer;\n  font: 700 26px/1 var(--hand); color: var(--pen);\n  background: transparent; border: 1.5px solid var(--pen); border-radius: 6px;\n}\n.pen-btn:hover { background: var(--pen); color: var(--paper); }\n.pen-btn:disabled { opacity: .45; cursor: default; background: transparent; color: var(--pen); }\n.note { font: 500 20px/1.2 var(--hand); color: var(--pencil); }\n.link-btn { font: inherit; color: var(--pencil); background: none; border: none; padding: 6px 0; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }\n.link-btn:hover { color: var(--margin); }\n.tiny { align-self: flex-start; display: inline-flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; font: 500 19px/1 var(--hand); color: var(--pencil); }\n.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }\n\nfooter { display: flex; justify-content: flex-end; font: 500 19px/1 var(--hand); }\nfooter a { color: var(--pencil); text-decoration: none; padding: 8px 0; }\nfooter a:hover { color: var(--pen); }\n:focus-visible { outline: 2px solid var(--pen); outline-offset: 3px; }\n[hidden] { display: none !important; }\n\n@media (max-width: 640px) {\n  .margin-line { display: none; }\n  h1 { font-size: 60px; }\n  body { padding-block: calc(48px + env(safe-area-inset-top, 0px)) calc(56px + env(safe-area-inset-bottom, 0px)); }\n}\n</style>\n</head>\n<body>\n<div class=\"margin-line\" aria-hidden=\"true\"></div>\n<div class=\"sheet\">\n  <header class=\"row\">\n    <div class=\"side faint\">с 2026</div>\n    <div class=\"main\">\n      <h1>Wolframium</h1>\n      <p class=\"about\">Здесь то, что происходит в моей жизни, и то, что у меня на уме.</p>\n    </div>\n  </header>\n\n  <form class=\"row login\" id=\"login\" hidden>\n    <div class=\"side faint\">вход</div>\n    <div class=\"main\">\n      <label for=\"pw\" class=\"sr\">Пароль</label>\n      <input id=\"pw\" type=\"password\" autocomplete=\"current-password\" placeholder=\"Пароль\">\n      <div class=\"actions\">\n        <button class=\"pen-btn\" type=\"submit\">Открыть</button>\n        <span class=\"note\" id=\"login-status\" role=\"status\">Пароль запомнится на этом устройстве</span>\n      </div>\n    </div>\n  </form>\n\n  <div class=\"row composer\" id=\"composer\" hidden>\n    <div class=\"side faint\" id=\"today\"></div>\n    <div class=\"main\">\n      <label for=\"draft\" class=\"sr\">Новая запись</label>\n      <textarea id=\"draft\" placeholder=\"Что сейчас на уме?\"></textarea>\n      <div class=\"actions\">\n        <button class=\"pen-btn\" id=\"write\" type=\"button\" disabled>Записать</button>\n        <span class=\"note\" id=\"status\" role=\"status\">Это поле видите только вы</span>\n        <button class=\"link-btn note\" id=\"logout\" type=\"button\">выйти</button>\n      </div>\n    </div>\n  </div>\n\n  <ol class=\"stream\" id=\"stream\" aria-live=\"polite\"></ol>\n\n  <footer><a href=\"#write\" id=\"write-link\">написать</a></footer>\n</div>\n\n<script>\n(function () {\n  const $ = id => document.getElementById(id);\n  const MONTHS = [\"янв.\",\"февр.\",\"марта\",\"апр.\",\"мая\",\"июня\",\"июля\",\"авг.\",\"сент.\",\"окт.\",\"нояб.\",\"дек.\"];\n  const sideDate = iso => { const [y, m, d] = iso.split(\"-\").map(Number); return `${d} ${MONTHS[m - 1]}<br>${y}`; };\n  const todayISO = () => { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, \"0\")}-${String(t.getDate()).padStart(2, \"0\")}`; };\n\n  const store = {\n    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },\n    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },\n    del(k) { try { localStorage.removeItem(k); } catch (e) {} },\n  };\n\n  let entries = [];\n  let password = store.get(\"wolframium-pw\");\n  let writing = false;\n\n  function render() {\n    const list = $(\"stream\");\n    list.textContent = \"\";\n    entries.slice().sort((a, b) => b.date.localeCompare(a.date)).forEach(e => {\n      const li = document.createElement(\"li\");\n      li.className = \"row entry\" + (e.quote ? \" quote\" : \"\");\n      const side = document.createElement(\"div\");\n      side.className = \"side\";\n      side.innerHTML = sideDate(e.date);\n      const main = document.createElement(\"div\");\n      main.className = \"main\";\n      String(e.text).split(/\\n\\s*\\n/).forEach(par => {\n        const p = document.createElement(\"p\");\n        p.textContent = par;\n        main.appendChild(p);\n      });\n      if (writing) main.appendChild(removeControl(e));\n      li.append(side, main);\n      list.appendChild(li);\n    });\n  }\n\n  function showMessage(text) {\n    const list = $(\"stream\");\n    list.textContent = \"\";\n    const li = document.createElement(\"li\");\n    li.className = \"row\";\n    li.innerHTML = '<div class=\"side\"></div>';\n    const msg = document.createElement(\"div\");\n    msg.className = \"main message\";\n    msg.textContent = text;\n    li.appendChild(msg);\n    list.appendChild(li);\n  }\n\n  async function api(method, url, body) {\n    const headers = { \"content-type\": \"application/json\" };\n    if (password) headers.authorization = \"Bearer \" + encodeURIComponent(password);\n    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });\n    let data = {};\n    try { data = await res.json(); } catch (e) {}\n    if (!res.ok) { const err = new Error(data.error || \"Ошибка\"); err.status = res.status; throw err; }\n    return data;\n  }\n\n  async function load() {\n    try {\n      const data = await api(\"GET\", \"/api/entries\");\n      entries = data.entries || [];\n      if (entries.length) render(); else showMessage(\"Пока ни одной записи.\");\n    } catch (e) {\n      showMessage(\"Записи не загрузились. Обновите страницу.\");\n    }\n  }\n\n  // ---- режим хозяина ----\n  function removeControl(e) {\n    const box = document.createElement(\"div\");\n    box.className = \"tiny\";\n    const ask = document.createElement(\"button\");\n    ask.type = \"button\"; ask.className = \"link-btn\"; ask.textContent = \"вычеркнуть\";\n    ask.onclick = () => {\n      box.textContent = \"Точно вычеркнуть?\";\n      const yes = document.createElement(\"button\");\n      yes.type = \"button\"; yes.className = \"link-btn\"; yes.textContent = \"да\";\n      yes.onclick = async () => {\n        box.textContent = \"вычёркиваю…\";\n        try {\n          const data = await api(\"DELETE\", \"/api/entries?id=\" + encodeURIComponent(e.id));\n          entries = data.entries || [];\n          render();\n        } catch (err) {\n          if (err.status === 401) return forget(\"Пароль больше не подходит. Войдите снова.\");\n          box.textContent = \"Не получилось. Попробуйте ещё раз.\";\n        }\n      };\n      const no = document.createElement(\"button\");\n      no.type = \"button\"; no.className = \"link-btn\"; no.textContent = \"нет\";\n      no.onclick = () => box.replaceWith(removeControl(e));\n      box.append(yes, no);\n    };\n    box.appendChild(ask);\n    return box;\n  }\n\n  function grow() { const t = $(\"draft\"); t.style.height = \"auto\"; t.style.height = t.scrollHeight + \"px\"; }\n\n  function openComposer() {\n    writing = true;\n    $(\"login\").hidden = true;\n    $(\"write-link\").hidden = true;\n    $(\"composer\").hidden = false;\n    $(\"today\").innerHTML = sideDate(todayISO());\n    const saved = store.get(\"wolframium-draft\");\n    if (saved && !$(\"draft\").value) $(\"draft\").value = saved;\n    $(\"write\").disabled = !$(\"draft\").value.trim();\n    grow();\n    render();\n  }\n\n  function openLogin(note) {\n    $(\"composer\").hidden = true;\n    $(\"login\").hidden = false;\n    $(\"login-status\").textContent = note || \"Пароль запомнится на этом устройстве\";\n    $(\"pw\").focus();\n  }\n\n  function forget(note) {\n    password = null;\n    writing = false;\n    store.del(\"wolframium-pw\");\n    $(\"write-link\").hidden = false;\n    render();\n    openLogin(note);\n  }\n\n  $(\"login\").addEventListener(\"submit\", async ev => {\n    ev.preventDefault();\n    const value = $(\"pw\").value;\n    if (!value) return;\n    $(\"login-status\").textContent = \"Проверяю…\";\n    password = value;\n    try {\n      await api(\"POST\", \"/api/auth\");\n      store.set(\"wolframium-pw\", value);\n      $(\"pw\").value = \"\";\n      openComposer();\n    } catch (err) {\n      password = null;\n      $(\"login-status\").textContent = err.status === 401 ? \"Пароль не подошёл\" : (err.message || \"Не получилось войти\");\n    }\n  });\n\n  $(\"draft\").addEventListener(\"input\", () => {\n    $(\"write\").disabled = !$(\"draft\").value.trim();\n    store.set(\"wolframium-draft\", $(\"draft\").value);\n    grow();\n  });\n\n  $(\"write\").addEventListener(\"click\", async () => {\n    const text = $(\"draft\").value.trim();\n    if (!text) return;\n    $(\"write\").disabled = true;\n    $(\"status\").textContent = \"Записываю…\";\n    try {\n      const data = await api(\"POST\", \"/api/entries\", { text, date: todayISO() });\n      entries = data.entries || [];\n      $(\"draft\").value = \"\";\n      store.del(\"wolframium-draft\");\n      grow();\n      $(\"status\").textContent = \"Записано\";\n      render();\n    } catch (err) {\n      if (err.status === 401) return forget(\"Пароль больше не подходит. Войдите снова.\");\n      $(\"status\").textContent = \"Не получилось сохранить. Текст на месте, попробуйте ещё раз.\";\n      $(\"write\").disabled = false;\n    }\n  });\n\n  $(\"logout\").addEventListener(\"click\", () => {\n    password = null;\n    writing = false;\n    store.del(\"wolframium-pw\");\n    $(\"composer\").hidden = true;\n    $(\"write-link\").hidden = false;\n    render();\n  });\n\n  $(\"write-link\").addEventListener(\"click\", ev => {\n    ev.preventDefault();\n    password ? openComposer() : openLogin();\n  });\n\n  load().then(() => {\n    if (password) openComposer();\n    else if (location.hash === \"#write\") openLogin();\n  });\n})();\n</script>\n</body>\n</html>\n";

async function route(request) {
  const url = new URL(request.url);
  const m = request.method;
  if (url.pathname === "/api/entries") {
    if (m === "GET") return entriesGET();
    if (m === "POST") return entriesPOST(request);
    if (m === "DELETE") return entriesDELETE(request);
    return json({ error: "Метод не поддерживается" }, 405);
  }
  if (url.pathname === "/api/auth" && m === "POST") return authPOST(request);
  if ((m === "GET" || m === "HEAD") && (url.pathname === "/" || url.pathname === "/index.html")) {
    return new Response(m === "HEAD" ? null : PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  }
  return new Response("Не найдено", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request("http://" + (req.headers.host || "localhost") + req.url, {
      method: req.method,
      headers: req.headers,
      body: body && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
    });
    const response = await route(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Ошибка сервера");
  }
});

server.listen(Number(process.env.PORT ?? 3000));
