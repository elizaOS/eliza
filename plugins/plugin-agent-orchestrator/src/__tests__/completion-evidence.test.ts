/**
 * Renderer pins for the completion-evidence bundle, centered on the
 * claims-vs-proof stance: probe-verified URLs vs mentioned URLs, and (#16523)
 * ledger-verified files vs unverified file claims. The judge only ever sees
 * the serialized string, so the section wording IS the contract. The durable
 * content store runs against a real temp filesystem (ELIZA_TRAJECTORY_DIR)
 * for the prompt-integrity pins: bounded views must be reference-bearing and
 * losslessly recoverable, never silent cuts.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendCompletionEvidenceSection,
  buildCompletionEvidenceString,
  buildEvidenceStringFromInput,
  classifyToolOutput,
  type CompletionEvidenceBundle,
  renderChangeSetBody,
} from "../services/completion-evidence.js";
import { readDurableContent } from "../services/durable-content-store.js";
import type { WorkspaceChangeSet } from "../services/workspace-diff.js";

let trajectoryDir: string;
let savedTrajectoryEnv: string | undefined;

beforeEach(() => {
  trajectoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-durable-"));
  savedTrajectoryEnv = process.env.ELIZA_TRAJECTORY_DIR;
  process.env.ELIZA_TRAJECTORY_DIR = trajectoryDir;
});

afterEach(() => {
  if (savedTrajectoryEnv === undefined) delete process.env.ELIZA_TRAJECTORY_DIR;
  else process.env.ELIZA_TRAJECTORY_DIR = savedTrajectoryEnv;
  fs.rmSync(trajectoryDir, { recursive: true, force: true });
});

function extractContentSha(text: string): string {
  const sha = /\/api\/orchestrator\/content\/([0-9a-f]{64})/.exec(text)?.[1];
  if (!sha) throw new Error(`no content reference in: ${text.slice(0, 200)}`);
  return sha;
}

function bundle(
  overrides: Partial<CompletionEvidenceBundle>,
): CompletionEvidenceBundle {
  return {
    summary: "did the thing",
    verifiedUrls: [],
    screenshots: [],
    ...overrides,
  };
}

describe("buildCompletionEvidenceString — unverified file claims (#16523)", () => {
  it("renders each unverified claim with its fail-closed reason", () => {
    const rendered = buildCompletionEvidenceString(
      bundle({
        unverifiedClaimedFiles: [
          { path: "src/phantom.ts", reason: "rejected-write" },
          { path: "src/invented.ts", reason: "no-write-observed" },
        ],
      }),
    );
    expect(rendered).toContain("## UNVERIFIED FILE CLAIMS");
    expect(rendered).toContain(
      "- src/phantom.ts (the tool layer REJECTED this write)",
    );
    expect(rendered).toContain(
      "- src/invented.ts (no successful write observed)",
    );
    // Explicit relay stance: the header tells the judge how to treat them.
    expect(rendered).toContain("treat each as NOT delivered");
  });

  it("renders no file-claims section when every claim is ledger-verified", () => {
    const rendered = buildCompletionEvidenceString(
      bundle({
        ledgerVerifiedFiles: ["src/good.ts"],
        unverifiedClaimedFiles: [],
      }),
    );
    expect(rendered).not.toContain("UNVERIFIED FILE CLAIMS");
  });

  it("the flag survives the thin-completion fallback — fail-closed relay", () => {
    // With ONLY unverified claims (no diff/tool output/urls), the renderer
    // falls back to the bare reply BUT must keep the flag attached: dropping
    // it would relay the phantom "Created" claim the section exists to
    // expose. The flag never upgrades a thin completion to "richer" evidence
    // — it only annotates the reply.
    const withFlagOnly = buildCompletionEvidenceString(
      bundle({
        unverifiedClaimedFiles: [
          { path: "src/phantom.ts", reason: "rejected-write" },
        ],
      }),
    );
    expect(withFlagOnly).toContain("did the thing");
    expect(withFlagOnly).toContain("## UNVERIFIED FILE CLAIMS");
    expect(withFlagOnly).toContain("src/phantom.ts");
  });

  it("mentioned URLs and unverified file claims coexist as distinct sections", () => {
    const rendered = buildCompletionEvidenceString(
      bundle({
        verifiedUrls: ["https://real.example/health"],
        mentionedUrls: ["https://claimed.example/deploy"],
        unverifiedClaimedFiles: [
          { path: "src/phantom.ts", reason: "rejected-write" },
        ],
      }),
    );
    expect(rendered).toContain("## VERIFIED URLS");
    expect(rendered).toContain("## CLAIMED URLS");
    expect(rendered).toContain("## UNVERIFIED FILE CLAIMS");
  });
});

describe("classifyToolOutput — prompt-integrity (no silent cuts)", () => {
  it("a long [tool output] envelope is persisted whole; the bucket view names the resolver", () => {
    const body = `test run FAILED\n${"x".repeat(6_000)}`;
    const out = classifyToolOutput([
      { text: `[tool output: bun test]${body}[/tool output]`, source: "run" },
    ]);
    const raw = out?.raw ?? "";
    // Bounded view carries the continuation marker naming the REAL route…
    expect(raw).toContain("/api/orchestrator/content/");
    // …and the marker's promise is real: the COMPLETE body resolves.
    const window = readDurableContent(extractContentSha(raw), {
      limit: 1_048_576,
    });
    expect(window?.text).toBe(body);
    expect(window?.hasMore).toBe(false);
  });

  it("a short envelope flows whole with no marker and no persistence", () => {
    const out = classifyToolOutput([
      { text: "[tool output: python3 squares.py]1 4 9 16[/tool output]" },
    ]);
    expect(out?.raw).toBe("1 4 9 16");
    expect(out?.raw).not.toContain("/api/orchestrator/content/");
  });

  it("a matched run-result line longer than 400 chars survives WHOLE (length gate removed)", () => {
    const longLine = `FAIL src/very-long.test.ts > suite ${"y".repeat(600)} (3 tests failed)`;
    const out = classifyToolOutput([{ text: longLine, source: "vitest run" }]);
    expect(out?.test).toContain(longLine);
  });
});

describe("mined tool-output sections are reference-bearing to the transcript", () => {
  it("the bundle section header names the durable session-output route", () => {
    const rendered = buildCompletionEvidenceString(
      bundle({ toolOutput: { test: "2 passed" } }),
    );
    expect(rendered).toContain("mined selection");
    expect(rendered).toContain("GET /api/coding-agents/:sessionId/output");
  });

  it("legacy assembler: long matched lines survive whole and the header names the transcript", () => {
    const longLine = `error TS2345: ${"z".repeat(500)} — Type 'A' is not assignable`;
    const rendered = buildEvidenceStringFromInput({
      fallbackSummary: "done",
      signals: [{ text: longLine, source: "tsc" }],
    });
    expect(rendered).toContain(longLine);
    expect(rendered).toContain("GET /api/coding-agents/:sessionId/output");
  });
});

describe("renderChangeSetBody — truncation carries a durable reference", () => {
  const changeSet = (truncated: boolean): WorkspaceChangeSet => ({
    changedFiles: ["a.ts"],
    diffStat: "1 file changed",
    diff: "diff --git a/a.ts b/a.ts\n+added line",
    truncated,
    capturedAt: Date.now(),
  });

  it("a truncated change set persists the captured record and names the resolver", () => {
    const body = renderChangeSetBody(changeSet(true));
    expect(body).toContain("changeset truncated at capture");
    const window = readDurableContent(extractContentSha(body), {
      limit: 1_048_576,
    });
    // The durable record holds the fullest captured body (diffstat + files +
    // diff) — the marker's promise of recoverability is real.
    expect(window?.text).toContain("+added line");
    expect(window?.text).toContain("changedFiles (1): a.ts");
  });

  it("an untruncated change set renders no truncation marker", () => {
    const body = renderChangeSetBody(changeSet(false));
    expect(body).not.toContain("truncated");
    expect(body).toContain("+added line");
  });
});

describe("appendCompletionEvidenceSection", () => {
  it("appends a verifier section after the assembled evidence", () => {
    const combined = appendCompletionEvidenceSection(
      "base evidence",
      "## EXTRA\ndetail",
    );
    expect(combined).toContain("base evidence");
    expect(combined).toContain("## EXTRA");
    expect(combined.indexOf("base evidence")).toBeLessThan(
      combined.indexOf("## EXTRA"),
    );
  });
});
