---
title: "Cloud 与提供商路由说明"
sidebarTitle: "Cloud 与路由"
description: "解释 Cloud 连接、推理路由、BYOK 切换与额度消耗之间的关系。"
---

# Cloud 与提供商路由说明

本页只回答一个问题：当前请求到底走谁来推理，什么时候会消耗 Cloud 额度。

## 路由规则速览

| Cloud 连接状态 | 云端推理开关 | 当前提供商 | 推理走向 |
|---|---|---|---|
| 未连接 | 关闭/开启均无效 | BYOK 提供商 | BYOK |
| 已连接 | 开启 | Eliza Cloud | Cloud |
| 已连接 | 开启 | BYOK 提供商 | 以配置为准（推荐显式关闭云端推理） |
| 已连接 | 关闭 | BYOK 提供商 | BYOK |

建议：如果你明确要走 BYOK，请在设置里关闭云端推理，避免认知混淆。

## 额度消耗何时发生

- 走 Cloud 推理时，会按 Cloud 计费与扣减额度。
- 走 BYOK 推理时，模型调用由你的提供商账户计费。
- 即使保持 Cloud 已连接，只要推理不走 Cloud，就不会产生对应的 Cloud 推理消耗。

## 推荐操作顺序

1. 先确定目标：`只用 Cloud` 或 `Cloud + BYOK`。
2. 在提供商设置中选择主推理提供商。
3. 若选择 BYOK，显式关闭云端推理。
4. 保存后如出现重启提示，完成重启再验证。

## 验证清单

- 聊天回复是否来自预期模型。
- Cloud 余额是否按预期变化。
- 设置页是否提示“需要重启”。

## 相关文档

- [中文入门：安装、引导与支持](/zh/guides/onboarding-and-support)
- [Eliza Cloud Integration](/guides/cloud)
- English: [Cloud and provider routing](/guides/cloud-provider-routing)

