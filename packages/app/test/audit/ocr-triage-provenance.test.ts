/**
 * Provenance regression guard for the app-audit OCR triage (#15790). Proves the
 * triage is scoped to the current `report.json` and can never fold a screenshot
 * left behind by an earlier capture into the result. Two layers: pure-function
 * tests of `authorizedShots` (the selection invariant), and an end-to-end run of
 * the real `scripts/ocr-triage.ts` CLI over a fixture directory salted with a
 * stale PNG and a stale OCR record — the exact shape that produced the bug where
 * 240 report rows were triaged against 379 globbed PNGs.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAuditAppOutput } from "../../scripts/lib/audit-output.mjs";
import {
  authorizedShots,
  type ReportEntry,
  runOcrTriage,
  validateImportedOcrRecords,
} from "../../scripts/ocr-triage";

// Changed-file coverage invokes Vitest from the repository root while the
// package script invokes it from `packages/app`. Vitest gives `import.meta.url`
// a virtual scheme, so select between those two documented cwd contracts by
// probing for the CLI rather than assuming the package-root invocation.
const appDirCandidates = [
  process.cwd(),
  join(process.cwd(), "packages", "app"),
].filter((candidate) =>
  existsSync(join(candidate, "scripts", "ocr-triage.ts")),
);
if (appDirCandidates.length !== 1) {
  throw new Error(
    `Expected one app package root from ${process.cwd()}, found ${appDirCandidates.length}`,
  );
}
const [APP_DIR] = appDirCandidates;
const CLI = join(APP_DIR, "scripts", "ocr-triage.ts");

/** Minimal valid 1×1 PNG — enough for `existsSync`; the CLI OCR comes from ndjson. */
const PNG_1x1 = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000d49444154789c62000100000500010d0a2db40000" +
    "000049454e44ae426082",
  "hex",
);

function shot(dir: string, viewport: string, slug: string): void {
  const vp = join(dir, viewport);
  mkdirSync(vp, { recursive: true });
  writeFileSync(join(vp, `${slug}.png`), PNG_1x1);
}

function ocrLine(viewport: string, slug: string, text: string): string {
  return JSON.stringify({
    path: join(viewport, `${slug}.png`),
    ok: true,
    text,
    lines: text.split("\n").filter(Boolean),
    words: text.split(/\s+/).filter(Boolean).length,
    meanConfidence: 1,
  });
}

// Slugs with no VIEW_EXPECTATIONS so the OCR verdict cannot confound the gate
// exit code — this test asserts provenance (which rows are triaged), not verdict.
const CURRENT_ROWS: ReportEntry[] = [
  { slug: "builtin-chat", viewport: "desktop-landscape", verdict: "good" },
  { slug: "builtin-phone", viewport: "desktop-landscape", verdict: "good" },
];
const STALE_SLUG = "plugin-social-alpha-gui";

describe("authorizedShots (report-authoritative selection)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ocr-authz-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("selects exactly one shot per report row", () => {
    for (const r of CURRENT_ROWS) shot(dir, r.viewport, r.slug);
    const shots = authorizedShots(dir, CURRENT_ROWS);
    expect(shots.map((s) => s.key).sort()).toEqual([
      "builtin-chat::desktop-landscape",
      "builtin-phone::desktop-landscape",
    ]);
  });

  it("ignores a stale PNG that no current row names", () => {
    for (const r of CURRENT_ROWS) shot(dir, r.viewport, r.slug);
    // A retired view left behind by an earlier capture (the #15790 symptom).
    shot(dir, "desktop-landscape", STALE_SLUG);
    const shots = authorizedShots(dir, CURRENT_ROWS);
    expect(shots).toHaveLength(CURRENT_ROWS.length);
    expect(shots.some((s) => s.slug.includes("social-alpha"))).toBe(false);
  });

  it("fails fast when a report row has no screenshot", () => {
    shot(dir, "desktop-landscape", "builtin-chat");
    // builtin-phone.png intentionally absent.
    expect(() => authorizedShots(dir, CURRENT_ROWS)).toThrow(
      /builtin-phone::desktop-landscape has no screenshot/,
    );
  });

  it("fails fast on a duplicate report row", () => {
    for (const r of CURRENT_ROWS) shot(dir, r.viewport, r.slug);
    expect(() =>
      authorizedShots(dir, [...CURRENT_ROWS, CURRENT_ROWS[0]]),
    ).toThrow(/duplicate report row builtin-chat::desktop-landscape/);
  });

  it("fails fast on an empty report", () => {
    expect(() => authorizedShots(dir, [])).toThrow(/lists no views/);
  });
});

