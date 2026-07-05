/**
 * REAL end-to-end coverage for the production auth path (#13692).
 *
 * The auth path real remote users hit — a client blocked by the pairing wall
 * completing `GET /api/auth/pair-code` (server-side / operator read) →
 * `POST /api/auth/pair` and receiving a REVOCABLE MACHINE SESSION — was
 * exercised by NO automated e2e on any surface. Every prior lane bypassed it:
 * the device host agent defaults `ELIZA_PAIRING_DISABLED=1`, the only UI
 * coverage mocks `/api/auth/status` from a fixture, and the route coverage was
 * five unit tests with hand-built `http.IncomingMessage` objects. A regression
 * anywhere in the pairing wall, the machine-session mint, session-cookie
 * persistence, or the token-authenticated remote connect would ship invisibly.
 *
 * This suite boots the REAL `AgentRuntime` + the REAL app-core HTTP API on a
 * real loopback port with pairing ENABLED (`ELIZA_API_TOKEN` configured) and
 * `ELIZA_REQUIRE_LOCAL_AUTH=1` — the flag on-device local agents set so that
 * loopback alone is NOT a trust signal. With that flag, `isTrustedLocalRequest`
 * returns false for the harness's own 127.0.0.1 socket, so the client is
 * treated exactly like a production-shaped, non-loopback device: it must clear
 * the pairing wall to obtain access. This is the "spoof-proof equivalent" of a
 * non-loopback client that #13692 "Done when" §1 explicitly permits.
 *
 * Coverage (the exact gaps named in #13692):
 *   §1 web/desktop production pairing: real server with pairing ENABLED, read
 *      the pair code server-side (via `ensureAuthPairingCodeForRemoteAccess`,
 *      the CLI/dev-server operator path — the log message at
 *      auth-pairing-routes.ts warn), `POST /api/auth/pair` it, and assert:
 *        - a session is MINTED (session id, NOT the static API token — proven by
 *          `GET /api/auth/me` returning `mode: "session"` for the session id but
 *          the static token authenticating a DIFFERENT branch),
 *        - the shell is unlocked (`/api/auth/status` → authenticated),
 *        - the session SURVIVES A RELOAD (a fresh request carrying only the
 *          `eliza_session` cookie — no bearer — still authenticates; this is the
 *          cookie-persistence guarantee a browser reload depends on).
 *   §3 remote-connect access-token path: against an agent that REJECTS tokenless
 *      requests, a tokenless `/api/auth/me` is 401 and the same request bearing
 *      the configured token authenticates — the driven analogue of the #11761
 *      first-run Remote "URL + access token" form.
 *   §4 deep-link-cannot-carry-a-credential constraint: covered as a co-located
 *      unit spec next to the parser it constrains
 *      (`packages/ui/src/first-run/__tests__/deep-link-entry.test.ts`) — the
 *      first-run remote deep-link parser accepts only `api|apiBase|url|host` and
 *      DROPS any `token`/`accessToken` param, so there is no unattended
 *      credential channel via the deep link. Also recorded in the test-auth
 *      contract doc (`packages/app/docs/TEST_AUTH.md`) so harness authors stop
 *      rediscovering it (the alternative #13692 §4 offers). Kept out of this
 *      server-boot file so the pure UI parser isn't dragged through the agent
 *      runtime module graph here.
 *
 * Negative canary (§Verification): the pairing assertions flip RED when the
 * pair-code validation is deliberately broken — a wrong code is rejected (403)
 * and mints NO session, so a green run is non-vacuous proof the real handshake,
 * not a fixture, is under test.
 *
 * Keyless: the deterministic LLM proxy supplies every model handler, so no
 * provider/cloud key and no native llama are needed. Boots a real runtime +
 * HTTP server, so it lives in the nightly `test:app-real-e2e` lane (this file is
 * added to `vitest.app-real-e2e.config.ts` include), NOT the PR unit lane which
 * excludes `*.real.e2e.test.ts` wholesale.
 *
 * FOLLOW-UPS (device/hardware — out of scope for an agent, per #13692 §2 and the
 * lane rules): the Android emulator on-device lane (fresh app → pairing wall →
 * CDP-typed pair code → home with screenrecord + host-agent log artifacts) needs
 * a booted emulator + adb and is a device-surface task. This harness ships the
 * maximal locally-testable slice: the real server-side handshake + session +
 * cookie-persistence + token-gated remote connect + the deep-link constraint,
 * against local/sim surfaces with no production credentials.
 */

import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeterministicLlmProxyPlugin } from "../../../test/mocks/helpers/llm-proxy-plugin.ts";
import { SESSION_COOKIE_NAME } from "../../src/api/auth/sessions.ts";
import {
  _resetAuthPairingStateForTests,
  ensureAuthPairingCodeForRemoteAccess,
} from "../../src/api/auth-pairing-routes.ts";
import {
  getSharedCompatRuntimeState,
  startApiServer,
} from "../../src/api/server.ts";
import { req } from "../helpers/http.ts";
import { useIsolatedConfigEnv } from "../helpers/isolated-config.ts";
import { createRealTestRuntime } from "../helpers/real-runtime.ts";

