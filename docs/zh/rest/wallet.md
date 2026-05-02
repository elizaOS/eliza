---
title: "钱包 API"
sidebarTitle: "Wallet"
description: "用于管理 EVM 和 Solana 钱包、余额、NFT 和密钥的 REST API 端点。"
---

钱包 API 提供对代理在 EVM 兼容链和 Solana 上的链上身份的访问。余额和 NFT 查询需要通过 `PUT /api/wallet/config` 配置 API 密钥（EVM 需要 Alchemy，Solana 需要 Helius）。

<Warning>
`POST /api/wallet/export` 端点以明文形式返回私钥。它需要显式确认，并作为安全事件记录。
</Warning>

<div id="endpoints">

## 端点

</div>

<div id="get-apiwalletaddresses">

### GET /api/wallet/addresses

</div>

获取代理的 EVM 和 Solana 钱包地址。

**响应**

```json
{
  "evmAddress": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  "solanaAddress": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHU"
}
```

---

<div id="get-apiwalletbalances">

### GET /api/wallet/balances

</div>

获取所有支持链上的代币余额。EVM 链需要 `ALCHEMY_API_KEY`，Solana 需要 `HELIUS_API_KEY`。对于未配置所需 API 密钥的链，返回 `null`。

**响应**

```json
{
  "evm": {
    "address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "chains": [
      {
        "chainId": 1,
        "name": "Ethereum",
        "nativeBalance": "1.5",
        "tokens": []
      }
    ]
  },
  "solana": {
    "address": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHU",
    "nativeBalance": "2.5",
    "tokens": []
  }
}
```

---

<div id="get-apiwalletnfts">

### GET /api/wallet/nfts

</div>

获取代理在 EVM 链和 Solana 上持有的 NFT。EVM 需要 `ALCHEMY_API_KEY`，Solana 需要 `HELIUS_API_KEY`。

**响应**

```json
{
  "evm": [
    {
      "contractAddress": "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D",
      "tokenId": "1234",
      "name": "Bored Ape #1234",
      "imageUrl": "https://..."
    }
  ],
  "solana": {
    "nfts": []
  }
}
```

---

<div id="get-apiwalletconfig">

### GET /api/wallet/config

</div>

获取钱包 API 密钥配置状态、RPC 提供者选择和当前钱包地址。不返回密钥值，仅返回其设置/未设置状态。

当启用云钱包功能（`ENABLE_CLOUD_WALLET=1`）时，响应包含额外的 `wallets` 和 `primary` 字段，用于描述所有可用钱包（本地和云端）以及每条链的主要来源。`evmAddress` 和 `solanaAddress` 字段反映当前作为主钱包的地址。

**响应**

```json
{
  "selectedRpcProviders": {
    "evm": "alchemy",
    "bsc": "alchemy",
    "solana": "helius-birdeye"
  },
  "walletNetwork": "mainnet",
  "legacyCustomChains": [],
  "alchemyKeySet": true,
  "infuraKeySet": false,
  "ankrKeySet": false,
  "nodeRealBscRpcSet": false,
  "quickNodeBscRpcSet": false,
  "managedBscRpcReady": false,
  "cloudManagedAccess": false,
  "heliusKeySet": true,
  "birdeyeKeySet": false,
  "evmChains": ["ethereum", "base"],
  "evmAddress": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  "solanaAddress": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHU",
  "walletSource": "local",
  "automationMode": "user-sign-only",
  "pluginEvmLoaded": true,
  "pluginEvmRequired": false,
  "executionReady": true,
  "executionBlockedReason": null,
  "solanaSigningAvailable": true
}
```

**启用云钱包时的额外字段**

当 `ENABLE_CLOUD_WALLET` 处于激活状态时，响应还包含：

```json
{
  "wallets": [
    {
      "source": "local",
      "chain": "evm",
      "address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      "provider": "local",
      "primary": false
    },
    {
      "source": "cloud",
      "chain": "evm",
      "address": "0x1234...abcd",
      "provider": "privy",
      "primary": true
    },
    {
      "source": "local",
      "chain": "solana",
      "address": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHU",
      "provider": "local",
      "primary": true
    }
  ],
  "primary": {
    "evm": "cloud",
    "solana": "local"
  }
}
```

