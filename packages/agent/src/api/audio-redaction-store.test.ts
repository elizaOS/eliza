/**
 * Covers the content-addressed audio-redaction memo store
 * (api/audio-redaction-store.ts) against a real temp-dir media store. No
 * module mocks: job-key derivation, memo lookup/overflow, prepare, and
 * persist-after-verify are driven through the exported API and the real
 * filesystem.
 */
import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import type { RedactionVerifyResult } from "@elizaos/shared/audio-redaction-verify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let stateDir: string;

beforeAll(() => {
  stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "audio-redaction-store-test-"),
  );
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterAll(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

// Imported after env is set so resolveStateDir resolves to the temp dir.
const {
  audioRedactionKey,
  findRedactedAudioVariant,
  prepareRedactedAudioVariant,
  persistVerifiedRedactedAudioVariant,
} = await import("./audio-redaction-store.ts");
const { persistMediaBytes, readStoredMediaBytes } = await import(
  "./media-store.ts"
);

const SAMPLE_RATE = 16_000;
const SHA = "a".repeat(64);
const SPAN = { startMs: 500, endMs: 1000 };
const RULESET = "2026-07-01";
const FINDING = {
  verifierId: "test-verifier",
  transcript: "sentinel",
  piiFound: [] as string[],
  sentinelsMissing: [] as string[],
  ok: true,
};
const VERIFIED: RedactionVerifyResult = {
  ok: true,
  findings: [FINDING],
};

function makeWav(
  durationMs: number,
  channels = 1,
  freqHz = 440,
  amplitude = 0.5,
): Buffer {
  const frames = Math.round((durationMs / 1000) * SAMPLE_RATE);
  const dataBytes = frames * channels * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    const value = Math.round(
      amplitude *
        32767 *
        Math.sin((2 * Math.PI * freqHz * frame) / SAMPLE_RATE),
    );
    for (let channel = 0; channel < channels; channel += 1) {
      buffer.writeInt16LE(value, 44 + (frame * channels + channel) * 2);
    }
  }
  return buffer;
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function memoPath(): string {
  return path.join(stateDir, "media", "audio-redactions.json");
}

function validParts(
  overrides: Partial<{
    originalSha: string;
    spans: readonly {
      startMs: number;
      endMs: number;
      labels?: readonly string[];
    }[];
    mode: "mute" | "bleep";
    rulesetVersion: string;
  }> = {},
) {
  return {
    originalSha: SHA,
    spans: [SPAN],
    mode: "mute" as const,
    rulesetVersion: RULESET,
    ...overrides,
  };
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ElizaError);
  expect((error as ElizaError).code).toBe(code);
}

function persistSyntheticVariant(
  originalSha: string,
  bytes: Buffer,
  rulesetVersion = RULESET,
) {
  const key = audioRedactionKey(validParts({ originalSha, rulesetVersion }));
  return persistVerifiedRedactedAudioVariant(
    {
      key,
      originalSha,
      bytes,
      mimeType: "audio/wav",
      lane: "pure-ts-wav",
      inputDurationMs: 1000,
    },
    VERIFIED,
  );
}

