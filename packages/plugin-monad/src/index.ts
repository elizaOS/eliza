/**
 * ElizaOS Monad Chain Plugin
 * 
 * 为 ElizaOS Agent 提供 Monad 链上数据能力：
 * - 查询 MON 余额
 * - 查询交易历史
 * - 监控链上活动
 * - 代币信息查询
 * - Gas 价格查询
 */

import type { 
  Plugin, Action, Provider, IAgentRuntime, Memory, State, 
  HandlerCallback, Content, ActionResult 
} from "@elizaos/core";
import { ethers } from "ethers";

// ═══════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════
const MONAD_CONFIG = {
  testnet: {
    rpc: "https://testnet-rpc.monad.xyz",
    chainId: 10143,
    explorer: "https://testnet.monadexplorer.com",
    currency: "MON",
  },
  mainnet: {
    rpc: "https://rpc.monad.xyz", // 主网上线后更新
    chainId: 10143, // 主网上线后更新
    explorer: "https://monadexplorer.com",
    currency: "MON",
  },
};

function getProvider(network: "testnet" | "mainnet" = "testnet") {
  const config = MONAD_CONFIG[network];
  return new ethers.JsonRpcProvider(config.rpc, config.chainId);
}

function getExplorerUrl(network: "testnet" | "mainnet" = "testnet") {
  return MONAD_CONFIG[network].explorer;
}

