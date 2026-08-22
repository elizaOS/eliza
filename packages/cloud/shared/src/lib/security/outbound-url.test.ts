// Exercises outbound url behavior with deterministic cloud-shared lib fixtures.
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

const lookupMock = vi.fn();

vi.mock("node:dns/promises", () => ({
  lookup: lookupMock,
}));

const { assertSafeOutboundUrl, isForbiddenIpAddress, isSafeRegistrationUrl } = await import(
  "./outbound-url"
);

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
    // Deprecated IPv4-compatible IPv6 (`::/96`): the embedded IPv4 must be
    // screened — `::169.254.169.254` would otherwise reach cloud metadata.
    "::169.254.169.254",
    "::127.0.0.1",
    "::10.0.0.1",
    "::a9fe:a9fe", // compressed-hex form of ::169.254.169.254
    "::7f00:1", // compressed-hex form of ::127.0.0.1
    // IPv6 transition ranges embed an IPv4 the network may translate the
    // literal to, so the embedded address must be screened (W5-017):
    "64:ff9b::a9fe:a9fe", // NAT64 (RFC 6052) for 169.254.169.254
    "64:ff9b::169.254.169.254", // NAT64 dotted-quad tail
    "64:ff9b::7f00:1", // NAT64 for 127.0.0.1
    "2002:a9fe:a9fe::", // 6to4 (RFC 3056) for 169.254.169.254
    "2002:ac10:1::", // 6to4 for 172.16.0.1
    "2001:0::5601:5601", // Teredo (RFC 4380) for 169.254.169.254
    "2001:0::80ff:ffff", // Teredo for 127.0.0.0
    // Leading-zero-expanded spellings of :: and ::1.
    "0:0:0:0:0:0:0:0",
    "0:0:0:0:0:0:0:1",
    "0000:0000:0000:0000:0000:0000:0000:0001",
    // Expanded documentation-range spelling (2001:db8::/32).
    "2001:0db8::1",
  ])("classifies %s as forbidden", (address) => {
    expect(isForbiddenIpAddress(address)).toBe(true);
  });

  test.each([
    "8.8.8.8",
    "1.1.1.1",
    "2606:4700:4700::1111",
    // Transition-range literals whose embedded IPv4 is public stay public.
    "64:ff9b::8.8.8.8", // NAT64 for 8.8.8.8
    "2002:808:808::", // 6to4 for 8.8.8.8
    "2001:0::f7f7:f7f7", // Teredo for 8.8.8.8
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

  test("never-settling DNS lookup returns when the caller signal aborts", async () => {
    lookupMock.mockReturnValue(
      new Promise(() => {
        /* never settles */
      }),
    );
    const controller = new AbortController();
    const reason = new DOMException("Aborted", "AbortError");
    const pending = assertSafeOutboundUrl("https://example.com/", {
      signal: controller.signal,
    });
    queueMicrotask(() => {
      controller.abort(reason);
    });
    const hung = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("assertSafeOutboundUrl ignored abort")), 80);
    });
    await expect(Promise.race([pending, hung])).rejects.toBe(reason);
  });
});

describe("isSafeRegistrationUrl", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  test("passes null/empty values — presence is the schema's job", () => {
    expect(isSafeRegistrationUrl(null)).toBe(true);
    expect(isSafeRegistrationUrl(undefined)).toBe(true);
    expect(isSafeRegistrationUrl("")).toBe(true);
  });

  test.each([
    "https://my-app.example.com",
    "https://my-app.example.com/path",
    "http://placeholder.invalid",
    "https://local-app.example.test",
  ])("accepts public registration URL %s without resolving DNS", (url) => {
    expect(isSafeRegistrationUrl(url)).toBe(true);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  test.each([
    "not-a-url",
    "ftp://example.com/file",
    "https://user:pass@example.com/",
    "http://localhost:3000",
    "https://localhost",
    "http://127.0.0.1:8080",
    "http://[::1]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.8/callback",
    "http://192.168.1.1/callback",
  ])("rejects unsafe registration URL %s", (url) => {
    expect(isSafeRegistrationUrl(url)).toBe(false);
  });
});
