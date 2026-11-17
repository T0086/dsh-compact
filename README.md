# dsh-compact

> 作者：空游

会话压缩相关的 DSH 插件（闲置自动压缩 + 手动压缩工具）

## 包含

- idle-compact：一段时间没人说话、且没有任务在跑时，把会话历史压成摘要
- auto-compact：把宿主的 compaction.compactNow() 暴露成工具，让定时任务能自己压缩

## 安装

每个子目录都是独立的 DSH bundle，分别安装：

    plugin_manager install_bundle "<path>\<subdir>"

## 说明

本仓库是归档：源码的活体在工作区，这里随发版同步。
