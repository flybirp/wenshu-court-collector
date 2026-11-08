/**
 * 裁判文书网技能 —— 常驻浏览器会话服务
 *
 * 以守护进程方式运行：打开一个真实 Chrome 窗口（持久化登录态），
 * 并在本机提供 HTTP 控制接口，供 cli.mjs 调用。
 *
 * 功能：
 *   1. 启动后自动打开登录页，由用户人工完成登录；未登录时各接口都会返回 needLogin 提示
 *   2. 检索（关键词/翻页）、浏览（详情页打开到窗口）、下载（/down/one）
 *      下载不可用（code=1/2/3）时自动兜底：提取文书全文并生成本地 .docx/.txt
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildDocx, htmlToParagraphs } from './docx.mjs';

const SKILL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROFILE_DIR = path.join(SKILL_DIR, '.chrome-profile');
const PORT = parseInt(process.env.WENSHU_PORT || '17650', 10);
const HEADLESS = process.env.WENSHU_HEADLESS === '1';
const STATE_FILE = path.join(SKILL_DIR, '.session.json');

const U = {
  login: 'https://wenshu.court.gov.cn/website/wenshu/181010CARHS5BS3C/index.html?open=login',
  home: 'https://wenshu.court.gov.cn/website/wenshu/181029CR4M5A62CH/index.html',
  search: 'https://wenshu.court.gov.cn/website/wenshu/181217BMTKHNT2W0/index.html',
  detail: (docId) =>
    `https://wenshu.court.gov.cn/website/wenshu/181107ANFZ0BXSK4/index.html?docId=${encodeURIComponent(docId)}`,
};

const DOWN_REASON = {
  '1': '非法用户/账号受限，站点不允许下载',
  '2': '账号未实名认证，站点不允许下载',
  '3': '登录姓名与当事人或代理人不符，站点不允许下载',
};

// ---------- 全局状态 ----------
let ctx = null;
let restLog = []; // 最近捕获的 rest.q4w 响应
let lastSearch = null; // 最近一次检索参数（拟人通道需要在页面上有结果列表才能点进去）
let queue = Promise.resolve(); // 动作互斥队列
let lastLoggedIn = null;
const lock = (fn) => {
  const run = queue.then(() => fn());
  queue = run.catch(() => {});
  return run;
};

const log = (...a) => {
  try {
    fs.writeSync(1, `${new Date().toISOString().slice(11, 19)} ${a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ')}\n`);
  } catch {}
};

// ---------- 工具 ----------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 站点 DES3：TripleDES-CBC/PKCS7，key=UTF8(secretKey)，iv=UTF8(当日 yyyyMMdd 本地时区)，密文 Base64 */
function ymdLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function des3DecryptNode(cipherText, secretKey, ivStr) {
  let key = Buffer.from(secretKey, 'utf8');
  if (key.length < 24) key = Buffer.concat([key, key.subarray(0, 24 - key.length)]);
  if (key.length > 24) key = key.subarray(0, 24);
  const iv = Buffer.from(ivStr || ymdLocal(), 'utf8');
  const decipher = crypto.createDecipheriv('des-ede3-cbc', key, iv);
  let out = decipher.update(cipherText, 'base64', 'utf8');
  out += decipher.final('utf8');
  return out;
}

/** 站点响应可能是 3DES 加密的 {code:1, secretKey, result}，优先 Node 解密，失败则用页面自带 DES3 */
async function decryptEntry(entry) {
  const d = entry?.parsed;
  if (!d) return null;
  if (d.secretKey && typeof d.result === 'string' && d.result.length > 0) {
    // 1) Node 端解密（Base64 密文）
    try {
      const plain = des3DecryptNode(d.result, d.secretKey);
      if (plain && plain.length > 0) {
        try {
          const obj = JSON.parse(plain);
          log(`decrypt: ok(node) keys=[${Object.keys(obj).slice(0, 10).join(',')}]`);
          return obj;
        } catch {
          log('decrypt: node plain not json, head=', String(plain).slice(0, 80));
          if (plain.length > 20) return plain;
        }
      }
    } catch (e) {
      log('decrypt: node fail', String(e.message || e).slice(0, 120));
    }
    // 2) 页面 DES3 兜底
    const pages = ctx.pages().filter((p) => p.url().includes('wenshu.court.gov.cn'));
    for (const p of pages) {
      try {
        const hasDes3 = await p.evaluate(() => typeof DES3 !== 'undefined' && typeof DES3.decrypt === 'function');
        if (!hasDes3) continue;
        const plain = await p.evaluate((c, k) => DES3.decrypt(c, k), d.result, d.secretKey);
        if (!plain) return null;
        try {
          return JSON.parse(plain);
        } catch {
          return plain;
        }
      } catch (e) {
        log('decrypt page error:', String(e.message || e).slice(0, 120));
      }
    }
    return null;
  }
  // 未加密：站点把数据放在 result 里
  if (d.result !== undefined && d.result !== null && typeof d.result === 'object') return d.result;
  return d;
}

/** 站点 DES3 加密（等价于页面里的 DES3.encrypt：TripleDES-CBC/PKCS7，输出 Base64） */
function des3EncryptNode(plain, secretKey, ivStr) {
  let key = Buffer.from(secretKey, 'utf8');
  if (key.length < 24) key = Buffer.concat([key, key.subarray(0, 24 - key.length)]);
  if (key.length > 24) key = key.subarray(0, 24);
  const iv = Buffer.from(ivStr || ymdLocal(), 'utf8');
  const c = crypto.createCipheriv('des-ede3-cbc', key, iv);
  return c.update(plain, 'utf8', 'base64') + c.final('base64');
}

/**
 * 复刻站点 strToBinary.js 的 cipher()：
 *   salt(24位随机) + iv(当日 yyyyMMdd，注意站点月份取值有 bug：>=10 月时用 getMonth()) + 3DES(timestamp, key=salt, iv)
 *   → 整串逐字符转二进制，空格分隔
 * 服务端据此解出 timestamp，校验请求新鲜度。
 */
function siteIv() {
  const d = new Date();
  const y = String(d.getFullYear());
  const mm = d.getMonth() + 1;
  const mstr = mm < 10 ? String(mm).padStart(2, '0') : String(d.getMonth()); // 站点原逻辑如此
  const dd = String(d.getDate()).padStart(2, '0');
  return y + mstr + dd;
}

const SALT_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function buildCiphertext() {
  const salt = Array.from({ length: 24 }, () => SALT_CHARS[crypto.randomInt(SALT_CHARS.length)]).join('');
  const iv = siteIv();
  const enc = des3EncryptNode(String(Date.now()), salt, iv);
  const str = salt + iv + enc;
  return str
    .split('')
    .map((c) => c.charCodeAt(0).toString(2))
    .join(' ');
}

