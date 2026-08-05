/**
 * Unit coverage locking which hosts count as loopback (no confirm prompt) vs
 * everything else for the attacker-reachable CONNECT deep link, plus the
 * storage-backed cloud bootstrap gate. Deterministic, no network harness.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isBootstrapGateRequired,
  isLoopbackGatewayHost,
} from "./use-startup-shell-controller";

/**
 * The `connect` deep link is attacker-reachable; the CONNECT_EVENT handler only
 * skips the user-confirmation prompt for a loopback (local-agent) gateway. This
 * locks which hosts are treated as loopback (no prompt) vs everything else
 * (prompt required).
 */
describe("isLoopbackGatewayHost (connect-confirm exemption)", () => {
  it("treats local-agent loopback hosts as exempt", () => {
    expect(isLoopbackGatewayHost("http://localhost:31337/")).toBe(true);
    expect(isLoopbackGatewayHost("http://127.0.0.1:31337/")).toBe(true);
    expect(isLoopbackGatewayHost("http://127.5.5.5/")).toBe(true);
    expect(isLoopbackGatewayHost("http://[::1]:2138/")).toBe(true);
    expect(isLoopbackGatewayHost("http://0.0.0.0/")).toBe(true);
  });

  it("requires confirmation for any non-loopback host", () => {
    expect(isLoopbackGatewayHost("http://192.168.1.50:31337/")).toBe(false);
    expect(isLoopbackGatewayHost("http://10.0.0.5/")).toBe(false);
    expect(isLoopbackGatewayHost("https://agent.attacker.example/")).toBe(
      false,
    );
    expect(isLoopbackGatewayHost("http://my-box.local/")).toBe(false);
    expect(isLoopbackGatewayHost("http://host.ts.net/")).toBe(false);
    // A host that merely starts with "127" but isn't the loopback block.
    expect(isLoopbackGatewayHost("http://127box.example/")).toBe(false);
    expect(isLoopbackGatewayHost("not a url")).toBe(false);
  });
});

describe("isBootstrapGateRequired", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("holds startup on bootstrap before protected first-run probes can run", () => {
    vi.stubGlobal("sessionStorage", { getItem: () => null });

    expect(isBootstrapGateRequired("first-run-required", true)).toBe(true);
  });

  it("releases the bootstrap gate after the session exchange", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) =>
        key === "eliza_session" ? "bootstrap-session" : null,
    });

    expect(isBootstrapGateRequired("first-run-required", true)).toBe(false);
  });
});
