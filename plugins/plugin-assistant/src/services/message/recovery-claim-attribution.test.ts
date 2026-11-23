/**
 * Reply recovery through the real runtime dispatcher with a controlled
 * renderer and grounding judge. The judge gives a whole-reply verdict and
 * attributes each claim; only the assistant's own changes need this turn's
 * receipt, and an unsupported claim gets one degrade rewrite before the turn
 * fails.
 */
import {
  type ActionResult,
  type EffectReceipt,
  type Memory,
  ModelType,
  stringToUuid,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, expect, it, vi } from "vitest";
import { resolvePlannedReplyEgress } from "./egress-policy";
import type { RecoveredReplyClaim } from "./recovery-grounding";

const REVIEW_PREFIX = "Review recovered reply grounding.";
const SENDER_REPORT =
  "Shipped all of this, here is the commit diff: removed the 25-point cap, typed the nulls, wired charged: false.";
const REVIEW_OF_SENDER_WORK =
  "solid. removed the cap, typed the nulls and wired charged: false. i'd still glance at the fail-closed path.";
const ASSISTANT_CLAIM =
  "pushed the fix for you: i removed the 25-point cap and it's live on the worker now.";
const DEGRADED =
  "your commit removes the 25-point cap; i haven't verified that it's live.";

const runtimes: ReturnType<typeof createSQLiteTestRuntime>[] = [];
afterEach(async () => {
  await Promise.all(
    runtimes.splice(0).map(async (runtime) => {
      await runtime.stop();
      await runtime.close();
    }),
  );
});

function fixture(
  renders: { response: string; effectReceiptIds?: string[] }[],
  reviews: { grounded: boolean; claims: RecoveredReplyClaim[] }[],
) {
  const runtime = createSQLiteTestRuntime({
    character: { name: "Recovery", bio: "test", settings: {} },
    logLevel: "fatal",
  });
  runtimes.push(runtime);
  const renderPrompts: string[] = [];
  const reviewPrompts: string[] = [];
  runtime.registerModel(
    ModelType.TEXT_SMALL,
    async (_runtime, params) => {
      if (params.prompt.startsWith(REVIEW_PREFIX)) {
        const verdict = reviews[reviewPrompts.length];
        reviewPrompts.push(params.prompt);
        if (!verdict) throw new Error("Unexpected grounding review");
        return JSON.stringify(verdict);
      }
      const render = renders[renderPrompts.length];
      renderPrompts.push(params.prompt);
      if (!render) throw new Error("Unexpected recovery render");
      return JSON.stringify({
        response: render.response,
        effectReceiptIds: render.effectReceiptIds ?? [],
      });
    },
    "claim-attribution-test",
  );
  const message: Memory = {
    id: stringToUuid("claim-attribution-turn"),
    roomId: stringToUuid("claim-attribution-room"),
    entityId: stringToUuid("claim-attribution-dev"),
    agentId: runtime.agentId,
    content: { text: SENDER_REPORT },
  };
  return {
    recover: (actionResults: ActionResult[] = []) =>
      resolvePlannedReplyEgress({
        runtime,
        message,
        reply: "",
        actionResults,
      }),
    runtime,
    renderPrompts,
    reviewPrompts,
  };
}

const evidenceOf = (prompt: string) =>
  prompt.slice(prompt.indexOf("Complete turn evidence: "));
const payloadOf = (prompt: string) =>
  JSON.parse(
    prompt
      .split("\n")
      .find((line) => line.startsWith("Original action payload: "))
      ?.slice("Original action payload: ".length) ?? "null",
  );

const senderClaim = (quote: string): RecoveredReplyClaim => ({
  quote,
  actor: "sender",
  change: true,
  supported: true,
  evidence: SENDER_REPORT,
});
const assistantChange = (supported: boolean): RecoveredReplyClaim => ({
  quote: "i removed the 25-point cap",
  actor: "assistant",
  change: true,
  supported,
  evidence: "",
});

