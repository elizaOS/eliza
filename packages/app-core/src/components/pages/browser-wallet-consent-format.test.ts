import { describe, expect, it } from "vitest";
import {
  decodeBase64ForPreview,
  decodeSignableMessage,
  formatAddressForDisplay,
  formatWeiForDisplay,
  truncateMessageForDisplay,
} from "./browser-wallet-consent-format";

describe("formatAddressForDisplay", () => {
  it("returns (unknown) for empty input", () => {
    expect(formatAddressForDisplay("")).toBe("(unknown)");
  });

  it("returns short addresses unchanged", () => {
    expect(formatAddressForDisplay("0xabc")).toBe("0xabc");
  });

  it("ellipses long EVM addresses", () => {
    expect(
      formatAddressForDisplay("0x1234567890abcdef1234567890abcdef12345678"),
    ).toBe("0x1234…5678");
  });

  it("ellipses long Solana base58 addresses", () => {
    expect(
      formatAddressForDisplay("DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy"),
    ).toBe("DRpbCB…21hy");
  });
});

describe("formatWeiForDisplay", () => {
  it("returns 0 ETH for zero or empty", () => {
    expect(formatWeiForDisplay("")).toBe("0 ETH");
    expect(formatWeiForDisplay("0")).toBe("0 ETH");
  });

  it("formats a whole 1 ETH", () => {
    expect(formatWeiForDisplay("1000000000000000000")).toBe("1 ETH");
  });

  it("formats fractional ETH at 6-digit precision", () => {
    expect(formatWeiForDisplay("1500000000000000000")).toBe("1.5 ETH");
    expect(formatWeiForDisplay("123450000000000000")).toBe("0.12345 ETH");
  });

  it("falls back to wei suffix on garbage input", () => {
    expect(formatWeiForDisplay("not-a-number")).toBe("not-a-number wei");
  });
});

describe("decodeSignableMessage", () => {
  it("returns plain text inputs unchanged", () => {
    expect(decodeSignableMessage("hello world")).toBe("hello world");
  });

  it("decodes 0x-hex into UTF-8", () => {
    // "Sign in" → 0x5369676e20696e
    expect(decodeSignableMessage("0x5369676e20696e")).toBe("Sign in");
  });

  it("returns the original hex when it isn't valid UTF-8", () => {
    expect(decodeSignableMessage("0xff")).toBe("0xff");
  });

  it("returns short or non-hex inputs unchanged", () => {
    expect(decodeSignableMessage("0x")).toBe("0x");
    expect(decodeSignableMessage("0xnot")).toBe("0xnot");
  });
});

describe("decodeBase64ForPreview", () => {
  it("decodes base64 UTF-8 round trips", () => {
    const base64 = btoa("Sign in to example.com");
    expect(decodeBase64ForPreview(base64)).toBe("Sign in to example.com");
  });

  it("returns a friendly fallback for invalid base64", () => {
    expect(decodeBase64ForPreview("!!!not base64!!!")).toBe(
      "(unable to decode message)",
    );
  });
});

describe("truncateMessageForDisplay", () => {
  it("returns short messages unchanged", () => {
    expect(truncateMessageForDisplay("short", 240)).toBe("short");
  });

  it("appends a count suffix on long messages", () => {
    const long = "x".repeat(300);
    const result = truncateMessageForDisplay(long, 240);
    expect(result.startsWith("x".repeat(240))).toBe(true);
    expect(result).toContain("(60 more chars)");
  });
});
