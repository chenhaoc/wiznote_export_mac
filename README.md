# WizNote Markdown 导出工具

在 macOS 上将为知笔记桌面端笔记导出为 Markdown，并尽量保留目录结构与本地资源。

这个项目的目标是帮助用户从为知笔记迁移到 Obsidian、思源笔记等其他工具。它直接读取本地为知桌面端 profile，并复用为知本地数据结构与部分编辑器转换链路。

English documentation: [README.en.md](README.en.md)

## 项目状态

- 仅支持 macOS
- 面向为知笔记桌面端本地 profile
- 不是为知官方工具
- 依赖对为知桌面端行为的观察与复用，未来版本更新可能导致失效
- 当前测试版本：WizNote for macOS `0.1.107`

## 可导出的内容

- 笔记目录树
- 笔记正文 Markdown
- 正文图片/资源到同级 `*.assets/` 目录
- 协作笔记中的正文文件链接附件
- 用于续跑、重试、校验的 manifest

本项目的主要迁移产物是 Markdown，不以原始 HTML 作为主要输出。

> ⚠️ **重要警告**
> `upgrade-legacy` 是一个会写回为知的操作。它会把旧 HTML 笔记转换成 `lite/markdown`，再把转换结果上传回为知。这会改变用户原笔记的类型，也可能改变原笔记的内容形态。如果你只想导出 Markdown，而不改动为知中的源笔记，应当使用普通 `export`。

## 当前导出策略

- 普通 `export` 对为知源数据是只读的。对于旧 HTML 笔记和较老的 `webnote` 剪藏，它可以直接把当前笔记内容转换成导出的 Markdown，而不会写回为知。
- `upgrade-legacy` 是可选步骤，但它会改写为知中的旧 HTML 笔记，把它们重写成 `lite/markdown`。
- 协作评论默认不导出。
- 所有导出都以 Markdown 为目标格式，包括旧网页剪藏。
- 协作笔记缺失资源时，可以回退到原始 WizNote profile 的本地缓存。
- manifest 采用短锁合并，方便多进程窄范围重试。

## 支持的笔记形态

- 协作笔记
- `lite/markdown` 笔记
- 旧 HTML 笔记，可直接导出为 Markdown
- 网页剪藏笔记，包括较老的 `webnote` 项
- 可选的旧普通 HTML 笔记写回升级流程：`upgrade-legacy`

极旧的笔记仍可能需要 fallback 转换或人工检查。

## 快速开始

环境要求：

- macOS
- 已安装为知笔记桌面端
- Node.js 24+
- 本机已安装 Google Chrome、Chromium 或 Microsoft Edge

检查本地准备情况：

```bash
npm run status
```

如果你用的是其他 Chromium 内核浏览器，也可以工作，但需要手工设置 `CHROME_PATH` 指向浏览器二进制路径，因为脚本的自动发现目前只检查上面这三个应用。

在大批量导出之前，先到为知 `设置 -> 同步设置` 中，将 `离线个人笔记` 和 `离线群组笔记（老笔记）` 都设成 `全部笔记`。当前测试版本的界面说明已经明确写明：这两项设置 **不含附件**。

设置完成后，建议先等待为知自己的后台同步把本地离线正文同步到位，再开始大批量导出。实际使用中，为知的离线同步即使在正常工作时也可能很慢，所以用户需要对这一步有耐心。**本地已同步完成** 的导出通常会明显更快，也更稳定。`--fetch-missing` 可以在不等待的情况下补抓缺失正文，但它本质上是补救路径，成功率和稳定性通常不如本地同步完成后的导出。

执行首次导出：

```bash
node scripts/wiz-export.js export --out ./export --fetch-missing
```

续跑已有导出：

```bash
node scripts/wiz-export.js export --out ./export --fetch-missing --attachments --resume
```

基于磁盘文件校验并重建 manifest：

```bash
node scripts/wiz-export.js verify --out ./export --rewrite-manifest
```

## 维护脚本

导出后的本地整理和校验可以直接用这些脚本：

```bash
npm run coedit-attachments
npm run clean:obsidian-tags
npm run fix:wiz-links
npm run find:missing-resources
```

- `coedit-attachments`：列出协作笔记里的 office/embed 附件元数据
- `clean:obsidian-tags`：清理误识别的 Obsidian 标签和部分 frontmatter 噪声
- `fix:wiz-links`：修正导出后带 `id=GUID` 的损坏 wikilink
- `find:missing-resources`：扫描导出目录里缺失或位置变动的本地资源引用

如果需要修正 moved 资源目录，可以直接运行：

```bash
node scripts/find-missing-local-resources.js ../export-wiznotes --fix-moved
```

## 输出结构

每篇笔记的输出形式：

```text
分类/子分类/笔记.md
分类/子分类/笔记.assets/
```

这样 Markdown、图片和本地文件链接会放在一起，复制或归档一个子目录时不会破坏相对路径。

## 文档索引

- [README.en.md](README.en.md)
- [docs/USAGE.md](docs/USAGE.md)
- [docs/USAGE.zh-CN.md](docs/USAGE.zh-CN.md)
- [docs/POST_IMPORT.md](docs/POST_IMPORT.md)
- [docs/POST_IMPORT.zh-CN.md](docs/POST_IMPORT.zh-CN.md)
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
- [docs/TROUBLESHOOTING.zh-CN.md](docs/TROUBLESHOOTING.zh-CN.md)