describe("ocr-triage CLI (end-to-end provenance)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ocr-cli-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(): { status: number; stderr: string } {
    try {
      execFileSync(
        "bun",
        [
          CLI,
          "--audit-dir",
          dir,
          "--ocr",
          join(dir, "ocr.ndjson"),
          "--out",
          join(dir, "ocr-triage.json"),
        ],
        { cwd: APP_DIR, encoding: "utf8", stdio: "pipe" },
      );
      return { status: 0, stderr: "" };
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      return { status: err.status ?? 1, stderr: err.stderr ?? "" };
    }
  }

  it("triages exactly the report rows while ignoring an unreported stale PNG", async () => {
    for (const r of CURRENT_ROWS) shot(dir, r.viewport, r.slug);
    writeFileSync(join(dir, "report.json"), JSON.stringify(CURRENT_ROWS));
    // A retired-view PNG can remain on disk, but it is not authorized evidence.
    shot(dir, "desktop-landscape", STALE_SLUG);
    writeFileSync(
      join(dir, "ocr.ndjson"),
      [
        ocrLine("desktop-landscape", "builtin-chat", "Chat messages composer"),
        ocrLine("desktop-landscape", "builtin-phone", "Phone dialer keypad"),
      ].join("\n"),
    );

    const result = await runOcrTriage([
      "--audit-dir",
      dir,
      "--ocr",
      join(dir, "ocr.ndjson"),
      "--out",
      join(dir, "ocr-triage.json"),
    ]);
    expect(result.summary.total).toBe(CURRENT_ROWS.length);
    expect(result.entries.map((entry) => entry.slug).sort()).toEqual([
      "builtin-chat",
      "builtin-phone",
    ]);

    const { status, stderr } = run();
    expect(stderr).toBe("");
    expect(status).toBe(0);

    const out = JSON.parse(
      readFileSync(join(dir, "ocr-triage.json"), "utf8"),
    ) as { summary: { total: number }; entries: { slug: string }[] };
    // OCR row count equals the DOM report row count — provenance holds.
    expect(out.summary.total).toBe(CURRENT_ROWS.length);
    expect(out.entries.map((e) => e.slug).sort()).toEqual([
      "builtin-chat",
      "builtin-phone",
    ]);
    expect(out.entries.some((e) => e.slug.includes("social-alpha"))).toBe(
      false,
    );
  });

  it("rejects imported OCR with missing, duplicate, unexpected, or mismatched records", () => {
    for (const r of CURRENT_ROWS) shot(dir, r.viewport, r.slug);
    const shots = authorizedShots(dir, CURRENT_ROWS);
    const chat = JSON.parse(
      ocrLine("desktop-landscape", "builtin-chat", "Chat messages composer"),
    );
    const phone = JSON.parse(
      ocrLine("desktop-landscape", "builtin-phone", "Phone dialer keypad"),
    );
    const stale = JSON.parse(
      ocrLine("desktop-landscape", STALE_SLUG, "Social Alpha leaderboard"),
    );

    expect(() =>
      validateImportedOcrRecords(dir, "ocr.ndjson", shots, [chat]),
    ).toThrow(/builtin-phone::desktop-landscape has no OCR record/);
    expect(() =>
      validateImportedOcrRecords(dir, "ocr.ndjson", shots, [
        chat,
        phone,
        phone,
      ]),
    ).toThrow(/duplicate OCR record builtin-phone::desktop-landscape/);
    expect(() =>
      validateImportedOcrRecords(dir, "ocr.ndjson", shots, [
        chat,
        phone,
        stale,
      ]),
    ).toThrow(/unexpected OCR record plugin-social-alpha-gui/);
    expect(() =>
      validateImportedOcrRecords(dir, "ocr.ndjson", shots, [
        {
          ...chat,
          path: join(
            tmpdir(),
            "elsewhere",
            "desktop-landscape",
            "builtin-chat.png",
          ),
        },
        phone,
      ]),
    ).toThrow(/builtin-chat::desktop-landscape points to/);
  });

  it("exits non-zero when imported OCR contains a stale record", async () => {
    for (const r of CURRENT_ROWS) shot(dir, r.viewport, r.slug);
    writeFileSync(join(dir, "report.json"), JSON.stringify(CURRENT_ROWS));
    writeFileSync(
      join(dir, "ocr.ndjson"),
      [
        ocrLine("desktop-landscape", "builtin-chat", "Chat messages composer"),
        ocrLine("desktop-landscape", "builtin-phone", "Phone dialer keypad"),
        ocrLine("desktop-landscape", STALE_SLUG, "Social Alpha leaderboard"),
      ].join("\n"),
    );

    await expect(
      runOcrTriage([
        "--audit-dir",
        dir,
        "--ocr",
        join(dir, "ocr.ndjson"),
        "--out",
        join(dir, "ocr-triage.json"),
      ]),
    ).rejects.toThrow(/unexpected OCR record plugin-social-alpha-gui/);
    const { status, stderr } = run();
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/unexpected OCR record plugin-social-alpha-gui/);
  });

  it("exits non-zero when a report row's screenshot is missing", async () => {
    shot(dir, "desktop-landscape", "builtin-chat");
    // builtin-phone.png absent → incomplete capture.
    writeFileSync(join(dir, "report.json"), JSON.stringify(CURRENT_ROWS));
    writeFileSync(
      join(dir, "ocr.ndjson"),
      ocrLine("desktop-landscape", "builtin-chat", "Chat messages"),
    );
    await expect(
      runOcrTriage([
        "--audit-dir",
        dir,
        "--ocr",
        join(dir, "ocr.ndjson"),
        "--out",
        join(dir, "ocr-triage.json"),
      ]),
    ).rejects.toThrow(/builtin-phone::desktop-landscape has no screenshot/);
    const { status, stderr } = run();
    expect(status).not.toBe(0);
    expect(stderr).toMatch(
      /builtin-phone::desktop-landscape has no screenshot/,
    );
  });
});

