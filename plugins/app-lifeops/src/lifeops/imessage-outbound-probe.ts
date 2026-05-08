import { homedir } from "node:os";
import { join } from "node:path";
import {
  createLifeOpsActivitySignal,
  type LifeOpsRepository,
} from "./repository.js";

const OUTBOUND_SIGNAL_LOOKBACK_MS = 10 * 60 * 1_000;
const IMESSAGE_PLUGIN_PACKAGE = "@elizaos/plugin-imessage";

function nativeIMessageProbeDisabled(): boolean {
  const backend = (
    process.env.ELIZA_IMESSAGE_BACKEND ??
    process.env.IMESSAGE_BACKEND ??
    ""
  )
    .trim()
    .toLowerCase();
  return backend === "none" || backend === "disabled";
}

export async function probeIMessageOutboundActivity(args: {
  repository: LifeOpsRepository;
  agentId: string;
  dbPath?: string;
}): Promise<void> {
  if (process.platform !== "darwin" || nativeIMessageProbeDisabled()) {
    return;
  }
  // Dynamic import: openChatDb / DEFAULT_CHAT_DB_PATH ship in the local
  // workspace plugin but are absent from the published @elizaos/plugin-imessage
  // tarball. Static imports would crash module load on non-darwin CI builds
  // that resolve the plugin from npm.
  const mod = (await import(/* @vite-ignore */ IMESSAGE_PLUGIN_PACKAGE)) as {
    openChatDb?: (path: string) => Promise<{
      getLatestOwnMessageTimestamp: () => number | null;
      close: () => void;
    } | null>;
    DEFAULT_CHAT_DB_PATH?: string;
  };
  if (typeof mod.openChatDb !== "function") {
    return;
  }
  const defaultPath =
    mod.DEFAULT_CHAT_DB_PATH ??
    join(homedir(), "Library", "Messages", "chat.db");
  const reader = await mod.openChatDb(
    args.dbPath ?? process.env.IMESSAGE_DB_PATH ?? defaultPath,
  );
  if (!reader) {
    return;
  }
  try {
    const latestOwnMessageMs = reader.getLatestOwnMessageTimestamp();
    if (latestOwnMessageMs === null) {
      return;
    }
    const observedAt = new Date(latestOwnMessageMs).toISOString();
    const recentSignals = await args.repository.listActivitySignals(
      args.agentId,
      {
        sinceAt: new Date(
          latestOwnMessageMs - OUTBOUND_SIGNAL_LOOKBACK_MS,
        ).toISOString(),
        limit: 32,
        states: ["active"],
      },
    );
    const alreadyCaptured = recentSignals.some(
      (signal) =>
        signal.source === "imessage_outbound" &&
        signal.observedAt === observedAt,
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
