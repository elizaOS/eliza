import { describe, expect, it, vi } from "vitest";

import {
  cleanSuggestions,
  handleSuggestionsRoutes,
  parseRequestBody,
} from "./suggestions-routes.ts";

describe("cleanSuggestions", () => {
  it("strips bullets/quotes, dedupes case-insensitively, and caps at 3", () => {
    const out = cleanSuggestions([
      "1. Plan my day",
      '"Summarize unread"',
      "- Draft a reply",
      "plan my day", // case-insensitive dup of the first, dropped
      "Review the budget", // beyond the cap of 3
    ]);
    expect(out).toEqual(["Plan my day", "Summarize unread", "Draft a reply"]);
  });

  it("drops empties, non-strings, and over-long entries", () => {
    const long = "x".repeat(60);
    const out = cleanSuggestions(["", "  ", 42, long, "Keep this one"]);
    expect(out).toEqual(["Keep this one"]);
  });

  it("returns [] for non-array input", () => {
    expect(cleanSuggestions(undefined)).toEqual([]);
    expect(cleanSuggestions("nope")).toEqual([]);
  });
});

describe("parseRequestBody", () => {
  it("keeps valid messages (last N) and a valid hour", () => {
    const out = parseRequestBody(
      JSON.stringify({
        hour: 14,
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hey" },
          { role: "bogus", content: "   " }, // empty after trim → dropped
        ],
      }),
    );
    expect(out.hour).toBe(14);
    expect(out.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hey" },
    ]);
  });

  it("rejects an out-of-range or non-numeric hour", () => {
    expect(parseRequestBody(JSON.stringify({ hour: 99 })).hour).toBeUndefined();
    expect(
      parseRequestBody(JSON.stringify({ hour: "9" })).hour,
    ).toBeUndefined();
  });

  it("tolerates empty and malformed bodies", () => {
    expect(parseRequestBody("")).toEqual({ messages: [], hour: undefined });
    expect(parseRequestBody("not json")).toEqual({
      messages: [],
      hour: undefined,
    });
    expect(parseRequestBody("[]")).toEqual({ messages: [], hour: undefined });
  });
});

describe("handleSuggestionsRoutes guards", () => {
  const res = {} as never;

  it("ignores non-matching paths without responding", async () => {
    const json = vi.fn();
    const error = vi.fn();
    const handled = await handleSuggestionsRoutes({
      req: {} as never,
      res,
      method: "POST",
      pathname: "/api/other",
      json,
      error,
      runtime: {} as never,
    });
    expect(handled).toBe(false);
    expect(json).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("405s a non-POST method", async () => {
    const json = vi.fn();
    const error = vi.fn();
    const handled = await handleSuggestionsRoutes({
      req: {} as never,
      res,
      method: "GET",
      pathname: "/api/suggestions",
      json,
      error,
      runtime: {} as never,
    });
    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(res, "Method not allowed", 405);
  });

  it("returns an empty set when there is no runtime", async () => {
    const json = vi.fn();
    const error = vi.fn();
    const handled = await handleSuggestionsRoutes({
      req: {} as never,
      res,
      method: "POST",
      pathname: "/api/suggestions",
      json,
      error,
      runtime: null,
    });
    expect(handled).toBe(true);
    expect(json).toHaveBeenCalledWith(res, { suggestions: [] });
  });
});
