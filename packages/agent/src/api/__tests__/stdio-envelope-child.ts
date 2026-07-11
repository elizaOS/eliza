/**
 * Bun-subprocess half of the IPC byte-envelope round-trip proof
 * (`dispatch-route-stdio-envelope.test.ts`). Serves the REAL NDJSON
 * stdio-bridge kernel (`createStdioBridge`) over this process's actual
 * stdin/stdout — the same kernel + envelope the Android UDS bridge, the iOS
 * stdio pipe, and the Electrobun local-agent child speak — with requests
 * dispatched through the real `dispatchBufferedRequest` → `dispatchRoute`
 * kernel against a real `AgentRuntime` route table.
 *
 * Routes (argv[2] is the base64 payload the audio route serves):
 *   GET /api/envelope/audio    → binary bytes, `Audio/WAV; Charset=UTF-8`
 *                                (mixed case + parameter — the exact shape the
 *                                old substring classifier corrupted)
 *   GET /api/envelope/partial  → writes a chunk, then throws (partial write)
 *   GET /api/envelope/bad-json → declares JSON, emits a malformed body
 *
 * stdout carries ONLY protocol frames plus whatever the runtime logger emits;
 * the parent filters to JSON frames keyed by request id, exactly like the
 * production Electrobun dispatcher does on the shared pipe.
 *
 * Lives under `__tests__/` (without a `.test.ts` suffix) so the coverage
 * changed-source classifier treats it as test support while no test collector
 * tries to run it in-process; spawn it with `bun --conditions=eliza-source`.
 */

import { Buffer } from "node:buffer";
import process from "node:process";
import { createInterface } from "node:readline";
import {
  AgentRuntime,
  type Character,
  type Route,
  type RouteResponse,
} from "@elizaos/core";
// Package-entry imports (not relative paths into the sibling package): the
// agent build's boundary guard forbids relative escapes, and the spawn runs
// with `--conditions=eliza-source` so these resolve to the plugin's TS sources
// without requiring a built dist.
import {
  type AndroidRequestPayload,
  dispatchBufferedRequest,
} from "@elizaos/plugin-capacitor-bridge/android/dispatch";
import {
  createStdioBridge,
  type StdioBridgeRequestFrame,
} from "@elizaos/plugin-capacitor-bridge/shared/stdio-bridge";
import { dispatchRoute } from "../dispatch-route.ts";

interface ShimResponse extends RouteResponse {
  setHeader(name: string, value: string | string[]): RouteResponse;
  write(chunk: unknown): boolean;
  end(chunk?: unknown): RouteResponse;
}

function isShimResponse(res: RouteResponse): res is ShimResponse {
  const candidate = res as Partial<
    Record<"setHeader" | "write" | "end", unknown>
  >;
  return (
    typeof candidate.setHeader === "function" &&
    typeof candidate.write === "function" &&
    typeof candidate.end === "function"
  );
}

function legacyRoute(
  path: string,
  handler: (response: ShimResponse) => void,
): Route {
  return {
    type: "GET",
    path,
    name: `envelope-fixture${path.replaceAll("/", "-")}`,
    public: true,
    publicReason: "Test-only IPC envelope round-trip fixture.",
    handler: async (_req, res) => {
      if (!isShimResponse(res)) {
        throw new Error(
          "legacy shim response no longer exposes setHeader/write/end",
        );
      }
      handler(res);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function framePayload(frame: StdioBridgeRequestFrame): AndroidRequestPayload {
  return isRecord(frame.payload) ? frame.payload : {};
}

const payloadBase64 = process.argv[2];
if (!payloadBase64) {
  process.stderr.write("usage: bun stdio-envelope-child.ts <base64-bytes>\n");
  process.exit(2);
}
const audioBytes = Buffer.from(payloadBase64, "base64");

const character: Character = { name: "stdio-envelope-fixture" };
const runtime = new AgentRuntime({ character });
runtime.routes.push(
  legacyRoute("/api/envelope/audio", (res) => {
    res.setHeader("Content-Type", "Audio/WAV; Charset=UTF-8");
    res.end(audioBytes);
  }),
  legacyRoute("/api/envelope/partial", (res) => {
    res.setHeader("content-type", "text/event-stream");
    res.write("data: token-1\n\n");
    throw new Error("model backend fell over mid-stream");
  }),
  legacyRoute("/api/envelope/bad-json", (res) => {
    res.setHeader("content-type", "application/json");
    res.end("{not-json");
  }),
);

const bridge = createStdioBridge({
  request: async (frame) =>
    dispatchBufferedRequest(runtime, dispatchRoute, framePayload(frame)),
  writeFrame: (frame) => {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  },
});

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  void bridge.handleLine(line);
});
lines.once("close", () => {
  void bridge.drain().then(() => {
    process.exit(0);
  });
});