describe("audit runner cleanup", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "audit-runner-cleanup-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("rejects filesystem, repository, and app roots", () => {
    const repoRoot = join(APP_DIR, "..", "..");
    const resolveConfigured = (configured: string) =>
      resolveAuditAppOutput({ appDir: APP_DIR, repoRoot, configured });

    expect(() => resolveConfigured(APP_DIR)).toThrow(/unsafe audit output/);
    expect(() => resolveConfigured(repoRoot)).toThrow(/unsafe audit output/);
    expect(() => resolveConfigured("/")).toThrow(/unsafe audit output/);
    expect(resolveConfigured(dir)).toBe(dir);
  });

  it("resets stale artifacts once before Playwright owns the run", () => {
    const stale = join(dir, "mobile-portrait", "plugin-social-alpha-gui.png");
    mkdirSync(join(dir, "mobile-portrait"));
    writeFileSync(stale, PNG_1x1);

    const output = execFileSync(
      "node",
      [
        join(APP_DIR, "scripts", "run-ui-playwright.mjs"),
        "--config",
        "playwright.ui-smoke.config.ts",
        "--project=audit-app",
        "--list",
      ],
      {
        cwd: APP_DIR,
        encoding: "utf8",
        env: {
          ...process.env,
          ELIZA_AUDIT_APP_DIR: dir,
          ELIZA_UI_SMOKE_SKIP_BUILD: "1",
          ELIZA_UI_SMOKE_SKIP_CORE_BUILD: "1",
          ELIZA_UI_SMOKE_SKIP_VIEW_BUILD: "1",
        },
      },
    );

    expect(output).toContain("Reset app aesthetic audit output");
    expect(output).toContain("Listing tests:");
    expect(existsSync(stale)).toBe(false);
  }, 30_000);
});
