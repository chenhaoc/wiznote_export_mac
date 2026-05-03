# 使用说明

当前测试版本：WizNote for macOS `0.1.107`。

## 核心命令

检查本地准备状态：

```bash
npm run status
```

在大批量导出之前，建议先在为知里确认离线下载范围已经设成全部笔记：

1. 打开 `设置`
2. 打开 `同步设置`
3. 将 `离线个人笔记` 设为 `全部笔记`
4. 将 `离线群组笔记（老笔记）` 设为 `全部笔记`

在当前测试的为知版本中，这两项设置的说明都明确写着：**不含附件**。也就是说，这个设置只保证正文离线可用，附件仍然需要由导出脚本单独处理。

开启这两个设置后，不建议立刻开始大批量导出。更好的做法是先等待为知后台把笔记正文同步到本地。实际使用中，为知自己的离线同步即使在正常工作时也可能比较慢，所以“耐心等待同步完成”本身就是迁移流程的一部分。**本地已同步完成** 的导出通常更快，也更稳定。

`--fetch-missing` 适合“来不及等同步完成”的情况，但它更像补救路径，不应当被当作首选 happy path。

普通 `export` 对为知源数据是只读的。对于旧 HTML 笔记和较老的 `webnote` 内容，脚本可以直接把当前内容转换成导出的 Markdown，而不会改写为知里的原笔记。

导出全部笔记：

```bash
node scripts/wiz-export.js export --out ./export --fetch-missing
```

续跑已有导出：

```bash
node scripts/wiz-export.js export --out ./export --fetch-missing --attachments --resume
```

校验导出结果并重建 manifest：

```bash
node scripts/wiz-export.js verify --out ./export --rewrite-manifest
```

## 导出后整理

这些脚本适合“导出已经完成，但还想继续整理导出结果”的场景。

默认假设：

- 当前目录是 `wiznote_export_mac/`
- 导出的 vault 位于 `../export-wiznotes`

### `coedit-attachments`

查看协作笔记里的附件元数据：

```bash
npm run coedit-attachments
```

### `fix:wiz-links`

修正仍然带 `id=GUID` 的损坏 wikilink：

```bash
npm run fix:wiz-links
```

### `clean:obsidian-tags`

清理误识别的标签和 frontmatter 噪声：

```bash
npm run clean:obsidian-tags
```

### `find:missing-resources`

扫描缺失资源和 moved 资源：

```bash
npm run find:missing-resources
node scripts/find-missing-local-resources.js ../export-wiznotes --fix-moved
```

### `sync_note_file_times.py`

按笔记 frontmatter 回写 Finder 创建时间和修改时间：

```bash
python3 scripts/sync_note_file_times.py --mode conservative ../export-wiznotes
```

## 常见流程

### 1. 首次全量迁移

```bash
node scripts/wiz-export.js export --out ./export --fetch-missing --attachments --resume
```

### 2. 只导出协作笔记

```bash
node scripts/wiz-export.js export --out ./export --coedit-only --attachments
```

### 3. 只导出网页剪藏

```bash
node scripts/wiz-export.js export --out ./export --fetch-missing --resume --web-clips-only
```

### 4. 后补附件，不重转正文

```bash
node scripts/wiz-export.js export --out ./export --attachments-only
```

如果附件链路太慢，也可以拆开处理：

```bash
node scripts/wiz-export.js export --out ./export --legacy-attachments-only
node scripts/wiz-export.js export --out ./export --body-attachments-only
```

### 5. 先升级旧普通笔记，再导出

```bash
node scripts/wiz-export.js upgrade-legacy --out ./export --dry-run --limit 20
node scripts/wiz-export.js upgrade-legacy --out ./export --resume --yes
```

`upgrade-legacy` 不只是做元数据处理。它会先把旧普通 HTML 笔记转换成兼容为知的 `lite/markdown`，再通过为知 API 写回，之后后续导出才会把这些笔记当作普通 Markdown 笔记处理。

这个命令会改写为知中的原笔记。它会改变原笔记的类型，也可能改变原笔记的内容形态。现在脚本默认会要求二次确认；只有显式传入 `--yes` 才会跳过确认。

只有在你明确希望“把为知里的旧 HTML 笔记也改造成 `lite/markdown`”时，才应该使用 `upgrade-legacy`。如果你只是想导出 Markdown，请使用普通 `export`。

## 重要参数

- `--fetch-missing`：本地正文/资源缺失时，改为向为知服务端补抓
- `--resume`：跳过已经新鲜导出的笔记
- `--attachments`：导出时同时下载协作正文里的文件链接附件
- `--attachments-only`：仅补附件，不重转正文
- `--coedit-only`：只处理协作笔记
- `--web-clips-only`：只处理网页剪藏笔记
- `--skip-web-clips`：跳过网页剪藏笔记
- `--yes`：跳过 `upgrade-legacy` 的破坏性操作确认
- `--failed-only`：只重试 manifest 中记录为失败的笔记
- `--degraded-only`：只重试有损 fallback 导出
- `--only DOC_GUID`：只处理单篇笔记
- `--limit N`：限制处理数量
- `--note-timeout-ms N`：单篇笔记转换超时
- `--attachment-timeout-ms N`：单个附件/资源下载超时
- `--mode conservative`：用于 `sync_note_file_times.py`，优先使用 `date modified` / `date created`

## 输出文件

导出过程中会生成：

- Markdown 笔记文件
- 同级 `*.assets/` 资源目录
- `_wiz_export_manifest.json`
- 运行 `upgrade-legacy` 时生成 `_wiz_upgrade_manifest.json`

这个项目以 Markdown 为最终迁移产物，不以原始 HTML 为最终输出。普通 `export` 可以直接把旧 HTML 笔记和较老的 `webnote` 内容转换成导出的 Markdown，而不会写回为知。`upgrade-legacy` 才是那个会把旧普通 HTML 笔记在为知内部重写成 `lite/markdown` 的独立命令。

## Manifest 的作用

manifest 主要用于：

- 续跑判断
- 指定失败重试范围
- 记录资源/附件状态
- 做当前状态校验

如果中途中断或人工修补过导出结果，最快的恢复方式通常是：

```bash
node scripts/wiz-export.js verify --out ./export --rewrite-manifest
```
