---
name: wenshu-court-collector
display_name: 裁判文书采集器
display_name_en: Court Document Collector
description: 裁判文书采集器 - 中国裁判文书网（wenshu.court.gov.cn）检索、浏览与下载文书。使用场景：用户要求"查判决书/裁定书"、"检索某类案由的裁判文书"、"按案号找文书"、"下载判决书原文"、"要某个案件的裁判文书全文"。关键词：裁判文书、判决书、裁定书、中国裁判文书网、文书检索、案例检索、类案检索、案号查询、文书下载。双通道设计：接口快通道约 0.2 秒拿全文，失败自动降级为拟人通道（真实点击+页面渲染）。打开真实浏览器由用户本人登录，不代填验证码。
description_zh: 裁判文书采集器 - 中国裁判文书网检索、浏览与下载文书。双通道：接口快通道（约 0.2 秒读全文，省算力、不渲染页面）优先，被限流/验证码/接口变更时自动降级为拟人通道（真实输入、真实点击结果、读屏取证并截图确认）。打开真实浏览器由用户本人完成登录（未登录时持续提醒），支持官方原件下载，下载不可用（账号未实名/姓名不符/账号受限）时自动兜底提取全文生成 docx + txt。支持案由/法院/案号/裁判日期筛选与分页。
description_en: Court Document Collector — search, browse and download Chinese court documents from China Judgments Online (wenshu.court.gov.cn). Dual-channel design: a fast API channel (~0.2s full text, no page rendering) with automatic fallback to a human-like channel (real typing, real clicking on result rows, on-screen reading plus screenshot verification) when rate-limited, captcha-blocked, or the API changes. Opens a real browser and lets the user log in personally (repeated reminders while logged out). Supports official file download and, when download is unavailable (unverified account, name mismatch, restricted account), automatically extracts the full text into docx + txt. Supports filtering by cause of action, court, case number and judgment date, plus pagination.
version: 1.0.0
license: MIT
metadata:
  author: flybirp
  homepage: https://github.com/flybirp/wenshu-court-collector
  tags:
    - 裁判文书
    - 法律
    - 文书检索
    - 判决书
    - 数据采集
    - legal
    - court-documents
    - china-judgments-online
---

# 裁判文书采集器（Court Document Collector）

中国裁判文书网（wenshu.court.gov.cn）的检索、浏览、下载技能。真实浏览器 + 用户本人登录 + 双通道取数。

**双通道设计（同一套命令，自动选路）**

| 通道 | 做法 | 耗时 | 何时用 |
|---|---|---|---|
| **接口快通道**（默认） | 借已打开的站点页面调用站点自己的 `$.WebSite.getData`，或由 Node 直接 POST `/website/parse/rest.q4w`（3DES 加密与反爬参数全部自动复刻） | 检索 ~0.4s / 读全文 **~0.18s** | 日常首选，省算力、不开新标签、不渲染页面 |
| **拟人通道**（兜底） | 真实输入关键词 → 真实点击结果条目 → 等页面渲染 → 读屏幕上 `.PDF_pox` 的正文 → 截图视觉确认 | 检索 6-10s / 读全文 3-6s | 快通道被限流/验证码/接口变更时；或需要让用户"看到"页面时 |

`--mode auto`（默认）先走快通道，失败自动降级拟人通道并回报原因；`--mode fast` 只用接口；
`--mode human` 强制走拟人通道（会打开页面、返回截图）。

## 何时使用

用户提出类似需求时触发：

- "查一下关于 XX 的判决书"
- "帮我找（2024）最高法民再 173 号"
- "检索建设工程施工合同违约金相关的裁判文书"
- "把这份判决书原文下载下来"
- "最近最高法关于保证合同的案例"

## 快速开始

```bash
SKILL=~/.workbuddy/skills/wenshu-court-collector
cd $SKILL && npm install                     # 首次：安装 playwright-core

node $SKILL/scripts/cli.mjs start            # 启动：弹出浏览器，未登录则停在登录页（幂等，SSO 有效期内自动静默登录）
node $SKILL/scripts/cli.mjs status --wait --timeout 300   # 等待用户登录（每隔几秒输出提醒）
node $SKILL/scripts/cli.mjs search "民间借贷 利息" --out /tmp/r.json
node $SKILL/scripts/cli.mjs read --doc-id <docId> --out /tmp/doc.json
node $SKILL/scripts/cli.mjs download --doc-id <docId>
```

## 安装（作为 WorkBuddy / CodeBuddy skill）

```bash
# WorkBuddy（git clone 或下载 ZIP 解压到 skills 目录）
git clone https://github.com/flybirp/wenshu-court-collector.git \
  ~/.workbuddy/skills/wenshu-court-collector
# 或 CodeBuddy
# git clone https://github.com/flybirp/wenshu-court-collector.git \
#   ~/.codebuddy/skills/wenshu-court-collector

cd ~/.workbuddy/skills/wenshu-court-collector && npm install
```

依赖 Node.js 18+ 与本机已安装的 Chrome（通过 `playwright-core` 的 `channel: 'chrome'` 驱动，不额外下载浏览器）。

## 核心规则（务必遵守）

1. **登录是人工环节**：`start` 弹出浏览器；未登录时停在登录页（手机号+验证码 / 扫码）。
   绝不代替用户输入验证码。未登录时执行操作会返回 `needLogin:true` —— 明确提醒用户去浏览器
   窗口登录，然后 `status --wait`。登录态由 SSO cookie 保持，通常重启会话也能静默续登。
