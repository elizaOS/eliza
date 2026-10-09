/**
 * Rollup tests against real finalized bundles on a tmp filesystem: lane
 * pass/fail/skip semantics (honest-skip: skips fail unless the requirements
 * mark the lane optional-with-reason), unparseable reporter output, analysis
 * expectation failures, and required-artifact checks.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBundle } from "../bundle.ts";
import { EvidenceValidationError } from "../errors.ts";
import {
  parseRequirements,
  parseVerdictsDocument,
  rollupBundle,
} from "./rollup.ts";
import type { CertificationVerdict } from "./schema.ts";

const COMMIT = "abcdef0123456789abcdef0123456789abcdef01";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-rollup-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Build a real finalized bundle from `files`: bundlePath → { content, kind }. */
async function fixtureBundle(
  files: Record<
    string,
    { content: string; kind: "report" | "analysis" | "screenshot" }
  >,
): Promise<string> {
  const sourceDir = tmpDir();
  const bundle = createBundle({
    rootDir: tmpDir(),
    provenance: {
      commit: COMMIT,
      branch: "feat/rollup-test",
      runner: "local",
      tier: "cpu",
      envFingerprint: { tier: "cpu" },
    },
    now: () => new Date("2026-07-05T12:00:00.000Z"),
  });
  let index = 0;
  for (const [bundlePath, spec] of Object.entries(files)) {
    const sourcePath = path.join(sourceDir, `file-${index}`);
    index += 1;
    fs.writeFileSync(sourcePath, spec.content);
    await bundle.addArtifact(sourcePath, {
      kind: spec.kind,
      source: "rollup-test",
      producedBy: "rollup.test.ts",
      bundlePath,
    });
  }
  await bundle.finalize();
  return bundle.dir;
}

function subject(
  verdicts: CertificationVerdict[],
  name: string,
): CertificationVerdict {
  const found = verdicts.find((verdict) => verdict.subject === name);
  expect(found, `expected verdict subject ${name}`).toBeDefined();
  return found as CertificationVerdict;
}

