/**
 * Fail-closed coverage for cached elizaOS token prices that feed redemption
 * quotes. The harness mocks the DB and source-fetch seam so corrupt persisted
 * NUMERIC values are exercised without network, while the service still runs
 * the same cache-read, validation, and quote code used in production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();

vi.mock("../../db/client", () => ({
  dbRead: {
    query: { elizaTokenPrices: { findFirst: (...args: unknown[]) => findFirst(...args) } },
  },
  dbWrite: { insert: vi.fn(() => ({ values: vi.fn() })) },
}));

vi.mock("../../db/schemas/token-redemptions", () => ({
  elizaTokenPrices: {
    network: "network",
    fetched_at: "fetched_at",
  },
}));

vi.mock("../utils/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Import AFTER mocks so the service binds to the mocked db client + logger.
const { CorruptCachedElizaPriceError, ElizaTokenPriceService, parseCachedPriceUsd } = await import(
  "./eliza-token-price"
);
const { logger } = await import("../utils/logger");

describe("parseCachedPriceUsd (fail-closed NUMERIC boundary)", () => {
  it("parses a normal decimal string (driver returns NUMERIC as string)", () => {
    expect(parseCachedPriceUsd("0.0125")).toBe(0.0125);
  });

  it("parses a numeric input", () => {
    expect(parseCachedPriceUsd(0.5)).toBe(0.5);
  });

  it("allows a price exactly at the MIN_ELIZA_PRICE_USD floor", () => {
    expect(parseCachedPriceUsd("0.000001")).toBe(0.000001);
    expect(parseCachedPriceUsd(0.000001)).toBe(0.000001);
  });

  it("REGRESSION: 'NaN'::numeric read-back throws instead of returning NaN", () => {
    // Postgres accepts 'NaN'::numeric; the driver hands it back as "NaN".
    expect(() => parseCachedPriceUsd("NaN")).toThrow(CorruptCachedElizaPriceError);
  });

  it("REGRESSION: a zero price throws (division-by-zero / infinite payout hazard)", () => {
    expect(() => parseCachedPriceUsd("0")).toThrow(CorruptCachedElizaPriceError);
    expect(() => parseCachedPriceUsd(0)).toThrow(CorruptCachedElizaPriceError);
  });

  it("REGRESSION: a sub-floor dust price throws (mirrors MIN_ELIZA_PRICE_USD guard)", () => {
    expect(() => parseCachedPriceUsd("0.0000001")).toThrow(CorruptCachedElizaPriceError);
  });

  it("throws on a negative price (negative payout hazard)", () => {
    expect(() => parseCachedPriceUsd("-1")).toThrow(CorruptCachedElizaPriceError);
  });

  it("REGRESSION: empty / whitespace-only string throws instead of coercing", () => {
    expect(() => parseCachedPriceUsd("")).toThrow(CorruptCachedElizaPriceError);
    expect(() => parseCachedPriceUsd("   ")).toThrow(CorruptCachedElizaPriceError);
  });

  it("throws on null / undefined (never returns NaN)", () => {
    expect(() => parseCachedPriceUsd(null)).toThrow(CorruptCachedElizaPriceError);
    expect(() => parseCachedPriceUsd(undefined)).toThrow(CorruptCachedElizaPriceError);
  });

  it("throws on a non-numeric string and on Infinity", () => {
    expect(() => parseCachedPriceUsd("not-a-number")).toThrow(CorruptCachedElizaPriceError);
    expect(() => parseCachedPriceUsd(Number.POSITIVE_INFINITY)).toThrow(
      CorruptCachedElizaPriceError,
    );
  });

  it("names the offending value in the error", () => {
    try {
      parseCachedPriceUsd("oops");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CorruptCachedElizaPriceError);
      expect((e as Error).message).toContain("oops");
    }
  });
});

// Access the private fetch/validate/cache seam through a narrow structural view
// so the cache behavior stays network-free without introducing `any`.
type ElizaPriceSeam = {
  fetchFromMultipleSources: (network: string) => Promise<unknown[]>;
  validatePrices: (prices: unknown[], network: string) => unknown;
  cachePrice: (network: string, quote: unknown) => Promise<void>;
};
const asSeam = (svc: InstanceType<typeof ElizaTokenPriceService>): ElizaPriceSeam =>
  svc as unknown as ElizaPriceSeam;

describe("ElizaTokenPriceService.getPrice (cached-price seam)", () => {
  const service = new ElizaTokenPriceService();
  const seam = asSeam(service);

  beforeEach(() => {
    findFirst.mockReset();
    (logger.error as unknown as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves a healthy cached price without re-fetching from sources", async () => {
    findFirst.mockResolvedValue({
      price_usd: "0.0200",
      source: "cache-test",
      fetched_at: new Date(),
    });
    const fetchSpy = vi.spyOn(seam, "fetchFromMultipleSources").mockResolvedValue([]);

    const quote = await service.getPrice("base");

    expect(quote.priceUsd).toBe(0.02);
    expect(quote.source).toBe("cache-test");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("REGRESSION: a corrupt 'NaN' cached price is IGNORED (cache miss) and never quoted", async () => {
    findFirst.mockResolvedValue({
      price_usd: "NaN",
      source: "corrupt-row",
      fetched_at: new Date(),
    });
    const validated = {
      priceUsd: 0.03,
      source: "fresh-fetch",
      timestamp: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      network: "base" as const,
    };
    vi.spyOn(seam, "fetchFromMultipleSources").mockResolvedValue([]);
    vi.spyOn(seam, "validatePrices").mockReturnValue(validated);
    vi.spyOn(seam, "cachePrice").mockResolvedValue(undefined);

    const quote = await service.getPrice("base");

    expect(quote.priceUsd).toBe(0.03);
    expect(quote.source).toBe("fresh-fetch");
    expect(Number.isNaN(quote.priceUsd)).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("REGRESSION: a corrupt cached row does not fabricate a NaN quote via getQuote", async () => {
    findFirst.mockResolvedValue({
      price_usd: "NaN",
      source: "corrupt-row",
      fetched_at: new Date(),
    });
    const validated = {
      priceUsd: 0.04,
      source: "fresh-fetch",
      timestamp: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      network: "base" as const,
    };
    vi.spyOn(seam, "fetchFromMultipleSources").mockResolvedValue([]);
    vi.spyOn(seam, "validatePrices").mockReturnValue(validated);
    vi.spyOn(seam, "cachePrice").mockResolvedValue(undefined);

    const { elizaAmount, quote } = await service.getQuote("base", 100);

    // 100 points = $1.00; at $0.04 the recovered quote yields 25 tokens.
    expect(quote.priceUsd).toBe(0.04);
    expect(elizaAmount).toBe(25);
    expect(Number.isNaN(elizaAmount)).toBe(false);
  });

  it("REGRESSION: a corrupt fresh source price does not fabricate a NaN quote", async () => {
    findFirst.mockResolvedValue(null);
    vi.spyOn(seam, "fetchFromMultipleSources").mockResolvedValue([
      { success: true, source: "corrupt-source", priceUsd: Number.NaN },
    ]);

    await expect(service.getPrice("base")).rejects.toThrow(/unusable elizaOS price/);
  });

  it("REGRESSION: a fresh dust source cannot disappear from quorum validation", async () => {
    findFirst.mockResolvedValue(null);
    vi.spyOn(seam, "fetchFromMultipleSources").mockResolvedValue([
      { success: true, source: "coingecko", priceUsd: 0.02 },
      { success: true, source: "dexscreener", priceUsd: 0 },
    ]);
    const cacheSpy = vi.spyOn(seam, "cachePrice").mockResolvedValue(undefined);

    await expect(service.getPrice("base")).rejects.toThrow(/unusable elizaOS price/);
    expect(cacheSpy).not.toHaveBeenCalled();
  });
});