/** 从站点页面取一个可用的 __RequestVerificationToken 与窗口校验值（缓存 10 分钟） */
let tokenCache = null;
async function siteTokens({ force = false } = {}) {
  if (!force && tokenCache && Date.now() - tokenCache.at < 10 * 60 * 1000) return tokenCache;
  const p = await siteRuntimePage();
  const t = await p.evaluate(() => {
    const el = document.querySelector('[name=__RequestVerificationToken]');
    return {
      token: el ? el.value : '',
      wh: typeof window.wh !== 'undefined' ? window.wh : 800,
      ww: typeof window.ww !== 'undefined' ? window.ww : 1500,
      cs: typeof window.cs !== 'undefined' ? window.cs : 0,
    };
  });
  tokenCache = { ...t, at: Date.now() };
  return tokenCache;
}

/**
 * Node 直发接口（不依赖页面 DOM，只需一次 HTTP 请求）。
 * 实测：比页面内 getData 再省一次 CDP 往返。
 */
async function nodeApiCall(cfg, param, { withCipher = false } = {}) {
  const t = await siteTokens();
  const form = {
    ...param,
    cfg,
    __RequestVerificationToken: t.token,
    wh: String(t.wh),
    ww: String(t.ww),
    cs: String(t.cs),
  };
  if (withCipher) form.ciphertext = buildCiphertext();
  const resp = await ctx.request.post('https://wenshu.court.gov.cn/website/parse/rest.q4w', {
    form,
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      Referer: U.search,
      Origin: 'https://wenshu.court.gov.cn',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
  });
  const parsed = parseMaybeJson(await resp.text());
  if (!parsed) return { ok: false, err: 'non-json response', status: resp.status() };
  if (parsed.secretKey && typeof parsed.result === 'string') {
    try {
      const plain = des3DecryptNode(parsed.result, parsed.secretKey);
      return { ok: true, data: JSON.parse(plain) };
    } catch (e) {
      return { ok: false, err: 'decrypt fail: ' + (e.message || e) };
    }
  }
  if (parsed.code == 1) {
    return { ok: true, data: typeof parsed.result === 'object' ? parsed.result : parsed };
  }
  return { ok: false, code: parsed.code, desc: parsed.description };
}

/**
 * 统一接口调用：Node 直发优先（最快，只多一次 cookie 请求），失败再借页面 getData。
 * 返回 { ok, data, via, ms } —— via 标明实际走的是哪一级，便于观察降级。
 */
async function apiCall(cfg, param, { withCipher = false } = {}) {
  const t0 = Date.now();
  try {
    let r = await nodeApiCall(cfg, param, { withCipher });
    if (r.ok) return { ...r, via: 'node', ms: Date.now() - t0 };
    log('node api fail:', r.code, (r.desc || r.err || '').slice(0, 60), '-> retry/page');
    if (r.code === -4 || r.code < -1) {
      // token 可能随页面刷新已失效：强制刷新后重试一次
      tokenCache = null;
      await siteTokens({ force: true }).catch(() => {});
      r = await nodeApiCall(cfg, param, { withCipher });
      if (r.ok) return { ...r, via: 'node-retry', ms: Date.now() - t0 };
    }
    // 页面通道（站点自己处理加密与校验）
    const pr = await pageApiCall(cfg, param, { withCipher });
    return { ...pr, via: 'page', ms: Date.now() - t0 };
  } catch (e) {
    log('apiCall error:', String(e.message || e).slice(0, 120));
    const pr = await pageApiCall(cfg, param, { withCipher });
    return { ...pr, via: 'page', ms: Date.now() - t0 };
  }
}

function findListEntry(sinceTs) {
  for (let i = restLog.length - 1; i >= 0; i--) {
    const item = restLog[i];
    if (sinceTs && item.ts < sinceTs) continue;
    const d = item.parsed;
    if (d && (d.queryResult || (d.code == 1 && d.secretKey))) return item;
  }
  return null;
}

function findDetailEntry(sinceTs) {
  for (let i = restLog.length - 1; i >= 0; i--) {
    const item = restLog[i];
    if (sinceTs && item.ts < sinceTs) continue;
    const d = item.parsed;
    if (!d) continue;
    if (d.qwContent !== undefined || d.s1 !== undefined) return item;
    if (d.secretKey && typeof d.result === 'string') return item;
    if (typeof d.code === 'number' && d.code < 0) return item;
  }
  return null;
}

function parseMaybeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(JSON.parse(text));
    } catch {
      return null;
    }
  }
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapListItem(it) {
  if (!it) return null;
  return {
    docId: it.rowkey || '',
    title: stripTags(it[1]),
    court: stripTags(it[2]),
    caseNo: stripTags(it[7]),
    date: stripTags(it[31]),
    caseCause: stripTags(it[10] || it[9]),
    reason: stripTags(it[26]).slice(0, 200),
    docTypeFlag: it[43] || '',
  };
}

async function loginState() {
  try {
    let loggedIn = false;
    let userName = '';
    let sawHeader = false;
    // 1) 页面头部文案是权威信号：登录后 #loginLi 显示「欢迎您，xxx」，未登录显示「登录」
    for (const p of ctx.pages()) {
      if (!p.url().includes('wenshu.court.gov.cn')) continue;
      let t = null;
      try {
        t = await p.evaluate(() => {
          const el = document.querySelector('#loginLi');
          return el ? el.innerText.trim() : null;
        });
      } catch {}
      if (t === null) continue;
      sawHeader = true;
      if (t.startsWith('欢迎您')) {
        loggedIn = true;
        userName = t.replace(/^欢迎您[，,]\s*/, '');
        break;
      }
      if (t.includes('登录')) {
        loggedIn = false;
        userName = '';
        break;
      }
    }
    // 2) cookie 兜底（部分流程会写入 nickName）
    if (!sawHeader || (!loggedIn && !userName)) {
      const cookies = await ctx.cookies('https://wenshu.court.gov.cn');
      const nick = cookies.find((c) => c.name === 'nickName');
      if (nick && nick.value && nick.value !== 'undefined' && nick.value.trim()) {
        loggedIn = true;
        if (!userName) userName = decodeURIComponent(nick.value);
      }
    }
    return { loggedIn, userName, sawHeader };
  } catch (e) {
    return { loggedIn: false, userName: '', error: String(e.message || e) };
  }
}

async function ensureSearchTab() {
  // 找一个已打开的检索页标签，否则新开
  for (const p of ctx.pages()) {
    if (p.url().includes('181217BMTKHNT2W0')) return p;
  }
  const p = await ctx.newPage();
  await p.goto(U.search, { waitUntil: 'domcontentloaded', timeout: 45000 });
  return p;
}