2. **快通道依赖一个站点页面存在**：接口调用要借页面的 `cipher()`（时间戳密文）与
   `__RequestVerificationToken`。若当前没有任何站点页面，会自动新建一个检索页（约 2s，只发生一次）。
   后续调用复用，常态耗时为百毫秒级。
3. **拟人通道有前置条件**：从检索结果点击进入，必须先让列表在页面上渲染出来。`--mode human`
   会自己处理"没有列表就先渲染一次检索"的逻辑；但**直接拼 URL 打开详情页会被站点判「权限已失效」**，
   不要绕过点击流。
4. **视觉确认**：`--mode human` 与 `screenshot` 会返回截图路径，拿不准时（验证码、权限提示、页面空白）
   直接查看图片确认，并把看到的转告用户。页面出现滑块/图片验证码时提醒用户手动完成。
5. **用后即停**：任务结束执行 `stop` 关闭浏览器。
6. **礼貌使用**：操作之间保留自然节奏，勿高频重试。仅限个人正当研究用途，遵守网站条款，
   不得批量抓取或转售文书数据。

## 命令一览（均为 `node $SKILL/scripts/cli.mjs <cmd>`）

| 命令 | 说明 |
|---|---|
| `start` | 启动常驻会话（幂等）。未登录 → 登录页；已登录 → 自动进检索页 |
| `status` | 登录状态（JSON）。`--wait --timeout 秒` 持续等待并反复输出提醒 |
| `search "关键词" [--page N] [--size 5\|10\|15] [--court 法院] [--case-no 案号] [--cause 案由] [--date-from] [--date-to] [--sort s50:desc] [--mode]` | 检索。返回 `total` 与 `items[]`（docId/标题/法院/案号/日期/案由/理由摘要） |
| `read --doc-id ID \| --url URL [--mode auto\|fast\|human] [--open] [--out f.json]` | 读全文。`--open` 保留页面（仅 human 通道有意义） |
| `download --doc-id ID [--dir 目录] [--name 名] [--force-extract]` | 下载；不可用自动兜底。`--force-extract` 跳过官方通道直接提取 |
| `open --url URL \| --page login\|home\|search` | 在浏览器打开页面 |
| `screenshot [--path f.png]` | 截当前（最后一个）标签页 |
| `stop` | 关闭会话与浏览器 |

返回结果里用 `mode`/`path`/`via` 标明实际走的路：

- `mode:"api"` + `via:"node"` → Node 直发接口（最快）
- `mode:"api"` + `via:"page"` → 借页面调接口（检索固定走这条，保证与搜框结果一致）
- `mode:"ui"` / `path:"human"` → 拟人通道，`fallbackReason` 说明为何降级

## 检索语义

- 关键词按空格拆成多个 `s21`（全文）条件，与页面搜框行为一致（同条件实测命中数完全相同）。
- 同 key 多条件在 **Node 直发**时会被服务端判空，所以检索固定走页面通道；读全文才用 Node 直发。
- `--court`→`s2`、`--case-no`→`s7`、`--cause`→`s11`、`--date-from/--date-to`→`cprq`（`起 TO 止`）。
- 列表里的案由代码用站点 `spcxs` 码表换成文字（与页面显示一致）。
- **docId 是一次性密文**：同一条文书每次检索返回的 docId 前缀相同、尾部不同（会话级加密）。
  短会话内可直接复用（read/download 都能解析）；跨会话或长时间后可能失效 —— 失效时重新检索
  拿新 docId 即可。**不要把 docId 当稳定 ID 持久化**，跨请求比对文书请用 `caseNo`。
- **拟人通道只回放关键词**：`--court/--case-no/--cause/--date-*` 筛选仅在快通道生效；
  拟人通道带了这些参数时结果会带 `warnings` 明确说明未应用，不要忽略该告警。

## 下载与兜底逻辑（已内置）

下载前先调站点 `/down/isDown` 探测权限：

- `code=0` → 官方通道 `/down/one`，保存原始 .doc/.zip（中文名自动解码），`mode:"download"`。
- `code=1/2/3`（账号受限/未实名/姓名与当事人不符）或接口异常 → **自动兜底**：先走快通道拿全文
  （约 0.2s），生成 `.docx` + `.txt`（以案号命名），`mode:"extract"`，`reason` 说明具体原因。
- 结果里 `files:[docx,txt]` 可直接交付。兜底 docx 为"全文提取版"（仿宋、首行缩进），非官方原版。

下载目录默认 `~/Downloads/wenshu-docs/`（`--dir` 覆盖，或环境变量 `WENSHU_DL_DIR`）。

## 结果要点速查

- `search`：`needLogin` → 提醒登录；`captcha`/`timeout` → 让用户看浏览器窗口（可能有验证码）。
- `read`：`path:"api"` 快、`path:"human"` 慢但可见；`permissionError:true` → 该文书当前读不了正文
  （重新检索后再试，或文书已下架/不公开）；`screenshot` 可视觉核对。
- `download`：`mode:"download"` 官方原版；`mode:"extract"` 兜底提取版。

## 故障排查

- 日志：`tail -50 $SKILL/.session.log`（含每次站点响应的 code/长度、快通道降级原因）。
- 会话僵死：`stop` 后 `start`。
- 快通道突然全面失败（`code:-11` 要验证码 / `-4` 未登录 / `-14` IP 黑名单）→ 用 `--mode human`
  走拟人通道，请用户在浏览器里完成验证码；或 `stop` 后重开。
- 站点改版：接口细节见 `references/site.md`；选择器集中在 `scripts/session.mjs`
  （搜索框 `input.searchKey`、结果 `.LM_list`、正文 `.PDF_pox`、下载按钮 `a.a_xz`）。

## License

MIT © flybirp
