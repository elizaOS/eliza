import { describe, expect, it } from "vitest";

import type { HomeModelStatus } from "../services/local-inference/home-model-status";
import {
  formatEta,
  MODEL_ACTION,
  MODEL_STATUS_TURN_ID,
  modelCancelledTurnText,
  modelStatusTurnText,
  modelSwitchedToCloudTurnText,
  typedWhileBlockedReply,
} from "./model-status-copy";

/**
 * Pure copy builders for the in-chat model-status turn. Assert the CHOICE
 * control values carry the reserved `__model__:` prefix, that progress copy
 * reflects the snapshot, and that no state is a dead end (cancel/error always
 * re-offer a way forward).
 */

function status(overrides: Partial<HomeModelStatus> = {}): HomeModelStatus {
  return {
    kind: "downloading",
    blocksSend: true,
    percent: 42,
    etaMs: 120_000,
    modelName: "eliza-1-2b",
    modelId: "eliza-1-2b",
    errors: [],
    ...overrides,
  };
}

describe("formatEta", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatEta(45_000)).toBe("~45s left");
    expect(formatEta(120_000)).toBe("~2m left");
    expect(formatEta(3_600_000)).toBe("~1h left");
  });

  it("returns null for unknown or non-positive ETAs", () => {
    expect(formatEta(null)).toBeNull();
    expect(formatEta(0)).toBeNull();
    expect(formatEta(-1)).toBeNull();
  });
});

describe("modelStatusTurnText", () => {
  it("renders downloading progress with a percent and ETA", () => {
    const text = modelStatusTurnText(status());
    expect(text).toContain("eliza-1-2b");
    expect(text).toContain("42%");
    expect(text).toContain("~2m left");
  });

  it("offers cancel / switch-cloud / keep-waiting while downloading", () => {
    const text = modelStatusTurnText(status());
    expect(text).toContain("[CHOICE:first-run id=model-status]");
    expect(text).toContain(`${MODEL_ACTION.cancel}=`);
    expect(text).toContain(`${MODEL_ACTION.switchCloud}=`);
    expect(text).toContain(`${MODEL_ACTION.keepWaiting}=`);
    expect(text).not.toContain(`${MODEL_ACTION.retry}=`);
  });

  it("swaps cancel for retry in the error state and surfaces the reason", () => {
    const text = modelStatusTurnText(
      status({ kind: "error", errors: ["disk full"], percent: null }),
    );
    expect(text).toContain("disk full");
    expect(text).toContain(`${MODEL_ACTION.retry}=`);
    expect(text).toContain(`${MODEL_ACTION.switchCloud}=`);
    expect(text).not.toContain(`${MODEL_ACTION.cancel}=`);
  });

  it("describes loading distinctly from downloading", () => {
    const text = modelStatusTurnText(
      status({ kind: "loading", percent: 100, etaMs: null }),
    );
    expect(text.toLowerCase()).toContain("loading");
  });
});

describe("modelCancelledTurnText", () => {
  it("re-offers download + switch-cloud so cancel is never a dead end", () => {
    const text = modelCancelledTurnText(status());
    expect(text).toContain(`${MODEL_ACTION.download}=`);
    expect(text).toContain(`${MODEL_ACTION.switchCloud}=`);
  });
});

describe("typedWhileBlockedReply", () => {
  it("acknowledges a typed message with live progress", () => {
    const text = typedWhileBlockedReply(status());
    expect(text).toContain("42%");
    expect(text.toLowerCase()).toContain("as soon as i'm loaded");
  });
});

describe("misc", () => {
  it("exposes a stable turn id and a cloud-switched confirmation", () => {
    expect(MODEL_STATUS_TURN_ID).toBe("model:download-status");
    expect(modelSwitchedToCloudTurnText().toLowerCase()).toContain(
      "eliza cloud",
    );
  });
});
