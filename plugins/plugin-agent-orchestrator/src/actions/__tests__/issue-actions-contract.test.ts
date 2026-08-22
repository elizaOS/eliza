/**
 * Deterministic coverage for the issue read/create prompt-integrity seams
 * (cap-audit close-out):
 *  - bulk create processes EVERY extracted item (the old code silently
 *    dropped items 26..N while replying success),
 *  - `list` is an explicit pagination contract — caller offset/limit honored,
 *    total + hasMore echoed — never a silent first-25 clip,
 *  - `get` renders an oversized body as a durable projection whose marker
 *    names the resolver route, with the complete body persisted first.
 * Stubbed service and runtime, no network; the durable store writes into a
 * sandboxed trajectory dir.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDurableContent } from "../../services/durable-content-store";
import { handleIssueAction } from "../tasks";

/** Narrows the action result — the seams under test always return one. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected an ActionResult");
  return value;
}

let dir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "issue-contract-"));
  savedEnv = process.env.ELIZA_TRAJECTORY_DIR;
  process.env.ELIZA_TRAJECTORY_DIR = dir;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.ELIZA_TRAJECTORY_DIR;
  else process.env.ELIZA_TRAJECTORY_DIR = savedEnv;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Runtime whose voice model is down: phraseForUser degrades to the factual
 * fallback, keeping assertions deterministic. */
const runtime = {
  agentId: "agent-1",
  getSetting: () => undefined,
  useModel: async () => {
    throw new Error("no model in unit test");
  },
} as never;

function issue(n: number, body = "") {
  return {
    number: n,
    title: `issue ${n}`,
    url: `https://github.com/o/r/issues/${n}`,
    state: "open" as const,
    labels: [] as string[],
    body,
  };
}

describe("bulk issue create", () => {
  it("creates EVERY extracted item — no silent 25-item cap", async () => {
    let next = 0;
    const service = {
      createIssue: vi.fn(async (_repo: string, req: { title: string }) => {
        next += 1;
        return { ...issue(next), title: req.title };
      }),
      addLabels: vi.fn(async () => undefined),
    } as never;
    const text = Array.from(
      { length: 30 },
      (_, i) => `${i + 1}. Fix problem number ${i + 1}`,
    ).join("\n");
    const result = must(
      await handleIssueAction(
        runtime,
        service,
        "o/r",
        "create",
        { text },
        text,
      ),
    );
    expect(result.success).toBe(true);
    const issues = (result.data as { issues: unknown[] }).issues;
    expect(issues).toHaveLength(30);
    expect(
      (service as { createIssue: ReturnType<typeof vi.fn> }).createIssue,
    ).toHaveBeenCalledTimes(30);
    // The receipt appendix reports every created issue, not a window.
    expect(result.text).toContain("#30:");
  });
});

describe("issue list pagination contract", () => {
  const thirty = Array.from({ length: 30 }, (_, i) => issue(i + 1));
  const service = { listIssues: vi.fn(async () => thirty) } as never;

  it("default page echoes total + hasMore and names the continuation", async () => {
    const result = must(
      await handleIssueAction(
        runtime,
        service,
        "o/r",
        "list",
        {},
        "list issues",
      ),
    );
    expect(result.data).toMatchObject({
      total: 30,
      offset: 0,
      limit: 25,
      hasMore: true,
    });
    expect((result.data as { issues: unknown[] }).issues).toHaveLength(25);
    expect(result.text).toContain("(1–25 of 30)");
    expect(result.text).toContain("pass offset=25 to continue");
  });

  it("honors the caller's offset and reports the final page as complete", async () => {
    const result = must(
      await handleIssueAction(
        runtime,
        service,
        "o/r",
        "list",
        { offset: 25 },
        "list issues",
      ),
    );
    expect(result.data).toMatchObject({
      total: 30,
      offset: 25,
      hasMore: false,
    });
    expect((result.data as { issues: unknown[] }).issues).toHaveLength(5);
    expect(result.text).toContain("(26–30 of 30)");
    expect(result.text).not.toContain("pass offset=");
  });

  it("honors a caller limit above the default page size", async () => {
    const result = must(
      await handleIssueAction(
        runtime,
        service,
        "o/r",
        "list",
        { limit: 30 },
        "list issues",
      ),
    );
    expect(result.data).toMatchObject({ total: 30, hasMore: false });
    expect((result.data as { issues: unknown[] }).issues).toHaveLength(30);
  });

  it("pages reassemble the complete listing losslessly", async () => {
    const page = async (offset: number) =>
      (
        must(
          await handleIssueAction(
            runtime,
            service,
            "o/r",
            "list",
            { offset, limit: 12 },
            "list issues",
          ),
        ).data as { issues: Array<{ number: number }> }
      ).issues;
    const reassembled = [
      ...(await page(0)),
      ...(await page(12)),
      ...(await page(24)),
    ];
    expect(reassembled.map((i) => i.number)).toEqual(
      thirty.map((i) => i.number),
    );
  });
});

describe("issue get body projection", () => {
  it("short bodies pass through whole with no marker", async () => {
    const service = {
      getIssue: vi.fn(async () => issue(7, "short body")),
    } as never;
    const result = must(
      await handleIssueAction(
        runtime,
        service,
        "o/r",
        "get",
        { issueNumber: 7 },
        "get issue 7",
      ),
    );
    expect(result.text).toContain("short body");
    expect(result.text).not.toContain("/api/orchestrator/content/");
  });

  it("an oversized body is durably persisted whole; the view names the resolver", async () => {
    const body = `HEAD-SENTINEL ${"lorem ipsum ".repeat(600)}TAIL-SENTINEL`;
    const service = { getIssue: vi.fn(async () => issue(9, body)) } as never;
    const result = must(
      await handleIssueAction(
        runtime,
        service,
        "o/r",
        "get",
        { issueNumber: 9 },
        "get issue 9",
      ),
    );
    const text = result.text ?? "";
    expect(text).toContain("HEAD-SENTINEL");
    // The marker names the REAL resolver route with the record's sha256.
    const match = text.match(
      /GET \/api\/orchestrator\/content\/([0-9a-f]{64})/,
    );
    expect(match).not.toBeNull();
    // The complete body is recoverable from the durable store (lossless).
    const sha = match?.[1] as string;
    const stored = readDurableContent(sha, { limit: 10_000_000 });
    expect(stored?.text).toBe(body);
    // The structured payload still carries the full body verbatim.
    expect((result.data as { issue: { body: string } }).issue.body).toBe(body);
  });
});
