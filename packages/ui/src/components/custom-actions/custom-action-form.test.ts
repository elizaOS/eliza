/**
 * Covers the pure form model behind the custom-action editor: the
 * name/alias/parameter/method normalizers, the parsers that coerce a
 * loosely-typed generated payload, and parameter validation.
 *
 * These run over model-generated output, so the contracts that matter are the
 * coercion ones: an action name must always come out as a legal identifier, a
 * duplicate parameter must be rejected rather than silently shadowing an
 * earlier one, and an unrecognized HTTP method must fall back rather than
 * reaching the request builder.
 *
 * No React, no network.
 */
import { describe, expect, it } from "vitest";

import {
  HTTP_METHODS,
  normalizeActionName,
  normalizeAlias,
  normalizeMethod,
  normalizeParamName,
  type ParamDef,
  parseGeneratedAction,
  parseHeaders,
  parseParameters,
  parseSimiles,
  parseSimilesInput,
  toNonEmptyString,
  validateParameters,
} from "./custom-action-form.ts";

describe("toNonEmptyString", () => {
  it("trims a usable string and rejects everything else", () => {
    expect(toNonEmptyString("  hi  ")).toBe("hi");
    for (const value of ["", "   ", null, undefined, 42, {}, []]) {
      expect(toNonEmptyString(value)).toBeUndefined();
    }
  });
});

describe("normalizeActionName / normalizeAlias", () => {
  it("upper-cases and converts separators to single underscores", () => {
    expect(normalizeActionName("  send message  ")).toBe("SEND_MESSAGE");
    expect(normalizeActionName("send--message")).toBe("SEND_MESSAGE");
    expect(normalizeActionName("send.message/now")).toBe("SEND_MESSAGE_NOW");
  });

  it("strips leading and trailing underscores", () => {
    expect(normalizeActionName("__send__")).toBe("SEND");
    expect(normalizeActionName("!!!send!!!")).toBe("SEND");
  });

  it("keeps digits and collapses to empty for punctuation-only input", () => {
    expect(normalizeActionName("action 2")).toBe("ACTION_2");
    expect(normalizeActionName("!!!")).toBe("");
    expect(normalizeActionName("")).toBe("");
  });

  it("treats an alias exactly like an action name", () => {
    expect(normalizeAlias("send message")).toBe(
      normalizeActionName("send message"),
    );
  });
});

describe("normalizeParamName", () => {
  it("preserves case, unlike the action-name normalizer", () => {
    expect(normalizeParamName("  userId  ")).toBe("userId");
  });

  it("converts separators and trims underscores", () => {
    expect(normalizeParamName("user-id")).toBe("user_id");
    expect(normalizeParamName("__user id__")).toBe("user_id");
    expect(normalizeParamName("!!!")).toBe("");
  });
});

describe("normalizeMethod", () => {
  it("accepts every documented method, case-insensitively", () => {
    for (const method of HTTP_METHODS) {
      expect(normalizeMethod(method)).toBe(method);
      expect(normalizeMethod(method.toLowerCase())).toBe(method);
    }
  });

  it("falls back to GET for anything unrecognized", () => {
    for (const value of ["TRACE", "", "   ", null, undefined, 42, {}]) {
      expect(normalizeMethod(value)).toBe("GET");
    }
  });
});

describe("parseHeaders", () => {
  it("returns an empty list for non-record input", () => {
    for (const value of [null, undefined, "x", 42, ["a"]]) {
      expect(parseHeaders(value)).toEqual([]);
    }
  });

  it("keeps string-valued headers and drops the rest", () => {
    expect(
      parseHeaders({ Accept: "application/json", Retries: 3, Blank: null }),
    ).toEqual([{ key: "Accept", value: "application/json" }]);
  });

  it("drops a header whose name normalizes to nothing", () => {
    expect(parseHeaders({ "!!!": "value" })).toEqual([]);
  });
});

describe("parseParameters", () => {
  it("returns an empty list for non-array input", () => {
    expect(parseParameters(null)).toEqual([]);
    expect(parseParameters({ name: "a" })).toEqual([]);
  });

  it("normalizes names and defaults the description to the name", () => {
    expect(parseParameters([{ name: " user-id " }])).toEqual([
      { name: "user_id", description: "user_id", required: false },
    ]);
  });

  it("treats required as strictly true", () => {
    expect(parseParameters([{ name: "a", required: true }])[0]?.required).toBe(
      true,
    );
    expect(parseParameters([{ name: "a", required: "yes" }])[0]?.required).toBe(
      false,
    );
    expect(parseParameters([{ name: "a", required: 1 }])[0]?.required).toBe(
      false,
    );
  });

  it("drops entries with no usable name", () => {
    expect(
      parseParameters([{ name: "!!!" }, { name: "" }, null, 42, { x: 1 }]),
    ).toEqual([]);
  });

  it("keeps only the first of two names colliding case-insensitively", () => {
    const parsed = parseParameters([
      { name: "userId", description: "first" },
      { name: "USERID", description: "second" },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.description).toBe("first");
  });
});

describe("parseSimiles / parseSimilesInput", () => {
  it("normalizes, drops blanks, and de-duplicates case-insensitively", () => {
    expect(
      parseSimiles(["send message", "SEND-MESSAGE", "  ", null, "reply"]),
    ).toEqual(["SEND_MESSAGE", "REPLY"]);
  });

  it("returns an empty list for non-array input", () => {
    expect(parseSimiles("send")).toEqual([]);
  });

  it("splits a comma-separated editor field and normalizes each entry", () => {
    expect(parseSimilesInput("send message, reply ,, ")).toEqual([
      "SEND_MESSAGE",
      "REPLY",
    ]);
  });

  it("returns an empty list for an empty editor field", () => {
    expect(parseSimilesInput("")).toEqual([]);
    expect(parseSimilesInput(" , , ")).toEqual([]);
  });
});

describe("validateParameters", () => {
  it("accepts a clean list and normalizes names in place", () => {
    const items: ParamDef[] = [
      { name: " user-id ", description: "d", required: false },
    ];
    expect(validateParameters(items)).toBeNull();
    // Documented side effect: the editor relies on the rows being normalized.
    expect(items[0]?.name).toBe("user_id");
  });

  it("rejects a parameter whose name normalizes to nothing", () => {
    expect(
      validateParameters([{ name: "!!!", description: "d", required: false }]),
    ).toBe("Each parameter needs a non-empty name.");
  });

  it("rejects a duplicate name, naming it, and matches case-insensitively", () => {
    const message = validateParameters([
      { name: "userId", description: "d", required: false },
      { name: "USERID", description: "d", required: false },
    ]);
    expect(message).toContain("Duplicate parameter name");
    expect(message).toContain("USERID");
  });

  it("accepts an empty list", () => {
    expect(validateParameters([])).toBeNull();
  });
});

describe("parseGeneratedAction", () => {
  it("rejects a non-object payload with an explicit error", () => {
    for (const payload of [null, undefined, "x", 42, ["a"]]) {
      const result = parseGeneratedAction(payload);
      expect(result.ok).toBe(false);
      expect(result.errors).toContain(
        "Generation returned an invalid payload.",
      );
      expect(result.action).toBeUndefined();
    }
  });

  it("reports errors rather than throwing on a structurally empty object", () => {
    const result = parseGeneratedAction({});
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.action).toBeUndefined();
  });
});
