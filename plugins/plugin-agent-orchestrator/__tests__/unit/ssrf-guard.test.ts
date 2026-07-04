/**
 * The verifier GET-probes URLs extracted from untrusted sub-agent narration, so
 * the guard is a security boundary: loopback is the one allowed non-public
 * range; every other off-public address (private, link-local incl. the
 * 169.254.169.254 cloud-metadata IP, CGNAT, ULA, multicast) must be blocked,
 * and neither DNS rebinding nor a redirect may slip past it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertHostAllowed,
  assertUrlAllowed,
  classifyIpLiteral,
  SsrfBlockedError,
  safeFetch,
  setHostResolver,
  setPinnedTransport,
} from "../../src/services/ssrf-guard.js";

afterEach(() => {
  setHostResolver(); // reset to system resolver
  setPinnedTransport(); // reset to the node pinned transport
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
    await expect(assertHostAllowed("localhost")).resolves.toBeNull();
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
    await expect(assertHostAllowed("example.com")).resolves.toEqual([
      "93.184.216.34",
    ]);
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
    await expect(assertUrlAllowed("https://8.8.8.8/")).resolves.toBeNull();
  });
});

describe("safeFetch", () => {
  const fakeResponse = (status: number, location?: string): Response =>
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(200)),
    );
    const res = await safeFetch("http://8.8.8.8/");
    expect(res.status).toBe(200);
  });

  it("rejects a redirect loop that exceeds the hop cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(302, "http://8.8.8.8/")),
    );
    await expect(safeFetch("http://8.8.8.8/")).rejects.toThrow(
      /too many redirects/,
    );
  });
});

describe("safeFetch DNS-rebinding pin (#11028)", () => {
  const fakeResponse = (status: number, location?: string): Response =>
    ({
      status,
      headers: new Headers(location ? { location } : {}),
      body: null,
    }) as unknown as Response;

  it("connects hostname targets through the PINNED transport with the vetted addresses, never plain fetch", async () => {
    // Rebinding resolver: answers PUBLIC on the vetting lookup and the
    // metadata IP on any subsequent lookup. The connection must use the first
    // (vetted) answer — a second resolution is the TOCTOU under test.
    let calls = 0;
    setHostResolver(async () => {
      calls += 1;
      return calls === 1
        ? [{ address: "93.184.216.34" }]
        : [{ address: "169.254.169.254" }];
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const transport = vi.fn(async () => fakeResponse(200));
    setPinnedTransport(transport);

    const res = await safeFetch("http://build-preview.example/");
    expect(res.status).toBe(200);
    // The request went through the pinned transport with the VETTED address…
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(
      "http://build-preview.example/",
      expect.anything(),
      ["93.184.216.34"],
    );
    // …and never through plain fetch (which would re-resolve DNS and hand the
    // rebinding resolver its second, internal answer).
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("re-vets and re-pins every redirect hop with that hop's own addresses", async () => {
    setHostResolver(async (host) =>
      host === "a.example"
        ? [{ address: "93.184.216.34" }]
        : [{ address: "142.250.72.14" }],
    );
    const transport = vi.fn(async (url: string) =>
      url.startsWith("http://a.example")
        ? fakeResponse(302, "http://b.example/next")
        : fakeResponse(200),
    );
    setPinnedTransport(transport);

    const res = await safeFetch("http://a.example/");
    expect(res.status).toBe(200);
    expect(transport).toHaveBeenNthCalledWith(
      1,
      "http://a.example/",
      expect.anything(),
      ["93.184.216.34"],
    );
    expect(transport).toHaveBeenNthCalledWith(
      2,
      "http://b.example/next",
      expect.anything(),
      ["142.250.72.14"],
    );
  });

  it("still blocks a hostname whose vetting resolution is internal (pin never reached)", async () => {
    setHostResolver(async () => [{ address: "169.254.169.254" }]);
    const transport = vi.fn();
    setPinnedTransport(transport);
    await expect(safeFetch("http://evil.example/")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it("IP-literal and localhost targets keep using plain fetch (no DNS to rebind)", async () => {
    const fetchSpy = vi.fn(async () => fakeResponse(200));
    vi.stubGlobal("fetch", fetchSpy);
    const transport = vi.fn();
    setPinnedTransport(transport);
    await safeFetch("http://127.0.0.1:3000/build");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(transport).not.toHaveBeenCalled();
  });
});
