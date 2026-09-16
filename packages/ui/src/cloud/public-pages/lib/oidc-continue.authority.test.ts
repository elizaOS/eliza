/** Exercises OIDC continuation through the real shared session coordinator with synthetic HTTP. */
// @vitest-environment jsdom

import {
  clearStoredStewardToken,
  getStewardTabSessionAuthorityCoordinator,
  resetStewardTabSessionAuthorityCoordinatorForTests,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { afterEach, expect, it, vi } from "vitest";
import { prepareOidcResumeTarget } from "./oidc-continue";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
  resetStewardTabSessionAuthorityCoordinatorForTests();
});

it("does not prepare an issuer redirect from a token invalidated while waiting", async () => {
  vi.stubEnv("VITE_OIDC_ISSUER_URL", "https://issuer.fixture.invalid");
  await writeStoredStewardToken("fixture-token");
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocker = getStewardTabSessionAuthorityCoordinator().runExclusive({
    kind: "session-sync",
    work: async () => {
      entered();
      await hold;
    },
  });
  await started;
  const logout = clearStoredStewardToken();
  const request = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", request);
  const target = prepareOidcResumeTarget(
    `eoq_${"a".repeat(64)}`,
    "staging.eliza.app",
  );
  release();
  await blocker;
  await logout;
  expect(await target).toEqual({ status: "session_sync_failed" });
  expect(request).not.toHaveBeenCalled();
});

it("prepares a valid issuer redirect after an uninterrupted real session sync", async () => {
  vi.stubEnv("VITE_OIDC_ISSUER_URL", "https://issuer.fixture.invalid");
  await writeStoredStewardToken("fixture-token");
  const request = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", request);
  const target = await prepareOidcResumeTarget(
    `eoq_${"a".repeat(64)}`,
    "staging.eliza.app",
  );
  expect(target.status).toBe("ok");
  expect(request).toHaveBeenCalledWith(
    "https://issuer.fixture.invalid/api/auth/steward-session",
    expect.objectContaining({
      method: "POST",
      credentials: "include",
      signal: expect.any(AbortSignal),
    }),
  );
});
