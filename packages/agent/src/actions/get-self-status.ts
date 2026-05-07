/**
 * GET_SELF_STATUS action — on-demand detail retrieval from the Self-Awareness System.
 *
 * Provides Layer 2 detail for a specific module or all modules.
 * The always-on Layer 1 summary (injected via the self-status provider)
 * gives a brief overview every turn; this action lets the agent (or user)
 * drill down when more context is needed.
 *
 * @module actions/get-self-status
 */

import type { Action, ActionExample, HandlerOptions } from "@elizaos/core";
import {
  type AwarenessRegistry,
  getGlobalAwarenessRegistry,
} from "@elizaos/shared";
import { hasSelectedContextOrSignalSync } from "./context-signal.js";

const VALID_MODULES = [
  "all",
  "runtime",
  "permissions",
  "wallet",
  "provider",
  "pluginHealth",
  "connectors",
  "cloud",
  "features",
] as const;

type ValidModule = (typeof VALID_MODULES)[number];
const GET_SELF_STATUS_CONTEXTS = [
  "general",
  "agent_internal",
  "admin",
  "settings",
  "connectors",
  "wallet",
] as const;
const GET_SELF_STATUS_TERMS = [
  "status",
  "self status",
  "system status",
  "runtime status",
  "plugin health",
  "health check",
  "how are your plugins",
  "how are you running",
  "permissions",
  "provider status",
  "connector status",
  "wallet status",
  "状态",
  "系统状态",
  "插件健康",
  "상태",
  "시스템 상태",
  "플러그인 상태",
  "estado",
  "estado del sistema",
  "salud del plugin",
  "estado do sistema",
  "saúde do plugin",
  "saude do plugin",
  "trạng thái",
  "trang thai",
  "tình trạng hệ thống",
  "tinh trang he thong",
  "katayuan",
  "status ng system",
];

function isAwarenessRegistry(value: unknown): value is AwarenessRegistry {
  return (
    typeof value === "object" &&
    value !== null &&
    "getDetail" in value &&
    typeof value.getDetail === "function"
  );
}

export const getSelfStatusAction: Action = {
  name: "GET_SELF_STATUS",
  contexts: [...GET_SELF_STATUS_CONTEXTS],
  roleGate: { minRole: "USER" },

  similes: [
    "CHECK_STATUS",
    "SELF_STATUS",
    "MY_STATUS",
    "SYSTEM_STATUS",
    "CHECK_SELF",
  ],

  description:
    "Get detailed self-status about a specific module (wallet, permissions, plugins, etc.) or all modules. " +
    "Use this when you need more detail than the always-on summary provides.",
  descriptionCompressed:
    "get detail self-status specific module (wallet, permission, plugin, etc) module use need detail always-on summary provide",

  validate: async (_runtime, message, state) =>
    hasSelectedContextOrSignalSync(
      message,
      state,
      GET_SELF_STATUS_CONTEXTS,
      GET_SELF_STATUS_TERMS,
    ),

  handler: async (runtime, _message, _state, options) => {
    const registry = (() => {
      const service = runtime.getService("AWARENESS_REGISTRY");
      return isAwarenessRegistry(service)
        ? service
        : getGlobalAwarenessRegistry();
    })();
    if (!registry) {
      return {
        text: "Self-awareness registry is not available.",
        values: { error: "REGISTRY_UNAVAILABLE" },
        data: { actionName: "GET_SELF_STATUS" },
        success: false,
      };
    }

    const params = (options as HandlerOptions | undefined)?.parameters;
    const rawModule =
      typeof params?.module === "string" ? params.module : "all";
    const module: ValidModule = VALID_MODULES.includes(rawModule as ValidModule)
      ? (rawModule as ValidModule)
      : "all";
    const detailLevel = params?.detailLevel === "full" ? "full" : "brief";

    const text = await registry.getDetail(runtime, module, detailLevel);
    return {
      text,
      values: { module, detailLevel },
      data: { actionName: "GET_SELF_STATUS", module, detailLevel },
      success: true,
    };
  },

  parameters: [
    {
      name: "module",
      description:
        "Which module: all, runtime, permissions, wallet, provider, pluginHealth, connectors, cloud, features.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "detailLevel",
      description: '"brief" (~200 tokens) or "full" (~2000 tokens).',
      required: false,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "How are your plugins doing right now?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Plugin health: 12 loaded, 2 degraded (discord reconnecting, telegram rate-limited).",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Give me a full rundown of your wallet module.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Wallet module: connected address 0x12…ab, balance 0.42 ETH, 3 pending sigs.",
        },
      },
    ],
  ] as ActionExample[][],
};