it("delivers a review of changes the sender reports without an assistant receipt", async () => {
  const f = fixture(
    [{ response: REVIEW_OF_SENDER_WORK }],
    [
      {
        grounded: true,
        claims: [
          senderClaim("removed the cap"),
          senderClaim("typed the nulls and wired charged: false"),
        ],
      },
    ],
  );
  await expect(f.recover()).resolves.toEqual({
    text: REVIEW_OF_SENDER_WORK,
    effectReceiptIds: [],
  });
  expect(f.renderPrompts).toHaveLength(1);
  expect(f.reviewPrompts).toHaveLength(1);
});

it("degrades an assistant change without a receipt once, judging both drafts on identical evidence", async () => {
  const f = fixture(
    [{ response: ASSISTANT_CLAIM }, { response: DEGRADED }],
    // The judge wrongly supports the assistant change; the receipt rule is code-side.
    [
      { grounded: true, claims: [assistantChange(true)] },
      {
        grounded: true,
        claims: [senderClaim("your commit removes the 25-point cap")],
      },
    ],
  );
  const warn = vi.spyOn(f.runtime.logger, "warn");
  await expect(f.recover()).resolves.toEqual({
    text: DEGRADED,
    effectReceiptIds: [],
  });
  const unsupportedClaims = [
    { quote: "i removed the 25-point cap", actor: "assistant", evidence: "" },
  ];
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "missing_reply", unsupportedClaims }),
    expect.stringContaining("unsupported claims"),
  );
  expect(f.renderPrompts).toHaveLength(2);
  expect(f.renderPrompts[1]).toContain("failed unsupported_claim");
  expect(payloadOf(f.renderPrompts[1] ?? "")).toMatchObject({
    reason: "missing_reply",
    rejectedReply: "",
    recoveredDraft: ASSISTANT_CLAIM,
    unsupportedClaims,
  });
  expect(f.reviewPrompts).toHaveLength(2);
  expect(f.reviewPrompts[1]).toContain(JSON.stringify(DEGRADED));
  expect(evidenceOf(f.reviewPrompts[1] ?? "")).toBe(
    evidenceOf(f.reviewPrompts[0] ?? ""),
  );
  expect(f.reviewPrompts[0]).not.toContain("unsupportedClaims");
});

it.each([
  ["an assistant change without a receipt", assistantChange(false)],
  [
    "an unsupported third-party claim",
    {
      quote: "the worker team deployed it",
      actor: "third_party",
      change: true,
      supported: false,
      evidence: "",
    } satisfies RecoveredReplyClaim,
  ],
])(
  "fails the turn when the degraded draft still carries %s",
  async (_label, claim) => {
    const f = fixture(
      [{ response: ASSISTANT_CLAIM }, { response: DEGRADED }],
      [
        { grounded: false, claims: [claim] },
        { grounded: false, claims: [claim] },
      ],
    );
    await expect(f.recover()).rejects.toMatchObject({
      code: "REPLY_GROUNDING_FAILED",
      message: "Recovered reply asserts an unsupported outcome",
    });
    expect(f.renderPrompts).toHaveLength(2);
    expect(f.reviewPrompts).toHaveLength(2);
  },
);

it("delivers an assistant change bound to this turn's applied receipt", async () => {
  const observedAt = "2026-10-25T00:00:00.000Z";
  const receipt: EffectReceipt = {
    receiptId: "worker-config-1",
    operation: "worker.config.update",
    resource: { kind: "worker.config", id: "score-cap" },
    artifacts: [],
    idempotency: { key: "cap-request", replayed: false },
    observedAt,
    outcome: "applied",
    commit: { kind: "durable", id: "commit-1", committedAt: observedAt },
  };
  const f = fixture(
    [
      {
        response: "i removed the 25-point cap from the worker config.",
        effectReceiptIds: [receipt.receiptId],
      },
    ],
    [
      {
        grounded: true,
        claims: [{ ...assistantChange(true), evidence: receipt.receiptId }],
      },
    ],
  );
  await expect(
    f.recover([
      {
        success: true,
        text: "Removed the score cap.",
        effectReceipts: [receipt],
      },
    ]),
  ).resolves.toEqual({
    text: "i removed the 25-point cap from the worker config.",
    effectReceiptIds: [receipt.receiptId],
  });
  expect(f.reviewPrompts).toHaveLength(1);
});

