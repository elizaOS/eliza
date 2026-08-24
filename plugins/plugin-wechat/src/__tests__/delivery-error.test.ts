import { describe, expect, it } from "vitest";
import {
  hasCommittedWechatSideEffect,
  WechatDeliveryError,
} from "./delivery-error.ts";

describe("WechatDeliveryError", () => {
  it("carries the side-effect-committed flag", () => {
    const err = new WechatDeliveryError("delivery failed", {
      cause: new Error("upstream"),
      sideEffectCommitted: true,
    });
    expect(err.name).toBe("WechatDeliveryError");
    expect(err.sideEffectCommitted).toBe(true);
    expect(err.cause).toBeInstanceOf(Error);
  });
});

describe("hasCommittedWechatSideEffect", () => {
  it("detects committed side effects", () => {
    const err = new WechatDeliveryError("failed", {
      cause: null,
      sideEffectCommitted: true,
    });
    expect(hasCommittedWechatSideEffect(err)).toBe(true);
  });

  it("returns false for uncommitted or unrelated errors", () => {
    const err = new WechatDeliveryError("failed", {
      cause: null,
      sideEffectCommitted: false,
    });
    expect(hasCommittedWechatSideEffect(err)).toBe(false);
    expect(hasCommittedWechatSideEffect(new Error("plain"))).toBe(false);
    expect(hasCommittedWechatSideEffect(null)).toBe(false);
  });
});
