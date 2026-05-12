/**
 * Scripted LLM provider — deterministic, no network.
 *
 * Produces a `ResponseHandlerResult`-shaped object given (scenarioId, callIndex,
 * incomingMessageText, conversation history, harness state snapshot). The
 * scripted logic is a hand-rolled "ideal agent": it understands abort, steer,
 * merge, fragment-coalesce, etc., and returns the correct field values so the
 * harness can test the scoring loop end-to-end without burning Cerebras quota.
 *
 * This is NOT a substitute for the real LLM — it's a baseline that lets us
 * verify scenarios are well-formed and scoring is correct. The Cerebras path
 * is where real model behavior gets measured.
 */

import type { ResponseHandlerResult } from "@elizaos/core";
import type { Scenario, ScenarioScriptStep } from "./types.ts";
import type { SimulatorState } from "./state.ts";

export interface ScriptedLlmInput {
  scenario: Scenario;
  callIndex: number;
  /** Conversation history seen so far (oldest first). */
  history: ScenarioScriptStep[];
  /** The triggering message for this Stage-1 call. */
  message: ScenarioScriptStep;
  /** Snapshot of harness state at call time. */
  state: SimulatorState;
}

export interface ScriptedLlmOutput {
  parsed: ResponseHandlerResult;
  /** Latency to simulate (virtual ms). */
  latencyMs: number;
}

export type ScriptedLlmProvider = (input: ScriptedLlmInput) => ScriptedLlmOutput;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyResult(overrides: Partial<ResponseHandlerResult> = {}): ResponseHandlerResult {
  return {
    shouldRespond: "RESPOND",
    contexts: [],
    intents: [],
    candidateActionNames: [],
    replyText: "",
    facts: [],
    relationships: [],
    addressedTo: [],
    threadOps: [],
    ...overrides,
  };
}

function looksLikeAbort(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\b(nvm|stop|cancel|nevermind|never mind|abort|wait\b.*\bdon'?t|dont send|hold on)\b/.test(t) ||
    /\bwait\s+actually\b/.test(t) ||
    /\bactually\s+(nvm|stop|cancel|scratch)\b/.test(t)
  );
}

function looksLikeRetraction(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(scratch that|actually|instead|nvm|wait)\b/.test(t);
}

// ---------------------------------------------------------------------------
// Default scripted provider — handles all 10 InterruptBench scenarios.
// ---------------------------------------------------------------------------

