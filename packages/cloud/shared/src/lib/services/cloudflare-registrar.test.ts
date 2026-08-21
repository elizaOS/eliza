// Exercises cloudflare registrar behavior with deterministic cloud-shared lib fixtures.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  CorruptRegistrarPriceError,
  CorruptRegistrarRegistrationSchemaError,
  cloudflareRegistrarService,
  parseMinimumRegistrationYears,
  parseWholesaleUsdCents,
} from "./cloudflare-registrar";

/**
 * Guard: the dev stub (ELIZA_CF_REGISTRAR_DEV_STUB=1) fabricates registrations
 * but the buy route still debits credits, so it must never run in production.
 * `config()` reads via getCloudAwareEnv(), which falls back to process.env
 * outside a Worker context — so these tests drive it through process.env.
 */
describe("cloudflareRegistrarService production stub guard", () => {
  let savedEnvironment: string | undefined;
  let savedStub: string | undefined;

  beforeEach(() => {
    savedEnvironment = process.env.ENVIRONMENT;
    savedStub = process.env.ELIZA_CF_REGISTRAR_DEV_STUB;
  });

  afterEach(() => {
    if (savedEnvironment === undefined) delete process.env.ENVIRONMENT;
    else process.env.ENVIRONMENT = savedEnvironment;
    if (savedStub === undefined) delete process.env.ELIZA_CF_REGISTRAR_DEV_STUB;
    else process.env.ELIZA_CF_REGISTRAR_DEV_STUB = savedStub;
  });

  it("refuses the stub in production before any registrar work happens", async () => {
    process.env.ENVIRONMENT = "production";
    process.env.ELIZA_CF_REGISTRAR_DEV_STUB = "1";

    await expect(cloudflareRegistrarService.checkAvailability("guard-example.com")).rejects.toThrow(
      /production deployment/i,
    );
    await expect(cloudflareRegistrarService.registerDomain("guard-example.com", 1)).rejects.toThrow(
      /production deployment/i,
    );
  });

  it("still serves the stub outside production (dev/test)", async () => {
    process.env.ENVIRONMENT = "development";
    process.env.ELIZA_CF_REGISTRAR_DEV_STUB = "1";

    const availability = await cloudflareRegistrarService.checkAvailability("guard-example.com");
    expect(availability.available).toBe(true);

    const registration = await cloudflareRegistrarService.registerDomain("guard-example.com", 1);
    expect(registration.registrationId).toContain("stub-reg-");
  });
});

describe("parseMinimumRegistrationYears", () => {
  it("accepts and pins a two-year registry minimum", () => {
    expect(
      parseMinimumRegistrationYears("example.ai", {
        properties: { years: { type: "integer", minimum: 2, maximum: 10 } },
      }),
    ).toBe(2);
  });

  it("fails closed when the extension schema cannot prove a safe minimum", () => {
    for (const schema of [
      null,
      {},
      { properties: {} },
      { properties: { years: {} } },
      { properties: { years: { minimum: "2" } } },
      { properties: { years: { minimum: 0 } } },
      { properties: { years: { minimum: 11 } } },
      { properties: { years: { minimum: 1.5 } } },
    ]) {
      expect(() => parseMinimumRegistrationYears("example.ai", schema)).toThrow(
        CorruptRegistrarRegistrationSchemaError,
      );
    }
  });
});