describe("audioRedactionKey", () => {
  it("formats the job key from sha, ruleset, mode, and a 16-hex span hash", () => {
    const key = audioRedactionKey(validParts());
    const spanHash = crypto
      .createHash("sha256")
      .update(JSON.stringify([[SPAN.startMs, SPAN.endMs]]))
      .digest("hex")
      .slice(0, 16);
    expect(key).toBe(`pii-audio:${SHA}:v${RULESET}:mute:${spanHash}`);
    expect(spanHash).toMatch(/^[a-f0-9]{16}$/);
  });

  it("ignores span labels so audit tags cannot split the content address", () => {
    const unlabeled = audioRedactionKey(validParts());
    const labeled = audioRedactionKey(
      validParts({
        spans: [{ ...SPAN, labels: ["phone", "cluster-7"] }],
      }),
    );
    expect(labeled).toBe(unlabeled);
  });

  it("changes the key when mode, ruleset, original sha, or windows change", () => {
    const base = audioRedactionKey(validParts());
    expect(audioRedactionKey(validParts({ mode: "bleep" }))).not.toBe(base);
    expect(
      audioRedactionKey(validParts({ rulesetVersion: "2026-08-01" })),
    ).not.toBe(base);
    expect(
      audioRedactionKey(validParts({ originalSha: "b".repeat(64) })),
    ).not.toBe(base);
    expect(
      audioRedactionKey(validParts({ spans: [{ startMs: 500, endMs: 1001 }] })),
    ).not.toBe(base);
  });

  it("accepts a single span and adjacent (touching, non-overlapping) windows", () => {
    expect(
      audioRedactionKey(
        validParts({
          spans: [
            { startMs: 0, endMs: 100 },
            { startMs: 100, endMs: 250 },
          ],
        }),
      ),
    ).toMatch(/^pii-audio:/);
  });

  it("rejects an empty span list", () => {
    try {
      audioRedactionKey(validParts({ spans: [] }));
      throw new Error("expected throw");
    } catch (error) {
      expectCode(error, "AUDIO_REDACTION_INPUT_INVALID");
      expect((error as ElizaError).message).toMatch(/at least one span/);
    }
  });

  it("rejects overlapping or unsorted windows", () => {
    try {
      audioRedactionKey(
        validParts({
          spans: [
            { startMs: 0, endMs: 100 },
            { startMs: 99, endMs: 200 },
          ],
        }),
      );
      throw new Error("expected throw");
    } catch (error) {
      expectCode(error, "AUDIO_REDACTION_INPUT_INVALID");
      expect((error as ElizaError).message).toMatch(
        /sorted, non-overlapping, and positive/,
      );
    }

    try {
      audioRedactionKey(
        validParts({
          spans: [
            { startMs: 200, endMs: 300 },
            { startMs: 0, endMs: 100 },
          ],
        }),
      );
      throw new Error("expected throw");
    } catch (error) {
      expectCode(error, "AUDIO_REDACTION_INPUT_INVALID");
    }
  });

  it("rejects non-positive, inverted, or non-finite span edges", () => {
    const bad = [
      [{ startMs: -1, endMs: 10 }],
      [{ startMs: 10, endMs: 10 }],
      [{ startMs: 20, endMs: 10 }],
      [{ startMs: Number.NaN, endMs: 10 }],
      [{ startMs: 0, endMs: Number.POSITIVE_INFINITY }],
    ];
    for (const spans of bad) {
      try {
        audioRedactionKey(validParts({ spans }));
        throw new Error(`expected throw for ${JSON.stringify(spans)}`);
      } catch (error) {
        expectCode(error, "AUDIO_REDACTION_INPUT_INVALID");
      }
    }
  });

  it("rejects an original sha that is not lowercase 64-hex", () => {
    for (const originalSha of [
      "A".repeat(64),
      "a".repeat(63),
      "a".repeat(65),
      "g".repeat(64),
      "",
    ]) {
      try {
        audioRedactionKey(validParts({ originalSha }));
        throw new Error(`expected throw for sha ${originalSha}`);
      } catch (error) {
        expectCode(error, "AUDIO_REDACTION_INPUT_INVALID");
        expect((error as ElizaError).message).toMatch(
          /original sha is invalid/,
        );
      }
    }
  });

  it("rejects a ruleset version outside the 1–64 token charset", () => {
    const tooLong = "v".repeat(65);
    for (const rulesetVersion of ["", "has space", "slash/nope", tooLong]) {
      try {
        audioRedactionKey(validParts({ rulesetVersion }));
        throw new Error(`expected throw for ruleset ${rulesetVersion}`);
      } catch (error) {
        expectCode(error, "AUDIO_REDACTION_INPUT_INVALID");
        expect((error as ElizaError).message).toMatch(
          /ruleset version is invalid/,
        );
      }
    }
    expect(
      audioRedactionKey(
        validParts({ rulesetVersion: "V1._-ok-".padEnd(64, "x") }),
      ),
    ).toContain(":vV1._-ok-");
  });

  it("rejects a mode that is not mute or bleep", () => {
    try {
      audioRedactionKey(validParts({ mode: "scramble" as unknown as "mute" }));
      throw new Error("expected throw");
    } catch (error) {
      expectCode(error, "AUDIO_REDACTION_INPUT_INVALID");
      expect((error as ElizaError).message).toMatch(/mode is invalid/);
    }
  });
});

