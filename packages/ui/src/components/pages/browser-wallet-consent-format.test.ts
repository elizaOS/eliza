import { describe, expect, it } from "vitest";
import { formatWeiForDisplay } from "./browser-wallet-consent-format";

describe("formatWeiForDisplay", () => {
  it("does not show a non-zero amount as zero ETH", () => {
    expect(formatWeiForDisplay("1")).toBe("<0.000001 ETH");
  });

  it("keeps an exact ether amount and the smallest visible fraction", () => {
    expect(formatWeiForDisplay("0")).toBe("0 ETH");
    expect(formatWeiForDisplay("1000000000000000000")).toBe("1 ETH");
    expect(formatWeiForDisplay("1000000000000")).toBe("0.000001 ETH");
  });
});