describe("extension minimum and registration request binding", () => {
  it("queries the extension schema and POSTs the same two-year minimum", async () => {
    const savedEnvironment = process.env.ENVIRONMENT;
    const savedStub = process.env.ELIZA_CF_REGISTRAR_DEV_STUB;
    const savedAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    const savedToken = process.env.CLOUDFLARE_API_TOKEN;
    const savedFetch = globalThis.fetch;
    const requests: Array<{ url: string; body: unknown }> = [];

    process.env.ENVIRONMENT = "development";
    delete process.env.ELIZA_CF_REGISTRAR_DEV_STUB;
    process.env.CLOUDFLARE_ACCOUNT_ID = "account-test";
    process.env.CLOUDFLARE_API_TOKEN = "token-test";
    globalThis.fetch = async (request, init) => {
      const url = String(request);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url, body });
      const result = url.endsWith("/registrar/extensions/ai")
        ? {
            metadata: { name: "ai", tld: "ai" },
            registration_schema: {
              properties: { years: { type: "integer", minimum: 2, maximum: 10 } },
            },
          }
        : {
            domain_name: "example.ai",
            state: "succeeded",
            context: { registration: { domain_name: "example.ai", status: "active" } },
          };
      return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
        status: 200,
      });
    };

    try {
      const years = await cloudflareRegistrarService.getMinimumRegistrationYears("example.ai");
      expect(years).toBe(2);
      await cloudflareRegistrarService.registerDomain("example.ai", years);
      expect(requests).toHaveLength(2);
      expect(requests[0]?.url.endsWith("/registrar/extensions/ai")).toBe(true);
      expect(requests[1]?.body).toEqual({ domain_name: "example.ai", years: 2 });
    } finally {
      if (savedEnvironment === undefined) delete process.env.ENVIRONMENT;
      else process.env.ENVIRONMENT = savedEnvironment;
      if (savedStub === undefined) delete process.env.ELIZA_CF_REGISTRAR_DEV_STUB;
      else process.env.ELIZA_CF_REGISTRAR_DEV_STUB = savedStub;
      if (savedAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
      else process.env.CLOUDFLARE_ACCOUNT_ID = savedAccount;
      if (savedToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
      else process.env.CLOUDFLARE_API_TOKEN = savedToken;
      globalThis.fetch = savedFetch;
    }
  });
});

/**
 * Fail-closed price boundary. The Cloudflare wholesale price string flows
 * straight into the buy route's credit debit; a NaN here silently bypasses the
 * route's `amount <= 0` positive-amount guard and charges against a fabricated
 * price. `parseWholesaleUsdCents` must throw on any unparseable value rather
 * than yield NaN.
 */
