import { describe, expect, it } from "vitest";

import { deriveHomeModelStatus } from "./home-model-status";
import type {
  LocalInferenceDownloadStatus,
  LocalInferenceReadiness,
  LocalInferenceSlotReadiness,
  TextGenerationSlot,
} from "./types";

const PRIMARY: TextGenerationSlot = "TEXT_LARGE";
const SECONDARY: TextGenerationSlot = "TEXT_SMALL";

function makeDownload(
  overrides: Partial<LocalInferenceDownloadStatus> = {},
): LocalInferenceDownloadStatus {
  return {
    state: "missing",
    receivedBytes: 0,
    totalBytes: 0,
    percent: null,
    bytesPerSec: 0,
    etaMs: null,
    updatedAt: null,
    errors: [],
    ...overrides,
  };
}

function makeSlot(
  overrides: Partial<LocalInferenceSlotReadiness> = {},
): LocalInferenceSlotReadiness {
  return {
    slot: PRIMARY,
    assigned: true,
    assignedModelId: "eliza-1",
    displayName: "Eliza 1",
    primaryDownloaded: false,
    downloaded: false,
    active: false,
    ready: false,
    state: "missing",
    requiredModelIds: ["eliza-1"],
    missingModelIds: ["eliza-1"],
    installedBytes: 0,
    expectedBytes: 0,
    download: makeDownload(),
    errors: [],
    ...overrides,
  };
}

function makeReadiness(
  slots: LocalInferenceSlotReadiness[],
): LocalInferenceReadiness {
  const record = {} as Record<TextGenerationSlot, LocalInferenceSlotReadiness>;
  for (const slot of slots) record[slot.slot] = slot;
  return { updatedAt: "2026-05-29T00:00:00.000Z", slots: record };
}

describe("deriveHomeModelStatus", () => {
  it("returns not-required and never blocks when no slot is assigned", () => {
    const status = deriveHomeModelStatus(
      makeReadiness([
        makeSlot({ assigned: false, state: "unassigned", displayName: null }),
      ]),
    );
    expect(status.kind).toBe("not-required");
    expect(status.blocksSend).toBe(false);
    expect(status.modelName).toBeNull();
  });

  it("returns ready and unblocks send when every assigned slot is ready", () => {
    const status = deriveHomeModelStatus(
      makeReadiness([
        makeSlot({
          ready: true,
          active: true,
          downloaded: true,
          state: "active",
        }),
      ]),
    );
    expect(status.kind).toBe("ready");
    expect(status.blocksSend).toBe(false);
    expect(status.modelName).toBe("Eliza 1");
  });

  it("returns downloading with max percent/eta and blocks send", () => {
    const status = deriveHomeModelStatus(
      makeReadiness([
        makeSlot({
          slot: PRIMARY,
          state: "downloading",
          download: makeDownload({
            state: "downloading",
            percent: 40,
            etaMs: 8000,
          }),
        }),
        makeSlot({
          slot: SECONDARY,
          state: "downloading",
          download: makeDownload({
            state: "downloading",
            percent: 72,
            etaMs: 3000,
          }),
        }),
      ]),
    );
    expect(status.kind).toBe("downloading");
    expect(status.blocksSend).toBe(true);
    expect(status.percent).toBe(72);
    expect(status.etaMs).toBe(8000);
  });

  it("returns missing and blocks send when an assigned model is absent", () => {
    const status = deriveHomeModelStatus(
      makeReadiness([makeSlot({ state: "missing" })]),
    );
    expect(status.kind).toBe("missing");
    expect(status.blocksSend).toBe(true);
  });

  it("returns loading when downloaded to disk but not yet active", () => {
    const status = deriveHomeModelStatus(
      makeReadiness([
        makeSlot({ state: "downloaded", downloaded: true, ready: false }),
      ]),
    );
    expect(status.kind).toBe("loading");
    expect(status.blocksSend).toBe(true);
    expect(status.percent).toBe(100);
  });

  it("returns error with deduped messages when a slot failed", () => {
    const status = deriveHomeModelStatus(
      makeReadiness([
        makeSlot({
          slot: PRIMARY,
          state: "failed",
          errors: ["disk full", "disk full"],
        }),
        makeSlot({
          slot: SECONDARY,
          state: "cancelled",
          errors: ["user cancelled"],
        }),
      ]),
    );
    expect(status.kind).toBe("error");
    expect(status.blocksSend).toBe(true);
    expect(status.errors).toEqual(["disk full", "user cancelled"]);
  });

  it("prioritizes error over downloading when slots are mixed", () => {
    const status = deriveHomeModelStatus(
      makeReadiness([
        makeSlot({
          slot: PRIMARY,
          state: "failed",
          errors: ["boom"],
        }),
        makeSlot({
          slot: SECONDARY,
          state: "downloading",
          download: makeDownload({ state: "downloading", percent: 50 }),
        }),
      ]),
    );
    expect(status.kind).toBe("error");
  });
});
