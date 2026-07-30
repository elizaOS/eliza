/**
 * Port-free desktop agent transport over the child process's NDJSON stdio.
 *
 * Electrobun owns the child and correlates frames by request id. Independent
 * requests dispatch concurrently, and a `local_agent_cancel` control frame
 * aborts the exact route/model operation without imposing a wall-clock limit.
 */

import { createInterface } from "node:readline";
import { dispatchRoute } from "@elizaos/agent";
import type { IAgentRuntime } from "@elizaos/core";
import {
  type AndroidRequestPayload,
  dispatchBufferedRequest,
  dispatchStreamingRequest,
} from "@elizaos/plugin-capacitor-bridge/android/dispatch";
import {
  createStdioBridge,
  type StdioBridgeRequestFrame,
} from "@elizaos/plugin-capacitor-bridge/shared/stdio-bridge";

function requestId(frame: StdioBridgeRequestFrame): string {
  if (typeof frame.id !== "string" && typeof frame.id !== "number") {
    throw new Error("Desktop local-agent frame requires a request id");
  }
  return String(frame.id);
}

/** Attach the protocol to process stdin/stdout after the runtime is ready. */
export function serveDesktopLocalAgentStdio(runtime: IAgentRuntime): void {
  const active = new Map<string, AbortController>();
  const bridge = createStdioBridge({
    request: async (frame) => {
      if (frame.method === "local_agent_cancel") {
        const payload =
          frame.payload &&
          typeof frame.payload === "object" &&
          !Array.isArray(frame.payload)
            ? (frame.payload as Record<string, unknown>)
            : {};
        const targetId = String(payload.requestId ?? "");
        const controller = active.get(targetId);
        if (!controller) return { requestId: targetId, cancelled: false };
        controller.abort(
          new DOMException(
            "Desktop local-agent request cancelled",
            "AbortError",
          ),
        );
        return { requestId: targetId, cancelled: true };
      }

      const id = requestId(frame);
      const controller = new AbortController();
      active.set(id, controller);
      try {
        return await dispatchBufferedRequest(
          runtime,
          dispatchRoute,
          (frame.payload ?? {}) as AndroidRequestPayload,
          undefined,
          controller.signal,
          "desktop",
        );
      } finally {
        if (active.get(id) === controller) active.delete(id);
      }
    },
    requestStream: async (frame, sink) => {
      const id = requestId(frame);
      const controller = new AbortController();
      active.set(id, controller);
      try {
        await dispatchStreamingRequest(
          runtime,
          dispatchRoute,
          (frame.payload ?? {}) as AndroidRequestPayload,
          sink,
          undefined,
          controller.signal,
          "desktop",
        );
      } finally {
        if (active.get(id) === controller) active.delete(id);
      }
    },
    writeFrame: (frame) => {
      process.stdout.write(`${JSON.stringify(frame)}\n`);
    },
  });

  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    void bridge.handleLine(line);
  });
  lines.once("close", () => {
    for (const controller of active.values()) {
      controller.abort(
        new DOMException(
          "Desktop local-agent owner disconnected",
          "AbortError",
        ),
      );
    }
    active.clear();
    void bridge.drain();
  });
  process.stdout.write(
    `${JSON.stringify({ type: "local_agent_ready", ready: true })}\n`,
  );
}
