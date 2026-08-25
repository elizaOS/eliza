/**
 * Colocated coverage for the app-core connector-setup HTTP-route contract
 * re-export. Drives the real module: identity with `@elizaos/core`, the closed
 * SETUP_ERROR_CODES set, buildSetupError envelope shape (including empty and
 * connector-specific codes), and setupPath composition for every action,
 * empty/single connectors, and unencoded interpolations. No mocks.
 */
import {
  SETUP_ERROR_CODES as CORE_SETUP_ERROR_CODES,
  buildSetupError as coreBuildSetupError,
  setupPath as coreSetupPath,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import * as setupContract from "./setup-contract";
import {
  buildSetupError,
  SETUP_ERROR_CODES,
  type SetupErrorCode,
  type SetupErrorResponse,
  type SetupState,
  type SetupStatusResponse,
  setupPath,
} from "./setup-contract";

describe("app-core setup-contract re-export", () => {
  it("re-exports the same runtime values as @elizaos/core", () => {
    expect(buildSetupError).toBe(coreBuildSetupError);
    expect(SETUP_ERROR_CODES).toBe(CORE_SETUP_ERROR_CODES);
    expect(setupPath).toBe(coreSetupPath);
  });

  it("exposes only the three runtime contract symbols", () => {
    expect(Object.keys(setupContract).sort()).toEqual([
      "SETUP_ERROR_CODES",
      "buildSetupError",
      "setupPath",
    ]);
  });
});

describe("SETUP_ERROR_CODES", () => {
  it("is the closed four-code map in declaration order", () => {
    expect(Object.keys(SETUP_ERROR_CODES)).toEqual([
      "BAD_REQUEST",
      "SERVICE_UNAVAILABLE",
      "INTERNAL_ERROR",
      "TOO_MANY_SESSIONS",
    ]);
    expect(SETUP_ERROR_CODES).toEqual({
      BAD_REQUEST: "bad_request",
      SERVICE_UNAVAILABLE: "service_unavailable",
      INTERNAL_ERROR: "internal_error",
      TOO_MANY_SESSIONS: "too_many_sessions",
    });
  });

  it("values are the SetupErrorCode union members", () => {
    const codes: SetupErrorCode[] = Object.values(SETUP_ERROR_CODES);
    expect(codes).toEqual([
      "bad_request",
      "service_unavailable",
      "internal_error",
      "too_many_sessions",
    ]);
  });

  it("is a mutable object at runtime (as const is compile-time only)", () => {
    expect(Object.isFrozen(SETUP_ERROR_CODES)).toBe(false);
    expect(Object.isSealed(SETUP_ERROR_CODES)).toBe(false);
  });
});

describe("buildSetupError", () => {
  it("wraps each catalogued code and a message in { error: { code, message } }", () => {
    for (const code of Object.values(SETUP_ERROR_CODES)) {
      const err: SetupErrorResponse = buildSetupError(code, `failed: ${code}`);
      expect(err).toEqual({
        error: { code, message: `failed: ${code}` },
      });
      expect(Object.keys(err)).toEqual(["error"]);
      expect(Object.keys(err.error)).toEqual(["code", "message"]);
    }
  });

  it("accepts a connector-specific code string that is not in the catalog", () => {
    expect(buildSetupError("unauthorized", "pairing token expired")).toEqual({
      error: { code: "unauthorized", message: "pairing token expired" },
    });
  });

  it("preserves empty code and empty message instead of substituting defaults", () => {
    expect(buildSetupError("", "")).toEqual({
      error: { code: "", message: "" },
    });
  });

  it("returns a new envelope each call and does not alias the inputs", () => {
    const first = buildSetupError("bad_request", "one");
    const second = buildSetupError("bad_request", "one");
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.error).not.toBe(second.error);
  });

  it("keeps unicode, whitespace, and JSON-special characters in the message", () => {
    const message = 'line\n\t"quoted" \\ 你好';
    expect(buildSetupError("internal_error", message)).toEqual({
      error: { code: "internal_error", message },
    });
  });
});

describe("setupPath", () => {
  it("composes /api/setup/<connector>/<action> for every documented action", () => {
    expect(setupPath("telegram", "status")).toBe("/api/setup/telegram/status");
    expect(setupPath("telegram", "start")).toBe("/api/setup/telegram/start");
    expect(setupPath("telegram", "cancel")).toBe("/api/setup/telegram/cancel");
  });

  it("interpolates an empty connector as a double slash rather than omitting the segment", () => {
    expect(setupPath("", "status")).toBe("/api/setup//status");
  });

  it("interpolates a single-character connector without padding", () => {
    expect(setupPath("x", "start")).toBe("/api/setup/x/start");
  });

  it("does not URI-encode, strip slashes, or reject extra path segments in the connector", () => {
    expect(setupPath("blue bubbles", "status")).toBe(
      "/api/setup/blue bubbles/status",
    );
    expect(setupPath("a/b", "start")).toBe("/api/setup/a/b/start");
    expect(setupPath("tg?x=1", "cancel")).toBe("/api/setup/tg?x=1/cancel");
  });

  it("does not validate action at runtime — an out-of-union string is interpolated as-is", () => {
    expect(setupPath("telegram", "delete" as "status")).toBe(
      "/api/setup/telegram/delete",
    );
  });
});

describe("SetupState and SetupStatusResponse", () => {
  it("SetupState is the closed four-state lifecycle union", () => {
    const states: SetupState[] = ["idle", "configuring", "paired", "error"];
    expect([...states].sort()).toEqual([
      "configuring",
      "error",
      "idle",
      "paired",
    ]);
  });

  it("SetupStatusResponse carries connector, state, and optional typed detail", () => {
    const withDetail: SetupStatusResponse<{ qr: string }> = {
      connector: "telegram",
      state: "configuring",
      detail: { qr: "otpauth://totp/eliza" },
    };
    const withoutDetail: SetupStatusResponse = {
      connector: "imessage",
      state: "idle",
    };
    expect(withDetail.detail?.qr).toBe("otpauth://totp/eliza");
    expect(withoutDetail.detail).toBeUndefined();
    expect(withoutDetail).toEqual({ connector: "imessage", state: "idle" });
  });
});
