/**
 * `isAllowedHost` is the DNS-rebinding / Host-header guard on the agent's HTTP
 * API (#8801). On a loopback bind it must accept only loopback / configured /
 * explicitly-allowed Host headers and REJECT an attacker-controlled host (the
 * rebinding vector that lets a malicious page in a browser reach the local
 * agent). The accept/reject paths and IPv6 parsing are pinned here.
 */
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAllowedHost } from "./server-helpers-auth.ts";

const ENV_KEYS = ["ELIZA_API_BIND", "ELIZA_ALLOWED_HOSTS"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const req = (host?: string): http.IncomingMessage =>
  ({ headers: host === undefined ? {} : { host } }) as http.IncomingMessage;

describe("isAllowedHost — default loopback bind", () => {
  it("allows a request with no / empty Host header (non-browser client)", () => {
    expect(isAllowedHost(req())).toBe(true);
    expect(isAllowedHost(req(""))).toBe(true);
  });

  it("allows loopback hosts (IPv4 + IPv6, with or without port/brackets)", () => {
    for (const h of [
      "localhost:31337",
      "127.0.0.1",
      "127.0.0.1:31337",
      "[::1]:31337",
      "::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isAllowedHost(req(h))).toBe(true);
    }
  });

  it("REJECTS an attacker-controlled host (DNS rebinding blocked)", () => {
    for (const h of [
      "evil.com",
      "evil.com:8080",
      "attacker.example:31337",
      "169.254.169.254", // cloud metadata IP — must not be allowed by default
    ]) {
      expect(isAllowedHost(req(h))).toBe(false);
    }
  });
});

describe("isAllowedHost — explicit allowlist", () => {
  it("allows a host on ELIZA_ALLOWED_HOSTS and still rejects others", () => {
    process.env.ELIZA_ALLOWED_HOSTS = "myapp.example, other.test";
    expect(isAllowedHost(req("myapp.example:31337"))).toBe(true);
    expect(isAllowedHost(req("other.test"))).toBe(true);
    expect(isAllowedHost(req("evil.com"))).toBe(false);
  });
});

describe("isAllowedHost — bind configuration", () => {
  it("allows the exact configured bind hostname", () => {
    process.env.ELIZA_API_BIND = "myhost.local";
    expect(isAllowedHost(req("myhost.local:31337"))).toBe(true);
    expect(isAllowedHost(req("evil.com"))).toBe(false);
  });

  it("accepts any Host when bound on all interfaces (0.0.0.0)", () => {
    // a wildcard bind is token-protected elsewhere, so Host is not the gate
    process.env.ELIZA_API_BIND = "0.0.0.0";
    expect(isAllowedHost(req("anything.example"))).toBe(true);
  });
});