export function createDefaultScriptedProvider(): ScriptedLlmProvider {
  return (input) => {
    const { scenario, message, history, state } = input;
    const ownerRoom = scenario.setup.rooms.find((r) => r.owner === message.sender);
    const channelId = message.channel;
    const text = message.text;

    // Branch on scenario id for explicit ideal behavior.
    switch (scenario.id) {
      // ---- A1, K1: fragmented stream — coalesce, respond on last fragment ----
      case "A1-fragmented-email-draft":
      case "K1-recipe-assembly": {
        const allMessagesInChannel = history.concat([message]).filter((m) => m.channel === channelId);
        const isLast = message.t === scenario.script[scenario.script.length - 1]!.t;
        if (!isLast) {
          // Suppress reply on intermediate fragments — IGNORE keeps the queue
          // quiet but lets us mutate state if needed. Empty replyText prevents
          // an emitted reply.
          return {
            parsed: emptyResult({ shouldRespond: "IGNORE" }),
            latencyMs: 80,
          };
        }
        const combined = allMessagesInChannel.map((m) => m.text).join(" ");
        let replyText: string;
        if (scenario.id === "A1-fragmented-email-draft") {
          replyText = "Drafting an email to Bob about lunch tomorrow.";
        } else {
          replyText = "Here's a quick Italian gluten-free recipe for 4 in under 30 minutes: lemon-garlic shrimp linguine with GF pasta.";
        }
        return {
          parsed: emptyResult({ replyText, addressedTo: [message.sender], facts: [combined] }),
          latencyMs: 120,
        };
      }

      // ---- A4: stream with retraction ----
      case "A4-stream-with-retraction": {
        const isLast = message.t === scenario.script[scenario.script.length - 1]!.t;
        if (!isLast) {
          return {
            parsed: emptyResult({ shouldRespond: "IGNORE" }),
            latencyMs: 80,
          };
        }
        return {
          parsed: emptyResult({
            replyText: "Got it — scheduling Carol for Friday at 10am (ignoring the earlier tomorrow-3pm draft).",
            facts: ["meeting:carol:friday:10am"],
            // Tell the harness to schedule a follow-up via threadOps create + side effect.
            threadOps: [{ type: "create", workThreadId: null, sourceWorkThreadIds: [], sourceRef: null, instruction: "meeting with carol friday 10am", reason: "retraction-honored" }],
          }),
          latencyMs: 110,
        };
      }

      // ---- B1: pure cancellation ----
      case "B1-pure-cancellation": {
        const targetThread = [...state.threads.values()].find((t) => t.roomId === channelId && t.status !== "stopped");
        return {
          parsed: emptyResult({
            replyText: "Ok, stopping.",
            threadOps: [
              {
                type: "abort",
                workThreadId: targetThread?.id ?? null,
                sourceWorkThreadIds: [],
                sourceRef: null,
                instruction: null,
                reason: "user retracted",
              },
            ],
          }),
          latencyMs: 60,
        };
      }

      // ---- B2: destructive cancellation — abort BEFORE send ----
      case "B2-destructive-cancellation": {
        const targetThread = [...state.threads.values()].find((t) => t.roomId === channelId && t.status !== "stopped");
        return {
          parsed: emptyResult({
            replyText: "Ok, did NOT send. Cancelled.",
            threadOps: [
              {
                type: "abort",
                workThreadId: targetThread?.id ?? null,
                sourceWorkThreadIds: [],
                sourceRef: null,
                instruction: null,
                reason: "user retracted before send",
              },
            ],
          }),
          latencyMs: 55,
        };
      }

      // ---- C1: mid-task steering ----
      case "C1-mid-task-steering": {
        const targetThread = [...state.threads.values()].find((t) => t.roomId === channelId && t.status === "active");
        return {
          parsed: emptyResult({
            replyText: "",
            threadOps: targetThread
              ? [
                  {
                    type: "steer",
                    workThreadId: targetThread.id,
                    sourceWorkThreadIds: [],
                    sourceRef: null,
                    instruction: "find a vegan pasta recipe for dinner tonight",
                    reason: "refine constraint",
                  },
                ]
              : [],
          }),
          latencyMs: 70,
        };
      }

      // ---- D1: cross-channel — answer ONE channel, never the other ----
      case "D1-cross-channel-leak": {
        if (message.sender === "alice") {
          return {
            parsed: emptyResult({
              replyText: "Paris.",
              addressedTo: ["alice"],
              facts: ["capital_of_france:Paris"],
            }),
            latencyMs: 90,
          };
        }
        // Bob's "hey what's up" — minimal reply in bob's channel only.
        return {
          parsed: emptyResult({
            replyText: "Hey Bob — not much, what's up with you?",
            addressedTo: ["bob"],
          }),
          latencyMs: 90,
        };
      }

      // ---- F1: pivot within thread — stop old, create new ----
      case "F1-pivot-within-thread": {
        const oldThread = [...state.threads.values()].find((t) => t.roomId === channelId && t.status === "active");
        return {
          parsed: emptyResult({
            replyText: "Got it — dropping the trip search, starting on the electrician hunt.",
            threadOps: [
              ...(oldThread
                ? [
                    {
                      type: "stop",
                      workThreadId: oldThread.id,
                      sourceWorkThreadIds: [],
                      sourceRef: null,
                      instruction: null,
                      reason: "user pivoted topics",
                    },
                  ]
                : []),
              {
                type: "create",
                workThreadId: null,
                sourceWorkThreadIds: [],
                sourceRef: null,
                instruction: "find a good electrician in Oakland",
                reason: "new topic",
              },
            ],
          }),
          latencyMs: 90,
        };
      }

      // ---- G1: cross-channel pending-prompt resolution ----
      case "G1-cross-channel-prompt-resolution": {
        const pendingPrompt = [...state.pendingPrompts.values()].find((p) => !p.resolved);
        const thread = [...state.threads.values()].find((t) => t.pendingPromptId === pendingPrompt?.id);
        return {
          parsed: emptyResult({
            replyText: "Got it — deploying.",
            facts: pendingPrompt ? [`resolved_prompt:${pendingPrompt.id}:yes`] : [],
            threadOps: thread
              ? [
                  {
                    type: "steer",
                    workThreadId: thread.id,
                    sourceWorkThreadIds: [],
                    sourceRef: null,
                    instruction: "approved — deploying",
                    reason: "prompt resolved across channels",
                  },
                ]
              : [],
          }),
          latencyMs: 95,
        };
      }

      // ---- H1: concurrent merge ----
      case "H1-concurrent-merge": {
        const active = [...state.threads.values()].filter((t) => t.status === "active");
        if (active.length >= 2) {
          const [target, ...rest] = active;
          return {
            parsed: emptyResult({
              replyText: "Merged into one combined thread.",
              threadOps: [
                {
                  type: "merge",
                  workThreadId: target!.id,
                  sourceWorkThreadIds: rest.map((t) => t.id),
                  sourceRef: null,
                  instruction: "draft Black Friday email blast AND design Black Friday landing page",
                  reason: "user requested merge",
                },
              ],
            }),
            latencyMs: 100,
          };
        }
        return {
          parsed: emptyResult({ replyText: "" }),
          latencyMs: 50,
        };
      }

      default: {
        // Generic fallback — abort heuristic + plain reply.
        if (looksLikeAbort(text)) {
          const targetThread = [...state.threads.values()].find((t) => t.roomId === channelId && t.status !== "stopped");
          return {
            parsed: emptyResult({
              replyText: "Ok, stopping.",
              threadOps: [
                {
                  type: "abort",
                  workThreadId: targetThread?.id ?? null,
                  sourceWorkThreadIds: [],
                  sourceRef: null,
                  instruction: null,
                  reason: "user retracted",
                },
              ],
            }),
            latencyMs: 60,
          };
        }
        return {
          parsed: emptyResult({ replyText: "" }),
          latencyMs: 80,
        };
      }
    }
  };
}

// Reference the helper so eslint --strict doesn't flag it; used in fallback paths.
export const _internal = { looksLikeRetraction };