describe("parseWholesaleUsdCents (money-out price boundary)", () => {
  it("parses a normal dollar-string price into rounded USD cents", () => {
    expect(parseWholesaleUsdCents("example.com", "registration_cost", "10.99")).toBe(1099);
    expect(parseWholesaleUsdCents("example.io", "registration_cost", "35.00")).toBe(3500);
    // Rounds to the nearest cent exactly as the previous inline Math.round did.
    expect(parseWholesaleUsdCents("example.dev", "renewal_cost", "15.005")).toBe(1501);
    expect(parseWholesaleUsdCents("example.app", "registration_cost", "12.994")).toBe(1299);
  });

  it("accepts a legitimate free / zero price (some TLDs/promos are $0)", () => {
    expect(parseWholesaleUsdCents("free.example", "registration_cost", "0")).toBe(0);
    expect(parseWholesaleUsdCents("free.example", "registration_cost", "0.00")).toBe(0);
    expect(parseWholesaleUsdCents("free.example", "renewal_cost", 0)).toBe(0);
  });

  it("accepts a numeric (non-string) price defensively", () => {
    expect(parseWholesaleUsdCents("example.com", "registration_cost", 10.99)).toBe(1099);
  });

  it("THROWS on an unparseable / non-finite / negative / absent price (never returns NaN)", () => {
    // These malformed values must never become a poisoned numeric debit amount.
    for (const bad of [
      "N/A",
      "free",
      "$10.99",
      "1e3",
      "0x10",
      "0b10",
      "+10.99",
      "",
      "   ",
      undefined,
      null,
      {},
      [],
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "-1",
      -5,
    ]) {
      expect(() => parseWholesaleUsdCents("corrupt.example", "registration_cost", bad)).toThrow(
        CorruptRegistrarPriceError,
      );
      // And it must NOT silently return a number.
      let returned: number | undefined;
      try {
        returned = parseWholesaleUsdCents("corrupt.example", "registration_cost", bad);
      } catch {
        returned = undefined;
      }
      expect(returned).toBeUndefined();
    }
  });

  it("attaches structured error metadata for repair and escalation", () => {
    try {
      parseWholesaleUsdCents("bad.example", "registration_cost", "0x10");
      throw new Error("expected parseWholesaleUsdCents to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CorruptRegistrarPriceError);
      expect((error as CorruptRegistrarPriceError).code).toBe("CORRUPT_REGISTRAR_PRICE");
      expect((error as CorruptRegistrarPriceError).context).toEqual({
        domain: "bad.example",
        field: "registration_cost",
        rawValue: "0x10",
        reason: "value is not a plain decimal money amount",
      });
      expect((error as CorruptRegistrarPriceError).severity).toBe("fatal");
    }
  });

  it("names the offending field + domain in the thrown error for audit", () => {
    expect(() => parseWholesaleUsdCents("bad.example", "renewal_cost", "N/A")).toThrow(
      /renewal_cost.*bad\.example/,
    );
  });

  it("pins the exact fail-open the fix closes: the old inline parse produced NaN", () => {
    // JavaScript comparison semantics make NaN an unsafe sentinel for debit guards.
    const oldInlineParse = (raw: string) => Math.round(Number(raw) * 100);
    expect(Number.isNaN(oldInlineParse("N/A"))).toBe(true);
    expect((Number.NaN as number) <= 0).toBe(false);
    expect(() => parseWholesaleUsdCents("corrupt.example", "registration_cost", "N/A")).toThrow(
      CorruptRegistrarPriceError,
    );
  });
});

/**
 * The dev-stub availability path returns concrete numeric prices; assert they
 * survive `fromCheckEntry` unchanged (behavior-preserving for real prices),
 * exercised end-to-end through the public checkAvailability API.
 */
describe("fromCheckEntry price parsing (behavior-preserving for valid prices)", () => {
  let savedEnvironment: string | undefined;
  let savedStub: string | undefined;

  beforeEach(() => {
    savedEnvironment = process.env.ENVIRONMENT;
    savedStub = process.env.ELIZA_CF_REGISTRAR_DEV_STUB;
    process.env.ENVIRONMENT = "development";
    process.env.ELIZA_CF_REGISTRAR_DEV_STUB = "1";
  });

  afterEach(() => {
    if (savedEnvironment === undefined) delete process.env.ENVIRONMENT;
    else process.env.ENVIRONMENT = savedEnvironment;
    if (savedStub === undefined) delete process.env.ELIZA_CF_REGISTRAR_DEV_STUB;
    else process.env.ELIZA_CF_REGISTRAR_DEV_STUB = savedStub;
  });

  it("returns a finite numeric priceUsdCents for a real available domain", async () => {
    const availability = await cloudflareRegistrarService.checkAvailability("pricing-ok.example");
    expect(availability.available).toBe(true);
    expect(Number.isFinite(availability.priceUsdCents)).toBe(true);
    expect(availability.priceUsdCents).toBeGreaterThanOrEqual(0);
  });

  it("throws when Cloudflare marks a domain registrable but omits pricing", async () => {
    const savedEnvironment = process.env.ENVIRONMENT;
    const savedStub = process.env.ELIZA_CF_REGISTRAR_DEV_STUB;
    const savedAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    const savedToken = process.env.CLOUDFLARE_API_TOKEN;
    const savedFetch = globalThis.fetch;

    process.env.ENVIRONMENT = "development";
    delete process.env.ELIZA_CF_REGISTRAR_DEV_STUB;
    process.env.CLOUDFLARE_ACCOUNT_ID = "account-test";
    process.env.CLOUDFLARE_API_TOKEN = "token-test";
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: {
            domains: [{ name: "missing-price.example", registrable: true }],
          },
        }),
        { status: 200 },
      );

    try {
      await expect(
        cloudflareRegistrarService.checkAvailability("missing-price.example"),
      ).rejects.toThrow(CorruptRegistrarPriceError);
    } finally {
      if (savedEnvironment === undefined) delete process.env.ENVIRONMENT;
      else process.env.ENVIRONMENT = savedEnvironment;
      if (savedStub === undefined) delete process.env.ELIZA_CF_REGISTRAR_DEV_STUB;
      else process.env.ELIZA_CF_REGISTRAR_DEV_STUB = savedStub;
      if (savedAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
      else process.env.CLOUDFLARE_ACCOUNT_ID = savedAccount;
      if (savedToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
      else process.env.CLOUDFLARE_API_TOKEN = savedToken;
      globalThis.fetch = savedFetch;
    }
  });
});
