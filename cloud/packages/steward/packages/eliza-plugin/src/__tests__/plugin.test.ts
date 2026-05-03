import { describe, expect, it } from "vitest";
import { StewardService, stewardPlugin } from "../index.js";

describe("@stwd/eliza-plugin", () => {
  it("exports a valid plugin shape", () => {
    expect(stewardPlugin).toBeDefined();
    expect(stewardPlugin.name).toBe("@stwd/eliza-plugin");
    expect(stewardPlugin.actions).toBeDefined();
    expect(stewardPlugin.providers).toBeDefined();
    expect(stewardPlugin.evaluators).toBeDefined();
    expect(stewardPlugin.services).toBeDefined();
  });

  it("registers expected actions", () => {
    const names = stewardPlugin.actions?.map((a) => a.name);
    expect(names).toContain("STEWARD_SIGN_TRANSACTION");
    expect(names).toContain("STEWARD_TRANSFER");
  });

  it("registers expected providers", () => {
    const names = stewardPlugin.providers?.map((p) => p.name);
    expect(names).toContain("stewardWalletStatus");
    expect(names).toContain("stewardBalance");
  });

  it("registers expected evaluators", () => {
    const names = stewardPlugin.evaluators?.map((e) => e.name);
    expect(names).toContain("approvalRequired");
  });

  it("registers StewardService", () => {
    expect(stewardPlugin.services).toHaveLength(1);
    expect(stewardPlugin.services?.[0]).toBe(StewardService);
  });

  it("StewardService has correct serviceType", () => {
    expect(StewardService.serviceType).toBe("steward");
  });
});