describe("rollupBundle", () => {
  it("drafts pass/fail/skip lane verdicts with honest-skip semantics", async () => {
    const dir = await fixtureBundle({
      "lanes/server/result.json": {
        content: JSON.stringify({ passed: 12, failed: 0, skipped: 0 }),
        kind: "report",
      },
      "lanes/client/result.json": {
        content: JSON.stringify({ passed: 9, failed: 2, skipped: 0 }),
        kind: "report",
      },
      "lanes/e2e/result.json": {
        content: JSON.stringify({ passed: 4, failed: 0, skipped: 5 }),
        kind: "report",
      },
    });
    const result = rollupBundle(dir);
    expect(subject(result.verdicts, "lane:server").verdict).toBe("pass");
    expect(subject(result.verdicts, "lane:client").verdict).toBe("fail");
    // No requirements file: skipped tests fail the lane, honestly.
    const e2e = subject(result.verdicts, "lane:e2e");
    expect(e2e.verdict).toBe("fail");
    expect(e2e.notes).toContain("skipped=5");
    expect(result.summary.counts).toEqual({ pass: 1, fail: 2, waived: 0 });
  });

  it("waives skipped and absent lanes only when marked optional-with-reason", async () => {
    const dir = await fixtureBundle({
      "lanes/e2e/result.json": {
        content: JSON.stringify({ passed: 4, failed: 0, skipped: 5 }),
        kind: "report",
      },
    });
    const requirements = parseRequirements(
      {
        schema: 1,
        lanes: [
          { lane: "e2e", optional: true, reason: "no display on cpu tier" },
          {
            lane: "native",
            optional: true,
            reason: "no simulator on this runner",
          },
          { lane: "scenario" },
        ],
      },
      "test",
    );
    const result = rollupBundle(dir, { requirements });
    const e2e = subject(result.verdicts, "lane:e2e");
    expect(e2e.verdict).toBe("waived");
    expect(e2e.notes).toContain("no display on cpu tier");
    const native = subject(result.verdicts, "lane:native");
    expect(native.verdict).toBe("waived");
    expect(native.notes).toContain("no simulator");
    // Required lane with no result.json in the bundle is a hard fail.
    const scenario = subject(result.verdicts, "lane:scenario");
    expect(scenario.verdict).toBe("fail");
    expect(scenario.notes).toContain("no result.json");
  });

  it("fails a lane whose result.json is unparseable — broken reporter is not green", async () => {
    const dir = await fixtureBundle({
      "lanes/server/result.json": { content: "not json{", kind: "report" },
      "lanes/client/result.json": {
        content: JSON.stringify({ ok: true }),
        kind: "report",
      },
    });
    const result = rollupBundle(dir);
    expect(subject(result.verdicts, "lane:server").verdict).toBe("fail");
    const client = subject(result.verdicts, "lane:client");
    expect(client.verdict).toBe("fail");
    expect(client.notes).toContain("passed|failed|skipped");
  });

  it("turns analysis expectation failures into failing subjects", async () => {
    const dir = await fixtureBundle({
      "visual/audit/home/analysis.json": {
        content: JSON.stringify({
          verdict: "pass",
          checks: [{ name: "require_text:Chat", ok: true }],
        }),
        kind: "analysis",
      },
      "visual/audit/settings/analysis.json": {
        content: JSON.stringify({
          verdict: "fail",
          checks: [
            { name: "brand:no_blue", ok: false, detail: "blue_fraction=0.4" },
            { name: "require_text:Save", ok: true },
          ],
        }),
        kind: "analysis",
      },
      "misc/rollup-test/broken-analysis.json": {
        content: "][",
        kind: "analysis",
      },
    });
    const result = rollupBundle(dir);
    expect(result.summary.analysesScanned).toBe(3);
    // Green analyses produce no subject; failing and broken ones do.
    expect(
      result.verdicts.find(
        (verdict) =>
          verdict.subject === "analysis:visual/audit/home/analysis.json",
      ),
    ).toBeUndefined();
    const failing = subject(
      result.verdicts,
      "analysis:visual/audit/settings/analysis.json",
    );
    expect(failing.verdict).toBe("fail");
    expect(failing.notes).toContain("verdict:fail");
    expect(failing.notes).toContain("brand:no_blue");
    expect(
      subject(result.verdicts, "analysis:misc/rollup-test/broken-analysis.json")
        .verdict,
    ).toBe("fail");
  });

  it("checks required artifacts by exact path and by prefix", async () => {
    const dir = await fixtureBundle({
      "visual/audit/home.png": { content: "png", kind: "screenshot" },
    });
    const requirements = parseRequirements(
      {
        schema: 1,
        artifacts: [
          { subject: "visual:home", path: "visual/audit/home.png" },
          { subject: "visual:any", pathPrefix: "visual/" },
          { subject: "video:walkthrough", pathPrefix: "video/" },
          { subject: "traj:live", path: "trajectories/live/run.jsonl" },
        ],
      },
      "test",
    );
    const result = rollupBundle(dir, { requirements });
    expect(subject(result.verdicts, "visual:home").verdict).toBe("pass");
    expect(subject(result.verdicts, "visual:any").verdict).toBe("pass");
    const video = subject(result.verdicts, "video:walkthrough");
    expect(video.verdict).toBe("fail");
    expect(video.evidence).toEqual([]);
    expect(subject(result.verdicts, "traj:live").verdict).toBe("fail");
    expect(result.summary.missingArtifacts).toHaveLength(2);
  });

  it("emits verdicts sorted by subject, signable as-is", async () => {
    const dir = await fixtureBundle({
      "lanes/z/result.json": {
        content: JSON.stringify({ passed: 1, failed: 0, skipped: 0 }),
        kind: "report",
      },
      "lanes/a/result.json": {
        content: JSON.stringify({ passed: 1, failed: 0, skipped: 0 }),
        kind: "report",
      },
    });
    const result = rollupBundle(dir);
    const subjects = result.verdicts.map((verdict) => verdict.subject);
    expect(subjects).toEqual([...subjects].sort());
    // The rollup document round-trips through the verdicts-file parser.
    const document = JSON.parse(JSON.stringify(result));
    expect(parseVerdictsDocument(document, "test").verdicts).toHaveLength(2);
  });
});

describe("parseRequirements", () => {
  it("requires a reason for optional lanes", () => {
    expect(() =>
      parseRequirements(
        { schema: 1, lanes: [{ lane: "e2e", optional: true }] },
        "test",
      ),
    ).toThrow(EvidenceValidationError);
  });

  it("requires exactly one of path or pathPrefix", () => {
    for (const artifact of [
      { subject: "x" },
      { subject: "x", path: "a", pathPrefix: "b" },
    ]) {
      expect(() =>
        parseRequirements({ schema: 1, artifacts: [artifact] }, "test"),
      ).toThrow(EvidenceValidationError);
    }
  });

  it("rejects reserved subject prefixes and duplicates", () => {
    expect(() =>
      parseRequirements(
        { schema: 1, artifacts: [{ subject: "lane:e2e", path: "a" }] },
        "test",
      ),
    ).toThrow(EvidenceValidationError);
    expect(() =>
      parseRequirements(
        {
          schema: 1,
          artifacts: [
            { subject: "x", path: "a" },
            { subject: "x", path: "b" },
          ],
        },
        "test",
      ),
    ).toThrow(EvidenceValidationError);
  });

  it("rejects unknown fields", () => {
    expect(() =>
      parseRequirements({ schema: 1, unexpected: [] }, "test"),
    ).toThrow(EvidenceValidationError);
  });
});
