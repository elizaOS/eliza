/**
 * Live-model CHOICE widget round trip (#14322). An app-create request that
 * fuzzy-matches an installed app makes the APP action emit a
 * `[CHOICE:app-create id=…]` picker block (plugin-app-control/app-create.ts)
 * and persist the pending intent as a task. The harness then plays the
 * dashboard user: a CHOICE tap re-enters as the option's raw `value` sent as
 * an ordinary message (use-inline-widget-context.ts `sendAction`), so turn 2
 * sends the literal option value and the live model must route that bare
 * token back into APP, which honors the pick — here `cancel`, which deletes
 * the pending intent task (asserted as the domain artifact) with no side
 * effects. `cancel` is the deliberate pick: `new`/`edit-N` would scaffold an
 * app or dispatch a coding agent from a scenario run.
 *
 * Installed apps are served by the fetch loopback so the picker branch is
 * deterministic; the model routing and the pick round trip are live.
 *
 * KNOWN-RED (#14322 finding): this scenario asserts the correct product
 * contract and fails today because the v5 planner path DROPS action handler
 * callback text. The `executeV5PlannedToolCall` call sites in
 * `packages/core/src/services/message.ts` build `executorCtx` without a
 * `callback`, so `execute-planned-tool-call.ts` hands `undefined` to
 * `action.handler(...)` and the `[CHOICE:app-create …]` block that
 * plugin-app-control emits via `callback?.({ text })` never reaches the user —
 * the reply is the Stage-1 early ack ("On it.") and the picker exists only in
 * the captured ActionResult. Turn 2 then compounds it: with no picker on
 * screen the planner answers "cancel" with a bare REPLY ("Canceled.") without
 * running APP, leaving the pending intent task alive — a fabricated
 * cancellation. Fixing the callback plumbing is core planner surgery tracked
 * as a follow-up in #14322.
 */

import { stringToUuid } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import { hasPendingIntent } from "../../../../plugins/plugin-app-control/src/actions/app-create.ts";
import { findInteractionRegions } from "../../../core/src/messaging/interactions/parse.ts";
import {
  jsonResponse,
  registerAppControlHttpHandler,
  resetAppControlHttpLoopback,
} from "./_helpers/app-control-http-loopback";

// Mirrors the executor's room-id derivation (`scenario-room:<id>:<room>`), so
// the final check can query the pending-intent task for the room turns ran in.
// The scenario id below must stay a string literal (the loader reads it via
// static AST), so it is repeated here rather than shared through a const.
const MAIN_ROOM_ID = stringToUuid(
  "scenario-room:live-chat-widgets-choice-roundtrip:main",
);

const INSTALLED_APPS_FIXTURE = [
  {
    name: "notes",
    displayName: "Notes",
    pluginName: "@elizaos/app-notes",
    version: "1.0.0",
    installedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    name: "tasks",
    displayName: "Tasks",
    pluginName: "@elizaos/app-tasks",
    version: "1.0.0",
    installedAt: "2026-01-01T00:00:00.000Z",
  },
];

export default scenario({
  id: "live-chat-widgets-choice-roundtrip",
  lane: "live-only",
  title: "Real LLM surfaces a [CHOICE] picker, then honors the picked value",
  domain: "chat-widgets",
  tags: ["live", "real-llm", "chat-widgets", "choice", "app-control"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-app-control"],
  },
  seed: [
    {
      type: "custom",
      name: "serve installed apps over the fetch loopback",
      apply: () => {
        resetAppControlHttpLoopback();
        registerAppControlHttpHandler((request) => {
          if (
            request.method === "GET" &&
            request.pathname === "/api/apps/installed"
          ) {
            return jsonResponse(INSTALLED_APPS_FIXTURE);
          }
          return undefined;
        });
        return undefined;
      },
    },
  ],
  rooms: [
    {
      id: "main",
      source: "eliza-app",
      title: "Chat Widgets Choice",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "app-create request with an existing match yields a [CHOICE] picker",
      room: "main",
      text: "Create a notes app for me.",
      assertTurn: (execution) => {
        const text = execution.responseText ?? "";
        const choices = findInteractionRegions(text)
          .map((region) => region.block)
          .filter((block) => block.kind === "choice");
        if (choices.length === 0) {
          return text.includes("[CHOICE")
            ? `reply contains a [CHOICE marker the shared parser rejects (malformed block): ${JSON.stringify(text.slice(0, 400))}`
            : `reply contains no parseable [CHOICE] block: ${JSON.stringify(text.slice(0, 400))}`;
        }
        const picker = choices[0];
        if (picker.scope !== "app-create") {
          return `expected [CHOICE:app-create …], saw scope '${picker.scope}'`;
        }
        const values = picker.options.map((option) => option.value);
        for (const expected of ["new", "edit-1", "cancel"]) {
          if (!values.includes(expected)) {
            return `picker is missing the '${expected}' option (options: ${values.join(", ")})`;
          }
        }
        return undefined;
      },
    },
    {
      kind: "message",
      name: "the raw picked value ('cancel') is routed back and honored",
      room: "main",
      // The dashboard sends the picked option's bare `value` as an ordinary
      // message — this is the exact wire text a CHOICE tap produces.
      text: "cancel",
      responseIncludesAny: [/cancel/i],
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "APP",
      status: "success",
      minCount: 2,
    },
    {
      type: "custom",
      name: "the pick was honored: pending intent task deleted, cancel path taken",
      predicate: async (ctx) => {
        const cancelTurn = ctx.actionsCalled.find((action) => {
          if (action.actionName !== "APP") return false;
          const values = action.result?.values as
            | { subMode?: unknown }
            | undefined;
          return values?.subMode === "cancel";
        });
        if (!cancelTurn) {
          return `no APP call resolved with subMode=cancel (actions: ${ctx.actionsCalled
            .map((action) => action.actionName)
            .join(", ")})`;
        }
        const runtime = ctx.runtime as Parameters<typeof hasPendingIntent>[0];
        const stillPending = await hasPendingIntent(runtime, MAIN_ROOM_ID);
        return stillPending
          ? "pending app-create intent task still exists after the cancel pick"
          : undefined;
      },
    },
  ],
});
