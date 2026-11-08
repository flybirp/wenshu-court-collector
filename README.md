# wenshu-court-collector

裁判文书采集器（Court Document Collector）—— 中国裁判文书网（[wenshu.court.gov.cn](https://wenshu.court.gov.cn)）的检索、浏览与下载技能。

给一句话，拿到文书：「查一下建设工程施工合同违约金相关的判决书」「帮我找（2024）最高法民再173号」「把这份裁定书全文存成 Word」。

## 特性

- **双通道取数**：接口快通道读全文约 **0.18 秒**（不渲染页面、不开新标签）；被限流、验证码、接口变更时自动降级为**拟人通道**（真实输入、真实点击结果条目、读屏取证、截图确认）
- **登录交给人**：打开真实浏览器停在登录页，你不登就一直提醒你，绝不代填验证码；登录态靠 SSO cookie 保持，重启会话通常可静默续登
- **官方原件下载**：能下就下原始 `.doc`（保留法院原始排版），中文文件名自动解码
- **下载不可用自动兜底**：账号未实名 / 姓名与当事人不符 / 账号受限时，自动提取全文生成 `.docx` + `.txt`，以案号命名，正文完整（含合议庭署名与裁判日期）
- **筛选与分页**：案由、法院、案号、裁判日期区间，每页 5/10/15，可按裁判日期排序
- **案由代码自动翻译**：接口返回的案由是 `0307` 这类代码，自动用站点码表换成「建设工程施工合同纠纷」
- **视觉可核对**：拟人通道与 `screenshot` 都留截图，遇到验证码、权限提示、空白页时可肉眼确认

## 安装（作为 WorkBuddy / CodeBuddy skill）

将本仓库解压到 skills 目录：

```bash
# WorkBuddy
unzip wenshu-court-collector.zip -d ~/.workbuddy/skills/
# 或 CodeBuddy
unzip wenshu-court-collector.zip -d ~/.codebuddy/skills/
```

安装依赖（只需一次）：

```bash
cd ~/.workbuddy/skills/wenshu-court-collector
npm install
```

要求：

- Node.js 18+
- 本机已安装 **Chrome**（通过 `playwright-core` 的 `channel: 'chrome'` 驱动，不会额外下载浏览器）
- 一个可登录裁判文书网的账号（检索与下载需登录）

## 独立使用

```bash
SKILL=~/.workbuddy/skills/wenshu-court-collector

node $SKILL/scripts/cli.mjs start                          # 弹出浏览器，未登录则停在登录页
node $SKILL/scripts/cli.mjs status --wait --timeout 300     # 等用户登录（持续提醒）
node $SKILL/scripts/cli.mjs search "民间借贷 利息" --size 10
node $SKILL/scripts/cli.mjs read --doc-id "<docId>"
node $SKILL/scripts/cli.mjs download --doc-id "<docId>"
node $SKILL/scripts/cli.mjs stop                            # 用完关掉浏览器
```

### 命令

| 命令 | 说明 |
|------|------|
| `start` | 启动常驻会话（幂等）。未登录 → 登录页；已登录 → 自动进检索页 |
| `status [--wait] [--timeout 秒]` | 查询登录状态；`--wait` 持续等待并反复提醒 |
| `search "关键词" [选项]` | 检索，返回 `total` 与 `items[]` |
| `read --doc-id ID \| --url URL [--mode] [--open]` | 读文书全文 |
| `download --doc-id ID [--dir] [--name] [--force-extract]` | 下载原件；不可用自动兜底 |
| `open --url URL \| --page login\|home\|search` | 在浏览器中打开页面（供人工浏览） |
| `screenshot [--path f.png]` | 截当前页面（调试/视觉核对） |
| `stop` | 关闭会话与浏览器 |

### search 选项

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `--page` | 页码 | 1 |
| `--size` | 每页条数，仅支持 `5` / `10` / `15` | 10 |
| `--court` | 法院名称 | - |
| `--case-no` | 案号 | - |
| `--cause` | 案由 | - |
| `--date-from` / `--date-to` | 裁判日期区间（`YYYY-MM-DD`） | - |
| `--sort` | 排序字段，如 `s50:desc`（裁判日期倒序） | `s50:desc` |
| `--mode` | `auto` / `fast` / `human` | `auto` |
| `--out` | 结果写入 JSON 文件 | - |

### read / download 模式

| 模式 | 行为 |
|------|------|
| `auto`（默认） | 先走接口快通道，失败自动降级拟人通道 |
| `fast` | 只用接口，最快（读全文约 0.2s） |
| `human` | 强制拟人通道：真实点击结果条目、等页面渲染、读屏、截图 |

`download` 另有 `--force-extract`：跳过官方下载通道，直接提取全文生成 docx/txt。

### 示例

```bash
# 检索某类纠纷的近期判决
node $SKILL/scripts/cli.mjs search "建设工程施工合同 违约金" --size 10 --date-from 2025-01-01

# 按案号精确找
node $SKILL/scripts/cli.mjs search "保证合同" --case-no "（2024）最高法民申1313号"

# 只看最高法的
node $SKILL/scripts/cli.mjs search "破产重整申请" --court 最高人民法院

# 读全文（默认自动选最快通道）
node $SKILL/scripts/cli.mjs read --doc-id "<docId>" --out /tmp/doc.json

# 强制拟人通道，并把页面留在窗口里给人看
node $SKILL/scripts/cli.mjs read --doc-id "<docId>" --mode human --open

# 下载原件；不可用则自动生成 docx + txt
node $SKILL/scripts/cli.mjs download --doc-id "<docId>" --dir ~/Downloads/裁判文书
```

## 返回结构

`search`：

```json
{
  "ok": true,
  "mode": "api",
  "via": "page",
  "ms": 206,
  "total": 200854,
  "count": 10,
  "items": [
    {
      "docId": "...",
      "title": "某某公司、某某公司建设工程施工合同纠纷民事再审民事判决书",
      "court": "最高人民法院",
      "caseNo": "（2024）最高法民再173号",
      "date": "2025-06-30",
      "caseCause": "民事再审",
      "reason": "本院再审认为……"
    }
  ]
}
```

`read`：`path` 为 `api` 或 `human`，含 `text`（全文）、`charCount`、`meta`、`paragraphs`（结构化段落）。

`download`：`mode` 为 `download`（官方原件）或 `extract`（兜底生成），`path` 与 `files` 给出落盘位置。

## 实现说明

- **为什么有两个通道**：接口通道借已打开的站点页面调用站点自身的 `$.WebSite.getData`，加密（3DES 时间戳密文）与反爬校验参数（`__RequestVerificationToken`、窗口宽高滚动量）全部由页面自动完成，因此又快又稳；但站点限流或改版时接口会失效，此时退回"像人一样"的点击流仍能拿到正文。
- **检索固定走页面通道**：同一 key 的多个条件在 Node 直发时会被服务端判空，页面通道则正常，且结果与搜索框完全一致。
- **拟人通道必须先有结果列表**：直接拼详情页 URL 会被判「权限已失效」，必须通过点击结果条目进入。
- **检索条件会累积**：站点把每个检索词渲染成筛选栏标签，提交时把所有现存标签拼进查询条件。拟人通道每次检索前会逐个点掉标签的 ×，否则本次关键词会被历史词以 AND 方式无声污染。
- **docId 是一次性密文**：同一文书每次检索返回的 docId 前缀相同、尾部不同。短期可复用，跨会话可能失效——比对文书请用案号。
- 详细接口与踩坑记录见 [`references/site.md`](references/site.md)。

## 注意事项

- **登录必须本人完成**：脚本只负责把浏览器停到登录页并反复提醒，不会代填手机号/验证码。
- **合规使用**：仅限个人正当研究、学习用途。请遵守网站服务条款与相关法律法规，不要高频请求、批量抓取或转售文书数据。
- 文书是否公开、能否下载由站点与账号权限决定；遇到「权限已失效」「文书不存在」属站点侧限制，脚本会如实报错而不是伪造内容。

## License

MIT © flybirp