// ═══════════════════════════════════════════════
// Action 1: 查询 MON 余额
// ═══════════════════════════════════════════════
const queryBalanceAction: Action = {
  name: "MONAD_QUERY_BALANCE",
  similes: [
    "CHECK_MONAD_BALANCE",
    "GET_MONAD_BALANCE",
    "MONAD_BALANCE",
    "MON_BALANCE",
  ],
  description: "Query the MON balance of a wallet address on Monad chain",

  parameters: [
    {
      name: "address",
      description: "The wallet address to query (0x...)",
      required: true,
      schema: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
    },
    {
      name: "network",
      description: "Monad network: testnet or mainnet",
      required: false,
      schema: { type: "string", enum: ["testnet", "mainnet"], default: "testnet" },
    },
  ],

  examples: [
    [
      {
        name: "{{user1}}" as string,
        content: { text: "What's the MON balance of 0x3194d81BB0758f3D2D66936E7740670f376dFDBb on Monad?" } as Content,
      },
      {
        name: "{{agentName}}" as string,
        content: { text: "Let me check that Monad wallet balance.", actions: ["MONAD_QUERY_BALANCE"] } as Content,
      },
    ],
    [
      {
        name: "{{user1}}" as string,
        content: { text: "查一下 0x3194d81BB0758f3D2D66936E7740670f376dFDBb 在 Monad 上的余额" } as Content,
      },
      {
        name: "{{agentName}}" as string,
        content: { text: "好的，让我查一下这个地址在 Monad 链上的余额。", actions: ["MONAD_QUERY_BALANCE"] } as Content,
      },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State) => {
    const text = (message.content as Content)?.text?.toLowerCase() || "";
    const hasMonad = text.includes("monad") || text.includes("mon");
    const hasBalance = text.includes("balance") || text.includes("余额") || text.includes("多少钱");
    const hasAddress = /0x[a-fA-F0-9]{40}/.test(text);
    return hasMonad && (hasBalance || hasAddress);
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    _callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    const text = (message.content as Content)?.text || "";
    const addressMatch = text.match(/0x[a-fA-F0-9]{40}/);

    if (!addressMatch) {
      return {
        success: false,
        text: "请提供一个有效的 Monad 钱包地址 (0x...)",
      };
    }

    const address = addressMatch[0];
    const network = text.toLowerCase().includes("mainnet") ? "mainnet" : "testnet";

    try {
      const provider = getProvider(network);
      const balance = await provider.getBalance(address);
      const balanceMon = parseFloat(ethers.formatEther(balance));
      const explorer = getExplorerUrl(network);

      return {
        success: true,
        text: `Monad ${network} 钱包余额查询结果：

地址: ${address}
余额: ${balanceMon.toFixed(6)} MON
网络: Monad ${network}
探索器: ${explorer}/address/${address}`,
        values: {
          address,
          balance: balanceMon,
          network,
          currency: "MON",
        },
      };
    } catch (error) {
      return {
        success: false,
        text: `查询 Monad 余额失败: ${(error as Error).message}`,
      };
    }
  },
};

// ═══════════════════════════════════════════════
// Action 2: 查询交易详情
// ═══════════════════════════════════════════════
const queryTransactionAction: Action = {
  name: "MONAD_QUERY_TX",
  similes: [
    "CHECK_MONAD_TX",
    "GET_MONAD_TX",
    "MONAD_TRANSACTION",
    "MON_TX",
  ],
  description: "Query details of a specific transaction on Monad chain",

  parameters: [
    {
      name: "txHash",
      description: "The transaction hash to query",
      required: true,
      schema: { type: "string", pattern: "^0x[a-fA-F0-9]{64}$" },
    },
  ],

  examples: [
    [
      {
        name: "{{user1}}" as string,
        content: { text: "Look up this Monad transaction: 0x1234..." } as Content,
      },
      {
        name: "{{agentName}}" as string,
        content: { text: "Let me fetch that transaction details from Monad.", actions: ["MONAD_QUERY_TX"] } as Content,
      },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State) => {
    const text = (message.content as Content)?.text?.toLowerCase() || "";
    return text.includes("monad") && 
           (text.includes("transaction") || text.includes("tx") || text.includes("交易")) &&
           /0x[a-fA-F0-9]{64}/.test(text);
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<ActionResult | undefined> => {
    const text = (message.content as Content)?.text || "";
    const txMatch = text.match(/0x[a-fA-F0-9]{64}/);

    if (!txMatch) {
      return { success: false, text: "请提供有效的交易哈希 (0x...)" };
    }

    try {
      const provider = getProvider("testnet");
      const tx = await provider.getTransaction(txMatch[0]);

      if (!tx) {
        return { success: false, text: "未找到该交易" };
      }

      const receipt = await provider.getTransactionReceipt(txMatch[0]);

      return {
        success: true,
        text: `Monad 交易详情：

交易哈希: ${tx.hash}
区块: ${tx.blockNumber}
发送方: ${tx.from}
接收方: ${tx.to || "合约创建"}
金额: ${ethers.formatEther(tx.value)} MON
Gas 价格: ${ethers.formatUnits(tx.gasPrice || 0n, "gwei")} Gwei
Gas 用量: ${receipt?.gasUsed?.toString() || "pending"}
状态: ${receipt?.status === 1 ? "✅ 成功" : "❌ 失败"}`,
        values: {
          txHash: tx.hash,
          blockNumber: tx.blockNumber,
          from: tx.from,
          to: tx.to,
          value: ethers.formatEther(tx.value),
          status: receipt?.status === 1 ? "success" : "failed",
        },
      };
    } catch (error) {
      return { success: false, text: `查询交易失败: ${(error as Error).message}` };
    }
  },
};

// ═══════════════════════════════════════════════
// Action 3: 查询区块信息
// ═══════════════════════════════════════════════
const queryBlockAction: Action = {
  name: "MONAD_QUERY_BLOCK",
  similes: ["CHECK_MONAD_BLOCK", "MONAD_BLOCK_INFO"],
  description: "Query block information on Monad chain",

  parameters: [
    {
      name: "blockNumber",
      description: "Block number (optional, defaults to latest)",
      required: false,
      schema: { type: "number" },
    },
  ],

  examples: [
    [
      {
        name: "{{user1}}" as string,
        content: { text: "What's the latest block on Monad?" } as Content,
      },
      {
        name: "{{agentName}}" as string,
        content: { text: "Let me check the latest Monad block.", actions: ["MONAD_QUERY_BLOCK"] } as Content,
      },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State) => {
    const text = (message.content as Content)?.text?.toLowerCase() || "";
    return text.includes("monad") && 
           (text.includes("block") || text.includes("区块") || text.includes("高度"));
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<ActionResult | undefined> => {
    try {
      const provider = getProvider("testnet");
      const blockNumber = await provider.getBlockNumber();
      const block = await provider.getBlock(blockNumber);

      if (!block) {
        return { success: false, text: "无法获取区块信息" };
      }

      return {
        success: true,
        text: `Monad 最新区块信息：

区块高度: ${block.number}
时间戳: ${new Date(block.timestamp * 1000).toLocaleString("zh-CN")}
交易数: ${block.transactions.length}
Gas 限制: ${block.gasLimit.toString()}
Gas 使用: ${block.gasUsed.toString()}
矿工: ${block.miner}`,
        values: {
          blockNumber: block.number,
          timestamp: block.timestamp,
          txCount: block.transactions.length,
        },
      };
    } catch (error) {
      return { success: false, text: `查询区块失败: ${(error as Error).message}` };
    }
  },
};

// ═══════════════════════════════════════════════
// Action 4: 地址交易数量
// ═══════════════════════════════════════════════
const queryNonceAction: Action = {
  name: "MONAD_QUERY_NONCE",
  similes: ["CHECK_MONAD_TX_COUNT", "MONAD_TX_COUNT"],
  description: "Query the transaction count (nonce) of an address on Monad",

  parameters: [
    {
      name: "address",
      description: "The wallet address to query",
      required: true,
      schema: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
    },
  ],

  examples: [
    [
      {
        name: "{{user1}}" as string,
        content: { text: "How many transactions has 0x1234... made on Monad?" } as Content,
      },
      {
        name: "{{agentName}}" as string,
        content: { text: "Let me check the transaction count.", actions: ["MONAD_QUERY_NONCE"] } as Content,
      },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State) => {
    const text = (message.content as Content)?.text?.toLowerCase() || "";
    return text.includes("monad") && 
           (text.includes("transaction count") || text.includes("nonce") || text.includes("交易数") || text.includes("多少笔")) &&
           /0x[a-fA-F0-9]{40}/.test(text);
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<ActionResult | undefined> => {
    const text = (message.content as Content)?.text || "";
    const addressMatch = text.match(/0x[a-fA-F0-9]{40}/);

    if (!addressMatch) {
      return { success: false, text: "请提供有效的钱包地址" };
    }

    try {
      const provider = getProvider("testnet");
      const nonce = await provider.getTransactionCount(addressMatch[0]);

      return {
        success: true,
        text: `Monad 地址交易统计：

地址: ${addressMatch[0]}
已发送交易数: ${nonce}
网络: Monad testnet`,
        values: {
          address: addressMatch[0],
          txCount: nonce,
        },
      };
    } catch (error) {
      return { success: false, text: `查询失败: ${(error as Error).message}` };
    }
  },
};

// ═══════════════════════════════════════════════
// Action 5: Gas 价格查询
// ═══════════════════════════════════════════════
const queryGasAction: Action = {
  name: "MONAD_QUERY_GAS",
  similes: ["CHECK_MONAD_GAS", "MONAD_GAS_PRICE"],
  description: "Query current gas price on Monad chain",

  parameters: [],

  examples: [
    [
      {
        name: "{{user1}}" as string,
        content: { text: "What's the gas price on Monad?" } as Content,
      },
      {
        name: "{{agentName}}" as string,
        content: { text: "Let me check the current Monad gas price.", actions: ["MONAD_QUERY_GAS"] } as Content,
      },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State) => {
    const text = (message.content as Content)?.text?.toLowerCase() || "";
    return text.includes("monad") && (text.includes("gas") || text.includes("矿工费") || text.includes("手续费"));
  },

  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<ActionResult | undefined> => {
    try {
      const provider = getProvider("testnet");
      const feeData = await provider.getFeeData();

      return {
        success: true,
        text: `Monad Gas 价格：

Gas 价格: ${ethers.formatUnits(feeData.gasPrice || 0n, "gwei")} Gwei
Max Fee: ${ethers.formatUnits(feeData.maxFeePerGas || 0n, "gwei")} Gwei
Max Priority: ${ethers.formatUnits(feeData.maxPriorityFeePerGas || 0n, "gwei")} Gwei

Monad 以高吞吐量著称，Gas 费用极低。`,
        values: {
          gasPrice: ethers.formatUnits(feeData.gasPrice || 0n, "gwei"),
          maxFeePerGas: ethers.formatUnits(feeData.maxFeePerGas || 0n, "gwei"),
        },
      };
    } catch (error) {
      return { success: false, text: `查询 Gas 失败: ${(error as Error).message}` };
    }
  },
};

// ═══════════════════════════════════════════════
// Provider: Monad 链上下文
// ═══════════════════════════════════════════════
const monadProvider: Provider = {
  name: "MONAD_CHAIN",
  description: "Provides Monad blockchain context information",

  get: async (_runtime: IAgentRuntime, _message: Memory, _state?: State) => {
    try {
      const provider = getProvider("testnet");
      const blockNumber = await provider.getBlockNumber();
      const feeData = await provider.getFeeData();

      return {
        text: `Monad Chain Status:
- Network: Monad Testnet
- Chain ID: 10143
- Latest Block: ${blockNumber}
- Gas Price: ${ethers.formatUnits(feeData.gasPrice || 0n, "gwei")} Gwei
- Explorer: https://testnet.monadexplorer.com
- Currency: MON
- Features: EVM compatible, 10,000+ TPS, 1s block time`,
        values: {
          monadBlockNumber: blockNumber,
          monadGasPrice: ethers.formatUnits(feeData.gasPrice || 0n, "gwei"),
          monadNetwork: "testnet",
        },
        data: {
          source: "monad-provider",
          chainId: 10143,
        },
      };
    } catch {
      return {
        text: `Monad Chain Status:
- Network: Monad Testnet
- Chain ID: 10143
- Explorer: https://testnet.monadexplorer.com
- Currency: MON
- Status: Connection failed`,
        values: {},
        data: { source: "monad-provider", error: true },
      };
    }
  },
};

// ═══════════════════════════════════════════════
// 插件定义
// ═══════════════════════════════════════════════
const monadPlugin: Plugin = {
  name: "plugin-monad",
  description: "Monad blockchain integration plugin for ElizaOS - query balances, transactions, blocks, and gas prices on Monad chain",

  actions: [
    queryBalanceAction,
    queryTransactionAction,
    queryBlockAction,
    queryNonceAction,
    queryGasAction,
  ],

  providers: [monadProvider],
};

export default monadPlugin;
