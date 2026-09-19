/** Unit tests for the dev-smoke local lane's live-provider skip/fail decision. */
import { describe, expect, it } from "vitest";
import { resolveLiveProviderLaneVerdict } from "./required-live-provider";

describe("resolveLiveProviderLaneVerdict", () => {
  it("runs whenever a provider is configured", () => {
    for (const offlineLane of [true, false]) {
      for (const required of [true, false]) {
        expect(
          resolveLiveProviderLaneVerdict({
            providerConfigured: true,
            offlineLane,
            required,
          }),
        ).toEqual({ action: "run" });
      }
    }
  });

  it("fails the required hosted local lane when no provider is configured", () => {
    const verdict = resolveLiveProviderLaneVerdict({
      providerConfigured: false,
      offlineLane: true,
      required: true,
    });
    expect(verdict.action).toBe("fail");
    if (verdict.action === "fail") {
      expect(verdict.reason).toMatch(/Required dev-smoke local lane/);
    }
  });

  it("keeps the optional skip for keyless local developer use", () => {
    expect(
      resolveLiveProviderLaneVerdict({
        providerConfigured: false,
        offlineLane: true,
        required: false,
      }).action,
    ).toBe("skip");
  });

  it("keeps the optional skip for non-local lanes", () => {
    expect(
      resolveLiveProviderLaneVerdict({
        providerConfigured: false,
        offlineLane: false,
        required: true,
      }).action,
    ).toBe("skip");
  });
});
