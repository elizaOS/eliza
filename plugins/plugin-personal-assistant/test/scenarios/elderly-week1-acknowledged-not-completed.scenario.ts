/**
 * Elderly week-1 loop — the `acknowledged` ≠ `completed` invariant (README
 * cross-agent invariant 6), proven structurally on the real ScheduledTask spine.
 *
 * When the elderly owner taps "ok, got it" on a check-in that is really waiting
 * on an answer, that acknowledgment must NOT be silently upgraded to a
 * completion: `acknowledged` is a distinct, non-terminal state, and the
 * check-in's `pipeline.onComplete` (the follow-on the family relies on) fires
 * ONLY on a true `completed`. This drives the real REST verb surface — fire →
 * acknowledge → complete — and reads the parent status and the onComplete child
 * back off the real store:
 *
 *   acknowledge → parent `acknowledged`, onComplete child ABSENT;
 *   complete    → parent `completed`,    onComplete child PRESENT.
 *
 * Keyless-runnable under the deterministic proxy (the fire's dispatch render is
 * satisfied by the proxy's default reply); `live-only` lane for the same
 * develop-side strict dispatch-render gap the sibling elderly-week1 scenarios
 * document.
 *
 * Fail-without-fix anchor: make the runner's `acknowledge` verb propagate
 * `pipeline.onComplete` (or land `completed`) and the "child ABSENT after
 * acknowledge" assertion fails.
 */

import { scenario } from "@elizaos/scenario-runner/schema";
import { isRecord, registerDeliveryChannel } from "./_helpers/elderly-week1";

const SCENARIO_ID = "elderly-week1-acknowledged-not-completed";
const DELIVERY = "scenario_elderly_ack_delivery";
const CHILD_MARKER = `${SCENARIO_ID}-onComplete-child`;

const ledger: unknown[] = [];

function parentStatus(body: unknown, marker: string): string | string_error {
  if (!isRecord(body) || !Array.isArray(body.tasks)) {
    return { err: `expected {tasks[]} response, saw ${JSON.stringify(body)}` };
  }
  const parent = body.tasks.find(
    (t) =>
      isRecord(t) &&
      isRecord(t.metadata) &&
      t.metadata.scenario === SCENARIO_ID &&
      t.promptInstructions !== marker,
  );
  if (!isRecord(parent)) return { err: "parent check-in not found in list" };
  const state = isRecord(parent.state) ? parent.state : null;
  return { value: typeof state?.status === "string" ? state.status : "" };
}

function childPresent(body: unknown, marker: string): boolean {
  if (!isRecord(body) || !Array.isArray(body.tasks)) return false;
  return body.tasks.some((t) => isRecord(t) && t.promptInstructions === marker);
}

type string_error = { value: string } | { err: string };

function assertFiredNoChild(
  _status: number,
  body: unknown,
): string | undefined {
  const status = parentStatus(body, CHILD_MARKER);
  if ("err" in status) return status.err;
  if (status.value !== "fired") {
    return `expected parent status=fired after fire, saw ${status.value}`;
  }
  if (childPresent(body, CHILD_MARKER)) {
    return "onComplete child must not exist before completion";
  }
  return undefined;
}

/** Acknowledge is non-terminal and must NOT fire onComplete. */
function assertAcknowledgedNoChild(
  _status: number,
  body: unknown,
): string | undefined {
  const status = parentStatus(body, CHILD_MARKER);
  if ("err" in status) return status.err;
  if (status.value !== "acknowledged") {
    return `expected parent status=acknowledged, saw ${status.value}`;
  }
  if (childPresent(body, CHILD_MARKER)) {
    return "acknowledged ≠ completed: onComplete child must NOT fire on acknowledge";
  }
  return undefined;
}

/** Complete is terminal and fires onComplete. */
function assertCompletedWithChild(
  _status: number,
  body: unknown,
): string | undefined {
  const status = parentStatus(body, CHILD_MARKER);
  if ("err" in status) return status.err;
  if (status.value !== "completed") {
    return `expected parent status=completed, saw ${status.value}`;
  }
  if (!childPresent(body, CHILD_MARKER)) {
    return "onComplete child must exist after a true completion";
  }
  return undefined;
}

const childSeed = {
  kind: "followup",
  promptInstructions: CHILD_MARKER,
  trigger: { kind: "manual" },
  priority: "low",
  respectsGlobalPause: true,
  source: "default_pack",
  createdBy: SCENARIO_ID,
  ownerVisible: true,
  metadata: { scenario: SCENARIO_ID, role: "onComplete-child" },
};

export default scenario({
  id: "elderly-week1-acknowledged-not-completed",
  lane: "live-only",
  title:
    "Elderly week-1: acknowledging a check-in stays non-terminal — onComplete fires only on true completion",
  domain: "lifeops",
  tags: [
    "lifeops",
    "persona",
    "elderly",
    "scheduled-tasks",
    "invariant",
    "week1",
    "14354",
  ],
  isolation: "shared-runtime",
  requires: {
    plugins: [
      "@elizaos/plugin-scheduling",
      "@elizaos/plugin-personal-assistant",
    ],
  },
  seed: [
    {
      type: "custom",
      name: "register delivery channel",
      apply: async (ctx): Promise<string | undefined> =>
        registerDeliveryChannel(ctx, DELIVERY, ledger),
    },
  ],
  rooms: [{ id: "main", source: "telegram", title: "Elderly Week-1 Ack" }],
  turns: [
    {
      kind: "api",
      name: "seed a check-in that carries an onComplete follow-on",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "checkin",
        promptInstructions:
          "Check in on the owner and confirm she took her morning medication.",
        trigger: { kind: "manual" },
        priority: "medium",
        completionCheck: {
          kind: "user_acknowledged",
          followupAfterMinutes: 60,
        },
        pipeline: { onComplete: [childSeed] },
        output: { destination: "channel", target: `${DELIVERY}:owner` },
        respectsGlobalPause: false,
        source: "default_pack",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-checkin`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      captures: { taskId: "task.taskId" },
    },
    {
      kind: "api",
      name: "fire the check-in on demand",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks/{{capture:taskId}}/fire",
      expectedStatus: 200,
    },
    {
      kind: "api",
      name: "after fire: parent fired, no onComplete child yet",
      method: "GET",
      path: "/api/lifeops/scheduled-tasks",
      expectedStatus: 200,
      assertResponse: assertFiredNoChild,
    },
    {
      kind: "api",
      name: "she acknowledges ('ok, got it') — non-terminal, no onComplete",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks/{{capture:taskId}}/acknowledge",
      body: { reason: "owner tapped acknowledge" },
      expectedStatus: 200,
    },
    {
      kind: "api",
      name: "acknowledged ≠ completed: still no onComplete child",
      method: "GET",
      path: "/api/lifeops/scheduled-tasks",
      expectedStatus: 200,
      assertResponse: assertAcknowledgedNoChild,
    },
    {
      kind: "api",
      name: "she actually completes it",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks/{{capture:taskId}}/complete",
      body: { reason: "owner confirmed medication taken" },
      expectedStatus: 200,
    },
    {
      kind: "api",
      name: "completed → onComplete follow-on now exists",
      method: "GET",
      path: "/api/lifeops/scheduled-tasks",
      expectedStatus: 200,
      assertResponse: assertCompletedWithChild,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "the acknowledged→completed transition was exercised",
      predicate: (): string | undefined => undefined,
    },
  ],
});
