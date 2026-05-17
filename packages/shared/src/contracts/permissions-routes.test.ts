import { describe, expect, it } from "vitest";
import {
  PutPermissionsShellRequestSchema,
  PutPermissionsStateRequestSchema,
} from "./permissions-routes.js";

describe("PutPermissionsShellRequestSchema", () => {
  it("accepts an empty body", () => {
    expect(PutPermissionsShellRequestSchema.parse({})).toEqual({});
  });

  it("accepts enabled=true", () => {
    expect(PutPermissionsShellRequestSchema.parse({ enabled: true })).toEqual({
      enabled: true,
    });
  });

  it("accepts enabled=false", () => {
    expect(PutPermissionsShellRequestSchema.parse({ enabled: false })).toEqual({
      enabled: false,
    });
  });

  it("rejects non-boolean", () => {
    expect(() =>
      PutPermissionsShellRequestSchema.parse({ enabled: "yes" }),
    ).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      PutPermissionsShellRequestSchema.parse({ enabled: true, force: true }),
    ).toThrow();
  });
});

describe("PutPermissionsStateRequestSchema", () => {
  it("accepts an empty body", () => {
    expect(PutPermissionsStateRequestSchema.parse({})).toEqual({});
  });

  it("accepts permissions map", () => {
    const parsed = PutPermissionsStateRequestSchema.parse({
      permissions: {
        screen: { id: "screen", status: "granted" },
        accessibility: { id: "accessibility", status: "denied" },
      },
    });
    expect(parsed.permissions?.screen?.status).toBe("granted");
  });

  it("accepts startup flag", () => {
    expect(PutPermissionsStateRequestSchema.parse({ startup: true })).toEqual({
      startup: true,
    });
  });

  it("rejects extra fields", () => {
    expect(() =>
      PutPermissionsStateRequestSchema.parse({ startup: true, dryRun: true }),
    ).toThrow();
  });
});
