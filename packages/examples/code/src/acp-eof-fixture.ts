#!/usr/bin/env bun

import { writeFile } from "node:fs/promises";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { installAcpConnectionCloseTeardown } from "./acp-connection-lifecycle.js";

const markerPath = process.env.ELIZA_ACP_EOF_MARKER;
if (!markerPath) throw new Error("ELIZA_ACP_EOF_MARKER is required");

let active:
  | {
      controller: AbortController;
      settled: Promise<void>;
    }
  | undefined;

const turns = {
  async cancelAllAndWait(timeoutMs: number): Promise<number> {
    const turn = active;
    if (!turn) return 0;
    turn.controller.abort(
      new DOMException("ACP connection closed", "AbortError"),
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        turn.settled,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("fixture turn did not quiesce")),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    return 1;
  },
};

const output = new WritableStream<Uint8Array>({
  write(chunk) {
    return new Promise<void>((resolve, reject) => {
      process.stdout.write(chunk, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  },
});
const input = new ReadableStream<Uint8Array>({
  start(controller) {
    process.stdin.on("data", (chunk: Buffer) =>
      controller.enqueue(new Uint8Array(chunk)),
    );
    process.stdin.on("end", () => controller.close());
    process.stdin.on("error", (error) => controller.error(error));
  },
});

const connection = new AgentSideConnection(
  () => ({
    async initialize() {
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
        authMethods: [],
      };
    },
    async authenticate() {
      return {};
    },
    async newSession() {
      return { sessionId: "eof-session" };
    },
    async prompt() {
      const controller = new AbortController();
      let settle = (): void => {};
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      active = { controller, settled };
      process.stderr.write("PROMPT_STARTED\n");
      try {
        // Deliberately ignore the abort signal. Without a process boundary this
        // simulates a provider/action that keeps mutation authority after EOF.
        await new Promise((resolve) => setTimeout(resolve, 500));
        await writeFile(markerPath, "late mutation after ACP EOF\n", "utf8");
        return { stopReason: "end_turn" as const };
      } finally {
        active = undefined;
        settle();
      }
    },
    async cancel() {},
  }),
  ndJsonStream(output, input),
);

installAcpConnectionCloseTeardown(connection.signal, turns, {
  timeoutMs: 50,
  exit: (code) => process.exit(code),
});