async function waitLoginPromptOrResults(page, deadline) {
  // 等待：出结果 / 提示无数据 / 弹出登录 / 超时
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => {
      const lists = document.querySelectorAll('.LM_list').length;
      const empty = document.body.innerText.includes('暂无数据');
      const loginIframe = !!document.querySelector('#contentIframe');
      const loginText = document.body.innerText.includes('扫码登录') || document.body.innerText.includes('账号登录');
      return { lists, empty, login: loginIframe || loginText };
    });
    if (st.lists > 0 || st.empty) return { ok: true, ...st };
    if (st.login) return { ok: false, needLogin: true };
    await sleep(500);
  }
  return { ok: false, timeout: true };
}

async function doSearch({ keyword, page = 1, pageSize = 10, mode = 'auto', court, caseNo, cause, dateFrom, dateTo, sort }) {
  const st = await loginState();
  if (!st.loggedIn) {
    return {
      needLogin: true,
      loggedIn: false,
      message: `尚未登录。请在已打开的浏览器窗口中完成登录（登录页应已打开），完成后重新执行检索。`,
    };
  }

  // 1) 快通道：一条接口调用拿结果（不填表单、不渲染列表）
  const reqParams = { keyword, page, pageSize, court, caseNo, cause, dateFrom, dateTo, sort };
  let searchFail = null;
  if (mode === 'fast' || mode === 'auto') {
    const fast = await searchFast(reqParams);
    if (fast.ok) {
      lastSearch = reqParams;
      return fast;
    }
    searchFail = fast;
    if (mode === 'fast') return fast;
    log('search fast failed -> fallback to UI:', fast.code || '', fast.message || '');
  }

  const uiIgnored = [];
  if (court) uiIgnored.push(`法院=${court}`);
  if (caseNo) uiIgnored.push(`案号=${caseNo}`);
  if (cause) uiIgnored.push(`案由=${cause}`);
  if (dateFrom || dateTo) uiIgnored.push(`裁判日期=${dateFrom || ''}~${dateTo || ''}`);
  if (uiIgnored.length) log('human search: 筛选条件未应用 ->', uiIgnored.join(', '));

  const p = await ensureSearchTab();
  await p.bringToFront();

  // 站点把每个检索词渲染成「条件标签」(.LT_Filter_right p)，提交检索时
  // addParams 会把这些标签全部拼进 queryCondition —— 也就是说新关键词是
  // 「追加」而不是「替换」。若不清，本次实际条件是
  // 「历史词1 AND 历史词2 AND ... AND 本次关键词」，结果被无声污染
  // （实测搜「破产重整申请」本应 29955 条，被两个历史词夹带后只剩 357 条）。
  // 因此先像人一样逐个点掉标签上的 ×，把条件清空。
  let closed = 0;
  for (let i = 0; i < 20; i++) {
    const tags = p.locator('.LT_Filter_right p');
    const n = await tags.count().catch(() => 0);
    if (!n) break;
    const close = p.locator('.LT_Filter_right p i.fa-close').first();
    if (!(await close.count().catch(() => 0))) break;
    await close.click({ timeout: 3000 }).catch(() => {});
    await sleep(260);
    const after = await tags.count().catch(() => 0);
    if (after >= n) break; // 点不掉就收手，避免死循环
    closed++;
  }
  if (closed) log(`human search: 清空 ${closed} 个历史检索条件标签`);

  // localStorage 里的镜像一并清掉，避免站点初始化时把旧条件回填成标签
  await p
    .evaluate(() => {
      try {
        localStorage.removeItem('wenshuListInfo');
        localStorage.removeItem('$listparams');
      } catch {}
    })
    .catch(() => {});

  let sinceTs = Date.now();

  const input = p.locator('input.searchKey.search-inp').first();
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.fill('');
  await input.click();
  await input.type(keyword, { delay: 60 });
  await p.keyboard.press('Enter');
  // 若回车无效则点搜索按钮
  await sleep(1200);
  let w = await waitLoginPromptOrResults(p, Date.now() + 8000);
  if (!w.ok && !w.needLogin) {
    const btn = p.locator('.search-click, .search-rightBtn').first();
    if (await btn.count()) {
      await btn.click().catch(() => {});
      w = await waitLoginPromptOrResults(p, Date.now() + 20000);
    }
  }
  if (w.needLogin) {
    await p.goto(U.login, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    return { needLogin: true, loggedIn: false, message: '站点要求登录后才能检索。已在浏览器中打开登录页，请完成登录后重试。' };
  }
  if (!w.ok) return { ok: false, message: '检索超时：未等到结果列表。若页面出现滑块验证码，请在浏览器窗口中手动完成后再试。', captcha: true };

  // 每页条数（站点只支持 5/10/15，改下拉框会重新加载）
  // 注意：站点默认就是 10，所以只有「当前值 != 目标值」时才操作，避免多余刷新。
  if (pageSize) {
    const sel = p.locator('select.pageSizeSelect').first();
    if (await sel.count()) {
      const cur = await sel.inputValue().catch(() => '');
      if (cur !== String(pageSize)) {
        sinceTs = Date.now();
        await sel.selectOption(String(pageSize)).catch(() => {});
        await waitLoginPromptOrResults(p, Date.now() + 20000);
      }
    }
  }

  // 翻页
  if (page > 1) {
    let cur = 1;
    while (cur < page) {
      const target = Math.min(page, cur + 5);
      const btn = p.locator(`.pageButton[value="${target}"]`).first();
      const btn2 = p.locator(`.pageButton[value="${cur + 1}"]`).first();
      const use = (await btn.count()) ? btn : btn2;
      if (!(await use.count())) return { ok: false, message: `无法翻到第 ${page} 页：分页按钮不存在（结果可能不足）` };
      const before = restLog.length;
      await use.click().catch(() => {});
      await waitLoginPromptOrResults(p, Date.now() + 20000);
      cur = target;
    }
  }

  await sleep(500);
  // 解密（站点 rest.q4w 响应多为 3DES 加密）
  let payload = null;
  const entry = findListEntry(sinceTs) || findListEntry();
  if (entry) payload = await decryptEntry(entry);
  // 兜底：从 DOM 解析
  let items;
  let total = null;
  if (payload && payload.queryResult) {
    items = payload.queryResult.resultList.map(mapListItem).filter(Boolean);
    await localizeItems(items);
    total = payload.queryResult.resultCount ?? null;
    if (payload.queryParams?.pageSize) pageSize = payload.queryParams.pageSize;
  } else if (payload && payload.__errCode) {
    return {
      ok: false,
      code: payload.__errCode,
      captcha: !!payload.__captcha,
      needLogin: !!payload.__needLogin,
      message: payload.__needLogin
        ? '站点提示未登录，请重新登录后重试。'
        : payload.__captcha
          ? `访问受限：请在浏览器窗口完成图片验证码后重试（${payload.__errText}）`
          : `站点返回错误 code=${payload.__errCode}: ${payload.__errText}`,
    };
  } else {
    items = await p.evaluate(() =>
      [...document.querySelectorAll('.LM_list')].map((el) => {
        const a = el.querySelector('a.caseName');
        const m = (a?.getAttribute('href') || '').match(/docId=([^&]+)/);
        const get = (sel) => {
          const t = el.querySelector(sel)?.innerText;
          return t ? t.trim() : '';
        };
        return {
          docId: m ? decodeURIComponent(m[1]) : '',
          title: a?.innerText?.trim() || '',
          court: get('.slfyName'),
          caseNo: get('.ah'),
          date: get('.cprq'),
          caseCause: get('.labelTwo'),
          reason: get('.list_reason p').slice(0, 200),
        };
      })
    );
  }
  // 总数：接口未给时从页面「共检索到 N 篇文书」解析
  if (total == null) {
    total = await p
      .evaluate(() => {
        const el = document.querySelector('.con_right');
        const m = el && el.innerText.match(/([\d,]+)/);
        return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
      })
      .catch(() => null);
  }
  // 当前页条数（站点下拉框真实值）
  const realPageSize = await p
    .evaluate(() => {
      const s = document.querySelector('select.pageSizeSelect');
      return s ? parseInt(s.value, 10) : null;
    })
    .catch(() => null);
  if (realPageSize) pageSize = realPageSize;
  lastSearch = reqParams;
  return {
    ok: true,
    loggedIn: true,
    keyword,
    page,
    pageSize,
    total,
    count: items.length,
    items,
    resultUrl: p.url(),
    mode: 'ui',
    // 拟人通道只回放「关键词」：法院/案号/案由/日期这些筛选需要操作高级检索面板，
    // 当前未实现。必须显式告知，否则用户会以为筛选生效而误读结果。
    ignoredFilters: uiIgnored.length ? uiIgnored : undefined,
    warnings: uiIgnored.length
      ? [`拟人通道当前仅回放关键词，以下筛选条件未应用：${uiIgnored.join('、')}。需要筛选请用 --mode fast 或 auto。`]
      : undefined,
    fallbackReason: searchFail ? searchFail.code || searchFail.message || 'api-failed' : undefined,
  };
}

// ---------- 接口快通道（省算力：不渲染页面、不开标签，一次 HTTP 调用拿数据） ----------
// 站点所有数据接口都走 POST /website/parse/rest.q4w，由页面里的 $.WebSite.getData 封装：
// 它会自动带上 __RequestVerificationToken、wh/ww/cs 校验参数、以及 ciphertext（时间戳的 3DES 密文）
// 并自动用下发的 secretKey 解密响应。所以我们借已打开的站点页面来发这个请求 —— 加密/校验全自动。
const API = {
  search: 'com.lawyee.judge.dc.parse.dto.SearchDataDsoDTO@queryDoc',
  doc: 'com.lawyee.judge.dc.parse.dto.SearchDataDsoDTO@docInfoSearch',
};

/** 找一个具备站点运行时的页面（jQuery + $.WebSite + cipher） */
async function siteRuntimePage() {
  for (const p of ctx.pages()) {
    if (!p.url().includes('wenshu.court.gov.cn')) continue;
    try {
      const ok = await p.evaluate(
        () => typeof window.jQuery !== 'undefined' && !!(window.$ && window.$.WebSite) && typeof window.cipher === 'function'
      );
      if (ok) return p;
    } catch {}
  }
  const p = await ensureSearchTab();
  await p.waitForFunction(() => typeof window.cipher === 'function', null, { timeout: 30000 }).catch(() => {});
  return p;
}

/** 在页面上下文里调用站点 $.WebSite.getData，拿解密后的数据 */
async function pageApiCall(cfg, param = {}, { timeoutMs = 20000, withCipher = false } = {}) {
  const p = await siteRuntimePage();
  return await p.evaluate(
    ({ cfg, param, timeoutMs, withCipher }) =>
      new Promise((resolve) => {
        let settled = false;
        const done = (v) => {
          if (settled) return;
          settled = true;
          resolve(v);
        };
        try {
          const params = Object.assign({}, param);
          if (withCipher) params.ciphertext = window.cipher();
          window.$.WebSite.getData({
            cfg,
            param: params,
            rollback: (data) => done({ ok: true, data }),
            error: (e) => done({ ok: false, code: (e || {}).code, desc: (e || {}).description }),
          });
          setTimeout(() => done({ ok: false, timeout: true }), timeoutMs);
        } catch (e) {
          done({ ok: false, err: String(e) });
        }
      }),
    { cfg, param, timeoutMs, withCipher }
  );
}

/** 详情接口返回的字段 → 我们的元信息结构 */
function metaFromDocData(d) {
  const ay = Array.isArray(d.wenshuAy)
    ? d.wenshuAy
        .map((x) => x && (x.text || x.name || x.value))
        .filter(Boolean)
        .join('、')
    : '';
  return {
    caseNo: stripTags(d.s7),
    court: stripTags(d.s2),
    caseCause: ay || stripTags(d.s11),
    docType: stripTags(d.s8 || d.s9),
    procedure: stripTags(d.s10),
    judgeDate: stripTags(d.s31),
    publishDate: stripTags(d.s41),
    viewCount: d.viewCount || '',
  };
}

/** 检索条件 → 站点 queryCondition 数组：s21=全文, s2=法院, s7=案号, s11=案由, cprq=裁判日期范围 */
function buildQueryCondition({ keyword, court, caseNo, cause, dateFrom, dateTo }) {
  const cond = [];
  String(keyword || '')
    .split(/\s+/)
    .filter(Boolean)
    .forEach((kw) => cond.push({ key: 's21', value: kw }));
  if (court) cond.push({ key: 's2', value: court });
  if (caseNo) cond.push({ key: 's7', value: caseNo });
  if (cause) cond.push({ key: 's11', value: cause });
  if (dateFrom || dateTo) cond.push({ key: 'cprq', value: `${dateFrom || ''} TO ${dateTo || ''}` });
  return cond;
}

/** 列表里的案由是代码（如 0307），用页面全局 spcxs 码表换成文字 */
async function localizeItems(items) {
  if (!items || !items.length) return items;
  const codes = [...new Set(items.map((i) => i.caseCause).filter((c) => c && /^[0-9A-Za-z]+$/.test(c)))];
  if (!codes.length) return items;
  try {
    const p = await siteRuntimePage();
    const map = await p.evaluate((cs) => {
      const m = window.spcxs || {};
      const out = {};
      cs.forEach((c) => {
        if (m[c]) out[c] = m[c];
      });
      return out;
    }, codes);
    items.forEach((i) => {
      if (map[i.caseCause]) {
        i.caseCauseCode = i.caseCause;
        i.caseCause = map[i.caseCause];
      }
    });
  } catch {}
  return items;
}

/** 站点每页只支持 5/10/15 */
function normalizePageSize(n) {
  const PS = [5, 10, 15];
  const v = parseInt(n, 10) || 10;
  return PS.includes(v) ? v : PS.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), 10);
}