it("fails an invented receipt selection without a degrade rewrite", async () => {
  const f = fixture(
    [{ response: ASSISTANT_CLAIM, effectReceiptIds: ["invented-receipt"] }],
    [],
  );
  await expect(f.recover()).rejects.toMatchObject({
    code: "REPLY_GROUNDING_FAILED",
  });
  expect(f.renderPrompts).toHaveLength(1);
  expect(f.reviewPrompts).toHaveLength(0);
});

it.each([
  [
    "an ungrounded verdict whose claims all read as supported",
    { grounded: false, claims: [senderClaim("removed the cap")] },
    "removed the cap",
  ],
  [
    "a supported claim that does not quote the reply",
    {
      grounded: true,
      claims: [senderClaim("removed the cap and redeployed the worker")],
    },
    "removed the cap and redeployed the worker",
  ],
])("degrades %s", async (_label, verdict, quote) => {
  const f = fixture(
    [{ response: REVIEW_OF_SENDER_WORK }, { response: DEGRADED }],
    [verdict, { grounded: true, claims: [] }],
  );
  await expect(f.recover()).resolves.toEqual({
    text: DEGRADED,
    effectReceiptIds: [],
  });
  expect(payloadOf(f.renderPrompts[1] ?? "")).toMatchObject({
    unsupportedClaims: [{ quote }],
  });
});

it("accepts a quote that differs from the reply only in case and spacing", async () => {
  const f = fixture(
    [{ response: REVIEW_OF_SENDER_WORK }],
    [{ grounded: true, claims: [senderClaim("Removed  the\nCap")] }],
  );
  await expect(f.recover()).resolves.toEqual({
    text: REVIEW_OF_SENDER_WORK,
    effectReceiptIds: [],
  });
});

it("fails an ungrounded verdict that lists no claims", async () => {
  const f = fixture(
    [{ response: REVIEW_OF_SENDER_WORK }],
    [{ grounded: false, claims: [] }],
  );
  await expect(f.recover()).rejects.toMatchObject({
    code: "REPLY_GROUNDING_REVIEW_FAILED",
  });
  expect(f.renderPrompts).toHaveLength(1);
});

const FAILED_NAVIGATION: ActionResult = {
  success: false,
  text: "Navigation rejected (HTTP 409).",
  error: "HTTP 409",
  data: { actionName: "OPEN_VIEW" },
};
const HONEST_FAILURE =
  "the navigation didn't go through: it was rejected (HTTP 409).";
const HONEST_FAILURE_DEGRADED = "i haven't confirmed the navigation.";
const failureClaim = (
  overrides: Partial<RecoveredReplyClaim> = {},
): RecoveredReplyClaim => ({
  quote: "the navigation didn't go through",
  actor: "assistant",
  change: true,
  outcome: "not_occurred",
  failedResult: 1,
  supported: true,
  evidence: "Navigation rejected (HTTP 409).",
  ...overrides,
});
const OBSERVED_AT = "2026-11-21T00:00:00.000Z";
const receiptBase = (receiptId: string) => ({
  receiptId,
  operation: "view.open",
  resource: { kind: "view", id: "maps" },
  artifacts: [],
  idempotency: { key: receiptId, replayed: false },
  observedAt: OBSERVED_AT,
});
const appliedReceipt = (receiptId: string): EffectReceipt => ({
  ...receiptBase(receiptId),
  outcome: "applied",
  commit: {
    kind: "durable",
    id: `${receiptId}-commit`,
    committedAt: OBSERVED_AT,
  },
});

