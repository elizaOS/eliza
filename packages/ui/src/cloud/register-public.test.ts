/**
 * Unit tests for register-public: validates idempotent public surface registration.
 */
import { describe, expect, it } from "vitest";
import { registerPublicCloudSurfaces } from "./register-public.ts";

describe("register-public", () => {
  it("executes public surface registration idempotently without throwing", () => {
    expect(() => registerPublicCloudSurfaces()).not.toThrow();
    expect(() => registerPublicCloudSurfaces()).not.toThrow();
  });
});
