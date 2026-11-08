# 裁判文书网站点技术备忘

> 最后实测：2026-11，站点结构若有变动，按此文档逐项复核。

## 页面与 URL

| 用途 | 路径 |
|---|---|
| 登录页 | `/website/wenshu/181010CARHS5BS3C/index.html?open=login`（登录框是 `account.court.gov.cn` 的 SSO iframe） |
| 检索页 | `/website/wenshu/181217BMTKHNT2W0/index.html` |
| 详情页 | `/website/wenshu/181107ANFZ0BXSK4/index.html?docId=<docId>` |
| 数据接口 | `POST /website/parse/rest.q4w` |

登录态判断：页面 `#loginLi` 文案（`欢迎您，xxx` = 已登录，`登录` = 未登录）。**不要只看 cookie**。

## 数据接口

全部数据请求都走 `$.WebSite.getData({cfg, param, rollback, error})`，内部 POST 到 `rest.q4w`，
自动附加 token 与校验参数，并用下发的 `secretKey` 解密响应。

### cfg 取值

| 功能 | cfg |
|---|---|
| 检索 | `com.lawyee.judge.dc.parse.dto.SearchDataDsoDTO@queryDoc` |
| 详情全文 | `com.lawyee.judge.dc.parse.dto.SearchDataDsoDTO@docInfoSearch` |
| 当前用户 | `com.lawyee.wbsttools.web.parse.dto.AppUserDTO@currentUser` |

### 请求体字段

```
sortFields=s50:desc
pageNum=1
pageSize=10
queryCondition=[{"key":"s21","value":"民间借贷"}]
docId=<docId>
ciphertext=<见下>
cfg=<上表>
__RequestVerificationToken=<页面 input[name=__RequestVerificationToken] 的值>
wh=<窗口内高>  ww=<窗口内宽>  cs=0
```

### ciphertext 算法（`js/strToBinary.js`）

```js
salt = 24 位随机字母数字
iv   = yyyyMMdd（站点原逻辑有 bug：>=10 月时月份取 getMonth()，10 月即 "9"）
enc  = 3DES_CBC_PKCS7(plaintext = String(Date.now()), key = salt, iv = iv)   // Base64
ciphertext = (salt + iv + enc) 逐字符 charCodeAt().toString(2)，用空格连接
```

服务端解出 timestamp 校验新鲜度。Node 实现见 `scripts/session.mjs` 的 `buildCiphertext()`。

### 响应

```json
{ "code": 1, "success": true, "secretKey": "…", "result": "<3DES 密文 或 对象>" }
```

- 有 `secretKey` 且 `result` 是字符串 → `3DES_CBC_PKCS7.decrypt(result, key=secretKey, iv=yyyyMMdd)`，
  明文再 `JSON.parse`。
- 无 `secretKey` → `result` 已是对象（如 `currentUser`）。

### 错误码

| code | 含义 |
|---|---|
| 1 | 成功 |
| -4 | 未登录 |
| -11 | 访问过于频繁，需验证码 |
| -12 | 未实名认证（跳 noauth.html） |
| -14 | IP 进入黑名单（跳 blackip.html） |
| 9 | 参数解析失败（如 queryCondition 被二次编码） |

## 详情字段对照（docInfoSearch 返回）

| 字段 | 含义 |
|---|---|
| `s1` | 标题 |
| `s2` | 审理法院 |
| `s7` | 案号 |
| `s8` | 案件类型 |
| `s9` | 案件类型代码 |
| `s10` | 审理程序 |
| `s31` | 裁判日期 |
| `s41` | 发布日期 |
| `s47` | 法律依据列表 |
| `wenshuAy` | 案由数组（`text` 是文字） |
| `qwContent` | **全文 HTML**（可能含 `<!DOCTYPE…><HTML>…` 外壳，直接 strip 标签即可） |
| `relWenshu` | 关联文书 |
| `viewCount` | 浏览次数 |

## 检索结果字段（queryDoc → queryResult.resultList）

数组索引式结构：`[1]` 标题（含高亮 `<em>`）、`[2]` 法院、`[7]` 案号、`[9]/[10]` 案由代码、
`[26]` 理由片段、`[31]` 裁判日期、`[43]` 类型标志、`rowkey` = **docId**。
`queryResult.resultCount` 为命中总数。

案由代码用页面全局 `window.spcxs` 映射成文字（与列表显示一致）。

## 踩坑记录

1. **详情页不能直拼 URL 打开** —— 直接 `goto` 会被判「权限已失效」（`description: "权限已失效"`），
   正文空白。必须从检索结果列表真实点击进入（点击流）。这是拟人通道存在的原因。
2. **接口 docId 与页面 docId 尾部不同** —— `docInfoSearch` 用 `rowkey`，列表 `href` 里的 docId
   前半段相同、尾部后缀不同。点击匹配必须用**前缀**（取前 80 字符），不能用全等。
3. **多 s21 条件在 Node 直发时返回 0 条**（同样的 form 在页面 `getData` 里正常）。因此检索固定走
   页面通道；详情接口 Node 直发正常（实测 130-200ms）。
4. `queryCondition` 的 value 里若含空格，Node 直发需写成 `%20`；整串 `encodeURIComponent` 反而会失败。
5. `pageSize` 只支持 5/10/15，传其它值会静默超时。
6. 后台/未聚焦窗口会触发渲染节流，截图里 SSO iframe 显示为红块（假象）——截图前必须 `bringToFront()`，
   并停留 ~800ms。
7. `networkidle` 在该站会挂起，一律用 `domcontentloaded` + 轮询判断。
8. 检索结果列表是异步替换的，旧 `.LM_list` 还在 DOM 里时新结果未到；点击要**轮询等待**目标链接出现。
9. **检索条件标签只增不减**（2026-11-08 回测发现）—— 站点把每个检索词渲染成筛选栏标签
   `.LT_Filter_right p`（带 `i.fa-close` 关闭按钮），提交检索时 `addParams` 把**所有**现存标签拼进
   `queryCondition`。不清空的话，本次关键词会被历史词以 AND 方式无声污染（实测：单搜
   「破产重整申请」应为 29955 条，被两个历史词夹带后只剩 357 条）。拟人通道每次检索前必须
   逐个点击标签的 × 清空条件；localStorage 里的镜像（`wenshuListInfo.searchItem` / `$listparams`）
   也要一并清掉，否则页面初始化会把旧条件回填成标签。**只清 localStorage + reload 无效**：
   卸载前内存值会覆盖回去。
10. **docId 是一次性密文** —— 同一条文书每次检索返回的 docId 前缀（约 88 字符）相同、尾部不同，
   是会话级加密标识。跨请求比对文书用 `caseNo`；docId 短期内可复用，长期/跨会话可能失效。
11. 拟人通道只回放关键词：法院/案号/案由/日期筛选需要操作高级检索面板（未实现），
   带这些参数跑 `--mode human` 时结果里会带 `warnings` 告知未应用。
12. 兜底 docx 曾因返回体漏传 `paragraphs` 只剩标题+元信息（1.5KB vs 正确的 10KB）——
   现在 read 两条路径都返回 `paragraphs`，且兜底生成时若段落为空会退化为按行切分正文。

## 下载

- `POST /down/isDown`（form: `docId`）→ `code=0` 可下载，`1/2/3` 分别对应账号受限/未实名/姓名不符。
- `GET /down/one?docId=<docId>` → 原始文件（`application/msword` 或 zip）。
- `content-disposition` 里的中文文件名是 URL 编码的，**必须 decodeURIComponent**，否则写盘 ENAMETOOLONG。