it("delivers an honest failure report backed by this turn's failed action", async () => {
  const f = fixture(
    [{ response: HONEST_FAILURE }],
    [{ grounded: true, claims: [failureClaim()] }],
  );
  await expect(f.recover([FAILED_NAVIGATION])).resolves.toEqual({
    text: HONEST_FAILURE,
    effectReceiptIds: [],
  });
  expect(evidenceOf(f.reviewPrompts[0] ?? "")).toContain("- failed");
  expect(f.renderPrompts).toHaveLength(1);
  expect(f.reviewPrompts).toHaveLength(1);
});

it("delivers a failure report whose cited result left its effect unapplied", async () => {
  const preview: EffectReceipt = {
    ...receiptBase("view-preview"),
    outcome: "preview",
  };
  const f = fixture(
    [{ response: HONEST_FAILURE }],
    [{ grounded: true, claims: [failureClaim()] }],
  );
  await expect(
    f.recover([
      { success: true, text: "Prepared.", effectReceipts: [preview] },
    ]),
  ).resolves.toEqual({ text: HONEST_FAILURE, effectReceiptIds: [] });
});

it.each([
  ["no action result at all", [], failureClaim()],
  [
    "no cited result",
    [FAILED_NAVIGATION],
    failureClaim({ failedResult: null }),
  ],
  [
    "a cited result outside this turn's results",
    [FAILED_NAVIGATION],
    failureClaim({ failedResult: 2 }),
  ],
  [
    "a cited successful read with no effect",
    [{ success: true, text: "Read the view list." }],
    failureClaim(),
  ],
  [
    "a cited failure whose provider acceptance is unknown",
    [
      {
        ...FAILED_NAVIGATION,
        effectReceipts: [
          {
            ...receiptBase("view-open-unknown"),
            outcome: "failed",
            failure: {
              code: "TIMEOUT",
              retryable: true,
              acceptance: "unknown",
            },
          },
        ],
      },
    ],
    failureClaim(),
  ],
  [
    "a cited result whose effect applied",
    [
      {
        success: true,
        text: "Opened Maps.",
        effectReceipts: [appliedReceipt("view-open-1")],
      },
    ],
    failureClaim(),
  ],
  [
    "a cited rejected receipt whose operation and resource a retry applied",
    [
      {
        success: true,
        text: "Opened Maps.",
        data: { actionName: "OPEN_VIEW" },
        effectReceipts: [appliedReceipt("view-open-retry")],
      },
      {
        ...FAILED_NAVIGATION,
        effectReceipts: [
          {
            ...receiptBase("view-open-rejected"),
            outcome: "failed",
            failure: {
              code: "HTTP_409",
              retryable: false,
              acceptance: "rejected",
            },
          },
        ],
      },
    ],
    failureClaim({ failedResult: 2 }),
  ],
] as [string, ActionResult[], RecoveredReplyClaim][])(
  "rejects a did-not-happen claim with %s",
  async (_label, results, claim) => {
    // The judge wrongly supports both drafts; the result check is code-side.
    const f = fixture(
      [{ response: HONEST_FAILURE }, { response: HONEST_FAILURE }],
      [
        { grounded: true, claims: [claim] },
        { grounded: true, claims: [claim] },
      ],
    );
    await expect(f.recover(results)).rejects.toMatchObject({
      code: "REPLY_GROUNDING_FAILED",
      message: "Recovered reply asserts an unsupported outcome",
    });
    expect(f.reviewPrompts).toHaveLength(2);
  },
);

