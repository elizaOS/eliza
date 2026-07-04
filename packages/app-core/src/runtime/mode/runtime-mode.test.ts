/**
 * Remote mode is a thin controller for ANOTHER local/private Eliza instance —
 * never Eliza Cloud or a public model API. validateRemoteApiBase is the guard
 * that enforces this: only http(s) targeting loopback, .local mDNS, link-local,
 * or RFC1918/CGNAT hosts is accepted. Pointing remote mode at a public host
 * would let the controller drive an untrusted instance, so each rejection here
 * is a real safety boundary.
 */
import { describe, expect, it } from "vitest";
import {
  isLocalRemoteHost,
  isLocalRuntime,
  validateRemoteApiBase,
} from "./runtime-mode.ts";

describe("isLocalRemoteHost", () => {
  it("accepts loopback, .local, link-local, and private ranges", () => {
    for (const h of [
      "localhost",
      "dev.localhost",
      "my-box.local",
      "::1",
      "fe80::1",
      "10.0.0.5",
      "127.0.0.1",
      "169.254.1.1",
      "172.16.0.1",
      "192.168.1.20",
      "100.64.0.1", // CGNAT
    ]) {
      expect(isLocalRemoteHost(h)).toBe(true);
    }
  });

  it("rejects public hosts and out-of-range octets", () => {
    for (const h of [
      "example.com",
      "8.8.8.8",
      "172.32.0.1",
      "100.128.0.1",
      "1.2.3.4.5",
      "",
    ]) {
      expect(isLocalRemoteHost(h)).toBe(false);
    }
  });
});

describe("validateRemoteApiBase", () => {
  it("accepts a private http(s) URL and trims trailing slashes", () => {
    const ok = validateRemoteApiBase("http://192.168.1.10:3000/api/");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.href).toBe("http://192.168.1.10:3000/api");
  });

  it("rejects empty, non-URL, non-http, and public targets", () => {
    expect(validateRemoteApiBase("")).toMatchObject({ ok: false });
    expect(validateRemoteApiBase("not a url")).toMatchObject({ ok: false });
    expect(validateRemoteApiBase("ftp://localhost")).toMatchObject({
      ok: false,
    });
    expect(validateRemoteApiBase("https://example.com")).toMatchObject({
      ok: false,
    });
  });
});

describe("isLocalRuntime", () => {
  it("is true only for local / local-only modes", () => {
    expect(isLocalRuntime("local")).toBe(true);
    expect(isLocalRuntime("local-only")).toBe(true);
    expect(isLocalRuntime("remote")).toBe(false);
  });
});
