import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  cleanSuggestions,
  computeHeuristicSuggestions,
  handleSuggestionsRoutes,
  parseRequestBody,
} from "./suggestions-routes.ts";

/** A minimal http.IncomingMessage stand-in carrying a JSON body. */
function jsonReq(body: unknown): never {
  const readable = Readable.from([Buffer.from(JSON.stringify(body))]);
  return readable as never;
}

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
    expect(parseRequestBody("")).toEqual({
      messages: [],
      hour: undefined,
      scope: undefined,
    });
    expect(parseRequestBody("not json")).toEqual({
      messages: [],
      hour: undefined,
      scope: undefined,
    });
    expect(parseRequestBody("[]")).toEqual({
      messages: [],
      hour: undefined,
      scope: undefined,
    });
  });

  it("keeps a well-formed page scope and rejects junk", () => {
    expect(
      parseRequestBody(JSON.stringify({ scope: "page-wallet" })).scope,
    ).toBe("page-wallet");
    expect(
      parseRequestBody(JSON.stringify({ scope: "page-admin" })).scope,
    ).toBeUndefined();
    expect(
      parseRequestBody(JSON.stringify({ scope: "wallet" })).scope,
    ).toBeUndefined(); // missing page- prefix
    expect(
      parseRequestBody(JSON.stringify({ scope: "page-<script>" })).scope,
    ).toBeUndefined();
    expect(
      parseRequestBody(JSON.stringify({ scope: 42 })).scope,
    ).toBeUndefined();
  });
});

describe("computeHeuristicSuggestions", () => {
  it("returns exactly 3 unique items, scope starters first after the lead", () => {
    const out = computeHeuristicSuggestions({
      messages: [],
      hour: 9,
      scope: "page-wallet",
    });
    expect(out).toEqual([
      "Plan my day",
      "Check my balance",
      "Recent transactions",
    ]);
  });

  it("leads with the thread follow-up when a conversation exists", () => {
    const out = computeHeuristicSuggestions({
      messages: [{ role: "user", content: "hey" }],
      hour: 9,
      scope: "page-wallet",
    });
    expect(out[0]).toBe("Continue where we left off");
    expect(out).toHaveLength(3);
  });

  it("falls back to the general pool with no scope", () => {
    const out = computeHeuristicSuggestions({
      messages: [],
      hour: 20,
      scope: undefined,
    });
    expect(out).toEqual([
      "Recap my day",
      "What can you do?",
      "Summarize my day",
    ]);
  });

  it("dedupes a scope starter that collides with a general starter", () => {
    // page-character starter "What can you do?" === GENERAL_STARTERS[0]
    // "What can you do?" — the collision must not leave a duplicate.
    const out = computeHeuristicSuggestions({
      messages: [],
      hour: 9,
      scope: "page-character",
    });
    expect(out).toEqual([
      "Plan my day",
      "Tune your personality",
      "Change your voice",
    ]);
    expect(new Set(out).size).toBe(3);
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

  it("serves the heuristic tier when there is no runtime (degrade-not-empty)", async () => {
    const json = vi.fn();
    const error = vi.fn();
    const handled = await handleSuggestionsRoutes({
      req: jsonReq({ scope: "page-wallet", hour: 9 }),
      res,
      method: "POST",
      pathname: "/api/suggestions",
      json,
      error,
      runtime: null,
    });
    expect(handled).toBe(true);
    const payload = json.mock.calls[0][1] as {
      suggestions: string[];
      tier: string;
      generatedAt: string;
    };
    expect(payload.tier).toBe("heuristic");
    expect(payload.suggestions).toHaveLength(3);
    expect(payload.suggestions).toContain("Check my balance");
    expect(typeof payload.generatedAt).toBe("string");
  });

  it("pads a short model set from the heuristic tier and reports tier=model", async () => {
    const json = vi.fn();
    const error = vi.fn();
    const runtime = {
      character: { name: "Eliza" },
      logger: { warn: vi.fn() },
      useModel: vi
        .fn()
        .mockResolvedValue('{"suggestions":["Reconcile my budget"]}'),
    };
    const handled = await handleSuggestionsRoutes({
      req: jsonReq({ scope: "page-wallet", hour: 9 }),
      res,
      method: "POST",
      pathname: "/api/suggestions",
      json,
      error,
      runtime: runtime as never,
    });
    expect(handled).toBe(true);
    const payload = json.mock.calls[0][1] as {
      suggestions: string[];
      tier: string;
    };
    expect(payload.tier).toBe("model");
    expect(payload.suggestions).toHaveLength(3);
    expect(payload.suggestions[0]).toBe("Reconcile my budget");
  });

  it("serves the heuristic tier when generation throws", async () => {
    const json = vi.fn();
    const error = vi.fn();
    const runtime = {
      character: { name: "Eliza" },
      logger: { warn: vi.fn() },
      useModel: vi.fn().mockRejectedValue(new Error("model offline")),
    };
    const handled = await handleSuggestionsRoutes({
      req: jsonReq({ hour: 14 }),
      res,
      method: "POST",
      pathname: "/api/suggestions",
      json,
      error,
      runtime: runtime as never,
    });
    expect(handled).toBe(true);
    const payload = json.mock.calls[0][1] as {
      suggestions: string[];
      tier: string;
    };
    expect(payload.tier).toBe("heuristic");
    expect(payload.suggestions).toHaveLength(3);
    expect(runtime.logger.warn).toHaveBeenCalled();
  });
});
