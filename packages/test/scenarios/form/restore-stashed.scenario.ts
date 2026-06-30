/**
 * Keyless per-plugin e2e for `@elizaos/plugin-form` (issue #8801).
 *
 * `@elizaos/plugin-form` ships its agent action surface — the noun-shaped
 * `FORM` router (subaction `restore`) — exported but, by design, NOT wired into
 * the plugin's own `actions: []`; a consuming plugin registers it (see the
 * package CLAUDE.md "Actions" section). This scenario mirrors that consumer
 * wiring: the seed registers the real `formAction` on the runtime, seeds a
 * stashed `FormSession` straight into plugin-form's component store, then a
 * "resume my form" turn drives the real planner → `FORM` action →
 * `FormService.restore` → component round-trip. Fully keyless: no live model
 * (deterministic LLM proxy fixtures) and no external API.
 */
import type { AgentRuntime, UUID } from "@elizaos/core";
import { ModelType, stringToUuid } from "@elizaos/core";
import {
  type FormSession,
  formAction,
  saveSession,
} from "@elizaos/plugin-form";
import { scenario } from "@elizaos/scenario-runner/schema";

const FORM = "FORM";
const SCENARIO_ID = "form.restore-stashed";
const ROOM = "main";

// The executor derives a room's entity/room ids deterministically from the
// scenario + room id (see resolveScenarioRooms): a room with no explicit
// `account` uses `scenario-user:<scenarioId>:<roomId>`.
const ROOM_ID = stringToUuid(`scenario-room:${SCENARIO_ID}:${ROOM}`);
const ENTITY_ID = stringToUuid(
  `scenario-account:scenario-user:${SCENARIO_ID}:${ROOM}`,
);

type R = AgentRuntime & {
  registerAction?: (action: unknown) => void;
  scenarioLlmFixtures?: {
    register: (...f: Array<Record<string, unknown>>) => void;
  };
};

export default scenario({
  lane: "pr-deterministic",
  id: "form.restore-stashed",
  title: "Form: restore a stashed form session",
  domain: "form",
  tags: ["smoke", "form", "action"],
  description:
    "Drives the FORM action's `restore` subaction against a seeded stashed FormSession in plugin-form's component store — keyless, no live model, no external API.",

  requires: { plugins: ["@elizaos/plugin-form"] },
  isolation: "per-scenario",

  rooms: [
    {
      id: ROOM,
      source: "dashboard",
      channelType: "DM",
      title: "Form",
    },
  ],

  seed: [
    {
      type: "custom",
      name: "seed-stashed-session-and-register-action",
      apply: async (ctx) => {
        const runtime = ctx.runtime as R;

        // Register the FORM action exactly as a consuming plugin would (the
        // plugin exports it but leaves `actions: []`). Plugin-form itself loads
        // after seeds, so its FormService is resolved lazily by the handler at
        // turn time.
        runtime.registerAction?.(formAction);

        // Seed one stashed session directly into the component store so
        // FormService.getStashedSessions / restore find it at turn time.
        const now = Date.now();
        const session: FormSession = {
          id: "seed-stashed-session",
          formId: "registration",
          entityId: ENTITY_ID as UUID,
          roomId: ROOM_ID as UUID,
          status: "stashed",
          fields: {},
          history: [],
          effort: {
            interactionCount: 2,
            timeSpentMs: 30_000,
            firstInteractionAt: now - 30_000,
            lastInteractionAt: now,
          },
          expiresAt: now + 60 * 60 * 1000,
          createdAt: now - 30_000,
          updatedAt: now,
        };
        await saveSession(runtime as unknown as AgentRuntime, session);

        runtime.scenarioLlmFixtures?.register(
          {
            name: "form-stage1",
            match: {
              modelType: ModelType.RESPONSE_HANDLER,
              input: (v: string) => v.includes("resume my stashed form"),
              toolName: "HANDLE_RESPONSE",
            },
            response: {
              contexts: ["memory"],
              intents: ["form"],
              replyText: "",
              threadOps: [],
              candidateActionNames: [FORM],
            },
            times: 1,
          },
          {
            name: "form-planner",
            match: {
              modelType: ModelType.ACTION_PLANNER,
              input: (v: string) => v.includes("resume my stashed form"),
              toolName: FORM,
            },
            response: {
              text: "",
              thought: "Restore the most recent stashed form.",
              messageToUser: "",
              completed: true,
              finishReason: "tool-calls",
              toolCalls: [
                {
                  id: "call-form",
                  name: FORM,
                  type: "function",
                  arguments: { action: "restore" },
                },
              ],
            },
            times: 1,
          },
          {
            name: "form-decision",
            match: (call: { modelType: string; toolNames: string[] }) =>
              call.modelType === ModelType.RESPONSE_HANDLER &&
              !call.toolNames.includes("HANDLE_RESPONSE"),
            response: {
              success: true,
              decision: "FINISH",
              thought: "Form restored; nothing more to do.",
              messageToUser: "I've restored your form. Let's continue.",
            },
            times: 1,
          },
        );
        return undefined;
      },
    },
  ],

  turns: [
    {
      kind: "message",
      name: "restore",
      text: "Please resume my stashed form.",
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find((a) => a.actionName === FORM);
        if (!call) {
          return `Expected ${FORM} but got: ${turn.actionsCalled
            .map((a) => a.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${FORM} did not succeed: ${
            call.error?.message ?? call.result?.text ?? "unknown error"
          }`;
        }
      },
    },
  ],
});
