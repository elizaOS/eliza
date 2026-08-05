import type { Action, ActionResult, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { readSolanaForgeConfig } from "../config.js";

export type MintAgentIntent = {
  name: string;
  uri: string;
  collectionMint: string | null;
  mode: "preview" | "live";
  unsigned: true;
  rails: Array<"solana" | "robinhood">;
  note: string;
};

export function buildMintAgentIntent(params: {
  name: string;
  uri?: string;
  cfg: ReturnType<typeof readSolanaForgeConfig>;
}): MintAgentIntent {
  const uri =
    params.uri ||
    `${params.cfg.cheshireApiBase.replace(/\/$/, "")}/agents/${encodeURIComponent(params.name)}.json`;
  const rails: Array<"solana" | "robinhood"> = ["solana"];
  if (params.cfg.omniEnabled) rails.push("robinhood");
  return {
    name: params.name,
    uri,
    collectionMint: params.cfg.collectionMint || null,
    mode: params.cfg.liveEnabled ? "live" : "preview",
    unsigned: true,
    rails,
    note: params.cfg.liveEnabled
      ? "Live mode: Metaplex Core mint must be signed by operator wallet (not held in agent process)."
      : "Preview-only mint intent. Set SOLANA_FORGE_LIVE=true only when ready to sign.",
  };
}

function extractName(text: string): string | null {
  const m =
    text.match(/mint(?:\s+agent)?\s+(?:named\s+)?["']?([A-Za-z0-9_\-. ]{2,64})["']?/i) ||
    text.match(/forge\s+["']?([A-Za-z0-9_\-. ]{2,64})["']?\s+on\s+solana/i);
  return m?.[1]?.trim() || null;
}

export const mintSolanaAgentAction: Action = {
  name: "MINT_SOLANA_AGENT",
  similes: ["METAPLEX_MINT_AGENT", "FORGE_SOLANA_AGENT", "SVM_AGENT_MINT"],
  description:
    "Preview Metaplex Core agent mint intent on Solana (Cheshire forge). Optional dual-rail omni when CHESHIRE_OMNI_MINT=true.",
  validate: async (_runtime, message) => {
    const text = message.content?.text || "";
    return /solana|metaplex|mint\s+agent|forge.*agent/i.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const cfg = readSolanaForgeConfig((k) => runtime.getSetting(k) as string | undefined);
    const name = extractName(message.content?.text || "") || "ClawdAgent";
    const intent = buildMintAgentIntent({ name, cfg });
    const body = [
      `Solana forge intent (${intent.mode})`,
      `· name: ${intent.name}`,
      `· uri: ${intent.uri}`,
      `· collection: ${intent.collectionMint || "(none)"}`,
      `· rails: ${intent.rails.join(" + ")}`,
      `· ${intent.note}`,
    ].join("\n");

    if (callback) {
      await callback({ text: body, actions: ["MINT_SOLANA_AGENT"] });
    }
    return { success: true, text: body, data: { intent } };
  },
  examples: [
    [
      { name: "{{user}}", content: { text: "Mint agent named ClawdScout on Solana preview" } },
      {
        name: "{{agent}}",
        content: {
          text: "Preparing Metaplex Core mint preview for ClawdScout.",
          actions: ["MINT_SOLANA_AGENT"],
        },
      },
    ],
  ],
};