| 字段 | 类型 | 描述 |
|------|------|------|
| `selectedRpcProviders` | object | 每条链（`evm`、`bsc`、`solana`）当前选择的 RPC 提供者 |
| `walletNetwork` | string | 活动钱包网络（`"mainnet"` 或 `"testnet"`） |
| `legacyCustomChains` | array | 遗留自定义链配置（可能为空） |
| `alchemyKeySet` | boolean | 是否已配置 Alchemy API 密钥 |
| `infuraKeySet` | boolean | 是否已配置 Infura API 密钥 |
| `ankrKeySet` | boolean | 是否已配置 Ankr API 密钥 |
| `nodeRealBscRpcSet` | boolean | 是否已配置 NodeReal BSC RPC 端点 |
| `quickNodeBscRpcSet` | boolean | 是否已配置 QuickNode BSC RPC 端点 |
| `managedBscRpcReady` | boolean | 是否有可用的托管 BSC RPC 端点 |
| `cloudManagedAccess` | boolean | 钱包访问是否通过 Eliza Cloud 管理 |
| `heliusKeySet` | boolean | 是否已配置 Helius API 密钥 |
| `birdeyeKeySet` | boolean | 是否已配置 Birdeye API 密钥 |
| `evmChains` | string[] | 活动 EVM 链列表 |
| `evmAddress` | string \| null | 当前主 EVM 钱包地址 |
| `solanaAddress` | string \| null | 当前主 Solana 钱包地址 |
| `walletSource` | string | 活动钱包来源（`"local"`、`"cloud"` 等） |
| `automationMode` | string | 当前交易自动化模式 |
| `pluginEvmLoaded` | boolean | EVM 插件是否已加载 |
| `pluginEvmRequired` | boolean | 是否需要 EVM 插件 |
| `executionReady` | boolean | 交易执行是否就绪 |
| `executionBlockedReason` | string \| null | 执行被阻止的原因（如有） |
| `solanaSigningAvailable` | boolean | Solana 交易签名是否可用（本地密钥或云端作为主钱包） |
| `wallets` | array | 本地和云端来源的所有钱包条目（仅在启用云钱包时） |
| `wallets[].source` | string | `"local"` 或 `"cloud"` |
| `wallets[].chain` | string | `"evm"` 或 `"solana"` |
| `wallets[].address` | string | 钱包地址 |
| `wallets[].provider` | string | `"local"`、`"privy"` 或 `"steward"` |
| `wallets[].primary` | boolean | 此钱包是否为其链的主钱包 |
| `primary` | object | 将每条链映射到其主钱包来源（仅在启用云钱包时） |
| `primary.evm` | string | `"local"` 或 `"cloud"` |
| `primary.solana` | string | `"local"` 或 `"cloud"` |

---

<div id="put-apiwalletconfig">

### PUT /api/wallet/config

</div>

更新钱包 API 密钥和 RPC 提供者选择。您可以在单个请求中设置 API 密钥、按链切换 RPC 提供者，或两者同时进行。设置 `HELIUS_API_KEY` 也会自动配置 `SOLANA_RPC_URL`。

当所有 RPC 提供者选择都设置为 `"eliza-cloud"` 时，云钱包功能开关（`ENABLE_CLOUD_WALLET`）会自动启用。

**请求（API 密钥）**

```json
{
  "ALCHEMY_API_KEY": "alchemy-key-here",
  "HELIUS_API_KEY": "helius-key-here"
}
```

**请求（RPC 提供者选择）**

使用 `selections` 字段为一条或多条链切换 RPC 提供者。例如，将一条链设置为 `"eliza-cloud"` 会将 RPC 访问委托给 Eliza Cloud。

