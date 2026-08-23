import { describe, expect, it } from "vitest";
import {
  ensurePrivateCloudSurfaces,
  registerAllCloudSurfaces,
  registerPrivateCloudSurfaces,
  registerPublicCloudSurfaces,
} from "../cloud-register-all-stub.ts";

describe("cloud-register-all-stub", () => {
  it("sync registrations are no-ops", () => {
    expect(() => registerAllCloudSurfaces()).not.toThrow();
    expect(() => registerPublicCloudSurfaces()).not.toThrow();
  });

  it("async registrations resolve", async () => {
    await expect(registerPrivateCloudSurfaces()).resolves.toBeUndefined();
    await expect(ensurePrivateCloudSurfaces()).resolves.toBeUndefined();
  });
});
