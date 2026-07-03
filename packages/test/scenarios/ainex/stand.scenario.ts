/**
 * Keyless per-plugin e2e for `@elizaos/plugin-ainex` (issue #8801).
 *
 * Drives the `AINEX_STAND` action end-to-end against a scoped, in-process
 * mock of the AiNex websocket bridge. The seed stands up a real `ws`
 * WebSocketServer that speaks the bridge protocol (CommandEnvelope ->
 * ResponseEnvelope) and points `ELIZA_AINEX_BRIDGE_URL` at it. Because
 * required plugins load AFTER seeds run, the AinexService connects to the
 * mock at start, loads the fallback robot profile, and the action's real
 * service -> AinexBridgeClient -> websocket send path runs with zero
 * hardware, no robot, and no credentials. AINEX_STAND makes no model calls
 * of its own, so only routing fixtures are needed.
 */
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import { WebSocketServer } from "ws";
import { describeCalls } from "../_helpers/effect-assertions.ts";

const AINEX_STAND = "AINEX_STAND";
type R = AgentRuntime & {
  scenarioLlmFixtures?: {
    register: (...f: Array<Record<string, unknown>>) => void;
  };
};

type BridgeCommandFrame = {
  command?: string;
  payload?: Record<string, unknown>;
};

/** Every CommandEnvelope the mock bridge actually received over the wire. */
const observedBridgeCommands: BridgeCommandFrame[] = [];

export default scenario({
  lane: "pr-deterministic",
  id: "ainex.stand",
  title: "AiNex: stand the robot up against a mocked websocket bridge",
  domain: "ainex",
  tags: ["smoke", "ainex", "connector", "robot"],
  description:
    "Plays the `stand` action group through the AINEX_STAND action against a scoped in-process mock of the AiNex websocket bridge — keyless, no robot hardware.",

  requires: { plugins: ["@elizaos/plugin-ainex"] },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "ainex-bridge-mock",
      apply: async (ctx) => {
        const runtime = ctx.runtime as R;

        // Real in-process websocket server speaking the bridge wire protocol.
        // Every CommandEnvelope is answered with an ok ResponseEnvelope keyed
        // back by request_id. `profile.describe` returns no profile, so the
        // service falls back to the hardcoded Hiwonder descriptor (no throw).
        observedBridgeCommands.length = 0;
        const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
        wss.on("connection", (socket) => {
          socket.on("message", (raw: Buffer | string) => {
            let frame: {
              type?: string;
              request_id?: string;
            } & BridgeCommandFrame = {};
            try {
              frame = JSON.parse(
                typeof raw === "string" ? raw : raw.toString("utf8"),
              );
            } catch {
              return;
            }
            if (
              frame.type !== "command" ||
              typeof frame.request_id !== "string"
            )
              return;
            observedBridgeCommands.push({
              command: frame.command,
              payload: frame.payload,
            });
            socket.send(
              JSON.stringify({
                type: "response",
                request_id: frame.request_id,
                timestamp: new Date().toISOString(),
                ok: true,
                backend: "mock",
                message: "",
                data: {},
              }),
            );
          });
        });
        await new Promise<void>((resolve) => wss.on("listening", resolve));
        const address = wss.address();
        const port = typeof address === "object" && address ? address.port : 0;

        // Keep the server referenced for the lifetime of the run so it is not
        // collected while the agent holds the socket open.
        (
          globalThis as { __ainexBridgeMock?: WebSocketServer }
        ).__ainexBridgeMock = wss;

        const url = `ws://127.0.0.1:${port}`;
        runtime.setSetting("ELIZA_AINEX_BRIDGE_URL", url, false);

        runtime.scenarioLlmFixtures?.register(
          {
            name: "ainex-stage1",
            match: {
              modelType: ModelType.RESPONSE_HANDLER,
              input: (v: string) => v.includes("AiNex"),
              toolName: "HANDLE_RESPONSE",
            },
            response: {
              contexts: ["connectors"],
              intents: ["stand the robot up"],
              replyText: "",
              threadOps: [],
              candidateActionNames: [AINEX_STAND],
            },
            times: 1,
          },
          {
            name: "ainex-planner",
            match: {
              modelType: ModelType.ACTION_PLANNER,
              input: (v: string) => v.includes("AiNex"),
              toolName: AINEX_STAND,
            },
            response: {
              text: "",
              thought: "Stand the AiNex up into its home pose.",
              messageToUser: "",
              completed: true,
              finishReason: "tool-calls",
              toolCalls: [
                {
                  id: "call-ainex-stand",
                  name: AINEX_STAND,
                  type: "function",
                  arguments: {},
                },
              ],
            },
            times: 1,
          },
          {
            name: "ainex-decision",
            match: (call: { modelType: string; toolNames: string[] }) =>
              call.modelType === ModelType.RESPONSE_HANDLER &&
              !call.toolNames.includes("HANDLE_RESPONSE"),
            response: {
              success: true,
              decision: "FINISH",
              thought: "Robot is standing; nothing more to do.",
              messageToUser: "AiNex is standing.",
            },
            times: 1,
          },
        );
        return undefined;
      },
    },
  ],

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "AiNex",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "stand",
      text: "Stand up, AiNex.",
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find(
          (a) => a.actionName === AINEX_STAND,
        );
        if (!call) {
          return `Expected ${AINEX_STAND} but got: ${turn.actionsCalled
            .map((a) => a.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${AINEX_STAND} did not succeed: ${
            call.error?.message ?? call.result?.text ?? "unknown error"
          }`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: AINEX_STAND,
      status: "success",
      minCount: 1,
    },
    {
      // Effect proof (#11381): AINEX_STAND's whole job is one wire command —
      // `action.play {name:"stand"}` — to the bridge. The seed records every
      // CommandEnvelope the mock bridge receives; a handler that "succeeds"
      // without the envelope crossing the socket (or with the wrong action
      // group) fails here.
      type: "custom",
      name: "stand-command-crossed-the-bridge",
      predicate: (ctx) => {
        const hit = observedBridgeCommands.find(
          (frame) =>
            frame.command === "action.play" && frame.payload?.name === "stand",
        );
        if (!hit) {
          return (
            `mock bridge never received action.play {name:"stand"}; got ${JSON.stringify(observedBridgeCommands).slice(0, 300)}; ` +
            `calls: ${describeCalls(ctx)}`
          );
        }
      },
    },
  ],
});
