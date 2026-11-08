/**
 * 裁判文书网技能 —— 命令行客户端
 *
 * 子命令：
 *   start                       启动常驻会话（浏览器窗口 + 本地服务），未登录会自动打开登录页
 *   status [--wait] [--timeout 秒]  查询登录状态；--wait 时持续等待登录并每隔几秒提醒
 *   search   "关键词" [--page N] [--size 10|15] [--out 文件.json]
 *   read     --doc-id ID | --url URL [--out 文件.json] [--open]   提取文书全文
 *   download --doc-id ID | --url URL [--dir 目录] [--name 文件名]  下载；不可用时自动兜底提取生成 docx/txt
 *   open     --url URL | --page login|home|search                 在浏览器中打开页面（供用户浏览）
 *   screenshot [--path 文件]                                     截图当前页面（调试用）
 *   stop                                                          关闭会话与浏览器
 *
 * 所有查询类命令输出 JSON。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.dirname(SCRIPT_DIR);
const STATE_FILE = path.join(SKILL_DIR, '.session.json');
const PORT = parseInt(process.env.WENSHU_PORT || '17650', 10);
const BASE = `http://127.0.0.1:${PORT}`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

async function api(p, body, method = 'GET', timeoutMs = 180000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(BASE + p, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
      signal: ctrl.signal,
    });
    const text = await resp.text();
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, message: '服务返回异常: ' + text.slice(0, 300) };
    }
  } catch (e) {
    return { ok: false, unreachable: true, message: `无法连接本地会话服务(${BASE})，请先执行: wenshu start` };
  } finally {
    clearTimeout(t);
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function cmdStart() {
  const health = await api('/health', null, 'GET', 3000);
  if (health.ok && health.app === 'wenshu-court-docs') {
    const st = await api('/status', null, 'GET', 30000);
    console.log(JSON.stringify({ ok: true, reused: true, port: PORT, loggedIn: st.loggedIn, message: st.message }, null, 2));
    return;
  }
  // 清理陈旧状态
  const state = readState();
  if (state?.pid) {
    try {
      process.kill(state.pid, 0);
      console.log(JSON.stringify({ ok: false, message: `检测到旧会话进程(pid=${state.pid})仍在运行但无响应，请执行 stop 后重试，或稍等其退出。` }));
      return;
    } catch {}
  }
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {}
  const out = fs.openSync(path.join(SKILL_DIR, '.session.log'), 'a');
  const err = fs.openSync(path.join(SKILL_DIR, '.session.log'), 'a');
  const child = spawn(process.execPath, [path.join(SCRIPT_DIR, 'session.mjs')], {
    detached: true,
    stdio: ['ignore', out, err],
    env: process.env,
  });
  child.unref();
  // 等待就绪
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const h = await api('/health', null, 'GET', 2000);
    if (h.ok && h.app === 'wenshu-court-docs') {
      let st = await api('/status', null, 'GET', 60000);
      // 站点有 SSO 静默登录：给几秒时间让登录态回填，避免误报"未登录"
      for (let k = 0; k < 8 && st.ok && !st.loggedIn; k++) {
        await new Promise((r) => setTimeout(r, 2000));
        st = await api('/status', null, 'GET', 60000);
      }
      console.log(
        JSON.stringify(
          {
            ok: true,
            started: true,
            port: PORT,
            pid: h.pid,
            loggedIn: st.loggedIn,
            message: st.message,
            log: path.join(SKILL_DIR, '.session.log'),
          },
          null,
          2
        )
      );
      if (!st.loggedIn) {
        console.log('>> 已在浏览器中打开登录页，请在窗口中完成登录（手机号+验证码 或 扫码）。');
        console.log('>> 之后可执行: wenshu status --wait 等待登录完成。');
      }
      return;
    }
  }
  console.log(JSON.stringify({ ok: false, message: '会话启动超时，请查看 ' + path.join(SKILL_DIR, '.session.log') }));
}

async function cmdStatus(args) {
  if (args.wait) {
    const timeout = (parseInt(args.timeout || '180', 10)) * 1000;
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeout) {
      const st = await api('/status', null, 'GET', 30000);
      if (st.ok && st.loggedIn !== last) {
        last = st.loggedIn;
        console.log(`[${new Date().toTimeString().slice(0, 8)}] ${st.message}`);
        if (st.loggedIn) {
          console.log(JSON.stringify({ ok: true, loggedIn: true, userName: st.userName }));
          return;
        }
      } else if (st.unreachable) {
        console.log(`[${new Date().toTimeString().slice(0, 8)}] 会话未启动，请先执行 wenshu start`);
        return;
      }
      await new Promise((r) => setTimeout(r, 4000));
    }
    console.log(JSON.stringify({ ok: false, loggedIn: false, message: '等待登录超时：用户尚未在浏览器中完成登录。请继续提醒用户登录后重试。' }));
    return;
  }
  const st = await api('/status', null, 'GET', 30000);
  console.log(JSON.stringify(st, null, 2));
  if (st.ok && !st.loggedIn) {
    console.log('>> 尚未登录：请提醒用户在已打开的浏览器窗口中完成登录。');
  }
}

async function output(args, obj) {
  const s = JSON.stringify(obj, null, 2);
  if (args.out) {
    fs.writeFileSync(path.resolve(args.out), s);
    console.log(`结果已写入 ${path.resolve(args.out)}`);
    console.log(s.slice(0, 1200) + (s.length > 1200 ? '\n...(截断，完整内容见输出文件)' : ''));
  } else {
    console.log(s);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    console.log(
      [
        '用法: node cli.mjs <子命令> [参数]',
        '  start                              启动常驻会话并打开登录页',
        '  status [--wait] [--timeout 秒]     查询/等待登录状态',
        '  search "关键词" [--page N] [--size 10|15] [--out f.json]',
        '  read --doc-id ID | --url URL [--out f.json] [--open]',
        '  download --doc-id ID [--dir 目录] [--name 名称]',
        '  open --url URL | --page login|home|search',
        '  screenshot [--path f.png]',
        '  stop',
      ].join('\n')
    );
    return;
  }
  switch (cmd) {
    case 'start':
      return cmdStart();
    case 'status':
      return cmdStatus(args);
    case 'search': {
      const keyword = args._[0] || args.keyword;
      if (!keyword) return console.log(JSON.stringify({ ok: false, message: '缺少检索关键词' }));
      const r = await api(
        '/search',
        {
          keyword,
          page: parseInt(args.page || '1', 10),
          pageSize: parseInt(args.size || '10', 10),
          mode: args.mode || 'auto',
          court: args.court,
          caseNo: args['case-no'],
          cause: args.cause,
          dateFrom: args['date-from'],
          dateTo: args['date-to'],
          sort: args.sort,
        },
        'POST',
        180000
      );
      await output(args, r);
      if (r.needLogin) console.log('>> 需要登录：请提醒用户在浏览器窗口完成登录后重试。');
      else if (r.mode === 'api') console.log(`>> 快通道（接口/${r.via || 'node'}）：${r.ms}ms，未渲染页面。`);
      else if (r.mode === 'ui') console.log(`>> 拟人通道（填表+渲染）${r.fallbackReason ? '，快通道不可用：' + r.fallbackReason : ''}`);
      if (Array.isArray(r.warnings)) r.warnings.forEach((w) => console.log('!! ' + w));
      return;
    }
    case 'read': {
      const mode = args.mode || 'auto';
      const r = await api(
        '/doc',
        { docId: args['doc-id'], url: args.url, keepOpen: !!args.open, mode },
        'POST',
        180000
      );
      await output(args, r);
      if (r.path === 'api') console.log(`>> 快通道（接口/${r.via || 'node'}）：${r.ms}ms，未渲染页面。`);
      else if (r.path === 'human') console.log(`>> 拟人通道（点击+渲染）${r.fallbackReason ? '，快通道不可用：' + r.fallbackReason : ''}`);
      return;
    }
    case 'download': {
      const r = await api('/download', { docId: args['doc-id'], url: args.url, dir: args.dir, name: args.name, forceExtract: !!args['force-extract'] }, 'POST', 240000);
      await output(args, r);
      if (r.mode === 'extract') console.log('>> 站点下载不可用，已自动兜底提取全文并生成 docx/txt。原因: ' + (r.reason || ''));
      return;
    }
    case 'open': {
      const r = await api('/goto', { url: args.url, page: args.page || (args['doc-id'] ? undefined : 'search') }, 'POST');
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    case 'screenshot': {
      const r = await api('/screenshot', { path: args.path || `/tmp/wenshu-${Date.now()}.png` }, 'POST');
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    case 'stop': {
      const r = await api('/stop', {}, 'POST', 15000);
      if (r.unreachable) {
        const state = readState();
        if (state?.pid) {
          try {
            process.kill(state.pid);
            console.log(JSON.stringify({ ok: true, message: '已终止会话进程 ' + state.pid }));
          } catch {
            console.log(JSON.stringify({ ok: true, message: '会话已不存在' }));
          }
        }
      } else console.log(JSON.stringify(r, null, 2));
      return;
    }
    default:
      console.log(JSON.stringify({ ok: false, message: '未知子命令: ' + cmd + '，执行 help 查看' }));
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, message: String(e.message || e) }));
  process.exit(1);
});