// A receipt-less failure names no target, so a later success of the same
// action gives code no target evidence: it may be a retry or a call for
// another target. These two cases used to be rejected in code even when the
// judge supported the report, which also stripped honest multi-target
// failures; whether the later call was a retry is now the judge's call, and
// an unsupported verdict still fails the turn.
it.each([
  [
    "a successful call with an applied receipt",
    {
      success: true,
      text: "Opened Maps.",
      data: { actionName: "OPEN_VIEW" },
      effectReceipts: [appliedReceipt("view-open-retry")],
    },
  ],
  [
    "a bare successful call",
    { success: true, text: "Opened Maps.", data: { actionName: "OPEN_VIEW" } },
  ],
] as [string, ActionResult][])(
  "leaves a receipt-less failure followed by %s of the same action to the judge",
  async (_label, later) => {
    const supported = fixture(
      [{ response: HONEST_FAILURE }],
      [{ grounded: true, claims: [failureClaim()] }],
    );
    await expect(
      supported.recover([FAILED_NAVIGATION, later]),
    ).resolves.toEqual({ text: HONEST_FAILURE, effectReceiptIds: [] });
    const unsupported = fixture(
      [{ response: HONEST_FAILURE }, { response: HONEST_FAILURE }],
      [
        { grounded: true, claims: [failureClaim({ supported: false })] },
        { grounded: true, claims: [failureClaim({ supported: false })] },
      ],
    );
    await expect(
      unsupported.recover([FAILED_NAVIGATION, later]),
    ).rejects.toMatchObject({
      code: "REPLY_GROUNDING_FAILED",
      message: "Recovered reply asserts an unsupported outcome",
    });
  },
);

it("delivers a failure report when only a different action succeeded later", async () => {
  const f = fixture(
    [{ response: HONEST_FAILURE }],
    [{ grounded: true, claims: [failureClaim()] }],
  );
  await expect(
    f.recover([
      FAILED_NAVIGATION,
      {
        success: true,
        text: "Read the view list.",
        data: { actionName: "LIST_VIEWS" },
      },
    ]),
  ).resolves.toEqual({ text: HONEST_FAILURE, effectReceiptIds: [] });
});

it("tells the reviewer a successful retry supersedes a failed attempt", async () => {
  const f = fixture(
    [{ response: HONEST_FAILURE }],
    [{ grounded: true, claims: [failureClaim()] }],
  );
  await f.recover([FAILED_NAVIGATION]);
  expect(f.reviewPrompts[0]).toContain(
    "a later successful retry supersedes the failed attempt",
  );
});

it("still degrades a false completion claim after a failed action", async () => {
  const done = "opened the map for you.";
  const doneClaim = failureClaim({
    quote: "opened the map",
    outcome: "occurred",
    failedResult: null,
  });
  const f = fixture(
    [{ response: done }, { response: HONEST_FAILURE_DEGRADED }],
    [
      { grounded: true, claims: [doneClaim] },
      { grounded: true, claims: [] },
    ],
  );
  await expect(f.recover([FAILED_NAVIGATION])).resolves.toEqual({
    text: HONEST_FAILURE_DEGRADED,
    effectReceiptIds: [],
  });
  expect(payloadOf(f.renderPrompts[1] ?? "")).toMatchObject({
    unsupportedClaims: [{ quote: "opened the map" }],
  });
});

it("treats a change claim without an outcome as one that occurred", async () => {
  const f = fixture(
    [{ response: HONEST_FAILURE }, { response: HONEST_FAILURE }],
    [
      { grounded: true, claims: [failureClaim({ outcome: undefined })] },
      { grounded: true, claims: [failureClaim({ outcome: undefined })] },
    ],
  );
  await expect(f.recover([FAILED_NAVIGATION])).rejects.toMatchObject({
    code: "REPLY_GROUNDING_FAILED",
  });
});