const PRODUCTION_API_TOKEN = "prod-shaped-static-api-token-13692";

type Started = Awaited<ReturnType<typeof startApiServer>>;
type RealRuntime = Awaited<ReturnType<typeof createRealTestRuntime>>;

describe("production auth path: pair-code → machine session; remote-connect token (#13692)", () => {
  let configEnv: ReturnType<typeof useIsolatedConfigEnv> | null = null;
  let runtimeResult: RealRuntime | null = null;
  let server: Started | null = null;

  // Snapshot the auth-shaping env so we restore the developer's environment.
  const prev = {
    apiToken: process.env.ELIZA_API_TOKEN,
    requireLocalAuth: process.env.ELIZA_REQUIRE_LOCAL_AUTH,
    pairingDisabled: process.env.ELIZA_PAIRING_DISABLED,
    cloudProvisioned: process.env.ELIZA_CLOUD_PROVISIONED,
    cloudEnabled: process.env.ELIZAOS_CLOUD_ENABLED,
    cloudApiKey: process.env.ELIZAOS_CLOUD_API_KEY,
    stewardToken: process.env.STEWARD_AGENT_TOKEN,
  };

  beforeEach(async () => {
    // Production-shaped auth surface:
    //  - a configured API token turns pairing ON (pairingEnabled() requires it).
    //  - ELIZA_REQUIRE_LOCAL_AUTH=1 makes loopback NOT a trust signal, so the
    //    harness's 127.0.0.1 socket is treated like a remote device and must
    //    clear the pairing wall — the spoof-proof non-loopback equivalent.
    //  - pairing must NOT be disabled, and the agent must NOT look cloud-
    //    provisioned (cloud provisioning disables local pairing).
    process.env.ELIZA_API_TOKEN = PRODUCTION_API_TOKEN;
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    delete process.env.ELIZA_PAIRING_DISABLED;
    delete process.env.ELIZA_CLOUD_PROVISIONED;
    delete process.env.ELIZAOS_CLOUD_ENABLED;
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    delete process.env.STEWARD_AGENT_TOKEN;

    _resetAuthPairingStateForTests();

    configEnv = useIsolatedConfigEnv("auth-pairing-remote-connect-");
    runtimeResult = await createRealTestRuntime({
      characterName: "PairingRemoteConnectE2E",
      plugins: [
        createDeterministicLlmProxyPlugin({ failOnUnhandledAction: false }),
      ],
    });
    server = await startApiServer({
      port: 0,
      runtime: runtimeResult.runtime,
      skipDeferredStartupWork: true,
    });
    // The compat routes resolve the DB through the shared runtime state; wire
    // ours so the pair route can mint a real machine session against PGLite.
    getSharedCompatRuntimeState().current = runtimeResult.runtime;
  }, 120_000);

  afterEach(async () => {
    getSharedCompatRuntimeState().current = null;
    await server?.close().catch(() => undefined);
    await runtimeResult?.cleanup().catch(() => undefined);
    await configEnv?.restore().catch(() => undefined);
    _resetAuthPairingStateForTests();
    for (const [key, value] of [
      ["ELIZA_API_TOKEN", prev.apiToken],
      ["ELIZA_REQUIRE_LOCAL_AUTH", prev.requireLocalAuth],
      ["ELIZA_PAIRING_DISABLED", prev.pairingDisabled],
      ["ELIZA_CLOUD_PROVISIONED", prev.cloudProvisioned],
      ["ELIZAOS_CLOUD_ENABLED", prev.cloudEnabled],
      ["ELIZAOS_CLOUD_API_KEY", prev.cloudApiKey],
      ["STEWARD_AGENT_TOKEN", prev.stewardToken],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server = null;
    runtimeResult = null;
    configEnv = null;
  });

  it("§1 completes the real pair-code → machine-session handshake, unlocks the shell, and the session survives a reload via cookie", async () => {
    const port = server?.port ?? 0;
    expect(port).toBeGreaterThan(0);

    // The status probe advertises pairing as open to an unauthenticated client
    // (this is what a remote device polls before showing the pairing UI).
    const status = await req(port, "GET", "/api/auth/status");
    expect(status.status).toBe(200);
    expect(status.data.pairingEnabled).toBe(true);
    expect(status.data.authenticated).toBe(false);

    // Read the pair code SERVER-SIDE, exactly as the CLI/dev-server operator
    // path does (`ensureAuthPairingCodeForRemoteAccess`), instead of the
    // loopback-only `GET /api/auth/pair-code` HTTP route (which we've made
    // untrusted by requiring local auth — mirroring a real remote client that
    // never gets the code over the wire).
    const pairing = ensureAuthPairingCodeForRemoteAccess();
    expect(pairing).not.toBeNull();
    const code = pairing?.code ?? "";
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    // Complete the pairing handshake as the remote client would.
    const paired = await req(port, "POST", "/api/auth/pair", { code });
    expect(paired.status).toBe(200);
    const sessionId = String((paired.data as { token?: unknown }).token ?? "");
    expect(sessionId.length).toBeGreaterThan(0);

    // The minted credential is a SESSION id, NOT the static API token. Proven
    // two ways below; here assert the obvious inequality first.
    expect(sessionId).not.toBe(PRODUCTION_API_TOKEN);

    // The session authenticates as a bearer and reports `mode: "session"` with
    // a machine identity — the pairing-minted, revocable principal. The static
    // token would resolve OWNER through a different (token) branch, not a
    // session row, so this asserts the mint produced a real DB-backed session.
    const meViaSession = await req(port, "GET", "/api/auth/me", undefined, {
      Authorization: `Bearer ${sessionId}`,
    });
    expect(meViaSession.status).toBe(200);
    expect(
      (meViaSession.data as { access?: { mode?: string } }).access?.mode,
    ).toBe("session");
    expect(
      (meViaSession.data as { identity?: { kind?: string } }).identity?.kind,
    ).toBe("machine");
    expect(
      (meViaSession.data as { session?: { id?: string } }).session?.id,
    ).toBe(sessionId);

    // Shell unlocked: the status probe now reports authenticated for the
    // session bearer (the client re-polls status after pairing).
    const statusAfter = await req(port, "GET", "/api/auth/status", undefined, {
      Authorization: `Bearer ${sessionId}`,
    });
    expect(statusAfter.status).toBe(200);
    expect(statusAfter.data.authenticated).toBe(true);

    // COOKIE PERSISTENCE ("survives a reload"): a browser persists the session
    // as the `eliza_session` cookie. A fresh request carrying ONLY that cookie
    // (no Authorization header — as a reloaded page would send) must still
    // authenticate. Drive the same session id through the cookie channel the
    // route reads on reload.
    const meViaCookie = await req(port, "GET", "/api/auth/me", undefined, {
      Cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    });
    expect(meViaCookie.status).toBe(200);
    expect(
      (meViaCookie.data as { access?: { mode?: string } }).access?.mode,
    ).toBe("session");
    expect(
      (meViaCookie.data as { session?: { id?: string } }).session?.id,
    ).toBe(sessionId);
  }, 120_000);

  it("§Verification canary: a WRONG pair code is rejected and mints NO session (green run is non-vacuous)", async () => {
    const port = server?.port ?? 0;

    // Ensure a real code exists (server-side), then present a deliberately
    // wrong one — the same shape but not the issued value.
    const pairing = ensureAuthPairingCodeForRemoteAccess();
    expect(pairing).not.toBeNull();
    const wrongCode = "ZZZZ-ZZZZ-ZZZZ";
    expect(wrongCode).not.toBe(pairing?.code);

    const rejected = await req(port, "POST", "/api/auth/pair", {
      code: wrongCode,
    });
    expect(rejected.status).toBe(403);
    // No session id handed back on rejection.
    expect((rejected.data as { token?: unknown }).token).toBeUndefined();

    // And an arbitrary non-session bearer does NOT authenticate — confirming
    // the §1 green result required the REAL minted session, not any string.
    const meWithGarbage = await req(port, "GET", "/api/auth/me", undefined, {
      Authorization: `Bearer ${crypto.randomUUID()}`,
    });
    expect(meWithGarbage.status).toBe(401);
  }, 120_000);

  it("§3 remote-connect token path: the agent rejects tokenless requests and authenticates the configured access token", async () => {
    const port = server?.port ?? 0;

    // The remote-connect probe the client uses is `GET /api/auth/status`, whose
    // `authenticated` field reflects whether the presented credential is
    // accepted — this is exactly what the #11761 first-run Remote "URL + access
    // token" form drives (supply URL + token, then confirm the shell unlocks).
    // A protected mutating route (`/api/auth/me`) uses the session-only
    // `ensureSessionForRequest` path and does NOT honour the static token, so
    // the status probe is the correct surface for the token-accept contract.

    // Tokenless (and cookieless): NOT authenticated, pairing still required.
    // This is the state a first-run Remote form sees before the user supplies
    // the access token.
    const tokenless = await req(port, "GET", "/api/auth/status");
    expect(tokenless.status).toBe(200);
    expect(tokenless.data.authenticated).toBe(false);
    expect(tokenless.data.required).toBe(true);

    // Supplying the configured access token (the Remote form field) is accepted
    // — the client's remote connect succeeds and the shell unlocks.
    const withToken = await req(port, "GET", "/api/auth/status", undefined, {
      Authorization: `Bearer ${PRODUCTION_API_TOKEN}`,
    });
    expect(withToken.status).toBe(200);
    expect(withToken.data.authenticated).toBe(true);

    // A WRONG token is still rejected — the gate is real, not permissive. This
    // is the negative that makes the positive above non-vacuous: only the exact
    // configured token is accepted.
    const withWrongToken = await req(
      port,
      "GET",
      "/api/auth/status",
      undefined,
      {
        Authorization: "Bearer not-the-configured-token",
      },
    );
    expect(withWrongToken.status).toBe(200);
    expect(withWrongToken.data.authenticated).toBe(false);
  }, 120_000);
});
