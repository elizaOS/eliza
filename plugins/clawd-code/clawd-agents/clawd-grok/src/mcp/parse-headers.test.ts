import { describe, expect, it } from "vitest";
import { parseEnvLines, parseHeaderLines } from "./parse-headers";

describe("parseHeaderLines", () => {
  it("parses colon-separated headers and trims whitespace", () => {
    expect(
      parseHeaderLines(`
        Authorization: Bearer token
        X-Trace-Id:  abc123
      `),
    ).toEqual({
      Authorization: "Bearer token",
      "X-Trace-Id": "abc123",
    });
  });

  it("ignores blank and malformed lines while preserving later colons in values", () => {
    expect(
      parseHeaderLines(`
        invalid
        : missing-name
        Host: example.com:443
      `),
    ).toEqual({
      Host: "example.com:443",
    });
  });
});

describe("parseEnvLines", () => {
  it("parses equals-separated env assignments and trims whitespace", () => {
    expect(
      parseEnvLines(`
        API_KEY = secret
        MODE= production
      `),
    ).toEqual({
      API_KEY: "secret",
      MODE: "production",
    });
  });

  it("ignores blank and malformed lines while preserving later equals in values", () => {
    expect(
      parseEnvLines(`
        missing
        = no-name
        URL=https://example.com?a=b
      `),
    ).toEqual({
      URL: "https://example.com?a=b",
    });
  });
});