```json
{
  "selections": {
    "evm": "eliza-cloud",
    "bsc": "eliza-cloud",
    "solana": "eliza-cloud"
  }
}
```

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `ALCHEMY_API_KEY` | string | 否 | 用于 EVM 余额/NFT 查询的 Alchemy API 密钥 |
| `INFURA_API_KEY` | string | 否 | Infura API 密钥 |
| `ANKR_API_KEY` | string | 否 | Ankr API 密钥 |
| `HELIUS_API_KEY` | string | 否 | 用于 Solana 查询的 Helius API 密钥 — 也会设置 `SOLANA_RPC_URL` |
| `BIRDEYE_API_KEY` | string | 否 | 用于 Solana 代币价格的 Birdeye API 密钥 |
| `selections` | object | 否 | 将链标识符（`evm`、`bsc`、`solana`）映射到 RPC 提供者名称（例如 `"alchemy"`、`"eliza-cloud"`） |

**响应**

```json
{
  "ok": true
}
```

---

<div id="post-apiwalletimport">

### POST /api/wallet/import

</div>

为 EVM 或 Solana 导入现有私钥。如果未指定，链会自动检测。

**请求**

```json
{
  "privateKey": "0xabc123...",
  "chain": "evm"
}
```

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `privateKey` | string | 是 | 要导入的私钥 |
| `chain` | string | 否 | `"evm"` 或 `"solana"` — 省略时自动检测 |

**响应**

```json
{
  "ok": true,
  "chain": "evm",
  "address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
}
```

---

<div id="post-apiwalletgenerate">

### POST /api/wallet/generate

</div>

生成一个或多个新钱包。默认情况下，密钥在本地生成并保存到配置中。当 Steward 桥配置且 `source` 不为 `"local"` 时，钱包生成会委托给 Steward。

**请求**

```json
{
  "chain": "both",
  "source": "local"
}
```

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `chain` | string | 否 | `"evm"`、`"solana"` 或 `"both"`（默认：`"both"`） |
| `source` | string | 否 | `"local"` 或 `"steward"`。省略时，若已配置 Steward 则默认为 Steward，否则为本地。设置为 `"local"` 以强制本地密钥生成，即使 Steward 可用。 |

**响应**

```json
{
  "ok": true,
  "wallets": [
    { "chain": "evm", "address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
    { "chain": "solana", "address": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHU" }
  ],
  "source": "local"
}
```

| 字段 | 类型 | 描述 |
|------|------|------|
| `wallets` | array | 生成的钱包地址及其链类型 |
| `source` | string | `"local"` 或 `"steward"` — 指示哪个提供者生成了钱包 |

**错误**

| 状态 | 条件 |
|------|------|
| 400 | `chain` 不是 `"evm"`、`"solana"` 或 `"both"` |
| 400 | `source` 不是 `"local"` 或 `"steward"` |

---

<div id="post-apiwalletexport">

### POST /api/wallet/export

</div>

以明文形式导出私钥。需要显式确认。此操作将作为安全事件记录。

**请求**

```json
{
  "confirm": true
}
```

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `confirm` | boolean | 是 | 必须为 `true` 才能继续 |
| `exportToken` | string | 否 | 可选的一次性导出令牌，用于增加安全性 |

**响应**

```json
{
  "evm": {
    "privateKey": "0xabc123...",
    "address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
  },
  "solana": {
    "privateKey": "base58encodedkey...",
    "address": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHU"
  }
}
```

---

<div id="steward-bridge">

## Steward 桥

</div>

Steward 桥通过外部策略服务启用委托交易签名。当已配置时，交易和转账端点通过 Steward 路由签名请求，Steward 可以在广播之前批准、拒绝或保留交易以进行策略审查。

<div id="get-apiwalletsteward-status">

### GET /api/wallet/steward-status

</div>

获取 Steward 桥连接的当前状态，包括服务是否已配置、可达以及正在使用哪个代理身份。

**响应**

```json
{
  "configured": true,
  "available": true,
  "connected": true,
  "baseUrl": "https://steward.example.com",
  "agentId": "agent-1",
  "evmAddress": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  "error": null
}
```

| 字段 | 类型 | 描述 |
|------|------|------|
| `configured` | boolean | Steward API URL 是否已设置 |
| `available` | boolean | Steward 服务是否成功响应 |
| `connected` | boolean | 桥是否建立了连接 |
| `baseUrl` | string \| null | Steward API 基础 URL（如已配置） |
| `agentId` | string \| null | 用于 Steward 请求的代理身份 |
| `evmAddress` | string \| null | 与此代理关联的 EVM 钱包地址 |
| `error` | string \| null | 连接检查失败时的错误消息 |

