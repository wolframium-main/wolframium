// Wolframium: весь сайт в одном файле. Страница, чтение записей, запись и правка по паролю.
// Внешний вид — по дизайн-системе Wolframium. Формат хранения и API прежние, поэтому все записи на месте.
// Записи лежат в приватном Vercel Blob: каждая — отдельный файл entries/<id>.json. Пароль — переменная WRITE_PASSWORD.
// Для запуска на своём компьютере без Blob: LOCAL_STORE=./data WRITE_PASSWORD=... node server.js
import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

const DIR = "entries/";
const LEGACY = "notebook/entries.json"; // старый формат: все записи в одном файле

// ---------- Хранилище ----------
// Два варианта с одинаковым интерфейсом: Vercel Blob (на сайте) и папка на диске (для разработки).

function blobStore(blob) {
  const { get, put, del, list, BlobNotFoundError } = blob;
  async function readJSON(pathname, useCache) {
    try {
      const res = await get(pathname, { access: "private", useCache });
      if (!res || res.statusCode !== 200 || !res.stream) return null;
      return JSON.parse(await new Response(res.stream).text());
    } catch (err) {
      if (err instanceof BlobNotFoundError) return null;
      throw err;
    }
  }
  async function listAll() {
    const blobs = [];
    let cursor;
    do {
      const page = await list({ cursor, limit: 1000 });
      blobs.push(...page.blobs);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return blobs;
  }
  async function save(entry) {
    await put(DIR + entry.id + ".json", JSON.stringify(entry), {
      access: "private",
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: "application/json",
    });
  }
  // Переносим записи из старого общего файла в отдельные файлы, порядок сохраняется.
  async function migrateLegacy() {
    const legacy = await readJSON(LEGACY, false);
    if (Array.isArray(legacy)) {
      const base = Date.now() - 60000;
      await Promise.all(legacy.map((e, i) => save({ ...e, created: e.created ?? base - i })));
    }
    await del(LEGACY);
  }
  return {
    async all() {
      let blobs = await listAll();
      if (blobs.some(b => b.pathname === LEGACY)) {
        await migrateLegacy();
        blobs = await listAll();
      }
      const files = blobs.filter(b => b.pathname.startsWith(DIR) && b.pathname.endsWith(".json"));
      return Promise.all(files.map(b => readJSON(b.pathname, true)));
    },
    one: id => readJSON(DIR + id + ".json", false),
    save,
    remove: id => del(DIR + id + ".json"),
  };
}

function diskStore(root) {
  const path = id => join(root, id + ".json");
  return {
    async all() {
      await mkdir(root, { recursive: true });
      const names = (await readdir(root)).filter(n => n.endsWith(".json"));
      return Promise.all(names.map(async n => JSON.parse(await readFile(join(root, n), "utf8"))));
    },
    async one(id) {
      try { return JSON.parse(await readFile(path(id), "utf8")); } catch { return null; }
    },
    async save(entry) {
      await mkdir(root, { recursive: true });
      await writeFile(path(entry.id), JSON.stringify(entry));
    },
    remove: id => rm(path(id), { force: true }),
  };
}

const storage = process.env.LOCAL_STORE
  ? diskStore(process.env.LOCAL_STORE)
  : blobStore(await import("@vercel/blob"));

const byNewest = (a, b) => b.date.localeCompare(a.date) || (b.created || 0) - (a.created || 0);

async function readEntries() {
  const entries = (await storage.all()).filter(e => e && e.id && e.text);
  return entries.sort(byNewest);
}

// После записи список читается из кэша и может отставать на одну запись: подставляем свежую.
async function withFresh(entry) {
  const entries = (await readEntries()).filter(e => e.id !== entry.id);
  entries.push(entry);
  return entries.sort(byNewest);
}

// ---------- Доступ ----------
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

const detail = err => String((err && err.message) || err).slice(0, 200);
const MAX_LENGTH = 20000;
const isDate = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isId = s => /^[a-z0-9]{1,40}$/i.test(s);

async function guard(request) {
  if (!passwordIsSet()) return json({ error: "На Vercel не задан WRITE_PASSWORD" }, 500);
  if (!(await authorized(request))) return json({ error: "Пароль не подошёл" }, 401);
  return null;
}

async function readText(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return { error: json({ error: "Пустой запрос" }, 400) };
  }
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return { error: json({ error: "Запись пустая" }, 400) };
  if (text.length > MAX_LENGTH) return { error: json({ error: "Запись слишком длинная" }, 400) };
  return { body, text };
}

// ---------- API ----------

// Все записи. Читать может любой, у кого есть ссылка.
async function entriesGET() {
  try {
    return json({ entries: await readEntries() });
  } catch (err) {
    console.error(err);
    return json({ error: "Не удалось прочитать записи", detail: detail(err) }, 500);
  }
}

