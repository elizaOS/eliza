/**
 * Replays the chunk streams of quint/ParentDirectiveStream.qnt through the
 * production SubAgentRouter on a PGlite-backed AgentRuntime. Each chunk is a
 * `message` session event on the production AcpService, so the router's own
 * buffering decides which `USE_SKILL parent-agent` directives reach the
 * parent-agent broker. Only the delivery of the broker's reply into the child
 * session is recorded instead of being written to a subprocess.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AgentRuntime, IAgentRuntime, ServiceClass } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.js";
import { SubAgentRouter } from "../services/sub-agent-router.js";
import type { SessionInfo } from "../services/types.js";
import { createRealTestRuntime } from "./real-runtime.js";

/** One streamed sequence of chunks and the directives it dispatches. */
interface ModelCase {
  chunks: number[];
  dispatched: number;
}

// The text a sub-agent streams for each chunk kind of the model.
const CHUNKS = [
  // 0 prose without the marker
  "Building the color app now.\n",
  // 1 the marker in prose, as a sub-agent repeats its prompt (goal-prompt.ts)
  "I can ask the parent Eliza agent to run its own capabilities via the parent-agent bridge (USE_SKILL parent-agent).\n",
  // 2 the marker with a balanced object that is not JSON, as written in the
  // deploy guidance (app-deploy-guidance.ts)
  'USE_SKILL parent-agent {"mode":"cloud-command","command":"apps.create","params":{...}}\n',
  // 3 a complete directive
  'USE_SKILL parent-agent {"mode":"list-cloud-commands"}\n',
  // 4 the first part of a directive whose JSON is still streaming
  'USE_SKILL parent-agent {"mode":"list-cl',
  // 5 the rest of that directive
  'oud-commands"}\n',
];
const NAMES = [
  "prose",
  "mention",
  "malformed",
  "directive",
  "opening",
  "closing",
];
const STREAM_LENGTHS = ["one chunk", "two chunks", "three chunks"];

// A directive streamed after a prose mention of the marker or after a
// malformed one is still dispatched.
const DEFAULT_CASES: ModelCase[] = [
  { chunks: [3], dispatched: 1 },
  { chunks: [1], dispatched: 0 },
  { chunks: [1, 3], dispatched: 1 },
  { chunks: [2, 3], dispatched: 1 },
  { chunks: [4, 5], dispatched: 1 },
  { chunks: [1, 4, 5], dispatched: 1 },
  { chunks: [2, 1, 3], dispatched: 1 },
  { chunks: [3, 2, 3], dispatched: 2 },
  { chunks: [0, 1, 0], dispatched: 0 },
];

const casesFile = process.env.ELIZA_PARENT_DIRECTIVE_MODEL_CASES;
const cases: ModelCase[] = casesFile
  ? JSON.parse(readFileSync(casesFile, "utf8"))
  : DEFAULT_CASES;

/** Production AcpService; the reply delivery into the child is recorded. */
class DeliveryRecordingAcpService extends AcpService {
  static override async start(runtime: IAgentRuntime): Promise<AcpService> {
    return new DeliveryRecordingAcpService(runtime);
  }

  readonly delivered: Array<{ sessionId: string; input: string }> = [];

  override async sendToSession(sessionId: string, input: string) {
    this.delivered.push({ sessionId, input });
    return {} as never;
  }

  override async getSession(
    _sessionId: string,
  ): Promise<SessionInfo | undefined> {
    return undefined;
  }
}

let runtime: AgentRuntime;
let cleanup: (() => Promise<void>) | undefined;
let acp: DeliveryRecordingAcpService;
let router: SubAgentRouter;

beforeAll(async () => {
  ({ runtime, cleanup } = await createRealTestRuntime({
    characterName: "Eliza",
    plugins: [
      {
        name: "parent-directive-acp-delivery",
        description: "Production ACP service with recorded child delivery",
        services: [DeliveryRecordingAcpService as unknown as ServiceClass],
      },
    ],
  }));
  const loaded = await runtime.getServiceLoadPromise(AcpService.serviceType);
  if (!(loaded instanceof DeliveryRecordingAcpService)) {
    throw new Error("ACP service did not start");
  }
  acp = loaded;
  router = await SubAgentRouter.start(runtime);
  await vi.waitFor(() => expect(router.isActive()).toBe(true), {
    timeout: 10_000,
  });
}, 60_000);

afterAll(async () => {
  await router?.stop();
  await cleanup?.();
});

const repliesTo = (sessionId: string) =>
  acp.delivered.filter((entry) => entry.sessionId === sessionId);

describe("parent directive stream model", () => {
  it.each(STREAM_LENGTHS)(
    "replays streams of %s",
    async (size) => {
      const length = STREAM_LENGTHS.indexOf(size) + 1;
      const group = cases.filter((item) => item.chunks.length === length);
      expect(group.length).toBeGreaterThan(0);
      // Each stream is one child session; its chunks arrive in order.
      const streams = group.map((item) => {
        const sessionId = `child-${randomUUID()}`;
        for (const kind of item.chunks) {
          acp.emitSessionEvent(sessionId, "message", { text: CHUNKS[kind] });
        }
        return { sessionId, item };
      });
      const expected = group.reduce((sum, item) => sum + item.dispatched, 0);
      const replies = () =>
        streams.reduce(
          (sum, stream) => sum + repliesTo(stream.sessionId).length,
          0,
        );
      const deadline = Date.now() + 20_000;
      while (replies() < expected && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // A dispatch the model does not expect would arrive in this window.
      await new Promise((resolve) => setTimeout(resolve, 200));
      for (const { sessionId, item } of streams) {
        const label = item.chunks.map((kind) => NAMES[kind]).join(" + ");
        const received = repliesTo(sessionId);
        expect(received.length, label).toBe(item.dispatched);
        for (const reply of received) {
          expect(reply.input, label).not.toMatch(/^parent-agent bridge/);
        }
      }
    },
    60_000,
  );
});
