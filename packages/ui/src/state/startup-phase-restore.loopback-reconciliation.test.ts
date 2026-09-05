/** Verifies reconcilePersistedApiBaseWithLive across IPv6, alternate loopback, and remote boundaries. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const live = vi.hoisted(() => ({ apiBase: undefined as string | undefined }));

vi.mock("../utils/eliza-globals", () => ({
  getElizaApiBase: () => live.apiBase,
  getElizaApiToken: () => undefined,
}));

import { reconcilePersistedApiBaseWithLive } from "./startup-phase-restore";

describe("reconcilePersistedApiBaseWithLive", () => {
  beforeEach(() => {
    live.apiBase = undefined;
  });

  it("reconciles IPv6 loopback when live port changes", () => {
    live.apiBase = "http://[::1]:31338";
    expect(reconcilePersistedApiBaseWithLive("http://[::1]:31337")).toBe(
      "http://[::1]:31338",
    );
  });

  it("reconciles alternate 127.0.0.0/8 loopback when live port changes", () => {
    live.apiBase = "http://127.0.0.2:31338";
    expect(reconcilePersistedApiBaseWithLive("http://127.0.0.2:31337")).toBe(
      "http://127.0.0.2:31338",
    );
  });

  it("reconciles standard 127.0.0.1 and localhost loopbacks", () => {
    live.apiBase = "http://127.0.0.1:31338";
    expect(reconcilePersistedApiBaseWithLive("http://127.0.0.1:31337")).toBe(
      "http://127.0.0.1:31338",
    );

    live.apiBase = "http://localhost:31338";
    expect(reconcilePersistedApiBaseWithLive("http://localhost:31337")).toBe(
      "http://localhost:31338",
    );
  });

  it("reconciles across loopback forms (such as 127.0.0.1 to [::1])", () => {
    live.apiBase = "http://[::1]:31338";
    expect(reconcilePersistedApiBaseWithLive("http://127.0.0.1:31337")).toBe(
      "http://[::1]:31338",
    );
  });

  it("preserves persisted remote URL when live is loopback", () => {
    live.apiBase = "http://127.0.0.1:31338";
    expect(
      reconcilePersistedApiBaseWithLive("https://remote-agent.example.com"),
    ).toBe("https://remote-agent.example.com");
  });

  it("preserves persisted loopback URL when live is remote", () => {
    live.apiBase = "https://remote-agent.example.com";
    expect(reconcilePersistedApiBaseWithLive("http://127.0.0.1:31337")).toBe(
      "http://127.0.0.1:31337",
    );
  });

  it("does not reconcile lookalike or attacker hostnames", () => {
    live.apiBase = "http://127.0.0.1:31338";
    expect(
      reconcilePersistedApiBaseWithLive("http://127.0.0.1.attacker.com:31337"),
    ).toBe("http://127.0.0.1.attacker.com:31337");

    expect(
      reconcilePersistedApiBaseWithLive("http://localhost.evil.com:31337"),
    ).toBe("http://localhost.evil.com:31337");
  });

  it("returns unchanged on matching or missing URLs", () => {
    live.apiBase = "http://localhost:31337";
    expect(reconcilePersistedApiBaseWithLive("http://localhost:31337")).toBe(
      "http://localhost:31337",
    );

    live.apiBase = undefined;
    expect(reconcilePersistedApiBaseWithLive("http://localhost:31337")).toBe(
      "http://localhost:31337",
    );

    expect(reconcilePersistedApiBaseWithLive(undefined)).toBeUndefined();
    expect(reconcilePersistedApiBaseWithLive("not-a-valid-url")).toBe(
      "not-a-valid-url",
    );
  });
});