/** 快通道检索：一条接口调用（实测 ~200ms），不填表单、不渲染结果列表 */
async function searchFast({ keyword, page = 1, pageSize = 10, court, caseNo, cause, dateFrom, dateTo, sort }) {
  const t0 = Date.now();
  pageSize = normalizePageSize(pageSize);
  const cond = buildQueryCondition({ keyword, court, caseNo, cause, dateFrom, dateTo });
  if (!cond.length) return { ok: false, mode: 'api', message: '检索条件为空' };
  // 注意：多条件 queryCondition 只在"页面通道"生效（Node 直发同参数会返回 0 条），
  // 所以检索固定走页面 getData，保证结果与页面搜框完全一致。
  const r = await pageApiCall(
    API.search,
    {
      sortFields: sort || 's50:desc',
      pageNum: page,
      pageSize,
      queryCondition: JSON.stringify(cond),
    },
    { withCipher: true }
  );
  const ms = Date.now() - t0;
  if (!r.ok) {
    return {
      ok: false,
      mode: 'api',
      via: 'page',
      ms,
      code: r.code,
      captcha: r.code === -11,
      needLogin: r.code === -4,
      message: r.timeout ? '接口超时（站点可能限流或要求验证码）' : r.desc || r.err || '接口调用失败',
    };
  }
  const qr = r.data && r.data.queryResult;
  if (!qr || !Array.isArray(qr.resultList)) {
    return {
      ok: false,
      mode: 'api',
      ms,
      message: '接口未返回结果列表',
      dataKeys: Object.keys(r.data || {}).slice(0, 12),
    };
  }
  const items = qr.resultList.map(mapListItem).filter(Boolean);
  await localizeItems(items);
  return {
    ok: true,
    mode: 'api',
    via: 'page',
    ms,
    loggedIn: true,
    keyword,
    page,
    pageSize,
    total: qr.resultCount ?? null,
    count: items.length,
    items,
    queryCondition: cond,
  };
}

