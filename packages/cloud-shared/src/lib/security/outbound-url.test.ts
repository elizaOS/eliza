import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

const lookupMock = vi.fn();

vi.mock("node:dns/promises", () => ({
  lookup: lookupMock,
}));

const { assertSafeOutboundUrl, isForbiddenIpAddress } = await import("./outbound-url");

// `vi.mock("node:dns/promises")` is process-global in bun:test, so this stub
// leaks into every suite loaded afterwards. Left in its reset (undefined-
// returning) state it makes `assertSafeOutboundUrl` treat every host as
// unresolvable — which silently broke waifu-webhook delivery tests downstream.
// Restore a benign default (a public IP) once this suite finishes so inherited
// callers resolve cleanly without real DNS.
afterAll(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

describe("outbound URL SSRF validation", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  test.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.2.1",
    "192.168.0.1",
    "198.18.0.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fd00::1",
    "fe80::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:a00:1",
  ])("classifies %s as forbidden", (address) => {
    expect(isForbiddenIpAddress(address)).toBe(true);
  });

  test.each([
    "8.8.8.8",
    "1.1.1.1",
    "2606:4700:4700::1111",
  ])("classifies %s as public", (address) => {
    expect(isForbiddenIpAddress(address)).toBe(false);
  });

  test.each([
    "ftp://example.com/file",
    "https://user:pass@example.com/",
    "http://localhost:3000/",
    "http://service.localhost/",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://169.254.169.254/latest/meta-data/",
  ])("rejects unsafe URL syntax or direct host %s", async (url) => {
    await expect(assertSafeOutboundUrl(url)).rejects.toThrow();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  test("accepts public hostnames resolving only to public addresses", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);

    await expect(assertSafeOutboundUrl("https://example.com/path")).resolves.toMatchObject({
      hostname: "example.com",
      protocol: "https:",
    });
    expect(lookupMock).toHaveBeenCalledWith("example.com", {
      all: true,
      verbatim: true,
    });
  });

  test("rejects hostnames resolving to any private or reserved address", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ]);

    await expect(assertSafeOutboundUrl("https://example.com/")).rejects.toThrow(
      "Endpoint resolves to a private or reserved IP address",
    );
  });

  test("rejects DNS failures and empty DNS answers", async () => {
    lookupMock.mockRejectedValueOnce(new Error("dns failed"));
    await expect(assertSafeOutboundUrl("https://example.com/")).rejects.toThrow(
      "Unable to resolve endpoint hostname",
    );

    lookupMock.mockResolvedValueOnce([]);
    await expect(assertSafeOutboundUrl("https://example.com/")).rejects.toThrow(
      "Unable to resolve endpoint hostname",
    );
  });
});
