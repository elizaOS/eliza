import {
  DEFAULT_CHAT_DB_PATH,
  openChatDb,
} from "@elizaos/plugin-imessage";
import {
  createLifeOpsActivitySignal,
  type LifeOpsRepository,
} from "./repository.js";

const OUTBOUND_SIGNAL_LOOKBACK_MS = 10 * 60 * 1_000;

export async function probeIMessageOutboundActivity(args: {
  repository: LifeOpsRepository;
  agentId: string;
  dbPath?: string;
}): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }
  const reader = await openChatDb(args.dbPath ?? process.env.IMESSAGE_DB_PATH ?? DEFAULT_CHAT_DB_PATH);
  if (!reader) {
    return;
  }
  try {
    const latestOwnMessageMs = reader.getLatestOwnMessageTimestamp();
    if (latestOwnMessageMs === null) {
      return;
    }
    const observedAt = new Date(latestOwnMessageMs).toISOString();
    const recentSignals = await args.repository.listActivitySignals(args.agentId, {
      sinceAt: new Date(latestOwnMessageMs - OUTBOUND_SIGNAL_LOOKBACK_MS).toISOString(),
      limit: 32,
      states: ["active"],
    });
    const alreadyCaptured = recentSignals.some(
      (signal) =>
        signal.source === "imessage_outbound" && signal.observedAt === observedAt,
    );
    if (alreadyCaptured) {
      return;
    }
    await args.repository.createActivitySignal(
      createLifeOpsActivitySignal({
        agentId: args.agentId,
        source: "imessage_outbound",
        platform: "macos_chatdb",
        state: "active",
        observedAt,
        idleState: null,
        idleTimeSeconds: 0,
        onBattery: null,
        health: null,
        metadata: {
          channel: "imessage",
          probe: "chatdb_latest_outbound",
        },
      }),
    );
  } finally {
    reader.close();
  }
}