/**
 * 快通道读全文：一条接口调用（实测 ~100ms），不渲染详情页、不开新标签。
 * 依赖 cipher（页面内生成时间戳密文），所以必须先有检索页/详情页存在。
 */
async function readDocFast(docId) {
  const t0 = Date.now();
  const r = await apiCall(API.doc, { docId }, { withCipher: true });
  const ms = Date.now() - t0;
  if (!r.ok) {
    return {
      ok: false,
      mode: 'api',
      via: r.via,
      ms,
      docId,
      code: r.code,
      message: r.timeout
        ? '接口超时（站点可能要求验证码/限流）'
        : r.desc || r.err || '接口调用失败',
      httpFail: true,
    };
  }
  const d = r.data || {};
  const paragraphs = htmlToParagraphs(d.qwContent || '');
  const text = paragraphs.join('\n');
  const restricted = !looksLikeDoc(text);
  return {
    ok: !restricted,
    mode: 'api',
    via: r.via,
    ms,
    docId,
    title: stripTags(d.s1),
    meta: metaFromDocData(d),
    charCount: text.length,
    paragraphsCount: paragraphs.length,
    source: 'api:docInfoSearch',
    restricted,
    paragraphs,
    text,
    preview: text.slice(0, 600),
    message: restricted ? `接口返回的不是文书正文（${text.length} 字，疑似不公开/已下架/字段变更）` : undefined,
  };
}

// 像人一样：从检索结果里点开某条文书的链接（真实点击，target=_blank 会开新标签）
async function clickDocFromResults(docId, waitMs = 15000) {
  const searchTab = ctx.pages().find((x) => x.url().includes('181217BMTKHNT2W0'));
  if (!searchTab) return null;
  // 接口返回的 docId 与页面列表里的 docId 尾部后缀不同（前者来自 rowkey），用前缀匹配
  const key = String(docId).slice(0, 80);
  const beforeSet = new Set(ctx.pages());
  // 轮询等待：检索结果列表是异步替换的，旧列表可能还在 DOM 里，需要等到目标链接出现
  let clicked = false;
  const deadline = Date.now() + (waitMs || 15000);
  while (Date.now() < deadline) {
    clicked = await searchTab
      .evaluate(({ d, key }) => {
        const els = [...document.querySelectorAll('.LM_list a.caseName, a.caseName')];
        const hit = (h) => {
          let dec = h;
          try {
            dec = decodeURIComponent(h);
          } catch {}
          return dec.includes(d) || h.includes(d) || (key.length > 40 && (dec.includes(key) || h.includes(key)));
        };
        const el = els.find((e) => hit(e.getAttribute('href') || ''));
        if (!el) return false;
        el.click();
        return true;
      }, { d: docId, key })
      .catch(() => false);
    if (clicked) break;
    await sleep(600);
  }
  if (!clicked) return null;
  // 等详情页出现：优先新开的标签，其次本标签自身跳转
  for (let i = 0; i < 40; i++) {
    const fresh = ctx.pages().find((p) => !beforeSet.has(p));
    if (fresh) {
      await fresh.waitForLoadState('domcontentloaded').catch(() => {});
      return fresh;
    }
    if (searchTab.url().includes('181107ANFZ0BXSK4')) return searchTab;
    await sleep(300);
  }
  return null;
}

/** 判断一段文字是不是"文书正文"，而不是公告/页脚模板 */
function looksLikeDoc(text) {
  if (!text || text.length < 200) return false;
  // 文书标题常带字间空格（"民 事 裁 定 书"），先归一化再判断
  const flat = String(text).replace(/\s+/g, '');
  if (/点击了解更多|严禁任何单位和个人利用|不得建立本裁判文书库的镜像|中国政府公开信息整合服务平台/.test(flat)) {
    return false;
  }
  if (/判决书|裁定书|决定书|通知书|调解书|调解协议/.test(flat)) return true;
  // 没有标题时，案号 + 法院署名也能佐证是文书正文
  return /[（(]\d{4}[）)][^，。\s]{2,30}号/.test(flat) && /审判长|审判员|此致|本院认为/.test(flat);
}

/** 从已渲染的页面取正文（屏幕上看到的内容） */
async function extractRendered(page) {
  return await page.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      const t = el ? el.innerText.trim() : '';
      return t.length > 80 ? t : '';
    };
    // 站点正文容器
    let t = pick('.PDF_pox') || pick('.qwContent') || pick('#qwContent');
    let how = 'PDF_pox';
    if (!t) {
      // 兜底：内容最长的、且不含页脚特征的容器
      let best = '';
      let bestCls = '';
      for (const el of document.querySelectorAll('div,article,section')) {
        const s = (el.innerText || '').trim();
        if (s.length < 200) continue;
        if (/ICP备|版权所有|中国政府公开信息整合服务平台/.test(s)) continue;
        if (s.length > best.length) {
          best = s;
          bestCls = el.className || el.id || '';
        }
      }
      t = best;
      how = 'largest-div:' + String(bestCls).slice(0, 30);
    }
    const bodyText = document.body.innerText || '';
    return {
      text: t,
      how,
      hasPermissionError: /权限已失效|无权访问|访问受限/.test(bodyText),
      header: {
        s1: (document.querySelector('.detail_title')?.innerText || '').trim(),
      },
      bodyHead: bodyText.slice(0, 200),
    };
  });
}