describe("findRedactedAudioVariant", () => {
  it("returns null when the memo is absent (empty queue)", () => {
    fs.rmSync(memoPath(), { force: true });
    expect(findRedactedAudioVariant(validParts())).toBeNull();
  });

  it("returns null for a missing key while leaving a present neighbor intact", () => {
    const presentSha = sha256(Buffer.from("present-original"));
    const missingSha = sha256(Buffer.from("missing-original"));
    const stored = persistSyntheticVariant(
      presentSha,
      Buffer.from("present-variant-bytes"),
    );
    expect(
      findRedactedAudioVariant(validParts({ originalSha: presentSha })),
    ).toMatchObject({
      reused: true,
      hash: stored.hash,
      fileName: stored.fileName,
      url: `/api/media/${stored.fileName}`,
      key: stored.key,
    });
    expect(
      findRedactedAudioVariant(validParts({ originalSha: missingSha })),
    ).toBeNull();
  });

  it("treats corrupted, non-array, or empty-array memo files as no memo", () => {
    fs.mkdirSync(path.dirname(memoPath()), { recursive: true });
    fs.writeFileSync(memoPath(), "{not-json");
    expect(findRedactedAudioVariant(validParts())).toBeNull();
    fs.writeFileSync(memoPath(), JSON.stringify({ not: "an-array" }));
    expect(findRedactedAudioVariant(validParts())).toBeNull();
    fs.writeFileSync(memoPath(), JSON.stringify([]));
    expect(findRedactedAudioVariant(validParts())).toBeNull();
  });

  it("skips memo entries that are malformed or fail the stored-name pattern", () => {
    const originalSha = sha256(Buffer.from("filter-original"));
    const variant = persistMediaBytes(
      Buffer.from("filter-variant-bytes"),
      "audio/wav",
    );
    const key = audioRedactionKey(validParts({ originalSha }));
    fs.writeFileSync(
      memoPath(),
      JSON.stringify([
        null,
        "skip-me",
        { key, fileName: 12 },
        { key, fileName: "not-a-content-address.wav" },
        { key: 1, fileName: variant.fileName },
        { key, fileName: variant.fileName },
      ]),
    );
    expect(findRedactedAudioVariant(validParts({ originalSha }))).toMatchObject(
      {
        reused: true,
        fileName: variant.fileName,
        hash: variant.hash,
      },
    );
  });

  it("returns null when the memo points at the original object itself", () => {
    const stored = persistMediaBytes(makeWav(400), "audio/wav");
    const parts = validParts({ originalSha: stored.hash });
    fs.writeFileSync(
      memoPath(),
      JSON.stringify([
        { key: audioRedactionKey(parts), fileName: stored.fileName },
      ]),
    );
    expect(findRedactedAudioVariant(parts)).toBeNull();
  });

  it("returns null when the memo's variant file was GC'd", () => {
    const originalSha = sha256(Buffer.from("gc-original"));
    const stored = persistSyntheticVariant(
      originalSha,
      Buffer.from("gc-variant-bytes"),
    );
    fs.rmSync(path.join(stateDir, "media", stored.fileName));
    expect(findRedactedAudioVariant(validParts({ originalSha }))).toBeNull();
  });

  it("replaces a same-key memo entry instead of accumulating duplicates", () => {
    const originalSha = sha256(Buffer.from("replace-original"));
    const first = persistSyntheticVariant(
      originalSha,
      Buffer.from("replace-variant-v1"),
    );
    const second = persistSyntheticVariant(
      originalSha,
      Buffer.from("replace-variant-v2"),
    );
    expect(second.hash).not.toBe(first.hash);
    const hit = findRedactedAudioVariant(validParts({ originalSha }));
    expect(hit?.fileName).toBe(second.fileName);
    const parsed: unknown = JSON.parse(fs.readFileSync(memoPath(), "utf8"));
    expect(Array.isArray(parsed)).toBe(true);
    expect(
      (parsed as { key: string }[]).filter((entry) => entry.key === second.key),
    ).toHaveLength(1);
  });

  it("ages out the oldest memo entries once the 256-entry cap overflows", () => {
    fs.rmSync(memoPath(), { force: true });
    const firstSha = sha256(Buffer.from("cap-original-0"));
    persistSyntheticVariant(firstSha, Buffer.from("cap-variant-0"));
    expect(
      findRedactedAudioVariant(validParts({ originalSha: firstSha })),
    ).not.toBeNull();

    for (let index = 1; index < 256; index += 1) {
      const originalSha = sha256(Buffer.from(`cap-original-${index}`));
      persistSyntheticVariant(originalSha, Buffer.from(`cap-variant-${index}`));
    }
    const overflowSha = sha256(Buffer.from("cap-original-256"));
    const overflow = persistSyntheticVariant(
      overflowSha,
      Buffer.from("cap-variant-256"),
    );

    const parsed: unknown = JSON.parse(fs.readFileSync(memoPath(), "utf8"));
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as unknown[]).length).toBeLessThanOrEqual(256);
    expect(
      findRedactedAudioVariant(validParts({ originalSha: firstSha })),
    ).toBeNull();
    expect(
      findRedactedAudioVariant(validParts({ originalSha: overflowSha })),
    ).toMatchObject({ reused: true, fileName: overflow.fileName });
  });
});

