/** The accepted background-handoff receipt shared by the planner and message-pipeline tests. */
import type { EffectReceipt } from "@elizaos/core";

/** The applied receipt of a background handoff its provider accepted. */
export const ACCEPTED_SPAWN_RECEIPT: EffectReceipt = {
  receiptId: "spawn-receipt",
  operation: "agent-orchestrator.tasks.spawn_agent",
  resource: { kind: "acp.session", id: "session-1" },
  artifacts: [],
  idempotency: { key: null, replayed: false },
  observedAt: "2026-01-01T00:00:00.000Z",
  outcome: "applied",
  commit: {
    kind: "provider_accepted",
    id: "session-1",
    committedAt: "2026-01-01T00:00:00.000Z",
  },
};
