/**
 * Unit tests for the ELIZA_DISABLE_WEB_SHELL cloud-registration stub. The
 * suite imports the real stub module (not a mock) and records its no-op
 * contracts: the four public helpers exist as functions, the sync registers
 * return undefined, and the private-surface helpers each resolve a fresh
 * Promise to undefined without throwing.
 */
import { describe, expect, it } from "vitest";
import * as stub from "../cloud-register-all-stub.js";
import {
  ensurePrivateCloudSurfaces,
  registerAllCloudSurfaces,
  registerPrivateCloudSurfaces,
  registerPublicCloudSurfaces,
} from "../cloud-register-all-stub.js";

describe("cloud-register-all-stub", () => {
  it("exports the four registration helpers as functions", () => {
    expect(Object.keys(stub).sort()).toEqual([
      "ensurePrivateCloudSurfaces",
      "registerAllCloudSurfaces",
      "registerPrivateCloudSurfaces",
      "registerPublicCloudSurfaces",
    ]);
    expect(typeof registerAllCloudSurfaces).toBe("function");
    expect(typeof registerPublicCloudSurfaces).toBe("function");
    expect(typeof registerPrivateCloudSurfaces).toBe("function");
    expect(typeof ensurePrivateCloudSurfaces).toBe("function");
  });

  it("sync registrations return undefined and do not throw", () => {
    expect(registerAllCloudSurfaces()).toBeUndefined();
    expect(registerPublicCloudSurfaces()).toBeUndefined();
  });

  it("repeated sync registrations stay no-ops", () => {
    expect(registerAllCloudSurfaces()).toBeUndefined();
    expect(registerAllCloudSurfaces()).toBeUndefined();
    expect(registerPublicCloudSurfaces()).toBeUndefined();
    expect(registerPublicCloudSurfaces()).toBeUndefined();
  });

  it("private registrations return Promises that resolve to undefined", async () => {
    const privateResult = registerPrivateCloudSurfaces();
    const ensureResult = ensurePrivateCloudSurfaces();
    expect(privateResult).toBeInstanceOf(Promise);
    expect(ensureResult).toBeInstanceOf(Promise);
    await expect(privateResult).resolves.toBeUndefined();
    await expect(ensureResult).resolves.toBeUndefined();
  });

  it("successive private registrations return distinct promises", async () => {
    const first = registerPrivateCloudSurfaces();
    const second = registerPrivateCloudSurfaces();
    const ensureFirst = ensurePrivateCloudSurfaces();
    const ensureSecond = ensurePrivateCloudSurfaces();
    expect(first).not.toBe(second);
    expect(ensureFirst).not.toBe(ensureSecond);
    expect(first).not.toBe(ensureFirst);
    await expect(
      Promise.all([first, second, ensureFirst, ensureSecond]),
    ).resolves.toEqual([undefined, undefined, undefined, undefined]);
  });

  it("concurrent private registrations all resolve", async () => {
    await expect(
      Promise.all([
        registerPrivateCloudSurfaces(),
        ensurePrivateCloudSurfaces(),
        registerPrivateCloudSurfaces(),
      ]),
    ).resolves.toEqual([undefined, undefined, undefined]);
  });

  it("mixed sync and async calls stay no-ops", async () => {
    expect(registerAllCloudSurfaces()).toBeUndefined();
    await expect(registerPrivateCloudSurfaces()).resolves.toBeUndefined();
    expect(registerPublicCloudSurfaces()).toBeUndefined();
    await expect(ensurePrivateCloudSurfaces()).resolves.toBeUndefined();
    expect(registerAllCloudSurfaces()).toBeUndefined();
  });
});