async function readDoc({ docId, url, keepOpen = false, mode = 'auto' }) {
  const st = await loginState();
  const target = url || U.detail(docId);
  if (!docId && url) {
    const m = target.match(/docId=([^&]+)/);
    docId = m ? decodeURIComponent(m[1]) : '';
  }
  if (!st.loggedIn) {
    return {
      ok: false,
      needLogin: true,
      loggedIn: false,
      docId,
      message: '尚未登录：请在浏览器窗口中完成登录后重试。',
    };
  }

  // 1) 快通道：一条接口调用拿全文（省算力，不渲染页面）
  let fastFail = null;
  if ((mode === 'fast' || mode === 'auto') && docId) {
    const fast = await readDocFast(docId);
    if (fast.ok) {
      fast.path = 'api';
      if (keepOpen) fast.note = '快通道不打开浏览器页面；如需在窗口里查看原文，用 --mode human。';
      return fast;
    }
    fastFail = fast;
    if (mode === 'fast') return fast;
    log('fast-path failed -> fallback to human:', fast.code || '', fast.message || '');
  }

  const triedTs = new Set();
  let p = null;
  let openedBy = 'goto';
  try {
    // 1) 优先"像人一样"从检索结果点进去
    if (docId) {
      let clicked = await clickDocFromResults(docId, 2500);
      // 页面上没有结果列表（例如刚用接口快通道检索过）→ 先把列表渲染出来，再点
      if (!clicked && lastSearch) {
        log('no result list on page -> render UI search first, then click');
        await doSearch({ ...lastSearch, mode: 'ui' });
        clicked = await clickDocFromResults(docId, 20000);
      }
      if (clicked) {
        p = clicked;
        openedBy = 'click-result';
      }
    }
    if (!p) {
      p = await ctx.newPage();
      const sinceTs0 = Date.now();
      await p.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000, referer: U.search });
      openedBy = 'goto-with-referer';
    }
    const sinceTs = Date.now() - 1000;

    // 2) 等页面把正文渲染出来（人能看到 → 我们也能取到）
    let rendered = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      rendered = await extractRendered(p).catch(() => null);
      if (rendered && rendered.text && rendered.text.length > 200) break;
      if (rendered && rendered.hasPermissionError) break;
      await sleep(800);
    }

    // 3) 如果页面没渲染出正文，再尝试从接口数据里解（明文 result 字段）
    let payload = null;
    if (!rendered || !rendered.text || rendered.text.length <= 200) {
      const entry = findDetailEntry(sinceTs);
      if (entry && !triedTs.has(entry.ts)) {
        triedTs.add(entry.ts);
        const cand = await decryptEntry(entry);
        if (cand && cand.qwContent) payload = cand;
      }
    }

    let paragraphs = [];
    let source = '';
    if (payload && payload.qwContent) {
      paragraphs = htmlToParagraphs(payload.qwContent);
      source = 'api-plain';
    } else if (rendered && rendered.text) {
      paragraphs = rendered.text
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      source = 'rendered(' + rendered.how + ')';
    }
    const text = paragraphs.join('\n');
    const meta = payload
      ? {
          caseNo: payload.s2 || '',
          court: payload.s8 || '',
          caseCause: payload.s10 || '',
          docType: payload.s9 || '',
          judgeDate: payload.s31 || '',
          viewCount: payload.viewCount || '',
        }
      : {};
    const restricted = !looksLikeDoc(text);
    const shot = path.join(os.tmpdir(), `wenshu-doc-${Date.now()}.png`);
    await p.screenshot({ path: shot, fullPage: false }).catch(() => {});
    const result = {
      ok: !restricted,
      docId,
      url: p.url(),
      openedBy,
      path: 'human',
      fallbackReason: fastFail ? [fastFail.code, fastFail.message].filter(Boolean).join(' ') || 'api-failed' : undefined,
      title: payload?.s1 || (rendered && rendered.header && rendered.header.s1) || (await p.title().catch(() => '')),
      meta,
      charCount: text.length,
      paragraphsCount: paragraphs.length,
      restricted,
      permissionError: !!(rendered && rendered.hasPermissionError),
      source,
      loggedIn: st.loggedIn,
      screenshot: shot,
      paragraphs,
      text,
      preview: text.slice(0, 600),
    };
    if (restricted) {
      result.message = rendered && rendered.hasPermissionError
        ? '站点提示「权限已失效」：该文书当前无法读取正文（可能需要重新登录，或该文书已下架/不公开）。'
        : '未能取到正文：页面可能仍在加载或需要人工处理（可看 screenshot 确认，或让用户手动操作后重试）。';
    }
    if (keepOpen) {
      result.note = '详情页已保留在浏览器窗口中';
    } else {
      await p.close().catch(() => {});
    }
    return result;
  } catch (e) {
    await p.close().catch(() => {});
    return { ok: false, docId, url: target, message: '打开详情页失败: ' + (e.message || e) };
  }
}

function defaultDownloadDir() {
  return process.env.WENSHU_DL_DIR || path.join(os.homedir(), 'Downloads', 'wenshu-docs');
}

