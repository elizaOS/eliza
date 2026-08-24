import { describe, expect, it } from "vitest";
import {
  createAdapterReadinessError,
  describeAdapterReadinessError,
  isMissingDatabaseAdapterError,
} from "./adapter-readiness";

describe("describeAdapterReadinessError", () => {
  it("returns the Error message for Error instances", () => {
    expect(describeAdapterReadinessError(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-Error values", () => {
    expect(describeAdapterReadinessError("raw string")).toBe("raw string");
    expect(describeAdapterReadinessError(42)).toBe("42");
    expect(describeAdapterReadinessError(undefined)).toBe("undefined");
    expect(describeAdapterReadinessError(null)).toBe("null");
  });
});

describe("isMissingDatabaseAdapterError", () => {
  it("returns true when the message carries the missing-adapter marker", () => {
    expect(isMissingDatabaseAdapterError(new Error("Database adapter not registered"))).toBe(true);
    expect(isMissingDatabaseAdapterError("Database adapter not registered for agent 7")).toBe(true);
  });

  it("returns false for unrelated errors and values", () => {
    expect(isMissingDatabaseAdapterError(new Error("connection refused"))).toBe(false);
    expect(isMissingDatabaseAdapterError("nope")).toBe(false);
    expect(isMissingDatabaseAdapterError(null)).toBe(false);
    expect(isMissingDatabaseAdapterError(undefined)).toBe(false);
  });
});

describe("createAdapterReadinessError", () => {
  it("wraps the cause with the typed code and preserves context", () => {
    const cause = new Error("underlying failure");
    const err = createAdapterReadinessError(cause, {
      agentId: "agent-123",
      entrypoint: "node",
    });

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ElizaError");
    expect(err.code).toBe("DB_ADAPTER_READY_CHECK_FAILED");
    expect(err.message).toBe("Database adapter readiness check failed");
    expect(err.cause).toBe(cause);
    expect(err.context).toEqual({
      agentId: "agent-123",
      entrypoint: "node",
    });
  });

  it("preserves the entrypoint and agentId verbatim (no mutation)", () => {
    const err = createAdapterReadinessError(new Error("x"), {
      agentId: "agent-9",
      entrypoint: "browser",
    });
    expect(err.context.entrypoint).toBe("browser");
    expect(err.context.agentId).toBe("agent-9");
  });
});
