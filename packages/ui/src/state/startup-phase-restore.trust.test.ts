// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isTrustedRestoreApiBaseUrl } from "./startup-phase-restore";

/**
 * The persisted active-server / agent-profile record is localStorage-backed and
 * could be tampered by an XSS or a malicious same-origin plugin view. The
 * restore + profile-switch paths only dial a "remote" apiBase whose host is
 * trusted; this locks which hosts pass (loopback / current-origin / private-LAN)
 * vs an arbitrary public attacker host (rejected, fail closed).
 */
describe("isTrustedRestoreApiBaseUrl", () => {
  it("trusts loopback and local-agent hosts", () => {
    expect(isTrustedRestoreApiBaseUrl("http://localhost:31337")).toBe(true);
    expect(isTrustedRestoreApiBaseUrl("http://127.0.0.1:31337")).toBe(true);
    expect(isTrustedRestoreApiBaseUrl("http://[::1]:2138")).toBe(true);
    expect(isTrustedRestoreApiBaseUrl("http://0.0.0.0")).toBe(true);
  });

  it("trusts the current page origin", () => {
    // jsdom default origin is http://localhost (already loopback); assert an
    // explicit same-host URL passes regardless.
    expect(isTrustedRestoreApiBaseUrl(`${window.location.origin}/api`)).toBe(
      true,
    );
  });

  it("trusts private / LAN / CGNAT / link-local hosts and private suffixes", () => {
    expect(isTrustedRestoreApiBaseUrl("http://192.168.1.50:31337")).toBe(true);
    expect(isTrustedRestoreApiBaseUrl("http://10.0.0.5")).toBe(true);
    expect(isTrustedRestoreApiBaseUrl("http://172.16.0.9")).toBe(true);
    expect(isTrustedRestoreApiBaseUrl("http://100.96.0.1")).toBe(true); // tailscale CGNAT
    expect(isTrustedRestoreApiBaseUrl("http://169.254.1.1")).toBe(true);
    expect(isTrustedRestoreApiBaseUrl("http://my-box.local")).toBe(true);
    expect(isTrustedRestoreApiBaseUrl("http://agent.ts.net")).toBe(true);
    expect(isTrustedRestoreApiBaseUrl("http://[fd00::1]")).toBe(true);
  });

  it("rejects arbitrary public hosts (the attacker-write vector)", () => {
    expect(isTrustedRestoreApiBaseUrl("https://attacker.example/")).toBe(false);
    expect(isTrustedRestoreApiBaseUrl("https://1.2.3.4/")).toBe(false);
    // 172.32 is outside the RFC1918 172.16-31 block.
    expect(isTrustedRestoreApiBaseUrl("http://172.32.0.1")).toBe(false);
    // 100.128 is outside the CGNAT 100.64-127 block.
    expect(isTrustedRestoreApiBaseUrl("http://100.128.0.1")).toBe(false);
    expect(
      isTrustedRestoreApiBaseUrl("http://evil.example.local.attacker.com"),
    ).toBe(false);
  });

  it("rejects non-http(s) schemes, malformed input, and empty values", () => {
    expect(isTrustedRestoreApiBaseUrl("javascript:alert(1)")).toBe(false);
    expect(isTrustedRestoreApiBaseUrl("file:///etc/passwd")).toBe(false);
    expect(isTrustedRestoreApiBaseUrl("not a url")).toBe(false);
    expect(isTrustedRestoreApiBaseUrl(undefined)).toBe(false);
    expect(isTrustedRestoreApiBaseUrl("")).toBe(false);
  });

  it("trusts the bundled on-device agent's IPC pseudo-base (iOS/Android local mode)", () => {
    // The mobile local-agent record is kind:"remote" with the in-process IPC
    // base — no network dial, no attacker-choosable host. Rejecting it made
    // every relaunch of a local-mode phone drop its saved on-device server
    // and silently un-complete first-run (found via the #11110 device boot
    // trace: boot ended at chat-first onboarding with no startup poll and
    // the Bun engine never started).
    expect(isTrustedRestoreApiBaseUrl("eliza-local-agent://ipc")).toBe(true);
    expect(isTrustedRestoreApiBaseUrl("eliza-local-agent://ipc/")).toBe(true);
  });

  it("still rejects other custom schemes and non-IPC authorities on the IPC scheme", () => {
    expect(isTrustedRestoreApiBaseUrl("evil-local-agent://ipc")).toBe(false);
    expect(isTrustedRestoreApiBaseUrl("eliza-local-agent://attacker.com")).toBe(
      false,
    );
  });
});
