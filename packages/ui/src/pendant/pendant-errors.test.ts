/**
 * Pins pendant failure classification. The cause-chain walker is the part with
 * a real hazard: it follows attacker-agnostic but arbitrarily shaped
 * `Error.cause` links, so a cycle must terminate rather than hang the caller.
 * Also covers permission precedence over the deepest-message heuristic and the
 * code/category mapping recovery logic keys off. Pure module, no harness.
 */

import { describe, expect, it } from "vitest";
import {
  classifyPendantConnectionError,
  createPendantError,
  type PendantErrorCode,
  PendantPermissionDeniedError,
  pendantErrorCauseChain,
} from "./pendant-errors";

const ALL_CODES: PendantErrorCode[] = [
  "permission-denied",
  "pendant-lost",
  "reconnect-exhausted",
  "asr-failed",
  "connection",
  "generic",
];

/** Build `new Error(a, {cause: new Error(b, {cause: ...})})` from outermost in. */
function nested(...messages: string[]): Error {
  let current: Error | undefined;
  for (const message of [...messages].reverse()) {
    current = current
      ? new Error(message, { cause: current })
      : new Error(message);
  }
  return current as Error;
}

describe("pendantErrorCauseChain", () => {
  it("returns a single-element chain for a bare error", () => {
    const error = new Error("boom");
    expect(pendantErrorCauseChain(error)).toEqual([error]);
  });

  it("walks nested causes outermost first", () => {
    const chain = pendantErrorCauseChain(nested("outer", "middle", "inner"));
    expect(chain.map((c) => (c as Error).message)).toEqual([
      "outer",
      "middle",
      "inner",
    ]);
  });

  it("terminates on a self-referential cause", () => {
    const error = new Error("loop");
    (error as Error & { cause: unknown }).cause = error;
    expect(pendantErrorCauseChain(error)).toEqual([error]);
  });

  it("terminates on a two-node cycle", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as Error & { cause: unknown }).cause = b;
    const chain = pendantErrorCauseChain(a);
    expect(chain).toEqual([a, b]);
  });

  it("terminates on a longer cycle", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    const c = new Error("c", { cause: b });
    (a as Error & { cause: unknown }).cause = c;
    expect(pendantErrorCauseChain(c).length).toBe(3);
  });

  it("stops at a non-Error cause without following it further", () => {
    const inner = { cause: new Error("never reached") };
    const chain = pendantErrorCauseChain(new Error("outer", { cause: inner }));
    expect(chain.length).toBe(2);
    expect(chain[1]).toBe(inner);
  });

  it("handles non-Error and nullish inputs", () => {
    expect(pendantErrorCauseChain("boom")).toEqual(["boom"]);
    expect(pendantErrorCauseChain(null)).toEqual([null]);
    expect(pendantErrorCauseChain(42)).toEqual([42]);
    expect(pendantErrorCauseChain(undefined)).toEqual([]);
  });

  it("does not conflate distinct errors with identical messages", () => {
    const inner = new Error("same");
    const outer = new Error("same", { cause: inner });
    expect(pendantErrorCauseChain(outer)).toEqual([outer, inner]);
  });
});

describe("createPendantError", () => {
  it("maps every code to a category and a non-empty message", () => {
    for (const code of ALL_CODES) {
      const error = createPendantError(code);
      expect(error.code).toBe(code);
      expect(error.category.length).toBeGreaterThan(0);
      expect(error.message.trim().length).toBeGreaterThan(0);
    }
  });

  it("never returns undefined for a declared code", () => {
    for (const code of ALL_CODES) {
      expect(createPendantError(code)).toBeDefined();
    }
  });

  it("groups both reconnect codes under one recovery category", () => {
    expect(createPendantError("pendant-lost").category).toBe("reconnect");
    expect(createPendantError("reconnect-exhausted").category).toBe(
      "reconnect",
    );
  });

  it("maps the remaining codes to their own categories", () => {
    expect(createPendantError("permission-denied").category).toBe("permission");
    expect(createPendantError("asr-failed").category).toBe("transcription");
    expect(createPendantError("connection").category).toBe("connection");
    expect(createPendantError("generic").category).toBe("generic");
  });

  it("appends a connection detail when one is given", () => {
    expect(createPendantError("connection", "adapter off").message).toBe(
      "Pendant connection failed: adapter off",
    );
  });

  it("falls back to the plain connection message for an empty detail", () => {
    for (const detail of [undefined, ""]) {
      expect(createPendantError("connection", detail).message).toBe(
        "Pendant connection failed.",
      );
    }
  });

  it("ignores a detail for codes that do not take one", () => {
    for (const code of [
      "permission-denied",
      "pendant-lost",
      "reconnect-exhausted",
      "asr-failed",
    ] as const) {
      expect(createPendantError(code, "ignored detail").message).toBe(
        createPendantError(code).message,
      );
    }
  });

  it("treats every failure as recoverable", () => {
    for (const code of ALL_CODES) {
      expect(createPendantError(code).recoverable).toBe(true);
    }
  });
});

describe("classifyPendantConnectionError", () => {
  it("detects a permission error at the top of the chain", () => {
    const result = classifyPendantConnectionError(
      new PendantPermissionDeniedError(),
    );
    expect(result.code).toBe("permission-denied");
    expect(result.category).toBe("permission");
  });

  it("detects a permission error buried in the chain", () => {
    const buried = new Error("connect failed", {
      cause: new Error("gatt", { cause: new PendantPermissionDeniedError() }),
    });
    expect(classifyPendantConnectionError(buried).code).toBe(
      "permission-denied",
    );
  });

  it("detects a NotAllowedError DOMException", () => {
    const denied = new DOMException("denied", "NotAllowedError");
    expect(classifyPendantConnectionError(denied).code).toBe(
      "permission-denied",
    );
    expect(
      classifyPendantConnectionError(new Error("outer", { cause: denied }))
        .code,
    ).toBe("permission-denied");
  });

  it("does not treat another DOMException name as a permission error", () => {
    const other = new DOMException("gone", "NetworkError");
    expect(classifyPendantConnectionError(other).code).toBe("connection");
  });

  it("permission wins over a deeper non-permission error", () => {
    const mixed = new PendantPermissionDeniedError();
    (mixed as Error & { cause: unknown }).cause = new Error("deepest detail");
    const result = classifyPendantConnectionError(mixed);
    expect(result.code).toBe("permission-denied");
    expect(result.message).not.toContain("deepest detail");
  });

  it("uses the deepest error message as the connection detail", () => {
    const result = classifyPendantConnectionError(
      nested("outer", "middle", "root cause"),
    );
    expect(result.code).toBe("connection");
    expect(result.message).toBe("Pendant connection failed: root cause");
  });

  it("falls back to the plain message when nothing in the chain is an Error", () => {
    for (const value of ["boom", null, 42, { message: "not an error" }]) {
      const result = classifyPendantConnectionError(value);
      expect(result.code).toBe("connection");
      expect(result.message).toBe("Pendant connection failed.");
    }
  });

  it("terminates on a cyclic chain", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as Error & { cause: unknown }).cause = b;
    expect(classifyPendantConnectionError(a).code).toBe("connection");
  });
});

describe("PendantPermissionDeniedError", () => {
  it("is an Error carrying a stable name", () => {
    const error = new PendantPermissionDeniedError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PendantPermissionDeniedError");
    expect(error.message.length).toBeGreaterThan(0);
  });

  it("accepts a custom message", () => {
    expect(new PendantPermissionDeniedError("custom").message).toBe("custom");
  });
});
