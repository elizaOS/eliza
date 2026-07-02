/**
 * Keyless per-plugin e2e for `@elizaos/plugin-local-inference` (issue #8801).
 *
 * Drives the `START_TRANSCRIPTION` action end-to-end. The action is a local,
 * deterministic control toggle: it emits a one-way `voice-control` command on
 * the AgentEventService bus (the renderer subscribes and toggles mic capture).
 * No model download, no live credentials, no device hardware — the only
 * dependency is the AGENT_EVENT service, which the seed registers from
 * `@elizaos/core` (the same real service the API host wires) so the action's
 * `validate` passes and the handler reports successful delivery.
 *
 * Only routing fixtures are needed: the action makes no `useModel` call, and it
 * declares no parameter schema, so the planner tool call carries empty arguments.
 */
import {
  AgentEventService,
  type AgentRuntime,
  ModelType,
  ServiceType,
} from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";

const START_TRANSCRIPTION = "START_TRANSCRIPTION";
const VOICE_CONTROL_STREAM = "voice-control";

type R = AgentRuntime & {
  scenarioLlmFixtures?: {
    register: (...f: Array<Record<string, unknown>>) => void;
  };
};

type BusEvent = { stream?: string; data?: unknown };
type SubscribableBus = {
  subscribe?: (listener: (event: BusEvent) => void) => () => void;
};

/** Every event the live AGENT_EVENT bus emitted during the run. */
const observedBusEvents: BusEvent[] = [];

export default scenario({
  lane: "pr-deterministic",
  id: "local-inference.start-transcription",
  title: "Local inference: start voice transcription via the control bus",
  domain: "local-inference",
  tags: ["smoke", "local-inference", "voice"],
  description:
    "Exercises the real START_TRANSCRIPTION action end-to-end. The action emits a voice-control command on the AGENT_EVENT bus (seeded from @elizaos/core) — keyless, no model download, no device.",

  requires: { plugins: ["@elizaos/plugin-local-inference"] },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "local-inference-voice-control-setup",
      apply: async (ctx) => {
        const runtime = ctx.runtime as R;

        // START_TRANSCRIPTION.validate requires the AGENT_EVENT service; the
        // scenario API host doesn't wire it, so register the real one here and
        // force-start it so the synchronous getService() in validate resolves.
        await runtime.registerService(AgentEventService);
        await runtime.getServiceLoadPromise(ServiceType.AGENT_EVENT);

        // Tap the live bus (the same subscribe() the renderer uses) so the
        // final check can prove the voice-control command actually crossed it.
        observedBusEvents.length = 0;
        const bus = runtime.getService(
          ServiceType.AGENT_EVENT,
        ) as SubscribableBus | null;
        bus?.subscribe?.((event) => {
          observedBusEvents.push(event);
        });

        runtime.scenarioLlmFixtures?.register(
          {
            name: "local-inference-stage1",
            match: {
              modelType: ModelType.RESPONSE_HANDLER,
              input: (v: string) => v.includes("transcrib"),
              toolName: "HANDLE_RESPONSE",
            },
            response: {
              contexts: ["voice"],
              intents: ["start voice transcription"],
              replyText: "",
              threadOps: [],
              candidateActionNames: [START_TRANSCRIPTION],
            },
            times: 1,
          },
          {
            name: "local-inference-planner",
            match: {
              modelType: ModelType.ACTION_PLANNER,
              input: (v: string) => v.includes("transcrib"),
              toolName: START_TRANSCRIPTION,
            },
            response: {
              text: "",
              thought: "Begin long-form voice transcription on the device.",
              messageToUser: "",
              completed: true,
              finishReason: "tool-calls",
              toolCalls: [
                {
                  id: "call-start-transcription",
                  name: START_TRANSCRIPTION,
                  type: "function",
                  arguments: {},
                },
              ],
            },
            times: 1,
          },
          {
            name: "local-inference-decision",
            match: (call: { modelType: string; toolNames: string[] }) =>
              call.modelType === ModelType.RESPONSE_HANDLER &&
              !call.toolNames.includes("HANDLE_RESPONSE"),
            response: {
              success: true,
              decision: "FINISH",
              thought: "Transcription started; nothing more to do.",
              messageToUser: "Starting transcription.",
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
      title: "Voice",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "start",
      text: "Start transcribing this conversation.",
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find(
          (a) => a.actionName === START_TRANSCRIPTION,
        );
        if (!call) {
          return `Expected ${START_TRANSCRIPTION} but got: ${turn.actionsCalled
            .map((a) => a.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${START_TRANSCRIPTION} did not succeed: ${
            call.error?.message ?? call.result?.text ?? "unknown error"
          }`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: START_TRANSCRIPTION,
      status: "success",
      minCount: 1,
    },
    {
      // Effect proof (#11381): the action's whole job is a one-way
      // `voice-control` command on the AGENT_EVENT bus. The seed subscribed
      // to the live bus; a `start` command must have actually been emitted —
      // handler-returned success without the bus event fails here.
      type: "custom",
      name: "voice-control-start-emitted-on-bus",
      predicate: () => {
        const hit = observedBusEvents.find((event) => {
          if (event.stream !== VOICE_CONTROL_STREAM) return false;
          const data = event.data as
            | { type?: string; command?: string }
            | undefined;
          return data?.type === "voice-control" && data?.command === "start";
        });
        if (!hit) {
          return `no {type:"voice-control", command:"start"} event observed on the "${VOICE_CONTROL_STREAM}" stream; saw ${observedBusEvents.length} bus event(s): ${JSON.stringify(observedBusEvents.map((e) => e.stream)).slice(0, 200)}`;
        }
      },
    },
  ],
});
