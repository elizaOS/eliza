// Unit coverage for the pure chat-input/streaming parsers in state/parsers.ts.
// These drive slash commands, custom-action argument binding, streamed-text
// reconciliation, and startup-error formatting — all chat-surface behavior with
// real branching and no co-located test until now.

import { describe, expect, it } from "vitest";
import type { CustomActionDef } from "../api/client";
import {
  asApiLikeError,
  formatSearchBullet,
  formatStartupErrorDetail,
  isRecord,
  normalizeCustomActionName,
  normalizeStreamComparisonText,
  parseCustomActionParams,
  parseSlashCommandInput,
  shouldApplyFinalStreamText,
} from "./parsers";

/**
 * Test fixture carrying only the fields `parseCustomActionParams` reads
 * (`parameters[].name` / `.required`). The unused `handler` is omitted, so the
 * partial is cast through `unknown` — never invoked, so the stub is irrelevant.
 */
function action(
  parameters: Array<{ name: string; required?: boolean }>,
): CustomActionDef {
  return {
    id: "act-1",
    name: "CUSTOM",
    description: "",
    parameters: parameters.map((p) => ({
      name: p.name,
      description: "",
      required: p.required ?? false,
    })),
    enabled: true,
    createdAt: "",
    updatedAt: "",
  } as unknown as CustomActionDef;
}

describe("isRecord", () => {
  it("is true only for non-null objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(5)).toBe(false);
    expect(isRecord("x")).toBe(false);
  });
});

describe("parseSlashCommandInput", () => {
  it("returns null for non-slash or empty bodies", () => {
    expect(parseSlashCommandInput("hello")).toBeNull();
    expect(parseSlashCommandInput("/")).toBeNull();
    expect(parseSlashCommandInput("/   ")).toBeNull();
  });

  it("parses a bare command and lowercases/prefixes the name", () => {
    expect(parseSlashCommandInput("/Help")).toEqual({
      name: "/help",
      argsRaw: "",
    });
  });

  it("splits the name from the args at the first whitespace", () => {
    expect(parseSlashCommandInput("/Send  hi   there")).toEqual({
      name: "/send",
      argsRaw: "hi   there",
    });
  });
});

describe("normalizeCustomActionName", () => {
  it("uppercases and collapses spaces/dashes to underscores", () => {
    expect(normalizeCustomActionName("send message")).toBe("SEND_MESSAGE");
    expect(normalizeCustomActionName("  my-cool-action ")).toBe(
      "MY_COOL_ACTION",
    );
  });
});

describe("parseCustomActionParams", () => {
  it("binds named key=value args to canonical parameter names", () => {
    const { params, missingRequired } = parseCustomActionParams(
      action([{ name: "To", required: true }, { name: "body" }]),
      "to=alice body=hello",
    );
    expect(params).toEqual({ To: "alice", body: "hello" });
    expect(missingRequired).toEqual([]);
  });

  it("fills positional args in declared parameter order", () => {
    const { params } = parseCustomActionParams(
      action([{ name: "to" }, { name: "body" }]),
      "alice hello",
    );
    expect(params).toEqual({ to: "alice", body: "hello" });
  });

  it("routes overflow positional tokens into a sink param (input/text/...)", () => {
    const { params } = parseCustomActionParams(
      action([{ name: "input" }]),
      "hello world extra",
    );
    expect(params).toEqual({ input: "hello world extra" });
  });

  it("reports required params that were never supplied", () => {
    const { missingRequired } = parseCustomActionParams(
      action([{ name: "to", required: true }]),
      "",
    );
    expect(missingRequired).toEqual(["to"]);
  });

  it("keeps quoted positional values intact", () => {
    const { params } = parseCustomActionParams(
      action([{ name: "input" }]),
      '"hello world"',
    );
    expect(params).toEqual({ input: "hello world" });
  });
});

describe("streamed-text reconciliation", () => {
  it("normalizeStreamComparisonText collapses whitespace and trims", () => {
    expect(normalizeStreamComparisonText("a  b\n c ")).toBe("a b c");
  });

  it("shouldApplyFinalStreamText only when final adds real content", () => {
    expect(shouldApplyFinalStreamText("", "final answer")).toBe(true);
    expect(shouldApplyFinalStreamText("final", "final")).toBe(false);
    // Whitespace-only difference → already shown, don't re-apply.
    expect(shouldApplyFinalStreamText("hello world", "hello  world")).toBe(
      false,
    );
    // Genuinely different final text → apply.
    expect(shouldApplyFinalStreamText("hi", "hello there")).toBe(true);
    // Empty final → never apply.
    expect(shouldApplyFinalStreamText("hi", "   ")).toBe(false);
  });
});

describe("formatSearchBullet", () => {
  it("formats an empty list and a bulleted list", () => {
    expect(formatSearchBullet("Items", [])).toBe("Items: none");
    expect(formatSearchBullet("Items", ["a", "b"])).toBe("Items:\n- a\n- b");
  });
});

describe("asApiLikeError + formatStartupErrorDetail", () => {
  it("extracts an API-shaped error and ignores non-API objects", () => {
    expect(
      asApiLikeError({
        kind: "http",
        status: 404,
        path: "/x",
        message: "nope",
      }),
    ).toEqual({ kind: "http", status: 404, path: "/x", message: "nope" });
    expect(asApiLikeError({ status: 500 })).toEqual({
      kind: undefined,
      status: 500,
      path: undefined,
      message: undefined,
    });
    expect(asApiLikeError({ foo: 1 })).toBeNull();
    expect(asApiLikeError("nope")).toBeNull();
  });

  it("formats startup error detail from API errors and Error instances", () => {
    expect(
      formatStartupErrorDetail({
        path: "/api/x",
        status: 500,
        message: "boom",
      }),
    ).toBe("/api/x - HTTP 500 - boom");
    expect(formatStartupErrorDetail(new Error("oops"))).toBe("oops");
    expect(formatStartupErrorDetail({})).toBeUndefined();
    expect(formatStartupErrorDetail("plain string")).toBeUndefined();
  });
});
