/**
 * qa.json writer tests: the record is placed beside its subject screenshot
 * (`.png` → `.qa.json`), added to the bundle with kind 'qa', and survives
 * verify. Also pins the canonical-serializability contract (#14552 review:
 * canonicalJson throws on Date/Map/class instances) — a QaRecord built from an
 * AskResult must be plain objects/ISO-strings throughout.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BundleProvenance } from "../bundle.ts";
import { createBundle, verifyBundle } from "../bundle.ts";
import { canonicalJson } from "../canonical.ts";
import { buildQaRecord, writeQaRecord } from "./qa-record.ts";
import type { AskResult, VisionQuestion } from "./types.ts";

const PROVENANCE: BundleProvenance = {
  commit: "abcdef0123456789abcdef0123456789abcdef01",
  branch: "feat/test",
  runner: "local",
  tier: "cpu",
  envFingerprint: {
    node: "v24.0.0",
    platform: "linux",
    arch: "x64",
    tier: "cpu",
  },
};

const QUESTIONS: VisionQuestion[] = [
  { id: "q1", question: "What does the button say?", expected: "Send" },
];

const RESULT: AskResult = {
  answers: [
    { id: "q1", answer: "Send", confidence: 0.98, details: "button label" },
  ],
  provenance: {
    backend: "anthropic",
    model: "claude-opus-4-8",
    usage: { inputTokens: 1200, outputTokens: 30 },
    latencyMs: 850,
    retries: 0,
    timestamp: "2026-01-01T00:00:00.000Z",
    cached: false,
    dimensions: {
      originalWidth: 2000,
      originalHeight: 1000,
      sentWidth: 1568,
      sentHeight: 784,
    },
  },
};

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-qa-record-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("buildQaRecord", () => {
  it("captures subject, backend, model, questions, answers, and usage", () => {
    const record = buildQaRecord("visual/audit/chat.png", QUESTIONS, RESULT);
    expect(record.schema).toBe(1);
    expect(record.subject).toBe("visual/audit/chat.png");
    expect(record.backend).toBe("anthropic");
    expect(record.model).toBe("claude-opus-4-8");
    expect(record.questions).toEqual(QUESTIONS);
    expect(record.answers).toEqual(RESULT.answers);
    expect(record.usage).toEqual({ inputTokens: 1200, outputTokens: 30 });
  });

  it("serializes canonically without throwing (plain objects + ISO strings)", () => {
    const record = buildQaRecord("visual/audit/chat.png", QUESTIONS, RESULT);
    expect(() => canonicalJson(record)).not.toThrow();
  });
});

describe("writeQaRecord", () => {
  it("places qa.json beside the subject and verifies clean", async () => {
    const root = tmpDir();
    const bundle = createBundle({ rootDir: root, provenance: PROVENANCE });
    // Add a subject screenshot first (any bytes; content-addressed).
    const shot = path.join(tmpDir(), "chat.png");
    fs.writeFileSync(shot, "fake-png-bytes");
    const subject = await bundle.addArtifact(shot, {
      kind: "screenshot",
      source: "audit",
      producedBy: "aesthetic-audit",
    });
    expect(subject.path).toBe("visual/audit/chat.png");

    const entry = await writeQaRecord(bundle, subject.path, QUESTIONS, RESULT);
    expect(entry.kind).toBe("qa");
    expect(entry.path).toBe("visual/audit/chat.qa.json");

    const finalized = await bundle.finalize();
    const written = JSON.parse(
      fs.readFileSync(path.join(bundle.dir, entry.path), "utf8"),
    );
    expect(written.subject).toBe("visual/audit/chat.png");
    expect(written.answers[0].answer).toBe("Send");

    const report = await verifyBundle(bundle.dir);
    expect(report.ok).toBe(true);
    expect(finalized.manifest.artifacts.map((a) => a.path)).toContain(
      "visual/audit/chat.qa.json",
    );
  });

  it("rejects an empty subject path", async () => {
    const bundle = createBundle({ rootDir: tmpDir(), provenance: PROVENANCE });
    await expect(
      writeQaRecord(bundle, "", QUESTIONS, RESULT),
    ).rejects.toMatchObject({ code: "VISION_QA_SUBJECT" });
  });
});