describe("prepareRedactedAudioVariant", () => {
  it("rejects an original filename that is not a content-addressed store name", async () => {
    try {
      await prepareRedactedAudioVariant({
        originalFileName: "../outside.wav",
        spans: [SPAN],
        mode: "mute",
        rulesetVersion: RULESET,
      });
      throw new Error("expected throw");
    } catch (error) {
      expectCode(error, "MEDIA_STORE_FILENAME_INVALID");
    }
  });

  it("rejects when the original is not in the store", async () => {
    try {
      await prepareRedactedAudioVariant({
        originalFileName: `${"0".repeat(64)}.wav`,
        spans: [SPAN],
        mode: "mute",
        rulesetVersion: RULESET,
      });
      throw new Error("expected throw");
    } catch (error) {
      expectCode(error, "AUDIO_REDACTION_ORIGINAL_MISSING");
    }
  });

  it("prepares a distinct WAV variant on the pure-TS lane without publishing it", async () => {
    const original = makeWav(2000);
    const stored = persistMediaBytes(original, "audio/wav");
    const prepared = await prepareRedactedAudioVariant({
      originalFileName: stored.fileName,
      spans: [SPAN],
      mode: "mute",
      rulesetVersion: RULESET,
    });
    expect(prepared.lane).toBe("pure-ts-wav");
    expect(prepared.originalSha).toBe(stored.hash);
    expect(prepared.mimeType).toBe("audio/wav");
    expect(prepared.inputDurationMs).toBeGreaterThan(0);
    expect(prepared.key).toBe(
      audioRedactionKey(validParts({ originalSha: stored.hash })),
    );
    expect(sha256(prepared.bytes)).not.toBe(stored.hash);
    expect(readStoredMediaBytes(`${sha256(prepared.bytes)}.wav`)).toBeNull();
  });

  it("fails closed when mute of digital silence would publish the original bytes", async () => {
    const stored = persistMediaBytes(makeWav(800, 1, 440, 0), "audio/wav");
    try {
      await prepareRedactedAudioVariant({
        originalFileName: stored.fileName,
        spans: [{ startMs: 100, endMs: 200 }],
        mode: "mute",
        rulesetVersion: RULESET,
      });
      throw new Error("expected throw");
    } catch (error) {
      expectCode(error, "AUDIO_REDACTION_UNCHANGED");
    }
  });
});

