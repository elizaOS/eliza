import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertHostAllowed,
  assertUrlAllowed,
  classifyIpLiteral,
  safeFetch,
  setHostResolver,
  SsrfBlockedError,
} from "../../src/services/ssrf-guard.js";

/**
 * The verifier GET-probes URLs extracted from untrusted sub-agent narration, so
 * the guard is a security boundary: loopback is the one allowed non-public
 * range; every other off-public address (private, link-local incl. the
 * 169.254.169.254 cloud-metadata IP, CGNAT, ULA, multicast) must be blocked,
 * and neither DNS rebinding nor a redirect may slip past it.
 */

afterEach(() => {
  setHostResolver(); // reset to system resolver
  vi.unstubAllGlobals();
});

describe("classifyIpLiteral", () => {
  it("treats loopback (v4/v6/mapped) as loopback", () => {
    expect(classifyIpLiteral("127.0.0.1")).toBe("loopback");
    expect(classifyIpLiteral("127.5.6.7")).toBe("loopback");
    expect(classifyIpLiteral("::1")).toBe("loopback");
    expect(classifyIpLiteral("::ffff:127.0.0.1")).toBe("loopback");
  });

  it("blocks every off-public special-use range", () => {
    for (const ip of [
      "169.254.169.254", // cloud metadata
      "169.254.0.1", // link-local
      "10.0.0.5", // RFC1918
      "172.16.0.1", // RFC1918
      "172.31.255.255", // RFC1918 upper
      "192.168.1.1", // RFC1918
      "100.64.0.1", // CGNAT
      "0.0.0.0", // this network
      "224.0.0.1", // multicast
      "255.255.255.255", // broadcast
      "fd00::1", // ULA
      "fe80::1", // link-local v6
      "ff02::1", // multicast v6
      "::", // unspecified
      "not-an-ip", // garbage classifies as blocked
    ]) {
      expect(classifyIpLiteral(ip)).toBe("blocked");
    }
  });

  it("allows public addresses", () => {
    expect(classifyIpLiteral("8.8.8.8")).toBe("allowed");
    expect(classifyIpLiteral("1.1.1.1")).toBe("allowed");
    expect(classifyIpLiteral("172.32.0.1")).toBe("allowed"); // just outside /12
    expect(classifyIpLiteral("2606:4700:4700::1111")).toBe("allowed");
  });
});

describe("assertHostAllowed", () => {
  it("allows localhost without a DNS round-trip", async () => {
    setHostResolver(() => {
      throw new Error("resolver must not be called for localhost");
    });
    await expect(assertHostAllowed("localhost")).resolves.toBeUndefined();
  });

  it("blocks an IP-literal metadata host directly", async () => {
    await expect(assertHostAllowed("169.254.169.254")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("blocks a hostname that resolves to any internal address (DNS-rebinding defense)", async () => {
    setHostResolver(async () => [
      { address: "8.8.8.8" }, // public...
      { address: "169.254.169.254" }, // ...but also internal → must block
    ]);
    await expect(assertHostAllowed("rebind.example")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("allows a hostname that resolves only to public addresses", async () => {
    setHostResolver(async () => [{ address: "93.184.216.34" }]);
    await expect(assertHostAllowed("example.com")).resolves.toBeUndefined();
  });

  it("blocks when resolution fails or returns nothing", async () => {
    setHostResolver(async () => {
      throw new Error("NXDOMAIN");
    });
    await expect(assertHostAllowed("nope.invalid")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    setHostResolver(async () => []);
    await expect(assertHostAllowed("empty.invalid")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });
});

describe("assertUrlAllowed", () => {
  it("rejects non-http(s) protocols", async () => {
    await expect(assertUrlAllowed("file:///etc/passwd")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    await expect(assertUrlAllowed("gopher://8.8.8.8/")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("rejects an unparseable URL", async () => {
    await expect(assertUrlAllowed("http://")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("rejects a metadata URL and allows a public one", async () => {
    await expect(
      assertUrlAllowed("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertUrlAllowed("https://8.8.8.8/")).resolves.toBeUndefined();
  });
});

describe("safeFetch", () => {
  const fakeResponse = (
    status: number,
    location?: string,
  ): Response =>
    ({
      status,
      headers: new Headers(location ? { location } : {}),
      body: null,
    }) as unknown as Response;

  it("blocks the initial request to an internal host before fetching", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(safeFetch("http://169.254.169.254/")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("re-validates a redirect hop and blocks an internal Location", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(302, "http://169.254.169.254/")),
    );
    await expect(safeFetch("http://8.8.8.8/")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("returns the response for a non-redirect public fetch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse(200)));
    const res = await safeFetch("http://8.8.8.8/");
    expect(res.status).toBe(200);
  });

  it("rejects a redirect loop that exceeds the hop cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(302, "http://8.8.8.8/")),
    );
    await expect(safeFetch("http://8.8.8.8/")).rejects.toThrow(/too many redirects/);
  });
});