---

<div id="trading">

## 交易

</div>

<div id="post-apiwallettradepreflight">

### POST /api/wallet/trade/preflight

</div>

运行预检检查以验证钱包和 RPC 是否准备好进行 BSC 交易。

**请求体**

| 字段 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `tokenAddress` | string | 否 | 要验证的代币合约地址（可选） |

**响应**

返回一个就绪对象，包含钱包余额、RPC 状态和任何阻塞问题。

---

<div id="post-apiwallettradequote">

### POST /api/wallet/trade/quote

</div>

在执行之前获取 BSC 代币交换的价格报价。

**请求体**

| 字段 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `side` | string | 是 | `"buy"` 或 `"sell"` |
| `tokenAddress` | string | 是 | 代币合约地址 |
| `amount` | string | 是 | 交易金额（人类可读单位） |
| `slippageBps` | number | 否 | 滑点容差（基点） |

**响应**

返回一个报价对象，包含估计的输出金额、价格影响和路由详情。

**错误**

| 状态 | 条件 |
|------|------|
| 400 | 缺少 `side`、`tokenAddress` 或 `amount` |

---

<div id="post-apiwallettradeexecute">

### POST /api/wallet/trade/execute

</div>

在 BSC 上执行代币交易。行为取决于钱包配置、Steward 桥可用性和确认：

- 没有 `confirm: true` 或没有本地私钥时，返回未签名的交易供客户端签名。
- 有 `confirm: true`、本地密钥和适当的交易权限时，在链上执行交易并返回收据。
- 当配置了 Steward 桥时，签名委托给 Steward 服务。Steward 可以立即批准交易、将其保留以进行策略审查，或根据配置的策略拒绝它。

**请求标头**

| 标头 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `x-eliza-agent-action` | string | 否 | 设置为 `1`、`true`、`yes` 或 `agent` 以将此标记为代理自动化请求。影响交易权限模式的解析。 |

**请求体**

| 字段 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `side` | string | 是 | `"buy"` 或 `"sell"` |
| `tokenAddress` | string | 是 | 代币合约地址 |
| `amount` | string | 是 | 交易金额（人类可读单位） |
| `slippageBps` | number | 否 | 滑点容差（基点） |
| `deadlineSeconds` | number | 否 | 交易截止时间（秒） |
| `confirm` | boolean | 否 | 设置为 `true` 以使用本地密钥立即执行 |
| `source` | string | 否 | `"agent"` 或 `"manual"` — 用于账本跟踪的归属 |

**响应（未签名 — 用户必须签名）**

当 `confirm` 不是 `true`、没有本地密钥可用或交易权限模式不允许服务器端执行时返回。

```json
{
  "ok": true,
  "side": "buy",
  "mode": "user-sign",
  "quote": {
    "side": "buy",
    "tokenAddress": "0x...",
    "slippageBps": 100,
    "route": "TOKEN/WBNB",
    "routerAddress": "0x...",
    "quoteIn": { "symbol": "BNB", "amount": "0.1", "amountWei": "100000000000000000" },
    "quoteOut": { "symbol": "TOKEN", "amount": "1000", "amountWei": "1000000000000000000000" }
  },
  "executed": false,
  "requiresUserSignature": true,
  "unsignedTx": {
    "to": "0x...",
    "data": "0x...",
    "valueWei": "100000000000000000",
    "chainId": 56
  },
  "requiresApproval": false
}
```

对于卖单，当路由器需要代币授权时，响应包含一个额外的 `unsignedApprovalTx` 字段：

```json
{
  "requiresApproval": true,
  "unsignedApprovalTx": {
    "to": "0x...",
    "data": "0x...",
    "valueWei": "0",
    "chainId": 56
  }
}
```

**响应（已执行）**

当交易已签名并广播（本地或通过 Steward）时返回。

