/** Exercises dynamic view error construction and throw-boundary behavior. */
import type { JsonValue } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { DynamicViewError } from "./errors";

const ALL_CODES = [
  "DYNAMIC_VIEW_DUPLICATE",
  "DYNAMIC_VIEW_INVALID_MANIFEST",
  "DYNAMIC_VIEW_NOT_FOUND",
  "DYNAMIC_VIEW_SESSION_NOT_FOUND",
  "DYNAMIC_VIEW_ENTRYPOINT_UNAVAILABLE",
  "DYNAMIC_VIEW_UNSUPPORTED_ENTRYPOINT",
  "DYNAMIC_VIEW_UNSUPPORTED_PLACEMENT",
  "DYNAMIC_VIEW_OPEN_FAILED",
  "DYNAMIC_VIEW_PUSH_FAILED",
] as const;

describe("DynamicViewError", () => {
  it("constructs with name, message, code, and details preserved", () => {
    const details: JsonValue = { viewId: "agent.run.trace", attempt: 2 };
    const error = new DynamicViewError(
      "DYNAMIC_VIEW_DUPLICATE",
      "view already registered",
      details,
    );

    expect(error).toBeInstanceOf(DynamicViewError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("DynamicViewError");
    expect(error.message).toBe("view already registered");
    expect(error.code).toBe("DYNAMIC_VIEW_DUPLICATE");
    expect(error.details).toBe(details);
  });

  it("round-trips every declared error code", () => {
    for (const code of ALL_CODES) {
      const error = new DynamicViewError(code, `failure: ${code}`);
      expect(error.code).toBe(code);
    }
  });

  it("leaves details undefined when omitted", () => {
    const error = new DynamicViewError(
      "DYNAMIC_VIEW_NOT_FOUND",
      "no such dynamic view",
    );

    expect(error.details).toBeUndefined();
  });

  it("preserves explicit null details instead of defaulting them away", () => {
    const error = new DynamicViewError(
      "DYNAMIC_VIEW_OPEN_FAILED",
      "window open failed",
      null,
    );

    expect(error.details).toBeNull();
  });

  it.each([false, 0, ""])(
    "preserves falsy JSON detail %s without truthiness defaulting",
    (value) => {
      const error = new DynamicViewError(
        "DYNAMIC_VIEW_PUSH_FAILED",
        "push failed",
        value,
      );

      expect(error.details).toBe(value);
    },
  );

  it("preserves structured JSON details by reference without transformation", () => {
    const details: JsonValue = {
      manifest: {
        id: "agent.run.trace",
        entrypoints: ["trace.html", null],
        retry: false,
      },
      history: [1, -0.5, "", null, { ok: true }],
    };
    const error = new DynamicViewError(
      "DYNAMIC_VIEW_INVALID_MANIFEST",
      "manifest rejected",
      details,
    );

    expect(error.details).toBe(details);
  });

  it("allows an empty message", () => {
    const error = new DynamicViewError("DYNAMIC_VIEW_SESSION_NOT_FOUND", "");

    expect(error.message).toBe("");
    expect(error.code).toBe("DYNAMIC_VIEW_SESSION_NOT_FOUND");
  });

  it("survives a throw/catch boundary with every field intact", () => {
    const details: JsonValue = ["trace.html", 2, true];
    let caught: unknown;
    try {
      throw new DynamicViewError(
        "DYNAMIC_VIEW_ENTRYPOINT_UNAVAILABLE",
        "entrypoint missing on disk",
        details,
      );
    } catch (thrown) {
      caught = thrown;
    }

    expect(caught).toBeInstanceOf(DynamicViewError);
    const error = caught as DynamicViewError;
    expect(error.name).toBe("DynamicViewError");
    expect(error.message).toBe("entrypoint missing on disk");
    expect(error.code).toBe("DYNAMIC_VIEW_ENTRYPOINT_UNAVAILABLE");
    expect(error.details).toBe(details);
  });
});