function saveName(base, ext) {
  let s = String(base || 'wenshu');
  try {
    s = decodeURIComponent(s);
  } catch {}
  s = s
    .replace(/[\\/:*?"<>|+=\r\n\t]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return `${s || 'wenshu'}${ext}`;
}

/** 从正文里猜一个可读的文件名（案号） */
function deriveName(text, fallback) {
  const m = String(text || '').match(/[（(]\s*(\d{4})\s*[）)]\s*[^\s，。：；]{2,30}?号/);
  if (m) return m[0].replace(/[（）()]/g, '');
  return fallback;
}

async function doDownload({ docId, url, dir, name, keepOpen = true, forceExtract = false }) {
  const st = await loginState();
  if (!docId && url) {
    const m = String(url).match(/docId=([^&]+)/);
    docId = m ? decodeURIComponent(m[1]) : '';
  }
  const outDir = dir || defaultDownloadDir();
  fs.mkdirSync(outDir, { recursive: true });
  const base = name || docId || 'wenshu_doc';

  if (!st.loggedIn) {
    // 未登录：直接走兜底提取（未登录详情页大概率也拿不到全文，如实报告）
    const r = await readDoc({ docId, url, keepOpen });
    if (r.restricted || !r.text) {
      return { ok: false, needLogin: true, message: '尚未登录，无法下载也无法读取全文。请先在浏览器窗口完成登录。' };
    }
    return extractFallback(r, outDir, base, '未登录，站点下载通道不可用，已兜底提取可见内容');
  }

  // 1) 询问站点是否允许下载（forceExtract 时跳过，直接走兜底提取）
  let code = null;
  if (!forceExtract) {
    try {
      const resp = await ctx.request.post('https://wenshu.court.gov.cn/down/isDown', {
        form: { docId: encodeURIComponent(docId) },
        headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: U.search },
      });
      const j = parseMaybeJson(await resp.text());
      code = j?.code ?? j?.Code ?? null;
    } catch (e) {
      return { ok: false, message: '查询下载权限失败: ' + (e.message || e) };
    }
    log('isDown code =', code, docId);
  } else {
    code = 'force-extract';
  }

  if (String(code) !== '0') {
    const reason = forceExtract
      ? '按要求直接提取正文（跳过站点下载通道）'
      : DOWN_REASON[String(code)] || `站点返回不可下载(code=${code})`;
    const r = await readDoc({ docId, url, keepOpen });
    if (r.text && !r.restricted) {
      return extractFallback(r, outDir, base, reason);
    }
    return {
      ok: false,
      code: String(code),
      reason,
      message: `${reason}；兜底提取也未获得全文（该文书可能仅展示摘要或不公开）。`,
      detail: r,
    };
  }

  // 2) 站点允许：正式下载 /down/one
  try {
    const resp = await ctx.request.get(`https://wenshu.court.gov.cn/down/one?docId=${encodeURIComponent(docId)}`, {
      headers: { Referer: U.search },
      timeout: 90000,
    });
    const ctype = resp.headers()['content-type'] || '';
    const cdisp = resp.headers()['content-disposition'] || '';
    const buf = await resp.body();
    const isHtml = /text\/html/i.test(ctype);
    if (isHtml || buf.length < 512) {
      const r = await readDoc({ docId, url, keepOpen });
      if (r.text && !r.restricted) return extractFallback(r, outDir, base, '站点下载接口返回异常内容，已兜底提取全文');
      return { ok: false, message: '下载接口返回异常（可能是错误页），兜底提取也未成功', detail: r };
    }
    // 文件名：优先 content-disposition（可能是 URL 编码的中文名），兜底用案号
    let fname = null;
    const mStar = cdisp.match(/filename\*\s*=\s*([^;]+)/i);
    const m = cdisp.match(/filename\s*=\s*"?([^";]+)"?/i);
    if (mStar) {
      try {
        fname = decodeURIComponent(mStar[1].trim().replace(/^utf-8''/i, '').replace(/''/, "'"));
      } catch {}
    } else if (m) {
      fname = m[1].trim();
    }
    const hasExt = fname && /\.(docx?|zip|pdf|txt)$/i.test(saveName(fname, ''));
    const ext = hasExt ? '' : /\bzip\b/i.test(ctype) ? '.zip' : '.doc';
    fname = saveName(fname || base, ext);
    const fpath = path.join(outDir, fname);
    fs.writeFileSync(fpath, buf);
    return { ok: true, mode: 'download', path: fpath, size: buf.length, contentType: ctype, docId };
  } catch (e) {
    const r = await readDoc({ docId, url, keepOpen });
    if (r.text && !r.restricted) return extractFallback(r, outDir, base, '下载请求失败(' + (e.message || e) + ')，已兜底提取全文');
    return { ok: false, message: '下载请求失败: ' + (e.message || e), detail: r };
  }
}

function extractFallback(r, outDir, base, reason) {
  const stem = deriveName(r.text, base);
  const metaPairs = [];
  const m = r.meta || {};
  if (r.title) metaPairs.push({ k: '文书名称', v: r.title });
  if (m.caseNo) metaPairs.push({ k: '案号', v: m.caseNo });
  if (m.court) metaPairs.push({ k: '法院', v: m.court });
  if (m.caseCause) metaPairs.push({ k: '案由', v: m.caseCause });
  if (m.docType) metaPairs.push({ k: '文书类型', v: m.docType });
  if (m.judgeDate) metaPairs.push({ k: '裁判日期', v: m.judgeDate });
  const srcUrl = r.url || (r.docId ? U.detail(r.docId) : 'https://wenshu.court.gov.cn/');
  const sourceNote = `来源：中国裁判文书网 ${srcUrl}\n说明：站点下载不可用，本文件由全文提取生成（${reason}）`;
  // 正文段落：优先用结构化段落，退化时按行切分 text，避免 docx 只剩标题+元信息
  const paras =
    Array.isArray(r.paragraphs) && r.paragraphs.length
      ? r.paragraphs
      : String(r.text || '')
          .split(/\n+/)
          .map((s) => s.trim())
          .filter(Boolean);
  const docxBuf = buildDocx({ title: r.title || '裁判文书', meta: metaPairs, paragraphs: paras, source: sourceNote });
  const docxPath = path.join(outDir, saveName(stem, '.docx'));
  const txtPath = path.join(outDir, saveName(stem, '.txt'));
  fs.writeFileSync(docxPath, docxBuf);
  fs.writeFileSync(txtPath, (r.text || '') + '\n\n' + sourceNote + '\n');
  return {
    ok: true,
    mode: 'extract',
    reason,
    files: [docxPath, txtPath],
    path: docxPath,
    size: docxBuf.length,
    charCount: r.charCount,
    paragraphsCount: paras.length,
    docId: r.docId,
  };
}

