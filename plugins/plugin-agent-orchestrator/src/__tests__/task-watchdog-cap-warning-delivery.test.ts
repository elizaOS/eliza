/**
 * A cap warning is only spent when the originating room actually received it.
 * The watchdog may skip delivery (no send handler bound, or a session spawned
 * without a chat origin) while the session keeps climbing to its cap; the
 * one-time warning must stay pending so a later tick still posts it once the
 * capability is available.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { expect, it } from "vitest";
import { TaskWatchdogService } from "../services/task-watchdog-service.ts";

const ROOM_ID = "5f2a1d3e-0000-4000-8000-000000000001";

type Sent = { roomId?: string; text?: string };

function buildRuntime(sent: Sent[]) {
  const session = {
    id: "session-cap-1",
    status: "running",
    lastActivityAt: new Date(),
    metadata: { roomId: ROOM_ID, label: "Worker" },
  };
  const acp = {
    listSessions: async () => [session],
    sendToSession: async () => undefined,
  };
  const router = {
    getRoundTripCount: () => 9,
    getRoundTripCap: () => 10,
  };
  const runtime: Record<string, unknown> = {
    getSetting: () => undefined,
    getService: (name: string) => {
      if (name === "ACP_SUBPROCESS_SERVICE") return acp;
      if (name === "ACPX_SUB_AGENT_ROUTER") return router;
      return null;
    },
  };
  const withSend = () => {
    runtime.sendMessageToTarget = async (
      target: { roomId?: string },
      content: { text?: string },
    ) => {
      sent.push({ roomId: target.roomId, text: content.text });
      return { id: `memory-${sent.length}` };
    };
  };
  return { runtime: runtime as unknown as IAgentRuntime, withSend };
}

it("keeps a cap warning pending until the room actually receives it", async () => {
  const sent: Sent[] = [];
  const { runtime, withSend } = buildRuntime(sent);
  const watchdog = new TaskWatchdogService(runtime);

  // No send capability yet: nothing can be delivered on this tick.
  await watchdog.runOnce();
  expect(sent).toEqual([]);

  // The session is still at 90% of its round-trip cap, so the warning that was
  // never delivered must still be pending and go out on this tick.
  withSend();
  await watchdog.runOnce();
  expect(sent).toEqual([
    { roomId: ROOM_ID, text: expect.stringContaining("9/10 round-trips") },
  ]);

  // Delivered once: the same approach must not warn twice.
  await watchdog.runOnce();
  expect(sent).toHaveLength(1);
});
