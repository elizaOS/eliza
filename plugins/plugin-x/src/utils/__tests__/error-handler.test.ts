import { describe, expect, it, vi } from "vitest";

vi.mock(
  "@elizaos/core",
  () => ({ logger: { warn: vi.fn(), error: vi.fn() } }),
  {
    virtual: true,
  },
);

import {
  getErrorType,
  isExplicitTwitterRejection,
  isRetryableError,
  TwitterError,
  TwitterErrorType,
} from "./error-handler.ts";

describe("isExplicitTwitterRejection", () => {
  it("classifies 4xx responses as explicit rejections", () => {
    expect(isExplicitTwitterRejection({ response: { status: 403 } })).toBe(
      true,
    );
    expect(isExplicitTwitterRejection({ code: 404 })).toBe(true);
  });

  it("excludes 5xx and non-status errors", () => {
    expect(isExplicitTwitterRejection({ response: { status: 500 } })).toBe(
      false,
    );
    expect(isExplicitTwitterRejection(new Error("network"))).toBe(false);
  });
});

describe("getErrorType", () => {
  it("classifies auth errors", () => {
    expect(getErrorType({ message: "unauthorized token" })).toBe(
      TwitterErrorType.AUTH,
    );
  });

  it("classifies rate limits", () => {
    expect(getErrorType({ response: { status: 429 } })).toBe(
      TwitterErrorType.RATE_LIMIT,
    );
  });

  it("classifies network errors", () => {
    expect(getErrorType(new Error("ECONNRESET"))).toBe(
      TwitterErrorType.NETWORK,
    );
  });

  it("preserves the type of a TwitterError", () => {
    const err = new TwitterError(TwitterErrorType.MEDIA, "bad media");
    expect(getErrorType(err)).toBe(TwitterErrorType.MEDIA);
  });
});

describe("isRetryableError", () => {
  it("returns true for rate limits and network errors", () => {
    expect(
      isRetryableError(new TwitterError(TwitterErrorType.RATE_LIMIT, "rl")),
    ).toBe(true);
    expect(
      isRetryableError(new TwitterError(TwitterErrorType.NETWORK, "net")),
    ).toBe(true);
  });

  it("returns false for auth and validation errors", () => {
    expect(
      isRetryableError(new TwitterError(TwitterErrorType.AUTH, "auth")),
    ).toBe(false);
  });
});