// Новая запись. Только с паролем.
async function entriesPOST(request) {
  const denied = await guard(request);
  if (denied) return denied;
  const { error, body, text } = await readText(request);
  if (error) return error;
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    date: isDate(body.date) ? body.date : new Date().toISOString().slice(0, 10),
    text,
    created: Date.now(),
  };
  try {
    await storage.save(entry);
    return json({ entries: await withFresh(entry) });
  } catch (err) {
    console.error(err);
    return json({ error: "Не удалось сохранить", detail: detail(err) }, 500);
  }
}

// Исправить запись. Только с паролем. Дата и время создания не меняются.
async function entriesPUT(request) {
  const denied = await guard(request);
  if (denied) return denied;
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!isId(id)) return json({ error: "Не указано, что исправить" }, 400);
  const { error, text } = await readText(request);
  if (error) return error;
  try {
    const old = await storage.one(id);
    if (!old) return json({ error: "Такой записи нет" }, 404);
    const entry = { ...old, text, edited: Date.now() };
    await storage.save(entry);
    return json({ entries: await withFresh(entry) });
  } catch (err) {
    console.error(err);
    return json({ error: "Не удалось сохранить", detail: detail(err) }, 500);
  }
}

// Вычеркнуть запись. Только с паролем.
async function entriesDELETE(request) {
  const denied = await guard(request);
  if (denied) return denied;
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!isId(id)) return json({ error: "Не указано, что вычеркнуть" }, 400);
  try {
    await storage.remove(id);
    return json({ entries: (await readEntries()).filter(e => e.id !== id) });
  } catch (err) {
    console.error(err);
    return json({ error: "Не удалось вычеркнуть", detail: detail(err) }, 500);
  }
}

async function authPOST(request) {
  const denied = await guard(request);
  return denied || json({ ok: true });
}

