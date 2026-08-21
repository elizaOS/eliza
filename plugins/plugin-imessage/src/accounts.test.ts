/**
 * Static iMessage account policy compatibility tests; stateful pairing is
 * intentionally excluded because the live service owns that handshake.
 */
import { describe, expect, it } from "vitest";
import { isIMessageUserAllowed } from "./accounts";

describe("isIMessageUserAllowed", () => {
  it("fails closed for the stateful pairing policy", () => {
    expect(
      isIMessageUserAllowed({
        identifier: "+14155550123",
        accountConfig: { dmPolicy: "pairing" },
        isGroup: false,
      })
    ).toBe(false);
  });

  it("preserves static open and allowlist evaluation", () => {
    expect(
      isIMessageUserAllowed({
        identifier: "+14155550123",
        accountConfig: { dmPolicy: "open" },
        isGroup: false,
      })
    ).toBe(true);
    expect(
      isIMessageUserAllowed({
        identifier: "+14155550123",
        accountConfig: {
          dmPolicy: "allowlist",
          allowFrom: ["+14155550123"],
        },
        isGroup: false,
      })
    ).toBe(true);
  });
});