// Two calls of one action for different targets in the same turn: the
// success for one target is not a retry of the other target's failure.
const smsReceipt = (
  receiptId: string,
  thread: string,
  outcome: "applied" | "rejected",
): EffectReceipt => {
  const base = {
    receiptId,
    operation: "sms.send",
    resource: { kind: "sms.thread", id: thread },
    artifacts: [],
    idempotency: { key: `send-${thread}`, replayed: false },
    observedAt: OBSERVED_AT,
  };
  return outcome === "applied"
    ? {
        ...base,
        outcome: "applied",
        commit: {
          kind: "provider_accepted",
          id: `${receiptId}-commit`,
          committedAt: OBSERVED_AT,
        },
      }
    : {
        ...base,
        outcome: "failed",
        failure: {
          code: "NO_NUMBER",
          retryable: false,
          acceptance: "rejected",
        },
      };
};
const MIXED_REPLY =
  "sent bob the text. alice's text didn't go through: she has no number saved.";
const bobSent = (): RecoveredReplyClaim => ({
  quote: "sent bob the text",
  actor: "assistant",
  change: true,
  outcome: "occurred",
  failedResult: null,
  supported: true,
  evidence: "sms-bob",
});
const aliceFailed = (
  failedResult: number,
  evidence = "No number saved for Alice.",
): RecoveredReplyClaim => ({
  quote: "alice's text didn't go through",
  actor: "assistant",
  change: true,
  outcome: "not_occurred",
  failedResult,
  supported: true,
  evidence,
});
const bobResult: ActionResult = {
  success: true,
  text: "Sent to Bob.",
  data: { actionName: "MESSAGE" },
  effectReceipts: [smsReceipt("sms-bob", "bob", "applied")],
};
const aliceResult: ActionResult = {
  success: false,
  text: "No number saved for Alice.",
  data: { actionName: "MESSAGE" },
};

it.each([
  [
    "a receipt-less failure before another target's success",
    [aliceResult, bobResult],
    aliceFailed(1),
  ],
  [
    "a receipt-less failure after another target's success",
    [bobResult, aliceResult],
    aliceFailed(2),
  ],
  [
    "a rejected receipt for one target before another target's success",
    [
      {
        ...aliceResult,
        effectReceipts: [smsReceipt("sms-alice", "alice", "rejected")],
      },
      bobResult,
    ],
    aliceFailed(1),
  ],
  [
    "a rejected receipt the claim names beside another target's applied receipt",
    [
      {
        success: true,
        text: "Sent to Bob. No number saved for Alice.",
        data: { actionName: "MESSAGE" },
        effectReceipts: [
          smsReceipt("sms-bob", "bob", "applied"),
          smsReceipt("sms-alice", "alice", "rejected"),
        ],
      },
    ],
    aliceFailed(1, "sms-alice"),
  ],
  [
    "a rejected receipt beside another target's applied receipt on one result",
    [
      {
        success: true,
        text: "Sent to Bob. No number saved for Alice.",
        data: { actionName: "MESSAGE" },
        effectReceipts: [
          smsReceipt("sms-bob", "bob", "applied"),
          smsReceipt("sms-alice", "alice", "rejected"),
        ],
      },
    ],
    aliceFailed(1),
  ],
] as [string, ActionResult[], RecoveredReplyClaim][])(
  "keeps an honest failure report for %s of the same action",
  async (_label, results, claim) => {
    const f = fixture(
      [{ response: MIXED_REPLY, effectReceiptIds: ["sms-bob"] }],
      [{ grounded: true, claims: [bobSent(), claim] }],
    );
    await expect(f.recover(results)).resolves.toEqual({
      text: MIXED_REPLY,
      effectReceiptIds: ["sms-bob"],
    });
    expect(f.renderPrompts).toHaveLength(1);
  },
);

// The review repro: Alice has no number and no receipt, Bob's text applied,
// and the judge supports both claims. Both orders keep Alice's failure.
const ALICE_BOB_REPLY =
  "sent bob the text. i couldn't text alice: no number saved for her.";