// ---------- HTTP 服务 ----------
function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;
  try {
    if (p === '/health') return json(res, 200, { ok: true, app: 'wenshu-court-docs', pid: process.pid, port: PORT });
    if (!ctx) return json(res, 503, { ok: false, message: 'browser not ready' });

    if (p === '/status') {
      const st = await loginState();
      const msg = st.loggedIn
        ? `已登录：${st.userName}`
        : '未登录：请在已打开的浏览器窗口中完成登录（手机号+验证码/扫码），期间会一直保持提醒，登录成功后自动跳转到检索页。';
      lastLoggedIn = st.loggedIn;
      return json(res, 200, {
        ok: true,
        loggedIn: st.loggedIn,
        userName: st.userName,
        url: ctx.pages()[0]?.url(),
        tabs: ctx.pages().map((x) => x.url()),
        restCaptures: restLog.length,
        message: msg,
      });
    }

    if (p === '/goto') {
      const b = await readBody(req);
      const target = b.url || U[b.page || 'login'];
      const tab = await (ctx.pages().find((x) => x.url().includes('wenshu.court.gov.cn')) || ctx.newPage());
      await tab.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
      return json(res, 200, { ok: true, url: target, message: '已在浏览器中打开' });
    }

    if (p === '/search') return json(res, 200, await lock(async () => doSearch(await readBody(req))));

    if (p === '/doc') {
      const b = await readBody(req);
      return json(res, 200, await lock(() => readDoc({ ...b, keepOpen: b.keepOpen !== false })));
    }

    if (p === '/download') return json(res, 200, await lock(async () => doDownload(await readBody(req))));

    if (p === '/screenshot') {
      const b = await readBody(req);
      const shotPath = b.path || '/tmp/wenshu-shot.png';
      // 默认截最后一个标签页（最近打开的通常是用户关心的页面）
      let tab;
      if (b.url) tab = ctx.pages().find((x) => x.url() === b.url);
      else if (typeof b.tabIndex === 'number') tab = ctx.pages()[b.tabIndex];
      else tab = ctx.pages()[ctx.pages().length - 1];
      if (!tab) tab = ctx.pages()[0];
      await tab.bringToFront().catch(() => {});
      await sleep(800);
      await tab.screenshot({ path: shotPath, fullPage: !!b.fullPage });
      return json(res, 200, { ok: true, path: shotPath, tabUrl: tab.url() });
    }

    // 调试：验证 Node 直发接口
    if (p === '/probe-node') {
      const b = await readBody(req);
      const t0 = Date.now();
      const cfg = b.cfg || API.doc;
      const param = b.param || { docId: b.docId };
      const r = await nodeApiCall(cfg, param, { withCipher: true });
      const d = r.data || {};
      const qr = d.queryResult;
      return json(res, 200, {
        ok: r.ok,
        ms: Date.now() - t0,
        code: r.code,
        desc: r.desc,
        err: r.err,
        keys: d && typeof d === 'object' ? Object.keys(d).slice(0, 30) : null,
        title: d && d.s1,
        qwLen: d && d.qwContent ? String(d.qwContent).length : 0,
        head: d && d.qwContent ? String(d.qwContent).slice(0, 150) : null,
        total: qr ? qr.resultCount : undefined,
        n: qr && qr.resultList ? qr.resultList.length : undefined,
      });
    }

    if (p === '/debug') {
      const cookies = await ctx.cookies('https://wenshu.court.gov.cn');
      const tab = ctx.pages().find((x) => x.url().includes('wenshu.court.gov.cn'));
      let pageInfo = {};
      if (tab) {
        pageInfo = await tab
          .evaluate(() => {
            const li = document.querySelector('#loginLi');
            return {
              loginLi: li ? li.innerText.trim() : null,
              hasLogout: !!document.querySelector('#logout'),
              bodyHead: document.body.innerText.slice(0, 300),
            };
          })
          .catch((e) => ({ error: String(e.message) }));
      }
      return json(res, 200, {
        ok: true,
        url: tab?.url(),
        cookies: cookies.map((c) => ({ name: c.name, value: c.value.slice(0, 60), domain: c.domain, expires: c.expires })),
        page: pageInfo,
        rest: restLog.slice(-14).map((r) => ({
          url: r.url.slice(-40),
          keys: Object.keys(r.parsed || {}),
          code: r.parsed?.code,
          hasSecret: !!r.parsed?.secretKey,
          qrKeys: r.parsed?.queryResult ? Object.keys(r.parsed.queryResult) : null,
          resultCount: r.parsed?.queryResult?.resultCount,
          listLen: r.parsed?.queryResult?.resultList?.length,
          resultKeys: r.parsed?.result && typeof r.parsed.result === 'object' ? Object.keys(r.parsed.result).slice(0, 30) : null,
          reqBody: (r.reqBody || '').slice(0, 1500),
        })),
      });
    }

    // 在页面上下文里执行任意表达式（调试用）
    if (p === '/eval') {
      const b = await readBody(req);
      const tab =
        typeof b.tabIndex === 'number'
          ? ctx.pages()[b.tabIndex]
          : ctx.pages().find((x) => x.url().includes('wenshu.court.gov.cn'));
      if (!tab) return json(res, 200, { ok: false, message: 'no wenshu tab' });
      try {
        const r = await tab.evaluate(b.code);
        return json(res, 200, { ok: true, result: r });
      } catch (e) {
        return json(res, 200, { ok: false, message: String(e.message || e) });
      }
    }

    if (p === '/stop') {
      json(res, 200, { ok: true, message: 'closing' });
      setTimeout(async () => {
        try {
          await ctx.close();
        } catch {}
        try {
          fs.unlinkSync(STATE_FILE);
        } catch {}
        process.exit(0);
      }, 200);
      return;
    }

    json(res, 404, { ok: false, message: 'unknown path ' + p });
  } catch (e) {
    json(res, 500, { ok: false, message: String(e.message || e) });
  }
});

// ---------- 启动 ----------
async function main() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  log('launching chrome (profile:', PROFILE_DIR + ')');
  ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: HEADLESS,
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', '--window-size=1500,950', '--lang=zh-CN'],
  });
  ctx.on('response', async (resp) => {
    try {
      const url = resp.url();
      if (!url.includes('rest.q4w') && !url.includes('/down/isDown')) return;
      const text = await resp.text().catch(() => '');
      const parsed = parseMaybeJson(text);
      if (parsed) {
        const brief = { code: parsed.code, success: parsed.success, hasKey: !!parsed.secretKey, keyLen: parsed.secretKey?.length, resLen: typeof parsed.result === 'string' ? parsed.result.length : typeof parsed.result, desc: (parsed.description || '').slice(0, 60) };
        log('CAP', url.slice(-32), JSON.stringify(brief));
        let reqBody = '';
        try {
          reqBody = resp.request().postData() || '';
        } catch {}
        restLog.push({ ts: Date.now(), url, parsed, reqBody: reqBody.slice(0, 8000), raw: text.slice(0, 500000) });
        if (restLog.length > 40) restLog = restLog.slice(-40);
      }
    } catch {}
  });
  ctx.on('close', () => {
    log('browser closed, exiting');
    process.exit(0);
  });

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, port: PORT, startedAt: new Date().toISOString() }));

  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(U.login, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => log('goto login:', e.message));
  const st = await loginState();
  if (st.loggedIn) {
    await page.goto(U.search, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  }
  log(`READY http://127.0.0.1:${PORT} loggedIn=${st.loggedIn}`);
  console.log(JSON.stringify({ ready: true, port: PORT, loggedIn: st.loggedIn }));
  // 心跳：登录态变化时切换页面（仅在还停留在登录页时才跳转，避免打扰用户浏览文书）
  setInterval(async () => {
    const s = await loginState();
    if (s.loggedIn === lastLoggedIn) return;
    const wasKnown = lastLoggedIn !== null;
    lastLoggedIn = s.loggedIn;
    log('login state ->', s.loggedIn, s.userName);
    const tab = ctx.pages().find((x) => x.url().includes('wenshu.court.gov.cn'));
    if (!tab) return;
    const onLoginPage = /181010CARHS5BS3C|open=login/.test(tab.url());
    if (s.loggedIn) {
      if (onLoginPage || !wasKnown) {
        await tab.goto(U.search, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      }
    }
  }, 4000);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