describe("persistVerifiedRedactedAudioVariant", () => {
  function preparedFrom(bytes: Buffer, originalSha: string) {
    return {
      key: audioRedactionKey(validParts({ originalSha })),
      originalSha,
      bytes,
      mimeType: "audio/wav" as const,
      lane: "pure-ts-wav" as const,
      inputDurationMs: 1500,
    };
  }

  it("refuses verification that is not ok, has no findings, or leaks PII", () => {
    const originalSha = sha256(Buffer.from("verify-original"));
    const prepared = preparedFrom(Buffer.from("verify-variant"), originalSha);
    const failures: RedactionVerifyResult[] = [
      { ok: false, findings: [FINDING] },
      { ok: true, findings: [] },
      {
        ok: true,
        findings: [{ ...FINDING, ok: false }],
      },
      {
        ok: true,
        findings: [{ ...FINDING, verifierId: "   " }],
      },
      {
        ok: true,
        findings: [{ ...FINDING, transcript: "\t" }],
      },
      {
        ok: true,
        findings: [{ ...FINDING, piiFound: ["555-0100"] }],
      },
      {
        ok: true,
        findings: [{ ...FINDING, sentinelsMissing: ["SENTINEL"] }],
      },
      {
        ok: true,
        findings: [FINDING, { ...FINDING, piiFound: ["leak"] }],
      },
    ];
    for (const verification of failures) {
      try {
        persistVerifiedRedactedAudioVariant(prepared, verification);
        throw new Error(`expected throw for ${JSON.stringify(verification)}`);
      } catch (error) {
        expectCode(error, "AUDIO_REDACTION_VERIFY_FAILED");
      }
    }
  });

  it("persists a verified variant as a second object and records the memo", () => {
    const originalSha = sha256(Buffer.from("persist-original"));
    const bytes = Buffer.from("persist-variant-bytes");
    const variant = persistVerifiedRedactedAudioVariant(
      preparedFrom(bytes, originalSha),
      VERIFIED,
    );
    expect(variant.reused).toBe(false);
    expect(variant.hash).toBe(sha256(bytes));
    expect(variant.hash).not.toBe(originalSha);
    expect(variant.fileName).toBe(`${variant.hash}.wav`);
    expect(variant.url).toBe(`/api/media/${variant.fileName}`);
    expect(readStoredMediaBytes(variant.fileName)?.equals(bytes)).toBe(true);
    expect(findRedactedAudioVariant(validParts({ originalSha }))).toMatchObject(
      { reused: true, fileName: variant.fileName },
    );
  });

  it("refuses to publish a verified variant that hashes to the original sha", () => {
    const bytes = Buffer.from("unchanged-variant-bytes");
    const originalSha = sha256(bytes);
    try {
      persistVerifiedRedactedAudioVariant(
        preparedFrom(bytes, originalSha),
        VERIFIED,
      );
      throw new Error("expected throw");
    } catch (error) {
      expectCode(error, "AUDIO_REDACTION_UNCHANGED");
    }
  });

  it("still returns the persisted handle when the memo write is best-effort and fails", () => {
    fs.mkdirSync(path.dirname(memoPath()), { recursive: true });
    fs.rmSync(memoPath(), { recursive: true, force: true });
    fs.mkdirSync(memoPath());
    const originalSha = sha256(Buffer.from("best-effort-original"));
    const bytes = Buffer.from("best-effort-variant");
    const variant = persistVerifiedRedactedAudioVariant(
      preparedFrom(bytes, originalSha),
      VERIFIED,
    );
    expect(variant.reused).toBe(false);
    expect(readStoredMediaBytes(variant.fileName)?.equals(bytes)).toBe(true);
    expect(findRedactedAudioVariant(validParts({ originalSha }))).toBeNull();
    fs.rmSync(memoPath(), { recursive: true, force: true });
  });
});
