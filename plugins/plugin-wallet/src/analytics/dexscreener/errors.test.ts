import { describe, expect, it } from "vitest";
import { dexScreenerErrorMessage } from "./errors";

describe("dexScreenerErrorMessage", () => {
  it("returns a raw string unchanged", () => {
    expect(dexScreenerErrorMessage("rate limited")).toBe("rate limited");
    expect(dexScreenerErrorMessage("")).toBe("");
  });

  it("returns the message of an Error instance", () => {
    expect(dexScreenerErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("prefers the nested response.data.message for fetch errors", () => {
    const caught = {
      response: { data: { message: "DexScreener API: 429" } },
      message: "Request failed with status code 429",
    };
    expect(dexScreenerErrorMessage(caught)).toBe("DexScreener API: 429");
  });

  it("falls back to the top-level message when response data has none", () => {
    const caught = { response: { data: {} }, message: "socket hang up" };
    expect(dexScreenerErrorMessage(caught)).toBe("socket hang up");
  });

  it("falls back to the top-level message when response is absent", () => {
    expect(dexScreenerErrorMessage({ message: "ECONNRESET" })).toBe(
      "ECONNRESET",
    );
  });

  it("returns the generic fallback for unknown shapes", () => {
    expect(dexScreenerErrorMessage(42)).toBe("Request failed");
    expect(dexScreenerErrorMessage(null)).toBe("Request failed");
    expect(dexScreenerErrorMessage(undefined)).toBe("Request failed");
  });

  it("returns the generic fallback when both messages are non-strings", () => {
    expect(
      dexScreenerErrorMessage({ response: { data: { message: 42 } } }),
    ).toBe("Request failed");
  });
});
