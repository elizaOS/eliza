import type { Action, ActionResult, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { readRobinhoodConfig, validateForgeReadiness } from "../config.js";

export type RegisterAgentIntent = {
  name: string;
  agentUri: string;
  chainId: number;
  identityRegistry: string;
  mode: "preview" | "live";
  unsigned: true;
  note: string;
};

/**
 * Pure intent builder — unit-tested without full runtime.
 */
export function buildRegisterAgentIntent(params: {
  name: string;
  agentUri?: string;
  cfg: ReturnType<typeof readRobinhoodConfig>;
}): RegisterAgentIntent {
  const uri =
    params.agentUri ||
    `${params.cfg.cheshireApiBase.replace(/\/$/, "")}/agents/${encodeURIComponent(params.name)}`;
  return {
    name: params.name,
    agentUri: uri,
    chainId: params.cfg.chainId,
    identityRegistry: params.cfg.identityRegistry,
    mode: params.cfg.liveEnabled ? "live" : "preview",
    unsigned: true,
    note: params.cfg.liveEnabled
      ? "Live mode: operator must sign the registration tx outside this preview path."
      : "Preview-only: no chain write. Set ROBINHOOD_LIVE=true and provide signer off-process.",
  };
}

function extractName(text: string): string | null {
  const m =
    text.match(/register(?:\s+agent)?\s+(?:named\s+)?["']?([A-Za-z0-9_\-. ]{2,64})["']?/i) ||
    text.match(/forge\s+["']?([A-Za-z0-9_\-. ]{2,64})["']?\s+on\s+robinhood/i);
  return m?.[1]?.trim() || null;
}

export const registerRobinhoodAgentAction: Action = {
  name: "REGISTER_ROBINHOOD_AGENT",
  similes: [
    "RH_REGISTER",
    "FORGE_RH_AGENT",
    "ERC8004_REGISTER",
    "REGISTER_ON_ROBINHOOD",
  ],
  description:
    "Preview (default) or prepare ERC-8004 agent identity registration on Robinhood Chain via Cheshire forge contracts.",
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const text = message.content?.text || "";
    if (!/robinhood|erc-?8004|rh\s*forge|register.*agent/i.test(text)) return false;
    const cfg = readRobinhoodConfig((k) => runtime.getSetting(k) as string | undefined);
    return validateForgeReadiness(cfg).length === 0 || /preview|dry.?run/i.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const cfg = readRobinhoodConfig((k) => runtime.getSetting(k) as string | undefined);
    const missing = validateForgeReadiness(cfg);
    const text = message.content?.text || "";
    const name = extractName(text) || "CheshireAgent";

    if (missing.length && !cfg.liveEnabled) {
      // Allow preview with empty registry — still return intent shape
    }

    const intent = buildRegisterAgentIntent({ name, cfg });
    const body = [
      `Robinhood forge intent (${intent.mode})`,
      `· name: ${intent.name}`,
      `· agentURI: ${intent.agentUri}`,
      `· chainId: ${intent.chainId}`,
      `· identityRegistry: ${intent.identityRegistry || "(not configured)"}`,
      `· ${intent.note}`,
    ].join("\n");

    if (callback) {
      await callback({ text: body, actions: ["REGISTER_ROBINHOOD_AGENT"] });
    }

    return {
      success: true,
      text: body,
      data: { intent, missing },
    };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "Register agent named Solizard on Robinhood preview" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Preparing Robinhood ERC-8004 registration preview for Solizard.",
          actions: ["REGISTER_ROBINHOOD_AGENT"],
        },
      },
    ],
  ],
};
