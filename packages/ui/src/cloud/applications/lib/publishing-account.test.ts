/**
 * Verifies publishing account reads against malformed Cloud JSON and proves
 * affiliate share URLs use the configured public console origin.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/api-client", () => ({
  api: (...args: unknown[]) => apiMock(...args),
}));

vi.mock("./native-cloud-nav", () => ({
  resolveCloudConsoleUrl: (path: string) => `https://cloud.example.test${path}`,
}));

const { getPublishingAccountData, publishingAffiliateUrl } = await import(
  "./publishing-account"
);

const VALID_BALANCE = {
  success: true,
  balance: { availableBalance: 42.5 },
};

afterEach(() => {
  apiMock.mockReset();
});

describe("publishing account context", () => {
  it("normalizes typed account data and derives an encoded public affiliate URL", async () => {
    apiMock
      .mockResolvedValueOnce({
        code: {
          code: " MAKER/20 ",
          is_active: true,
        },
      })
      .mockResolvedValueOnce(VALID_BALANCE);

    await expect(getPublishingAccountData()).resolves.toEqual({
      affiliate: { code: "MAKER/20", isActive: true },
      availableBalance: 42.5,
    });
    expect(apiMock.mock.calls).toEqual([
      ["/api/v1/affiliates"],
      ["/api/v1/redemptions/balance"],
    ]);
    expect(publishingAffiliateUrl("MAKER/20")).toBe(
      "https://cloud.example.test/login?affiliate=MAKER%2F20",
    );
  });

  it("distinguishes no affiliate code from a legacy code-only response", async () => {
    apiMock
      .mockResolvedValueOnce({ code: null })
      .mockResolvedValueOnce(VALID_BALANCE);
    await expect(getPublishingAccountData()).resolves.toEqual({
      affiliate: null,
      availableBalance: 42.5,
    });

    apiMock
      .mockResolvedValueOnce({ code: "MAKER20" })
      .mockResolvedValueOnce(VALID_BALANCE);
    await expect(getPublishingAccountData()).resolves.toEqual({
      affiliate: { code: "MAKER20", isActive: null },
      availableBalance: 42.5,
    });
  });

  it("rejects malformed affiliate and balance responses instead of rendering fabricated context", async () => {
    const malformedPairs = [
      [{ code: { code: "", is_active: true } }, VALID_BALANCE],
      [{ code: { code: "MAKER20", is_active: "yes" } }, VALID_BALANCE],
      [
        { code: { code: "MAKER20", is_active: true } },
        { success: false, balance: { availableBalance: 42.5 } },
      ],
      [
        { code: { code: "MAKER20", is_active: true } },
        { success: true, balance: { availableBalance: Number.NaN } },
      ],
    ];

    for (const [affiliate, balance] of malformedPairs) {
      apiMock.mockResolvedValueOnce(affiliate).mockResolvedValueOnce(balance);
      await expect(getPublishingAccountData()).rejects.toThrow();
    }
  });
});