it.each([
  ["Alice's failure first", [aliceResult, bobResult], 1],
  ["Bob's success first", [bobResult, aliceResult], 2],
] as [string, ActionResult[], number][])(
  "delivers both halves of the Alice/Bob reply with %s",
  async (_label, results, failedResult) => {
    const f = fixture(
      [{ response: ALICE_BOB_REPLY, effectReceiptIds: ["sms-bob"] }],
      [
        {
          grounded: true,
          claims: [
            bobSent(),
            {
              ...aliceFailed(failedResult),
              quote: "i couldn't text alice",
            },
          ],
        },
      ],
    );
    await expect(f.recover(results)).resolves.toEqual({
      text: ALICE_BOB_REPLY,
      effectReceiptIds: ["sms-bob"],
    });
    expect(f.renderPrompts).toHaveLength(1);
    expect(f.reviewPrompts).toHaveLength(1);
  },
);

it("rejects a did-not-happen claim for a failure retried to the same target under the same key", async () => {
  // Target evidence stays code-side: the judge wrongly supports both drafts.
  const aliceRetried: ActionResult = {
    success: true,
    text: "Sent to Alice.",
    data: { actionName: "MESSAGE" },
    effectReceipts: [smsReceipt("sms-alice-retry", "alice", "applied")],
  };
  const claim = aliceFailed(1, "sms-alice");
  const f = fixture(
    [{ response: HONEST_FAILURE }, { response: HONEST_FAILURE }],
    [
      { grounded: true, claims: [claim] },
      { grounded: true, claims: [claim] },
    ],
  );
  await expect(
    f.recover([
      {
        ...aliceResult,
        effectReceipts: [smsReceipt("sms-alice", "alice", "rejected")],
      },
      aliceRetried,
    ]),
  ).rejects.toMatchObject({
    code: "REPLY_GROUNDING_FAILED",
    message: "Recovered reply asserts an unsupported outcome",
  });
  expect(f.reviewPrompts).toHaveLength(2);
});

it("does not treat an unnamed earlier success as a retry of an unnamed failure", async () => {
  const f = fixture(
    [{ response: HONEST_FAILURE }],
    [{ grounded: true, claims: [failureClaim({ failedResult: 2 })] }],
  );
  await expect(
    f.recover([
      { success: true, text: "Read the view list." },
      {
        success: false,
        text: "Navigation rejected (HTTP 409).",
        error: "HTTP 409",
      },
    ]),
  ).resolves.toEqual({ text: HONEST_FAILURE, effectReceiptIds: [] });
});

it("does not treat an unnamed later success as a retry of an unnamed failure", async () => {
  const f = fixture(
    [{ response: HONEST_FAILURE }],
    [{ grounded: true, claims: [failureClaim()] }],
  );
  await expect(
    f.recover([
      {
        success: false,
        text: "Navigation rejected (HTTP 409).",
        error: "HTTP 409",
      },
      { success: true, text: "Read the view list." },
    ]),
  ).resolves.toEqual({ text: HONEST_FAILURE, effectReceiptIds: [] });
});

const calendarFailed: ActionResult = {
  success: false,
  text: "Calendar source required.",
  data: { actionName: "CALENDAR" },
  effectReceipts: [
    {
      receiptId: "calendar-evaluate-failed",
      operation: "calendar.request.evaluate",
      resource: { kind: "calendar.operation", id: "op-hash-1" },
      artifacts: [],
      idempotency: { key: null, replayed: false },
      observedAt: OBSERVED_AT,
      outcome: "failed",
      failure: {
        code: "CALENDAR_NATIVE_RESOURCE_REQUIRED",
        retryable: true,
        acceptance: "rejected",
      },
    },
  ],
};
const calendarCreated = (
  receipt: Partial<EffectReceipt> = {},
): ActionResult => ({
  success: true,
  text: "Added the event.",
  data: { actionName: "CALENDAR" },
  effectReceipts: [
    {
      receiptId: "calendar-event-9",
      operation: "calendar.event.create",
      resource: { kind: "calendar.event", id: "event-9" },
      artifacts: [],
      idempotency: { key: "create-dentist", replayed: false },
      observedAt: OBSERVED_AT,
      outcome: "applied",
      commit: {
        kind: "provider_accepted",
        id: "event-9-commit",
        committedAt: OBSERVED_AT,
      },
      ...receipt,
    } as EffectReceipt,
  ],
});

