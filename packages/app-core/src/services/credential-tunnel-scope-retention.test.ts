/**
 * Retention of abandoned credential scopes.
 *
 * Eviction in the credential tunnel is otherwise entirely lazy: a scope leaves
 * the maps only when that same scope is touched again after its TTL, or when
 * every declared key has been redeemed. A child session that is killed, times
 * out, or whose owner never fulfils the request does neither, and `expireScopes`
 * — the only proactive sweep — has no production caller. These pin that
 * declaring a scope reclaims the dead ones, and that reclaiming them does not
 * disturb any scope that is still live.
 *
 * Uses the service's injected clock, so no timers and no real waiting.
 */
import { describe, expect, it } from "vitest";
import { createCredentialTunnelService } from "./credential-tunnel-service.ts";

const TTL_MS = 100;

function makeService(clock: { now: number }) {
  return createCredentialTunnelService({
    ttlMs: TTL_MS,
    now: () => clock.now,
  });
}

describe("credential tunnel: abandoned scope retention", () => {
  it("reclaims scopes abandoned by their child session when a new one is declared", () => {
    const clock = { now: 1_000 };
    const service = makeService(clock);

    // 50 sub-agents each declare a scope and are then killed without ever
    // redeeming the key they declared.
    for (let i = 0; i < 50; i += 1) {
      service.declareScope({
        childSessionId: `pty-abandoned-${i}`,
        credentialKeys: ["OPENAI_API_KEY"],
      });
    }

    clock.now += TTL_MS * 10;

    // The next sub-agent declares its scope.
    service.declareScope({
      childSessionId: "pty-live",
      credentialKeys: ["OPENAI_API_KEY"],
    });

    // Nothing is left for a sweep to find: the 50 dead scopes were reclaimed
    // by that declare rather than being retained for the runtime's lifetime.
    expect(service.expireScopes()).toBe(0);
  });

  it("reclaims a scope whose child redeemed only some of its declared keys", () => {
    const clock = { now: 1_000 };
    const service = makeService(clock);

    const scope = service.declareScope({
      childSessionId: "pty-partial",
      credentialKeys: ["KEY_A", "KEY_B"],
    });
    service.tunnelCredential({
      childSessionId: "pty-partial",
      credentialScopeId: scope.credentialScopeId,
      key: "KEY_A",
      value: "value-a",
    });
    service.retrieveCredential({
      childSessionId: "pty-partial",
      key: "KEY_A",
      scopedToken: scope.scopedToken,
    });
    // KEY_B is never tunneled or redeemed, so the all-redeemed drop never fires.

    clock.now += TTL_MS * 10;
    service.declareScope({
      childSessionId: "pty-next",
      credentialKeys: ["KEY_C"],
    });

    expect(service.expireScopes()).toBe(0);
  });

  it("leaves a still-live scope usable across a later declare", () => {
    const clock = { now: 1_000 };
    const service = makeService(clock);

    const live = service.declareScope({
      childSessionId: "pty-live",
      credentialKeys: ["OPENAI_API_KEY"],
    });
    service.tunnelCredential({
      childSessionId: "pty-live",
      credentialScopeId: live.credentialScopeId,
      key: "OPENAI_API_KEY",
      value: "sk-live-value",
    });

    // Time moves, but not past the live scope's TTL.
    clock.now += TTL_MS - 1;
    service.declareScope({
      childSessionId: "pty-other",
      credentialKeys: ["OTHER_KEY"],
    });

    expect(
      service.retrieveCredential({
        childSessionId: "pty-live",
        key: "OPENAI_API_KEY",
        scopedToken: live.scopedToken,
      }),
    ).toBe("sk-live-value");
  });

  it("still refuses an expired scope", () => {
    const clock = { now: 1_000 };
    const service = makeService(clock);

    const scope = service.declareScope({
      childSessionId: "pty-expired",
      credentialKeys: ["OPENAI_API_KEY"],
    });
    service.tunnelCredential({
      childSessionId: "pty-expired",
      credentialScopeId: scope.credentialScopeId,
      key: "OPENAI_API_KEY",
      value: "sk-expired-value",
    });

    clock.now += TTL_MS * 10;

    expect(() =>
      service.retrieveCredential({
        childSessionId: "pty-expired",
        key: "OPENAI_API_KEY",
        scopedToken: scope.scopedToken,
      }),
    ).toThrowError();
  });

  it("still reports the sweep count when expireScopes is called directly", () => {
    const clock = { now: 1_000 };
    const service = makeService(clock);

    service.declareScope({
      childSessionId: "pty-1-a",
      credentialKeys: ["K1"],
    });
    service.declareScope({
      childSessionId: "pty-1-b",
      credentialKeys: ["K2"],
    });

    clock.now += TTL_MS * 10;

    expect(service.expireScopes()).toBe(2);
    expect(service.expireScopes()).toBe(0);
  });
});