// ---------- Страницы ----------
const PAGE = "<!doctype html>\n<html lang=\"ru\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<title>Wolframium</title>\n<meta name=\"description\" content=\"Здесь то, что происходит в моей жизни, и то, что у меня на уме.\">\n<meta name=\"robots\" content=\"noindex, nofollow\">\n<meta name=\"theme-color\" content=\"#100d18\">\n<meta name=\"color-scheme\" content=\"dark\">\n<meta property=\"og:title\" content=\"Wolframium\">\n<meta property=\"og:description\" content=\"Здесь то, что происходит в моей жизни, и то, что у меня на уме.\">\n<link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\" width=\"32\" height=\"32\"%3E%3Ctitle%3EWolframium%3C/title%3E%3Crect width=\"32\" height=\"32\" rx=\"1\" fill=\"%233b2475\"/%3E%3Cpath fill=\"%23eeecf3\" d=\"M9.14 24.38 5.25 7.62H8.42L10.07 15.66L11.1 20.8H11.18L12.38 15.66L14.3 7.62H17.8L19.72 15.66L20.9 20.8H20.97L22.02 15.66L23.73 7.62H26.75L22.74 24.38H19.17L17.03 15.52L16 11.1H15.95L14.87 15.52L12.74 24.38Z\"/%3E%3C/svg%3E\">\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n<link rel=\"stylesheet\" href=\"https://fonts.googleapis.com/css2?family=IBM+Plex+Mono&family=IBM+Plex+Sans:wght@400;600&display=swap\">\n<style>\n/* Wolframium. Все значения — токены дизайн-системы Wolframium (tokens.json). Основная тема — «Ночь». */\n:root {\n  --bg: #100d18; --surface: #171325; --surface-raised: #1f1a31;\n  --line: #2c2645; --line-strong: #6e6b82;\n  --ink: #e9e7ef; --ink-2: #b3b0c0; --ink-3: #8f8c9f;\n  --violet: #3b2475; --violet-hover: #462b88; --on-violet: #eeecf3;\n  --amber: #f2a93b; --amber-hover: #f5b95e; --on-amber: #2a1a04; --amber-ink: #f2a93b;\n  --focus: var(--amber); --success: #5fc9a8; --danger: #f47c86;\n  --space-dense: 4px; --space-1: 8px; --space-2: 16px; --space-3: 24px; --space-4: 32px; --space-6: 48px; --space-8: 64px; --space-12: 96px;\n  --radius: 2px; --stroke: 1px; --focus-width: 2px; --focus-offset: 2px;\n  --font-sans: \"IBM Plex Sans\", system-ui, sans-serif; --font-mono: \"IBM Plex Mono\", ui-monospace, monospace;\n  --ease: cubic-bezier(0.215, 0.61, 0.355, 1); --dur: 120ms;\n  color-scheme: dark;\n}\n/* «Бумага» — для печати. */\n@media print {\n  :root {\n    --bg: #f4f3f8; --surface: #fbfafd; --surface-raised: #ffffff;\n    --line: #dcd8e6; --line-strong: #8b889c;\n    --ink: #16121f; --ink-2: #4a4757; --ink-3: #67647a;\n    --amber-ink: #8a5200; --focus: var(--amber-ink); --success: #17735a; --danger: #b3263a;\n    color-scheme: light;\n  }\n}\n\n* { box-sizing: border-box; }\nhtml { background: var(--bg); -webkit-text-size-adjust: 100%; }\nbody {\n  margin: 0; background: var(--bg); color: var(--ink);\n  font: 400 15px/24px var(--font-sans);\n  font-kerning: normal; -webkit-font-smoothing: antialiased;\n}\n\n/* Шрифтовые стили: точно по шкале ×1.5 */\n.display { font: 600 76px/80px var(--font-sans); letter-spacing: -0.02em; }\n.title { font: 600 50px/56px var(--font-sans); letter-spacing: -0.015em; }\n.subheading { font: 600 22px/32px var(--font-sans); }\n.body-strong { font: 600 15px/24px var(--font-sans); }\n.meta { font: 400 12px/16px var(--font-mono); color: var(--ink-3); }\nh1, h2, p, ol { margin: 0; }\n\n/* Сетка: колонка даты 176px + колонка текста до 640px (68 знаков) */\n.page {\n  max-width: calc(960px + 2 * var(--space-3)); margin: 0 auto;\n  padding: calc(var(--space-12) + env(safe-area-inset-top, 0px)) var(--space-3) calc(var(--space-8) + env(safe-area-inset-bottom, 0px));\n}\n.row { display: grid; grid-template-columns: 176px minmax(0, 640px); column-gap: var(--space-6); }\n.row > .main { grid-column: 2; }\n\n/* Шапка: display — один раз на экран */\n.masthead { padding-bottom: var(--space-8); }\n.masthead .main { display: flex; flex-direction: column; gap: var(--space-2); }\n.masthead h1 { color: var(--ink); }\n.lede { color: var(--ink-2); max-width: 34em; }\n\n/* Нажимаемое: подпись body-strong, отступы space-1 / space-2, высота 40px, radius */\n.btn {\n  display: inline-flex; align-items: center; justify-content: center;\n  min-height: 40px; padding: var(--space-1) var(--space-2);\n  font: 600 15px/24px var(--font-sans); border-radius: var(--radius);\n  border: var(--stroke) solid var(--line-strong); background: transparent; color: var(--ink);\n  cursor: pointer; white-space: nowrap;\n  transition: background-color var(--dur) var(--ease), color var(--dur) var(--ease), transform var(--dur) var(--ease);\n}\n.btn:hover { background: var(--surface-raised); }\n.btn:active { transform: translateY(1px); }\n.btn.is-primary { background: var(--amber); color: var(--on-amber); border-color: var(--amber); }\n.btn.is-primary:hover { background: var(--amber-hover); border-color: var(--amber-hover); }\n.btn.is-second { background: var(--violet); color: var(--on-violet); border-color: var(--violet); }\n.btn.is-second:hover { background: var(--violet-hover); border-color: var(--violet-hover); }\n\n/* Действие в строке: тихий текст с подчёркиванием line-strong */\n.act {\n  font: inherit; color: var(--ink-3);\n  background: none; border: 0; padding: var(--space-1) 0; cursor: pointer;\n  text-decoration: underline; text-decoration-color: var(--line-strong); text-decoration-thickness: 1px; text-underline-offset: 3px;\n  transition: color var(--dur) var(--ease), text-decoration-color var(--dur) var(--ease);\n}\n.act:hover { color: var(--ink); text-decoration-color: var(--amber-ink); }\n.act.is-danger { color: var(--danger); text-decoration-color: var(--danger); }\n\n:focus-visible { outline: var(--focus-width) solid var(--focus); outline-offset: var(--focus-offset); }\n[hidden] { display: none !important; }\n::selection { background: var(--violet); color: var(--on-violet); }\n.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }\n\n/* Поле ввода: на bg — фон surface, рамка line-strong */\n.field-label { display: block; margin-bottom: var(--space-1); }\n.input, .textarea {\n  width: 100%; min-height: 40px; padding: var(--space-1) var(--space-2);\n  font: 400 15px/24px var(--font-sans); color: var(--ink);\n  background: var(--surface); border: var(--stroke) solid var(--line-strong); border-radius: var(--radius);\n  transition: border-color var(--dur) var(--ease);\n}\n.input::placeholder, .textarea::placeholder { color: var(--ink-3); opacity: 1; }\n.input:focus-visible, .textarea:focus-visible { outline: var(--focus-width) solid var(--focus); outline-offset: var(--focus-offset); }\n.textarea { display: block; min-height: 96px; resize: none; overflow: hidden; }\n.inline { display: flex; gap: var(--space-1); }\n.inline .input { flex: 1; min-width: 0; }\n\n/* Вход */\n.login { padding-bottom: var(--space-8); }\n.note { margin-top: var(--space-1); color: var(--ink-3); }\n.is-error { color: var(--danger); }\n.is-ok { color: var(--success); }\n\n/* Поток записей: день = строка сетки, между днями — линия */\n.day { border-top: var(--stroke) solid var(--line); padding: var(--space-4) 0 var(--space-6); }\n.day-date { display: flex; flex-direction: column; gap: var(--space-dense); padding-top: var(--space-dense); }\n.day-date .wd { color: var(--ink-3); }\n.day.is-today .day-date .wd { color: var(--ink-2); }\n.entries { display: flex; flex-direction: column; gap: var(--space-4); }\n.entry-text { display: flex; flex-direction: column; gap: var(--space-2); overflow-wrap: anywhere; }\n.entry-text p { white-space: pre-line; }\n.entry-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 0 var(--space-3); margin-top: var(--space-1); min-height: 32px; }\n.entry-foot .actions { display: inline-flex; flex-wrap: wrap; gap: 0 var(--space-2); align-items: center; }\n.entry.is-editing .entry-text { display: none; }\n.notice { color: var(--ink-3); padding: var(--space-4) 0; }\n\n/* Редактор */\n.editor-bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-2); margin-top: var(--space-2); }\n.kbd { color: var(--ink-3); }\n.composer:not(:last-child) { padding-bottom: var(--space-4); border-bottom: var(--stroke) solid var(--line); }\n/* Ошибка — обычным текстом цветом danger, а не меткой */\n.status.is-error { font: 400 15px/24px var(--font-sans); }\n\n/* Избранет */\n.rules { border-top: var(--stroke) solid var(--line); padding-top: var(--space-4); margin-top: var(--space-2); }\n.rules .main { display: flex; flex-direction: column; gap: var(--space-2); }\n.rules p { color: var(--ink-2); max-width: 34em; }\n.rules ol { list-style: none; padding: 0; display: flex; flex-direction: column; border-top: var(--stroke) solid var(--line); margin-top: var(--space-1); }\n.rules li { display: grid; grid-template-columns: 48px 1fr; align-items: baseline; padding: var(--space-2) 0; border-bottom: var(--stroke) solid var(--line); }\n\n/* Подвал */\n.foot { margin-top: var(--space-8); }\n.foot .main { display: flex; justify-content: space-between; align-items: center; }\n\n/* Узкий экран: колонка даты уходит над текстом, display спускается на ступень — до title */\n@media (max-width: 760px) {\n  .page { padding-top: calc(var(--space-8) + env(safe-area-inset-top, 0px)); }\n  .row { grid-template-columns: minmax(0, 1fr); }\n  .row > .main { grid-column: 1; }\n  .masthead h1 { font: 600 50px/56px var(--font-sans); letter-spacing: -0.015em; }\n  .day-date { flex-direction: row; gap: var(--space-1); padding: 0 0 var(--space-2); }\n  .day-date .wd::before { content: \"· \"; }\n}\n\n/* На телефоне нет клавиатуры с Ctrl — подсказку не показываем */\n@media (hover: none) { .kbd { display: none; } }\n@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }\n@media print {\n  .login, .composer, .foot .act, .entry-foot .actions { display: none !important; }\n  .page { padding: var(--space-6) 0 0; }\n}\n</style>\n</head>\n<body>\n<main class=\"page\">\n  <header class=\"row masthead\">\n    <div class=\"main\">\n      <h1 class=\"display\">Wolframium</h1>\n      <p class=\"lede\">Здесь то, что происходит в&nbsp;моей жизни, и&nbsp;то, что у&nbsp;меня на&nbsp;уме.</p>\n      <p class=\"meta\" id=\"meta\" aria-live=\"polite\"></p>\n    </div>\n  </header>\n\n  <form class=\"row login\" id=\"login\" hidden novalidate>\n    <div class=\"main\">\n      <label for=\"pw\" class=\"field-label body-strong\">Пароль</label>\n      <div class=\"inline\">\n        <input class=\"input\" id=\"pw\" type=\"password\" autocomplete=\"current-password\" placeholder=\"••••••••\" enterkeyhint=\"go\">\n        <button class=\"btn is-primary\" type=\"submit\">Войти</button>\n      </div>\n      <p class=\"note\" id=\"login-note\" role=\"status\">Пароль запомнится на этом устройстве.</p>\n    </div>\n  </form>\n\n  <section id=\"stream\" aria-label=\"Записи\"></section>\n\n  <section class=\"row rules\" aria-labelledby=\"rules-title\">\n    <div class=\"main\">\n      <h2 id=\"rules-title\" class=\"subheading\">Избранет</h2>\n      <p>Сеть личных сайтов, куда попадают только по&nbsp;ссылке. Этот сайт&nbsp;— первый из&nbsp;них. Правила:</p>\n      <ol>\n        <li><span class=\"meta\">01</span><span>Пиши о&nbsp;себе.</span></li>\n        <li><span class=\"meta\">02</span><span>Пиши часто и&nbsp;с&nbsp;минимальным фильтром.</span></li>\n        <li><span class=\"meta\">03</span><span>Не&nbsp;скрывай изъяны.</span></li>\n        <li><span class=\"meta\">04</span><span>Не&nbsp;стирай записи.</span></li>\n        <li><span class=\"meta\">05</span><span>Ссылку получают только избранные.</span></li>\n      </ol>\n    </div>\n  </section>\n\n  <footer class=\"row foot\">\n    <div class=\"main meta\">\n      <span>С 2026</span>\n      <button class=\"act\" id=\"auth-toggle\" type=\"button\">Войти</button>\n    </div>\n  </footer>\n</main>\n\n<script>\n(function () {\n  \"use strict\";\n  const NB = \" \";\n  const $ = id => document.getElementById(id);\n  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };\n  const button = (cls, text, onClick) => { const b = el(\"button\", cls, text); b.type = \"button\"; if (onClick) b.onclick = onClick; return b; };\n\n  // ---------- Даты: 09.10.2026 · ПЯТНИЦА ----------\n  const MONTHS = [\"января\",\"февраля\",\"марта\",\"апреля\",\"мая\",\"июня\",\"июля\",\"августа\",\"сентября\",\"октября\",\"ноября\",\"декабря\"];\n  const WEEKDAYS = [\"Воскресенье\",\"Понедельник\",\"Вторник\",\"Среда\",\"Четверг\",\"Пятница\",\"Суббота\"];\n  const pad = n => String(n).padStart(2, \"0\");\n  const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;\n  const todayISO = () => isoOf(new Date());\n  const yesterdayISO = () => { const d = new Date(); d.setDate(d.getDate() - 1); return isoOf(d); };\n  const parseISO = iso => { const [y, m, d] = iso.split(\"-\").map(Number); return new Date(y, m - 1, d); };\n  const dotted = iso => { const [y, m, d] = iso.split(\"-\"); return `${d}.${m}.${y}`; };\n  const timeOf = e => { if (!e.created) return \"\"; const d = new Date(e.created); return isNaN(d) ? \"\" : `${pad(d.getHours())}:${pad(d.getMinutes())}`; };\n\n  function plural(n, one, few, many) {\n    const a = n % 10, b = n % 100;\n    if (a === 1 && b !== 11) return one;\n    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;\n    return many;\n  }\n\n  // ---------- Типографика: ёлочки, тире, многоточие, неразрывные пробелы ----------\n  function typo(s) {\n    return String(s)\n      .replace(/(^|[\\s(«])\"(?=\\S)/g, \"$1«\")\n      .replace(/(\\S)\"(?=$|[\\s.,!?;:)…])/g, \"$1»\")\n      .replace(/\\.\\.\\./g, \"…\")\n      .replace(/(\\S) [-–] (?=\\S)/g, \"$1\" + NB + \"— \")\n      .replace(/(\\S) — /g, \"$1\" + NB + \"— \")\n      .replace(/(^|[\\s(«])([А-ЯЁа-яёA-Za-z]{1,2}|не|ни|но|на|по|за|из|от|до|для|без|под|над|при|про|что|как|это|все|всё)[ \\t]+/g, (m, pre, w) => pre + w + NB)\n      .replace(/(\\d)[ \\t]+(?=[^\\s\\d])/g, \"$1\" + NB);\n  }\n\n  // ---------- Хранилище устройства ----------\n  const store = {\n    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },\n    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },\n    del(k) { try { localStorage.removeItem(k); } catch (e) {} },\n  };\n  const KEY_PW = \"wolframium-pw\", KEY_DRAFT = \"wolframium-draft\";\n\n  let entries = [];\n  let loaded = false;\n  let password = store.get(KEY_PW);\n  let owner = false;\n  let editingId = null;\n\n  async function api(method, url, body) {\n    const headers = { \"content-type\": \"application/json\" };\n    if (password) headers.authorization = \"Bearer \" + encodeURIComponent(password);\n    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });\n    let data = {};\n    try { data = await res.json(); } catch (e) {}\n    if (!res.ok) { const err = new Error(data.error || \"Ошибка\"); err.status = res.status; err.detail = data.detail || \"\"; throw err; }\n    return data;\n  }\n\n  // ---------- Отрисовка ----------\n  function groupByDay(list) {\n    const sorted = list.slice().sort((a, b) => b.date.localeCompare(a.date) || (b.created || 0) - (a.created || 0));\n    const days = [];\n    for (const e of sorted) {\n      const last = days[days.length - 1];\n      if (last && last.date === e.date) last.items.push(e);\n      else days.push({ date: e.date, items: [e] });\n    }\n    return days;\n  }\n\n  function renderMeta() {\n    const meta = $(\"meta\");\n    if (!loaded) { meta.textContent = \"Загружаю записи…\"; return; }\n    if (!entries.length) { meta.textContent = \"\"; return; }\n    const n = entries.length;\n    const first = entries.reduce((a, e) => (e.date < a ? e.date : a), entries[0].date);\n    meta.textContent = `${n} ${plural(n, \"запись\", \"записи\", \"записей\")} · с ${dotted(first)}`;\n  }\n\n  function dateBlock(iso) {\n    const d = parseISO(iso);\n    const box = el(\"time\", \"day-date meta\");\n    box.dateTime = iso;\n    const wd = iso === todayISO() ? \"Сегодня\" : iso === yesterdayISO() ? \"Вчера\" : WEEKDAYS[d.getDay()];\n    box.appendChild(el(\"span\", \"num\", dotted(iso)));\n    box.appendChild(el(\"span\", \"wd\", wd));\n    box.setAttribute(\"aria-label\", `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${wd.toLowerCase()}`);\n    return box;\n  }\n\n  function render() {\n    renderMeta();\n    const stream = $(\"stream\");\n    stream.textContent = \"\";\n    if (!loaded) return;\n\n    const days = groupByDay(entries);\n    const today = todayISO();\n    if (owner && !days.some(d => d.date === today)) {\n      const at = days.findIndex(d => d.date < today);\n      days.splice(at === -1 ? days.length : at, 0, { date: today, items: [] });\n    }\n\n    if (!days.length) {\n      const row = el(\"div\", \"row\");\n      row.appendChild(el(\"p\", \"main notice\", \"Записей пока нет.\"));\n      stream.appendChild(row);\n      return;\n    }\n\n    days.forEach(day => {\n      const art = el(\"article\", \"row day\" + (day.date === today ? \" is-today\" : \"\"));\n      art.appendChild(dateBlock(day.date));\n      const list = el(\"div\", \"main entries\");\n      if (owner && day.date === today) list.appendChild(composer(!day.items.length));\n      day.items.forEach(e => list.appendChild(entryNode(e)));\n      art.appendChild(list);\n      stream.appendChild(art);\n    });\n  }\n\n  function paragraphs(text) {\n    const box = el(\"div\", \"entry-text\");\n    String(text).split(/\\n\\s*\\n/).forEach(par => box.appendChild(el(\"p\", null, typo(par.trim()))));\n    return box;\n  }\n\n  function entryNode(e) {\n    const node = el(\"div\", \"entry\");\n    node.dataset.id = e.id;\n    if (owner && editingId === e.id) {\n      node.classList.add(\"is-editing\");\n      node.appendChild(editor({\n        value: e.text,\n        placeholder: \"\",\n        primary: \"Сохранить\",\n        onSubmit: async text => {\n          const data = await api(\"PUT\", \"/api/entries?id=\" + encodeURIComponent(e.id), { text });\n          entries = data.entries || entries;\n          editingId = null;\n          render();\n          const back = document.querySelector(`.entry[data-id=\"${CSS.escape(e.id)}\"] .act`);\n          if (back) back.focus();\n        },\n        onCancel: () => { editingId = null; render(); },\n      }));\n      return node;\n    }\n    node.appendChild(paragraphs(e.text));\n\n    const foot = el(\"div\", \"entry-foot meta\");\n    const t = timeOf(e);\n    if (t) foot.appendChild(el(\"span\", \"time\", e.edited ? t + \" · исправлено\" : t));\n    if (owner) {\n      const actions = el(\"span\", \"actions\");\n      actions.appendChild(button(\"act\", \"Исправить\", () => { editingId = e.id; render(); }));\n      actions.appendChild(strikeControl(e));\n      foot.appendChild(actions);\n    }\n    node.appendChild(foot);\n    return node;\n  }\n\n  function strikeControl(e) {\n    const wrap = el(\"span\", \"actions\");\n    wrap.appendChild(button(\"act\", \"Вычеркнуть\", () => {\n      wrap.textContent = \"\";\n      const no = button(\"act\", \"Отмена\", () => wrap.replaceWith(strikeControl(e)));\n      const yes = button(\"act is-danger\", \"Да, вычеркнуть\", async () => {\n        wrap.textContent = \"Вычёркиваю…\";\n        try {\n          const data = await api(\"DELETE\", \"/api/entries?id=\" + encodeURIComponent(e.id));\n          entries = data.entries || [];\n          render();\n        } catch (err) {\n          if (err.status === 401) return signOut(\"Пароль изменился. Войди снова.\");\n          wrap.textContent = \"\";\n          wrap.appendChild(el(\"span\", \"is-error\", \"Не вычеркнулось. Попробуй ещё раз.\"));\n        }\n      });\n      wrap.append(el(\"span\", null, \"Точно?\"), yes, no);\n      no.focus();\n    }));\n    return wrap;\n  }\n\n  // Редактор для новой записи и для исправления.\n  // Главная кнопка на экране одна — «Записать» (янтарь). «Сохранить» при правке — второй вес (фиолетовый).\n  function editor({ value, placeholder, primary, onSubmit, onCancel, draftKey }) {\n    const box = el(\"div\", \"editor\");\n    const ta = el(\"textarea\", \"textarea\");\n    ta.rows = 1;\n    ta.value = value || \"\";\n    ta.placeholder = placeholder;\n    ta.setAttribute(\"aria-label\", onCancel ? \"Текст записи\" : \"Новая запись\");\n    ta.setAttribute(\"autocapitalize\", \"sentences\");\n    ta.spellcheck = true;\n\n    const bar = el(\"div\", \"editor-bar\");\n    const save = button(onCancel ? \"btn is-second\" : \"btn is-primary\", primary);\n    const mac = /Mac|iPhone|iPad/.test(navigator.platform || \"\");\n    const hint = el(\"span\", \"kbd meta\", (mac ? \"⌘\" : \"Ctrl\") + \" + Enter\");\n    const status = el(\"span\", \"status meta\");\n    status.setAttribute(\"role\", \"status\");\n    bar.append(save);\n    if (onCancel) bar.appendChild(button(\"btn\", \"Отмена\", onCancel));\n    bar.append(hint, status);\n\n    const grow = () => { ta.style.height = \"auto\"; ta.style.height = ta.scrollHeight + 2 + \"px\"; };\n    const say = (text, cls) => { status.className = \"status meta\" + (cls ? \" \" + cls : \"\"); status.textContent = text; };\n    let timer;\n    ta.addEventListener(\"input\", () => {\n      grow();\n      say(\"\");\n      if (!draftKey) return;\n      clearTimeout(timer);\n      timer = setTimeout(() => {\n        if (ta.value.trim()) { store.set(draftKey, ta.value); say(\"Черновик сохранён\"); }\n        else store.del(draftKey);\n      }, 600);\n    });\n    ta.addEventListener(\"keydown\", ev => {\n      if (ev.key === \"Enter\" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); save.click(); }\n      if (ev.key === \"Escape\" && onCancel) { ev.preventDefault(); onCancel(); }\n    });\n    let busy = false;\n    save.onclick = async () => {\n      if (busy) return;\n      const text = ta.value.trim();\n      if (!text) { say(onCancel ? \"Пустую запись не сохранить. Вычеркни её, если нужно.\" : \"Сначала напиши что-нибудь.\", \"is-error\"); ta.focus(); return; }\n      if (onCancel && text === String(value).trim()) { onCancel(); return; }\n      busy = true;\n      say(onCancel ? \"Сохраняю…\" : \"Записываю…\");\n      try {\n        await onSubmit(text);\n      } catch (err) {\n        busy = false;\n        if (err.status === 401) return signOut(\"Пароль изменился. Войди снова.\");\n        say(\"Не сохранилось. Текст на месте, попробуй ещё раз.\" + (err.detail ? ` (${err.detail})` : \"\"), \"is-error\");\n      }\n    };\n\n    box.append(ta, bar);\n    requestAnimationFrame(() => {\n      grow();\n      if (onCancel) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }\n    });\n    return box;\n  }\n\n  function composer(isFirstToday) {\n    const box = el(\"div\", \"composer\");\n    box.appendChild(editor({\n      value: store.get(KEY_DRAFT) || \"\",\n      placeholder: isFirstToday ? \"Что сегодня произошло?\" : \"Что ещё на уме?\",\n      primary: \"Записать\",\n      draftKey: KEY_DRAFT,\n      onSubmit: async text => {\n        const data = await api(\"POST\", \"/api/entries\", { text, date: todayISO() });\n        entries = data.entries || [];\n        store.del(KEY_DRAFT);\n        render();\n        const s = document.querySelector(\".composer .status\");\n        if (s) { s.className = \"status meta is-ok\"; s.textContent = \"Записано\"; setTimeout(() => { if (s.textContent === \"Записано\") s.textContent = \"\"; }, 2400); }\n        const ta = document.querySelector(\".composer textarea\");\n        if (ta) ta.focus();\n      },\n    }));\n    return box;\n  }\n\n  // ---------- Вход и выход ----------\n  function setOwner(on) {\n    owner = on;\n    editingId = null;\n    $(\"auth-toggle\").textContent = on ? \"Выйти\" : \"Войти\";\n    $(\"login\").hidden = true;\n    render();\n  }\n\n  function openLogin(note, isError) {\n    $(\"login\").hidden = false;\n    const n = $(\"login-note\");\n    n.textContent = note || \"Пароль запомнится на этом устройстве.\";\n    n.classList.toggle(\"is-error\", !!isError);\n    $(\"pw\").focus();\n  }\n\n  function signOut(note) {\n    password = null;\n    store.del(KEY_PW);\n    setOwner(false);\n    if (note) openLogin(note, true);\n  }\n\n  $(\"auth-toggle\").addEventListener(\"click\", () => {\n    if (owner) return signOut();\n    if ($(\"login\").hidden) { openLogin(); window.scrollTo({ top: 0 }); }\n    else $(\"login\").hidden = true;\n  });\n\n  $(\"login\").addEventListener(\"submit\", async ev => {\n    ev.preventDefault();\n    const value = $(\"pw\").value;\n    const n = $(\"login-note\");\n    if (!value) { n.classList.add(\"is-error\"); n.textContent = \"Сначала введи пароль.\"; $(\"pw\").focus(); return; }\n    n.classList.remove(\"is-error\");\n    n.textContent = \"Проверяю…\";\n    password = value;\n    try {\n      await api(\"POST\", \"/api/auth\");\n      store.set(KEY_PW, value);\n      $(\"pw\").value = \"\";\n      setOwner(true);\n      requestAnimationFrame(() => { const ta = document.querySelector(\".composer textarea\"); if (ta) ta.focus(); });\n    } catch (err) {\n      password = null;\n      n.classList.add(\"is-error\");\n      n.textContent = err.status === 401 ? \"Пароль не подошёл.\" : \"Не получилось войти. Проверь соединение.\";\n      $(\"pw\").select();\n    }\n  });\n\n  document.addEventListener(\"keydown\", ev => {\n    if (ev.key === \"Escape\" && !$(\"login\").hidden) $(\"login\").hidden = true;\n  });\n\n  // ---------- Загрузка ----------\n  async function load() {\n    renderMeta();\n    try {\n      const data = await api(\"GET\", \"/api/entries\");\n      entries = data.entries || [];\n      loaded = true;\n      if (password) { owner = true; $(\"auth-toggle\").textContent = \"Выйти\"; }\n      render();\n    } catch (e) {\n      $(\"meta\").textContent = \"\";\n      const stream = $(\"stream\");\n      stream.textContent = \"\";\n      const row = el(\"div\", \"row\");\n      row.appendChild(el(\"p\", \"main notice\", \"Записи не загрузились. Проверь соединение и обнови страницу.\"));\n      stream.appendChild(row);\n    }\n  }\n\n  load().then(() => { if (!owner && location.hash === \"#write\") openLogin(); });\n})();\n</script>\n</body>\n</html>\n";
const NOT_FOUND = "<!doctype html>\n<html lang=\"ru\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Не найдено · Wolframium</title>\n<meta name=\"robots\" content=\"noindex, nofollow\">\n<meta name=\"theme-color\" content=\"#100d18\">\n<meta name=\"color-scheme\" content=\"dark\">\n<link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\" width=\"32\" height=\"32\"%3E%3Ctitle%3EWolframium%3C/title%3E%3Crect width=\"32\" height=\"32\" rx=\"1\" fill=\"%233b2475\"/%3E%3Cpath fill=\"%23eeecf3\" d=\"M9.14 24.38 5.25 7.62H8.42L10.07 15.66L11.1 20.8H11.18L12.38 15.66L14.3 7.62H17.8L19.72 15.66L20.9 20.8H20.97L22.02 15.66L23.73 7.62H26.75L22.74 24.38H19.17L17.03 15.52L16 11.1H15.95L14.87 15.52L12.74 24.38Z\"/%3E%3C/svg%3E\">\n<link rel=\"stylesheet\" href=\"https://fonts.googleapis.com/css2?family=IBM+Plex+Mono&family=IBM+Plex+Sans:wght@400;600&display=swap\">\n<style>\n:root { --bg: #100d18; --ink: #e9e7ef; --ink-2: #b3b0c0; --ink-3: #8f8c9f; --line-strong: #6e6b82; --amber-ink: #f2a93b; }\nbody { margin: 0; min-height: 100vh; display: flex; align-items: center; background: var(--bg); color: var(--ink); font: 400 15px/24px \"IBM Plex Sans\", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }\nmain { width: 100%; max-width: 640px; margin: 0 auto; padding: 96px 24px; display: flex; flex-direction: column; gap: 16px; }\n.meta { font: 400 12px/16px \"IBM Plex Mono\", ui-monospace, monospace; color: var(--ink-3); margin: 0; }\nh1 { font: 600 34px/40px \"IBM Plex Sans\", system-ui, sans-serif; letter-spacing: -0.01em; margin: 0; }\na { color: var(--ink); text-decoration: underline; text-decoration-color: var(--amber-ink); text-decoration-thickness: 1px; text-underline-offset: 3px; transition: color 120ms cubic-bezier(0.215, 0.61, 0.355, 1); align-self: flex-start; padding: 8px 0; }\na:hover { color: var(--amber-ink); }\na:focus-visible { outline: 2px solid var(--amber-ink); outline-offset: 2px; }\n</style>\n</head>\n<body>\n<main>\n  <p class=\"meta\">Ошибка 404</p>\n  <h1>Этой страницы не&nbsp;существует. Проверил дважды.</h1>\n  <a href=\"/\">← На главную</a>\n</main>\n</body>\n</html>\n";

const html = (body, status = 200, method = "GET") =>
  new Response(method === "HEAD" ? null : body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });

async function route(request) {
  const url = new URL(request.url);
  const m = request.method;
  if (url.pathname === "/api/entries") {
    if (m === "GET") return entriesGET();
    if (m === "POST") return entriesPOST(request);
    if (m === "PUT") return entriesPUT(request);
    if (m === "DELETE") return entriesDELETE(request);
    return json({ error: "Метод не поддерживается" }, 405);
  }
  if (url.pathname === "/api/auth" && m === "POST") return authPOST(request);
  if ((m === "GET" || m === "HEAD") && (url.pathname === "/" || url.pathname === "/index.html")) return html(PAGE, 200, m);
  return html(NOT_FOUND, 404, m);
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
