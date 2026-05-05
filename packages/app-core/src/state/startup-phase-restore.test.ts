import { describe, expect, it } from "vitest";
import type { PersistedActiveServer } from "./persistence";
import { canRestoreActiveServer } from "./startup-phase-restore";

function server(
  kind: PersistedActiveServer["kind"],
  apiBase?: string,
): PersistedActiveServer {
  return {
    id: `${kind}:test`,
    kind,
    label: "Test server",
    ...(apiBase ? { apiBase } : {}),
  };
}

describe("canRestoreActiveServer", () => {
  it("rejects a local server when native has no HTTP origin or injected API base", () => {
    expect(
      canRestoreActiveServer({
        server: server("local"),
        clientApiAvailable: false,
        forceLocal: false,
        isDesktop: false,
      }),
    ).toBe(false);
  });

  it("rejects a cloud server without a runtime API base when native has no HTTP origin", () => {
    expect(
      canRestoreActiveServer({
        server: server("cloud"),
        clientApiAvailable: false,
        forceLocal: false,
        isDesktop: false,
      }),
    ).toBe(false);
  });

  it("allows remote or cloud servers with explicit API bases", () => {
    expect(
      canRestoreActiveServer({
        server: server("cloud", "https://agent.example.com"),
        clientApiAvailable: false,
        forceLocal: false,
        isDesktop: false,
      }),
    ).toBe(true);
    expect(
      canRestoreActiveServer({
        server: server("remote", "http://127.0.0.1:31337"),
        clientApiAvailable: false,
        forceLocal: false,
        isDesktop: false,
      }),
    ).toBe(true);
  });

  it("allows same-origin local restores on web and desktop restores", () => {
    expect(
      canRestoreActiveServer({
        server: server("local"),
        clientApiAvailable: true,
        forceLocal: false,
        isDesktop: false,
      }),
    ).toBe(true);
    expect(
      canRestoreActiveServer({
        server: server("local"),
        clientApiAvailable: false,
        forceLocal: false,
        isDesktop: true,
      }),
    ).toBe(true);
  });
});
