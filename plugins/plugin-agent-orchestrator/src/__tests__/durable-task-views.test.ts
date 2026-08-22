/**
 * Prompt-integrity regression coverage for the task service's model-facing
 * views (repo invariant: model-facing content is complete, or a bounded view
 * carries a resolvable continuation reference — never a bare truncation).
 *
 * - eventExcerpt / retryInstruction / withPlanRevisionContext: oversized
 *   payloads are persisted whole to the durable content store FIRST and the
 *   emitted head names `GET /api/orchestrator/content/<sha256>`; the marker's
 *   promise is proven real by reading the record back losslessly.
 * - composeVerifyEscalationNotice: the user notice previews the first three
 *   missing items but NAMES the omission instead of dropping items silently.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDurableContent } from "../services/durable-content-store.js";
import {
  composeVerifyEscalationNotice,
  eventExcerpt,
  retryInstruction,
  withPlanRevisionContext,
} from "../services/orchestrator-task-service.js";
import type { OrchestratorTaskDocument } from "../services/orchestrator-task-types.js";

let dir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "durable-task-views-"));
  savedEnv = process.env.ELIZA_TRAJECTORY_DIR;
  process.env.ELIZA_TRAJECTORY_DIR = dir;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.ELIZA_TRAJECTORY_DIR;
  else process.env.ELIZA_TRAJECTORY_DIR = savedEnv;
  fs.rmSync(dir, { recursive: true, force: true });
});

const CONTENT_ROUTE_RE = /\/api\/orchestrator\/content\/([0-9a-f]{64})/u;

/** Assert a view's continuation marker resolves to the COMPLETE original. */
function expectRecoverable(view: string, full: string): void {
  const sha = CONTENT_ROUTE_RE.exec(view)?.[1];
  expect(
    sha,
    `no resolvable content route in view: ${view.slice(-200)}`,
  ).toBeDefined();
  const record = readDurableContent(sha as string, { limit: 1_048_576 });
  expect(record?.text).toBe(full);
  expect(record?.hasMore).toBe(false);
}

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

  it("projects an oversized payload durably: bounded head + resolvable route", () => {
    const data = { text: "x".repeat(5_000) };
    const full = JSON.stringify(data);
    const excerpt = eventExcerpt(makeEvent(data));
    const dataSection = excerpt.slice(
      excerpt.indexOf("\nData: ") + "\nData: ".length,
    );
    expect(dataSection.length).toBeLessThanOrEqual(1_200);
    expectRecoverable(excerpt, full);
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

  it("projects an oversized source message durably instead of bare-truncating", () => {
    const full = "y".repeat(6_000);
    const text = retryInstruction(makeDoc(full), { messageId: "msg-1" });
    expect(text.length).toBeLessThan(full.length);
    expectRecoverable(text, full);
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

  it("projects an oversized plan durably so tail steps are never silently cut", () => {
    const plan = {
      steps: Array.from(
        { length: 200 },
        (_, i) => `step ${i}: ${"z".repeat(40)}`,
      ),
    };
    const full = JSON.stringify(plan);
    expect(full.length).toBeGreaterThan(2_000);
    const text = withPlanRevisionContext("do it", makeRevision(plan));
    expectRecoverable(text, full);
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