it.each([
  [
    "a cited rejected receipt whose retry committed under the same idempotency key",
    [
      {
        ...calendarFailed,
        data: { actionName: "CALENDAR_CREATE" },
        effectReceipts: [
          {
            ...smsReceipt("create-draft-1", "x", "rejected"),
            operation: "calendar.event.create",
            resource: { kind: "calendar.event", id: "draft-1" },
            idempotency: { key: "create-dentist", replayed: false },
          },
        ],
      },
      calendarCreated(),
    ],
    failureClaim({ failedResult: 1 }),
  ],
  [
    "a cited receipt the claim names that committed elsewhere",
    [
      {
        success: true,
        text: "Sent to Bob. No number saved for Alice.",
        data: { actionName: "MESSAGE" },
        effectReceipts: [
          smsReceipt("sms-bob", "bob", "applied"),
          smsReceipt("sms-alice", "alice", "rejected"),
        ],
      },
    ],
    failureClaim({ failedResult: 1, evidence: "sms-bob" }),
  ],
] as [string, ActionResult[], RecoveredReplyClaim][])(
  "rejects a did-not-happen claim with %s",
  async (_label, results, claim) => {
    const f = fixture(
      [{ response: HONEST_FAILURE }, { response: HONEST_FAILURE }],
      [
        { grounded: true, claims: [claim] },
        { grounded: true, claims: [claim] },
      ],
    );
    await expect(f.recover(results)).rejects.toMatchObject({
      code: "REPLY_GROUNDING_FAILED",
      message: "Recovered reply asserts an unsupported outcome",
    });
  },
);

// A CALENDAR failure receipt (kind calendar.operation) and a later create
// (kind calendar.event) cannot be compared by target: code cannot tell a
// retry of one event from a second event, so it does not strip the failure
// report, and whether the create was a retry is the judge's call.
const CALENDAR_MIXED_REPLY =
  "added lunch with sam. i couldn't add the dentist appointment: no calendar source was picked.";
const lunchAdded = (): RecoveredReplyClaim => ({
  quote: "added lunch with sam",
  actor: "assistant",
  change: true,
  outcome: "occurred",
  failedResult: null,
  supported: true,
  evidence: "calendar-event-9",
});
const dentistFailed = (supported: boolean): RecoveredReplyClaim => ({
  quote: "i couldn't add the dentist appointment",
  actor: "assistant",
  change: true,
  outcome: "not_occurred",
  failedResult: 1,
  supported,
  evidence: "Calendar source required.",
});

it("keeps an honest CALENDAR failure report beside a later create for another event", async () => {
  const f = fixture(
    [
      {
        response: CALENDAR_MIXED_REPLY,
        effectReceiptIds: ["calendar-event-9"],
      },
    ],
    [{ grounded: true, claims: [lunchAdded(), dentistFailed(true)] }],
  );
  await expect(
    f.recover([
      calendarFailed,
      calendarCreated({
        idempotency: { key: "create-lunch", replayed: false },
      }),
    ]),
  ).resolves.toEqual({
    text: CALENDAR_MIXED_REPLY,
    effectReceiptIds: ["calendar-event-9"],
  });
  expect(f.renderPrompts).toHaveLength(1);
});

it("leaves a CALENDAR failure retried by a later create of the same event to the judge", async () => {
  const f = fixture(
    [{ response: HONEST_FAILURE }, { response: HONEST_FAILURE }],
    [
      { grounded: true, claims: [dentistFailed(false)] },
      { grounded: true, claims: [dentistFailed(false)] },
    ],
  );
  await expect(
    f.recover([calendarFailed, calendarCreated()]),
  ).rejects.toMatchObject({
    code: "REPLY_GROUNDING_FAILED",
    message: "Recovered reply asserts an unsupported outcome",
  });
});
