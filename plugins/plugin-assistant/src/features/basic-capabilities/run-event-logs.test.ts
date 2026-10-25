import {
  type IAgentRuntime,
  type RunEventPayload,
  TurnAbortedError,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  decodeRecord,
  encodeRecord,
} from "../../../../plugin-sqlite/record-codec.ts";
import { createAssistantBehavior } from "./index.ts";

describe("portable run-event diagnostics", () => {
  it.each(["RUN_ENDED", "RUN_TIMEOUT"] as const)(
    "%s retains the error stack in a portable record",
    async (event) => {
      const stored: unknown[] = [];
      const runtime = {
        createLogs: async (logs: unknown[]) => {
          stored.push(...logs.map((log) => decodeRecord(encodeRecord(log))));
        },
      } as unknown as IAgentRuntime;
      const error = new TurnAbortedError("caller disconnected");
      const handler = createAssistantBehavior().events?.[event]?.at(-1);
      if (!handler) throw new Error(`Missing ${event} handler`);
      await handler({ runtime, error, status: "cancelled" } as RunEventPayload);
      expect(stored).toEqual([
        expect.objectContaining({
          type: "run_event",
          body: expect.objectContaining({ error: error.stack }),
        }),
      ]);
    },
  );
});
