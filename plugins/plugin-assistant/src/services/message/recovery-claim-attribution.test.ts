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
