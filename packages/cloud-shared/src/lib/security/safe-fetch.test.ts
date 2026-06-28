import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

const lookupMock = vi.fn();

vi.mock("node:dns/promises", () => ({
  lookup: lookupMock,
}));

const { createPinnedLookup, safeFetch } = await import("./safe-fetch");
const { resolveSafeOutboundTarget } = await import("./outbound-url");

// `vi.mock("node:dns/promises")` is process-global, so leave the stub returning
// a benign public IP for any suite that loads afterwards (see outbound-url.test).
afterAll(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

describe("createPinnedLookup", () => {
  test("returns the pinned address for the legacy (address, family) callback", () => {
    const cb = vi.fn();
    createPinnedLookup("93.184.216.34", 4)("example.com", {}, cb);
    expect(cb).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  });

  test("returns the pinned address as an array when `all` is requested", () => {
    const cb = vi.fn();
    createPinnedLookup("93.184.216.34", 4)("example.com", { all: true }, cb);
    expect(cb).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
  });

  test.each([
    "169.254.169.254",
    "127.0.0.1",
    "10.0.0.5",
    "::1",
  ])("rejects a pin that re-checks as a private/reserved address (%s)", (address) => {
    const cb = vi.fn();
    createPinnedLookup(address, address.includes(":") ? 6 : 4)("host", { all: true }, cb);
    const [error] = cb.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/private or reserved/i);
  });
});

describe("resolveSafeOutboundTarget (connection pin)", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  test("pins to the first validated resolved address", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "1.1.1.1", family: 4 },
    ]);

    const { url, address, family } = await resolveSafeOutboundTarget("https://example.com/path");
    expect(url.hostname).toBe("example.com");
    expect(address).toBe("93.184.216.34");
    expect(family).toBe(4);
  });

  test("pins an IP-literal target without a DNS round-trip", async () => {
    const { address, family } = await resolveSafeOutboundTarget("https://93.184.216.34/x");
    expect(address).toBe("93.184.216.34");
    expect(family).toBe(4);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  test("rejects when a host resolves to any private/reserved address", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ]);

    await expect(resolveSafeOutboundTarget("https://example.com/")).rejects.toThrow(
      "Endpoint resolves to a private or reserved IP address",
    );
  });

  // A redirect hop re-runs exactly this resolver, so a rebinding redirect host
  // is rejected before safeFetch can re-pin and re-issue the request.
  test("rejects a rebinding redirect host that now resolves to link-local metadata", async () => {
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);

    await expect(resolveSafeOutboundTarget("https://rebind.example/")).rejects.toThrow(
      "Endpoint resolves to a private or reserved IP address",
    );
  });
});

describe("safeFetch fail-closed", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  test("never connects when the target host resolves to a private address", async () => {
    // 127.0.0.1 has a live local listener (the test runner) — the unpinned
    // `assertSafeOutboundUrl(url) + fetch(url)` pattern would happily connect to
    // it on the second resolution. safeFetch rejects during validation, so no
    // socket is opened.
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);

    await expect(safeFetch("https://rebind.example/internal")).rejects.toThrow(
      "Endpoint resolves to a private or reserved IP address",
    );
  });

  test("rejects credential-bearing and non-http targets before any lookup", async () => {
    await expect(safeFetch("http://user:pass@example.com/")).rejects.toThrow();
    await expect(safeFetch("ftp://example.com/file")).rejects.toThrow();
    expect(lookupMock).not.toHaveBeenCalled();
  });
});
