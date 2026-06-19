import { describe, expect, it } from "bun:test";
import { isProductionDeployment, shouldBlockRegistrarStub } from "./deployment-environment";

describe("isProductionDeployment", () => {
  it("uses ENVIRONMENT when it is set", () => {
    expect(isProductionDeployment({ ENVIRONMENT: "production" })).toBe(true);
    expect(isProductionDeployment({ ENVIRONMENT: "staging", NODE_ENV: "production" })).toBe(false);
  });

  it("falls back to NODE_ENV when ENVIRONMENT is unset", () => {
    expect(isProductionDeployment({ NODE_ENV: "production" })).toBe(true);
    expect(isProductionDeployment({ NODE_ENV: "test" })).toBe(false);
    expect(isProductionDeployment({})).toBe(false);
  });
});

describe("shouldBlockRegistrarStub", () => {
  it("blocks the stub when it is enabled in a production deployment", () => {
    expect(
      shouldBlockRegistrarStub({
        ELIZA_CF_REGISTRAR_DEV_STUB: "1",
        ENVIRONMENT: "production",
      }),
    ).toBe(true);
    expect(
      shouldBlockRegistrarStub({
        ELIZA_CF_REGISTRAR_DEV_STUB: "1",
        NODE_ENV: "production",
      }),
    ).toBe(true);
  });

  it("allows the stub outside production (dev / test / staging)", () => {
    expect(
      shouldBlockRegistrarStub({
        ELIZA_CF_REGISTRAR_DEV_STUB: "1",
        NODE_ENV: "test",
      }),
    ).toBe(false);
    expect(
      shouldBlockRegistrarStub({
        ELIZA_CF_REGISTRAR_DEV_STUB: "1",
        ENVIRONMENT: "staging",
      }),
    ).toBe(false);
    expect(shouldBlockRegistrarStub({ ELIZA_CF_REGISTRAR_DEV_STUB: "1" })).toBe(false);
  });

  it("does not block when the stub flag is off", () => {
    expect(shouldBlockRegistrarStub({ ENVIRONMENT: "production" })).toBe(false);
    expect(
      shouldBlockRegistrarStub({
        ELIZA_CF_REGISTRAR_DEV_STUB: "0",
        ENVIRONMENT: "production",
      }),
    ).toBe(false);
  });
});