```json
{
  "ok": true,
  "side": "buy",
  "mode": "local",
  "quote": { "..." : "..." },
  "executed": true,
  "requiresUserSignature": false,
  "unsignedTx": { "..." : "..." },
  "requiresApproval": false,
  "execution": {
    "hash": "0x...",
    "nonce": 42,
    "gasLimit": "250000",
    "valueWei": "100000000000000000",
    "explorerUrl": "https://bscscan.com/tx/0x...",
    "blockNumber": null,
    "status": "pending",
    "approvalHash": "0x..."
  }
}
```

| 字段 | 类型 | 描述 |
|------|------|------|
| `mode` | string | `"local-key"`、`"user-sign"`、`"steward"` 或 `"local"` |
| `execution.hash` | string | 链上交易哈希 |
| `execution.nonce` | number \| null | 交易 nonce（由 Steward 签名时为 `null`） |
| `execution.status` | string | 广播后立即为 `"pending"` |
| `execution.approvalHash` | string \| undefined | 代币授权交易哈希（仅卖单） |

**响应（Steward 待批准）**

当 Steward 保留交易以进行策略审查而不是立即签名时返回。

```json
{
  "ok": true,
  "side": "buy",
  "mode": "steward",
  "quote": { "..." : "..." },
  "executed": false,
  "requiresUserSignature": false,
  "unsignedTx": { "..." : "..." },
  "requiresApproval": false,
  "execution": {
    "status": "pending_approval",
    "policyResults": [
      { "policy": "max-trade-value", "result": "pending" }
    ]
  }
}
```

**响应（Steward 策略拒绝）**

当 Steward 根据策略规则拒绝交易时，返回状态 `403`。

```json
{
  "ok": false,
  "mode": "steward",
  "executed": false,
  "requiresUserSignature": false,
  "error": "Policy rejected",
  "execution": {
    "status": "rejected",
    "policyResults": [
      { "policy": "max-trade-value", "result": "denied" }
    ]
  }
}
```

**错误**

| 状态 | 条件 |
|------|------|
| 400 | 缺少 `side`、`tokenAddress` 或 `amount` |
| 400 | `side` 不是 `"buy"` 或 `"sell"` |
| 403 | Steward 策略拒绝（参见上面的响应形式） |
| 500 | 交易执行失败 |

---

<div id="get-apiwallettradetx-status">

### GET /api/wallet/trade/tx-status

</div>

检查之前提交的交易的链上状态。

**查询参数**

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `hash` | string | 是 | 交易哈希 |

**响应**

```json
{
  "ok": true,
  "hash": "0x...",
  "status": "success",
  "explorerUrl": "https://bscscan.com/tx/0x...",
  "chainId": 56,
  "blockNumber": 12345678,
  "confirmations": 12,
  "nonce": 42,
  "gasUsed": "150000",
  "effectiveGasPriceWei": "3000000000"
}
```

| 字段 | 类型 | 描述 |
|------|------|------|
| `status` | string | `"pending"`、`"success"`、`"reverted"` 或 `"not_found"` |
| `chainId` | number | 始终为 `56`（BSC） |

**错误**

| 状态 | 条件 |
|------|------|
| 400 | 缺少 `hash` 查询参数 |

---

<div id="get-apiwallettradingprofile">

### GET /api/wallet/trading/profile

</div>

从本地交易账本获取交易损益概要。

**查询参数**

| 参数 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `window` | string | `30d` | 时间窗口：`"7d"`、`"30d"` 或 `"all"` |
| `source` | string | `all` | 按归属过滤：`"agent"`、`"manual"` 或 `"all"` |

**响应**

返回聚合的交易统计数据，包括请求窗口内已实现和未实现的 P&L。

---

<div id="post-apiwallettransferexecute">

### POST /api/wallet/transfer/execute

</div>

在 BSC 上转账原生代币（BNB）或 ERC-20 代币。

- 没有 `confirm: true` 或没有本地私钥时，返回未签名的交易供客户端签名。
- 有 `confirm: true` 和本地密钥时，在链上执行转账。
- 当配置了 Steward 桥时，签名委托给 Steward 服务，使用与交易执行相同的策略批准流程。

**请求标头**

| 标头 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `x-eliza-agent-action` | string | 否 | 设置为 `1`、`true`、`yes` 或 `agent` 以将此标记为代理自动化请求。影响交易权限模式的解析。 |

