import type { Action, HandlerCallback, Memory } from "@elizaos/core";
import type { CoinSnapshot } from "./evaluate.ts";
import { summarizePnl } from "./pnl.ts";
import { getValhallaService } from "./service.ts";

function messageText(message: Memory): string {
  const content = message.content;
  if (
    content &&
    typeof content === "object" &&
    "text" in content &&
    typeof content.text === "string"
  ) {
    return content.text;
  }
  return "";
}

function snapshotFromText(text: string): CoinSnapshot | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as CoinSnapshot;
    if (!parsed || typeof parsed.mint !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function mintFromText(text: string): string | null {
  const match = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  return match ? match[0] : null;
}

async function reply(callback: HandlerCallback | undefined, text: string): Promise<void> {
  if (callback) await callback({ text, actions: ["VALHALLA"] });
}

export const evaluateCoinAction: Action = {
  name: "VALHALLA_EVALUATE_COIN",
  description:
    "Score a Solana memecoin with the Mech safety filters: stables, liquidity, volume, buy pressure, market cap, manipulation scan, prebuy safety, and ticket size. Read only. Does not send a swap.",
  similes: ["SCAN_COIN", "EVALUATE_MEMECOIN", "CHECK_TOKEN_SAFETY"],
  validate: async () => true,
  handler: async (runtime, message, _state, _options, callback) => {
    const service = getValhallaService(runtime);
    const text = messageText(message);
    const snapshot = snapshotFromText(text);
    if (snapshot) {
      const result = await service.evaluateSnapshot({ ...snapshot, now: Date.now() });
      const line = result.ok
        ? `Pass ${result.evaluation.lane} size ${result.evaluation.sizeSol} SOL. ${result.reason}`
        : `Block: ${result.reason}`;
      await reply(callback, line);
      return { success: true, text: line };
    }
    const mint = mintFromText(text);
    if (!mint) {
      const line = "Give a mint address or a JSON coin snapshot.";
      await reply(callback, line);
      return { success: false, text: line };
    }
    const evaluation = await service.evaluateMint(mint);
    const line = evaluation.ok
      ? `Pass ${evaluation.lane} size ${evaluation.sizeSol} SOL. ${evaluation.reason}`
      : `Block: ${evaluation.reason}`;
    await reply(callback, line);
    return { success: evaluation.ok, text: line };
  },
};

export const tradingControlAction: Action = {
  name: "VALHALLA_TRADING",
  description:
    "Start or stop the Mech trading loop. The loop is paper unless VALHALLA_LIVE_TRADING=true. This action cannot transfer or withdraw funds.",
  similes: ["START_COPY_TRADING", "STOP_COPY_TRADING"],
  validate: async () => true,
  handler: async (runtime, message, _state, _options, callback) => {
    const service = getValhallaService(runtime);
    const text = messageText(message).toLowerCase();
    const line = text.includes("stop") ? service.stopLoop() : service.startLoop();
    await reply(callback, line);
    return { success: true, text: line };
  },
};

export const pnlAction: Action = {
  name: "VALHALLA_PNL",
  description: "Report paper or live realized P&L from the Mech book. Read only.",
  similes: ["COPYBOT_PNL", "SHOW_POSITIONS"],
  validate: async () => true,
  handler: async (runtime, _message, _state, _options, callback) => {
    const service = getValhallaService(runtime);
    const pnl = summarizePnl(service.book.closed);
    const line = `${service.status()}\nrealized ${pnl.pnlSol.toFixed(4)} SOL over ${pnl.trades} closes (${pnl.wins} wins, ${pnl.losses} losses)`;
    await reply(callback, line);
    return { success: true, text: line };
  },
};
