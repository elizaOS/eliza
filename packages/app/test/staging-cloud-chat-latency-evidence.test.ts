/**
 * Deterministically verifies the staging chat-latency artifact's closed,
 * privacy-safe schema and its on-disk round trip without a live Cloud call.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStagingCloudChatLatencyEvidence,
  parseStagingCloudChatLatencyEvidence,
  readStagingCloudChatLatencyEvidence,
  writeStagingCloudChatLatencyEvidence,
} from "./staging-cloud-chat-latency-evidence";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("staging Cloud chat latency evidence", () => {
  it("contains only fixed labels and the measured duration", () => {
    const evidence = createStagingCloudChatLatencyEvidence(12_345);
    expect(evidence).toEqual({
      schemaVersion: 1,
      lane: "app-live-e2e-cloud-staging",
      metric: "first-turn-latency",
      definition:
        "composer-send-click-to-settled-valid-assistant-turn: starts immediately before the UI send click; ends after the same fresh non-empty assistant row settles and passes the liveness contract; not first-token latency",
      firstTurnLatencyMs: 12_345,
    });
    expect(Object.keys(evidence).sort()).toEqual([
      "definition",
      "firstTurnLatencyMs",
      "lane",
      "metric",
      "schemaVersion",
    ]);
  });

  it("rejects missing, extra, mislabeled, and invalid duration values", () => {
    const valid = createStagingCloudChatLatencyEvidence(1);
    expect(() =>
      parseStagingCloudChatLatencyEvidence({ ...valid, prompt: "secret" }),
    ).toThrow("exact closed schema");
    expect(() =>
      parseStagingCloudChatLatencyEvidence({ ...valid, metric: "first-token" }),
    ).toThrow("labels do not match");
    for (const latency of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => createStagingCloudChatLatencyEvidence(latency)).toThrow(
        "positive safe integer",
      );
    }
  });

  it("writes and reads the exact privacy-safe JSON artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "staging-chat-latency-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, "nested", "latency.json");

    expect(await writeStagingCloudChatLatencyEvidence(outputPath, 8_765)).toBe(
      outputPath,
    );
    expect(await readStagingCloudChatLatencyEvidence(outputPath)).toEqual(
      createStagingCloudChatLatencyEvidence(8_765),
    );

    const raw = await readFile(outputPath, "utf8");
    expect(raw).toBe(
      `${JSON.stringify(createStagingCloudChatLatencyEvidence(8_765), null, 2)}\n`,
    );
    expect(raw).not.toMatch(
      /authorization|bearer|api.?key|credential|prompt|response|reply/i,
    );
    await expect(
      writeStagingCloudChatLatencyEvidence(outputPath, 9_999),
    ).rejects.toThrow();
  });
});