**请求体**

| 字段 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `toAddress` | string | 是 | 收款人 EVM 地址 |
| `amount` | string | 是 | 转账金额（人类可读单位） |
| `assetSymbol` | string | 是 | 代币符号（例如 `"BNB"`、`"USDT"`） |
| `tokenAddress` | string | 否 | ERC-20 合约地址（非原生代币时需要） |
| `confirm` | boolean | 否 | 设置为 `true` 以使用本地密钥立即执行 |

**响应（未签名 — 用户必须签名）**

```json
{
  "ok": true,
  "mode": "user-sign",
  "executed": false,
  "requiresUserSignature": true,
  "toAddress": "0x...",
  "amount": "1.5",
  "assetSymbol": "BNB",
  "unsignedTx": {
    "chainId": 56,
    "from": "0x...",
    "to": "0x...",
    "data": "0x",
    "valueWei": "1500000000000000000",
    "explorerUrl": "https://bscscan.com",
    "assetSymbol": "BNB",
    "amount": "1.5"
  }
}
```

对于 ERC-20 转账，`unsignedTx.to` 是代币合约地址，`unsignedTx.data` 包含编码的 `transfer` 调用，并包含 `unsignedTx.tokenAddress`。

**响应（已执行）**

```json
{
  "ok": true,
  "mode": "local",
  "executed": true,
  "requiresUserSignature": false,
  "toAddress": "0x...",
  "amount": "1.5",
  "assetSymbol": "BNB",
  "unsignedTx": { "..." : "..." },
  "execution": {
    "hash": "0x...",
    "nonce": 42,
    "gasLimit": "21000",
    "valueWei": "1500000000000000000",
    "explorerUrl": "https://bscscan.com/tx/0x...",
    "blockNumber": null,
    "status": "pending"
  }
}
```

| 字段 | 类型 | 描述 |
|------|------|------|
| `mode` | string | `"local-key"`、`"user-sign"`、`"steward"` 或 `"local"` |
| `execution.nonce` | number \| null | 交易 nonce（由 Steward 签名时为 `null`） |
| `execution.status` | string | 广播后立即为 `"pending"` |

**响应（Steward 待批准）**

```json
{
  "ok": true,
  "mode": "steward",
  "executed": false,
  "requiresUserSignature": false,
  "toAddress": "0x...",
  "amount": "1.5",
  "assetSymbol": "BNB",
  "unsignedTx": { "..." : "..." },
  "execution": {
    "status": "pending_approval",
    "policyResults": [
      { "policy": "max-transfer-value", "result": "pending" }
    ]
  }
}
```

**响应（Steward 策略拒绝）**

当 Steward 根据策略规则拒绝交易时，返回状态 `403`。

```json
{
  "ok": false,
  "mode": "steward",
  "executed": false,
  "requiresUserSignature": false,
  "error": "Policy rejected",
  "execution": {
    "status": "rejected",
    "policyResults": [
      { "policy": "max-transfer-value", "result": "denied" }
    ]
  }
}
```

**错误**

| 状态 | 条件 |
|------|------|
| 400 | 缺少 `toAddress`、`amount` 或 `assetSymbol` |
| 400 | EVM 地址格式无效 |
| 403 | Steward 策略拒绝（参见上面的响应形式） |
| 500 | 转账执行失败 |

---

<div id="post-apiwalletproduction-defaults">

### POST /api/wallet/production-defaults

</div>

为钱包交易配置应用预设的生产默认值（交易权限模式、RPC 设置等）。

**响应**

```json
{
  "ok": true,
  "applied": [
    "tradePermissionMode=user-sign-only",
    "bscRpcUrl=https://bsc-dataseed.binance.org"
  ],
  "tradePermissionMode": "user-sign-only"
}
```

| 字段 | 类型 | 描述 |
|------|------|------|
| `applied` | string[] | 已应用的配置更改列表 |
| `tradePermissionMode` | string | 生成的交易权限模式 |

---

<div id="cloud-wallet">

## 云钱包

</div>

这些端点管理双钱包（本地 + 云端）架构。它们受 `ENABLE_CLOUD_WALLET` 功能开关控制，当开关关闭时返回 `404`。

