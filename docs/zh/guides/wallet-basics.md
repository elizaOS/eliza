---
title: "钱包基础（中文）"
sidebarTitle: "钱包基础"
description: "中文钱包速查：创建、导入、余额检查与常见故障定位。"
---

# 钱包基础（中文）

Eliza 内置 EVM + Solana 钱包能力。本页给出最常用的操作与排错路径。

## 1. 首次使用

- 在钱包页生成或导入地址。
- 复制地址给钱包充值后再查看资产。
- 若要读取链上余额，先配置对应 RPC/数据提供商密钥。

## 2. 常用接口速查

- `GET /api/wallet/addresses`：查看地址
- `GET /api/wallet/balances`：查看余额
- `POST /api/wallet/import`：导入私钥
- `POST /api/wallet/generate`：生成新钱包

## 3. 安全建议

- 私钥不要提交到仓库或聊天记录。
- 导出私钥前确认你在受信任环境。
- 生产环境建议启用最小权限与审计。

## 4. 常见问题

### 看不到余额

- 检查 API Key（如 Alchemy/Helius）是否已配置。
- 检查地址是否有入账。
- 重试后仍失败，查看后端日志中的链路错误。

### 导入私钥失败

- EVM 私钥应为 64 位十六进制（可含 `0x` 前缀）。
- Solana 私钥应为有效 Base58 且长度合法。

### 切换了提供商后钱包能力异常

- 先确认并非推理路由问题（见 Cloud/BYOK 文档）。
- 按提示重启后再验证。

## 5. 进一步阅读

- [Wallet & Crypto](/guides/wallet)
- [Cloud 与提供商路由说明](/zh/guides/cloud-provider-routing)

