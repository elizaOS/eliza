/**
 * Keyless per-plugin e2e for `@elizaos/plugin-commands` (issue #8801).
 *
 * The commands plugin owns the universal slash-command system and ships
 * built-in DETERMINISTIC commands (/help, /commands, /status). This drives the
 * built-in `/help` command end-to-end with zero credentials: the seed
 * initializes the per-runtime command registry (registering the built-ins),
 * then `/help` dispatches its deterministic `HELP_COMMAND` action directly —
 * no LLM routing, no fixtures, no external service.
 */
import type { AgentRuntime } from "@elizaos/core";
import { initForRuntime, useRuntime } from "@elizaos/plugin-commands";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  describeCalls,
  successfulCalls,
} from "../_helpers/effect-assertions.ts";

const HELP_COMMAND = "HELP_COMMAND";

export default scenario({
  lane: "pr-deterministic",
  id: "commands.help-command",
  title: "Commands: /help built-in command dispatches HELP_COMMAND",
  domain: "commands",
  tags: ["smoke", "commands", "slash-command"],
  description:
    "Sends /help and verifies the built-in deterministic HELP_COMMAND action is dispatched and succeeds — keyless, no LLM, no credentials.",

  requires: { plugins: ["@elizaos/plugin-commands"] },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "init-command-registry",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime;
        // Initialize the per-runtime command registry so the built-in
        // /help, /commands, /status commands are registered (as a live runtime
        // does on boot).
        useRuntime(runtime.agentId);
        initForRuntime(runtime.agentId);
        return undefined;
      },
    },
  ],

  rooms: [
    { id: "main", source: "dashboard", channelType: "DM", title: "Commands" },
  ],

  turns: [
    {
      kind: "message",
      name: "help",
      text: "/help",
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find(
          (a) => a.actionName === HELP_COMMAND,
        );
        if (!call) {
          return `Expected ${HELP_COMMAND} but got: ${turn.actionsCalled
            .map((a) => a.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${HELP_COMMAND} did not succeed: ${
            call.error?.message ?? "unknown error"
          }`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: HELP_COMMAND,
      status: "success",
      minCount: 1,
    },
    {
      // Effect proof (#11381): /help's contract is the serialized live command
      // registry. The reply must be the real formatted list containing the
      // built-in commands the seed registered — an empty or unregistered
      // registry (initForRuntime not run) fails here.
      type: "custom",
      name: "help-reply-lists-live-registry",
      predicate: (ctx) => {
        const call = successfulCalls(ctx, HELP_COMMAND)[0];
        const reply = call?.result?.text ?? "";
        if (!reply.includes("Available commands:")) {
          return `expected the help reply to start the registry listing; calls: ${describeCalls(ctx)}`;
        }
        for (const builtin of ["/help", "/commands", "/status"]) {
          if (!reply.includes(builtin)) {
            return `expected built-in "${builtin}" in the serialized registry, reply: ${reply.slice(0, 300)}`;
          }
        }
      },
    },
  ],
});