<Info>
云钱包通过 Eliza Cloud 配置，并支持 Privy 和 Steward 等提供者。启用云钱包后，代理可以为每条链同时持有本地和云端托管的钱包，其中一个被指定为主钱包。
</Info>

<div id="post-apiwalletprimary">

### POST /api/wallet/primary

</div>

为一条链设置主钱包来源。主钱包用于余额查询、交易执行和地址显示。更改主钱包会触发运行时重新加载以重新绑定钱包插件。

**请求**

```json
{
  "chain": "evm",
  "source": "cloud"
}
```

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `chain` | string | 是 | `"evm"` 或 `"solana"` |
| `source` | string | 是 | `"local"` 或 `"cloud"` |

**响应**

```json
{
  "ok": true,
  "chain": "evm",
  "source": "cloud",
  "restarting": true
}
```

| 字段 | 类型 | 描述 |
|------|------|------|
| `chain` | string | 已更新的链 |
| `source` | string | 新的主来源 |
| `restarting` | boolean | 运行时是否正在重启以应用更改 |
| `warnings` | string[] | 可选警告（例如配置保存问题） |

**错误**

| 状态 | 条件 |
|------|------|
| 400 | `chain` 不是 `"evm"` 或 `"solana"` |
| 400 | `source` 不是 `"local"` 或 `"cloud"` |
| 404 | 云钱包功能未启用 |
| 500 | 持久化配置失败 |

---

<div id="post-apiwalletrefresh-cloud">

### POST /api/wallet/refresh-cloud

</div>

重新查询 Eliza Cloud 以获取最新的云钱包描述符并更新本地缓存。重新获取所有链以捕获上游地址更改，例如钱包轮换或迁移。如果某条链刷新失败，则保留先前缓存的描述符。

当钱包绑定发生变化时，更改主钱包会触发运行时重新加载。

**请求**

不需要请求体。

**响应**

```json
{
  "ok": true,
  "restarting": true,
  "wallets": {
    "evm": {
      "address": "0x1234...abcd",
      "provider": "privy"
    },
    "solana": {
      "address": "Abc123...xyz",
      "provider": "steward"
    }
  }
}
```

| 字段 | 类型 | 描述 |
|------|------|------|
| `restarting` | boolean | 由于钱包绑定更改，运行时是否正在重启 |
| `wallets.evm` | object \| null | 已刷新的 EVM 云钱包描述符 |
| `wallets.solana` | object \| null | 已刷新的 Solana 云钱包描述符 |
| `wallets.*.address` | string | 云钱包地址 |
| `wallets.*.provider` | string | 钱包提供者（`"privy"` 或 `"steward"`） |
| `warnings` | string[] | 部分失败或配置保存问题的可选警告 |

**错误**

| 状态 | 条件 |
|------|------|
| 400 | 未连接云端 — 未配置 API 密钥 |
| 400 | 未配置代理 |
| 404 | 云钱包功能未启用 |
| 502 | 云钱包刷新失败（上游错误） |

---

<div id="common-error-codes">

## 常见错误代码

</div>

| 状态 | 代码 | 描述 |
|------|------|------|
| 400 | `INVALID_REQUEST` | 请求体格式不正确或缺少必需字段 |
| 401 | `UNAUTHORIZED` | 缺少或无效的身份验证令牌 |
| 404 | `NOT_FOUND` | 请求的资源不存在 |
| 400 | `INVALID_KEY` | 私钥格式无效 |
| 400 | `INVALID_ADDRESS` | EVM 地址格式无效 |
| 403 | `EXPORT_FORBIDDEN` | 未经适当确认不允许导出 |
| 403 | `TRADE_FORBIDDEN` | 交易权限被拒绝 |
| 403 | `STEWARD_POLICY_REJECTED` | Steward 策略引擎拒绝了交易。响应体包含 `execution.policyResults`，其中包含评估了哪些策略的详细信息。 |
| 500 | `INSUFFICIENT_BALANCE` | 钱包余额不足以执行操作 |
| 500 | `INTERNAL_ERROR` | 意外的服务器错误 |
