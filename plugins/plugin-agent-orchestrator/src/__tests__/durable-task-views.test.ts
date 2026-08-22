/**
 * Prompt-integrity regression coverage for the task service's model-facing
 * views (repo contract, maintainer ruling closing #24549–#24553: content that
 * reaches a model call arrives COMPLETE — a capped projection with a
 * recoverable reference does not preserve the current model call).
 *
 * - eventExcerpt / retryInstruction / withPlanRevisionContext: the payload is
 *   passed WHOLE regardless of size — no head+marker substitution, no
 *   `GET /api/orchestrator/content/<sha256>` route in the emitted text.
 *   Canonicalization (well-formed Unicode + credential redaction) remains as
 *   a security transform, never a cap.
 * - composeVerifyEscalationNotice: the user notice previews the first three
 *   missing items but NAMES the omission instead of dropping items silently
 *   (user-facing preview surface; the complete list still reaches the model
 *   prompt — covered in orchestrator-task-service.test.ts).
 */
import { describe, expect, it } from "vitest";
import {
  composeVerifyEscalationNotice,
  eventExcerpt,
  retryInstruction,
  withPlanRevisionContext,
} from "../services/orchestrator-task-service.js";
import type { OrchestratorTaskDocument } from "../services/orchestrator-task-types.js";

const CONTENT_ROUTE_RE = /\/api\/orchestrator\/content\/([0-9a-f]{64})/u;

function makeEvent(
  data: Record<string, unknown>,
): OrchestratorTaskDocument["events"][number] {
  return {
    id: "evt-1",
    taskId: "task-1",
    eventType: "message",
    summary: "preview line",
    data,
    timestamp: 1,
    createdAt: new Date(1).toISOString(),
  };
}

describe("eventExcerpt (rerun prompt payload)", () => {
  it("passes a small payload through whole, without a marker", () => {
    const excerpt = eventExcerpt(makeEvent({ text: "hello" }));
    expect(excerpt).toContain('{"text":"hello"}');
    expect(excerpt).not.toMatch(CONTENT_ROUTE_RE);
  });

  it("passes an oversized payload COMPLETE — no cap, no content-route marker", () => {
    const data = { text: "x".repeat(5_000) };
    const full = JSON.stringify(data);
    const excerpt = eventExcerpt(makeEvent(data));
    // The complete serialized payload is present verbatim in the model text.
    expect(excerpt).toContain(full);
    expect(excerpt).not.toMatch(CONTENT_ROUTE_RE);
  });

  it("canonicalizes without capping: redacts credentials, repairs lone surrogates", () => {
    const secret = "sk-abcdef0123456789abcdef";
    const excerpt = eventExcerpt(
      makeEvent({ note: `API_KEY=${secret} \uD800 ${"y".repeat(3_000)}` }),
    );
    // Security transform still applies to the complete text...
    expect(excerpt).not.toContain(secret);
    expect(excerpt).not.toContain("\uD800");
    // ...but it is a transform, not a cap: the payload tail survives whole.
    expect(excerpt).toContain("y".repeat(3_000));
    expect(excerpt).not.toMatch(CONTENT_ROUTE_RE);
  });
});

describe("retryInstruction (retry prompt source quote)", () => {
  function makeDoc(content: string): OrchestratorTaskDocument {
    return {
      messages: [
        {
          id: "msg-1",
          taskId: "task-1",
          senderKind: "user",
          direction: "inbound",
          content,
          searchableText: content,
          timestamp: 1,
          metadata: {},
          createdAt: new Date(1).toISOString(),
        },
      ],
    } as unknown as OrchestratorTaskDocument;
  }

  it("quotes a short source message whole", () => {
    const text = retryInstruction(makeDoc("fix the header"), {
      messageId: "msg-1",
    });
    expect(text).toContain("fix the header");
    expect(text).not.toMatch(CONTENT_ROUTE_RE);
  });

  it("quotes an oversized source message COMPLETE — no truncation, no marker", () => {
    const full = "y".repeat(6_000);
    const text = retryInstruction(makeDoc(full), { messageId: "msg-1" });
    expect(text).toContain(full);
    expect(text).not.toMatch(CONTENT_ROUTE_RE);
  });
});

describe("withPlanRevisionContext (plan revision prompt)", () => {
  function makeRevision(
    plan: Record<string, unknown>,
  ): OrchestratorTaskDocument["planRevisions"][number] {
    return {
      id: "rev-1",
      taskId: "task-1",
      plan,
      createdBy: "user",
      metadata: {},
      timestamp: 1,
      createdAt: new Date(1).toISOString(),
    };
  }

  it("inlines a small plan whole", () => {
    const text = withPlanRevisionContext(
      "do it",
      makeRevision({ steps: ["a"] }),
    );
    expect(text).toContain('{"steps":["a"]}');
    expect(text).not.toMatch(CONTENT_ROUTE_RE);
  });

  it("inlines an oversized plan COMPLETE so tail steps are never cut", () => {
    const plan = {
      steps: Array.from(
        { length: 200 },
        (_, i) => `step ${i}: ${"z".repeat(40)}`,
      ),
    };
    const full = JSON.stringify(plan);
    expect(full.length).toBeGreaterThan(2_000);
    const text = withPlanRevisionContext("do it", makeRevision(plan));
    // The whole serialized revision — including the final step — is in the
    // prompt; nothing is deferred to a continuation route.
    expect(text).toContain(full);
    expect(text).toContain(`step 199: ${"z".repeat(40)}`);
    expect(text).not.toMatch(CONTENT_ROUTE_RE);
  });
});

describe("composeVerifyEscalationNotice missing-list preview", () => {
  it("shows all items when three or fewer, with no omission tail", () => {
    const notice = composeVerifyEscalationNotice("build", {
      attempts: 3,
      summary: "gave up",
      missing: ["item-a", "item-b", "item-c"],
    });
    expect(notice).toContain("Couldn't confirm: item-a; item-b; item-c.");
    expect(notice).not.toContain("more on the task's verification record");
  });

  it("names the omission instead of silently dropping items past three", () => {
    const notice = composeVerifyEscalationNotice("build", {
      attempts: 3,
      summary: "gave up",
      missing: ["item-a", "item-b", "item-c", "item-d", "item-e"],
    });
    expect(notice).toContain("Couldn't confirm: item-a; item-b; item-c");
    expect(notice).not.toContain("item-d");
    expect(notice).toContain("plus 2 more on the task's verification record");
  });

  it("counts the omission after the summary-stutter dedupe, not before", () => {
    const notice = composeVerifyEscalationNotice("build", {
      attempts: 2,
      summary: "Missing: a thing",
      // "a thing" is deduped against the summary; the remaining four leave
      // exactly one omitted.
      missing: ["a thing", "w", "x", "y", "z"],
    });
    expect(notice).toContain("Couldn't confirm: w; x; y");
    expect(notice).toContain("plus 1 more on the task's verification record");
  });
});
