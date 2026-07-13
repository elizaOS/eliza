/**
 * CLI auth session completion is idempotent (fix: staging cli-login regression
 * 2026-07-12).
 *
 * REGRESSION: the browser cli-login page POSTs
 * `/api/auth/cli-session/:id/complete` inside a React effect that can fire more
 * than once for the same session — StrictMode double-invoke, an effect re-run
 * when `ready`/`authenticated` transition, a retry, or the user revisiting the
 * same `?session=` URL within the 10-minute TTL. The FIRST POST flips the
 * session pending -> authenticated and mints the CLI API key. The SECOND POST
 * used to throw `"Session already authenticated or expired"`, which the page
 * rendered as a hard "Authentication Error — Session already authenticated or
 * expired" even though the user WAS signed in.
 *
 * Root cause: `completeAuthentication` treated any non-`pending` status
 * (including `authenticated`) as an error. Because the CLI/device receives the
 * plaintext key via the separate single-use poll endpoint (getAndClearApiKey)
 * and the browser only reads `keyPrefix`, a re-completion by the SAME user is
 * safe to treat as idempotent success.
 *
 * These tests pin the fixed behaviour:
 *  - pending  -> mints a key, alreadyAuthenticated=false (negative control)
 *  - re-complete by the SAME user -> success, alreadyAuthenticated=true,
 *    NO second key minted, keyPrefix echoed from the existing api_keys row
 *  - authenticated by a DIFFERENT user -> still rejected (no session leak)
 *  - expired / null session -> still the clear error
 *
 * Only the two repository singletons + apiKeysService the service imports are
 * doubled; the service logic under test is real.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { apiKeysRepository, cliAuthSessionsRepository } from "../../db/repositories";
import type { CliAuthSession } from "../../db/schemas/cli-auth-sessions";
import { apiKeysService } from "./api-keys";
import { cliAuthSessionsService } from "./cli-auth-sessions";

const SESSION_ID = "sess-idem-1";
const USER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_USER_ID = "22222222-2222-2222-2222-222222222222";
const ORG_ID = "33333333-3333-3333-3333-333333333333";
const API_KEY_ID = "44444444-4444-4444-4444-444444444444";

function future(minutes = 10): Date {
  const d = new Date();
  d.setMinutes(d.getMinutes() + minutes);
  return d;
}

function pendingSession(): CliAuthSession {
  return {
    id: "row-1",
    session_id: SESSION_ID,
    user_id: null,
    api_key_id: null,
    consumed_at: null,
    status: "pending",
    expires_at: future(),
    authenticated_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  } as CliAuthSession;
}

function authenticatedSession(userId: string | null): CliAuthSession {
  return {
    ...pendingSession(),
    user_id: userId,
    api_key_id: API_KEY_ID,
    status: "authenticated",
    authenticated_at: new Date(),
  } as CliAuthSession;
}

const spies: Array<{ mockRestore: () => void }> = [];
function track<T extends { mockRestore: () => void }>(s: T): T {
  spies.push(s);
  return s;
}

beforeEach(() => {
  spies.length = 0;
});

afterEach(() => {
  for (const s of spies) s.mockRestore();
});

describe("cliAuthSessionsService.completeAuthentication idempotency", () => {
  test("pending session mints a key and reports alreadyAuthenticated=false (negative control)", async () => {
    track(
      spyOn(cliAuthSessionsRepository, "findActiveBySessionId").mockResolvedValue(pendingSession()),
    );
    const createSpy = track(
      spyOn(apiKeysService, "create").mockResolvedValue({
        apiKey: {
          id: API_KEY_ID,
          key_prefix: "ek_live_pre",
          expires_at: null,
        } as never,
        plainKey: "ek_live_plaintext_secret",
      } as never),
    );
    track(
      spyOn(cliAuthSessionsRepository, "markAuthenticated").mockResolvedValue(
        authenticatedSession(USER_ID),
      ),
    );

    const result = await cliAuthSessionsService.completeAuthentication(SESSION_ID, USER_ID, ORG_ID);

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(result.alreadyAuthenticated).toBe(false);
    expect(result.apiKey).toBe("ek_live_plaintext_secret");
    expect(result.keyPrefix).toBe("ek_live_pre");
  });

  test("re-completing an already-authenticated session by the SAME user is idempotent — success, no second key minted", async () => {
    track(
      spyOn(cliAuthSessionsRepository, "findActiveBySessionId").mockResolvedValue(
        authenticatedSession(USER_ID),
      ),
    );
    const createSpy = track(spyOn(apiKeysService, "create"));
    const markSpy = track(spyOn(cliAuthSessionsRepository, "markAuthenticated"));
    track(
      spyOn(apiKeysRepository, "findById").mockResolvedValue({
        id: API_KEY_ID,
        key_prefix: "ek_live_pre",
        expires_at: null,
      } as never),
    );

    const result = await cliAuthSessionsService.completeAuthentication(SESSION_ID, USER_ID, ORG_ID);

    // The crux of the regression fix: NO error thrown, and NO duplicate key.
    expect(result.alreadyAuthenticated).toBe(true);
    expect(result.keyPrefix).toBe("ek_live_pre");
    // Plaintext is never re-derivable (D-6) — the browser only needs keyPrefix.
    expect(result.apiKey).toBeNull();
    expect(createSpy).not.toHaveBeenCalled();
    expect(markSpy).not.toHaveBeenCalled();
  });

  test("re-completing when the api_keys row is gone still succeeds with a null keyPrefix", async () => {
    track(
      spyOn(cliAuthSessionsRepository, "findActiveBySessionId").mockResolvedValue(
        authenticatedSession(USER_ID),
      ),
    );
    track(spyOn(apiKeysRepository, "findById").mockResolvedValue(undefined as never));

    const result = await cliAuthSessionsService.completeAuthentication(SESSION_ID, USER_ID, ORG_ID);

    expect(result.alreadyAuthenticated).toBe(true);
    expect(result.keyPrefix).toBeNull();
  });

  test("rejects an authenticated legacy session whose owner cannot be proven", async () => {
    const session = authenticatedSession(null);
    session.api_key_id = null;
    track(spyOn(cliAuthSessionsRepository, "findActiveBySessionId").mockResolvedValue(session));
    const createSpy = track(spyOn(apiKeysService, "create"));

    await expect(
      cliAuthSessionsService.completeAuthentication(SESSION_ID, USER_ID, ORG_ID),
    ).rejects.toThrow("Session already authenticated or expired");
    expect(createSpy).not.toHaveBeenCalled();
  });

  test("does NOT leak a session authenticated by a DIFFERENT user", async () => {
    track(
      spyOn(cliAuthSessionsRepository, "findActiveBySessionId").mockResolvedValue(
        authenticatedSession(OTHER_USER_ID),
      ),
    );

    await expect(
      cliAuthSessionsService.completeAuthentication(SESSION_ID, USER_ID, ORG_ID),
    ).rejects.toThrow("Session already authenticated or expired");
  });

  test("rejects any other non-pending terminal state", async () => {
    const session = pendingSession();
    session.status = "expired";
    track(spyOn(cliAuthSessionsRepository, "findActiveBySessionId").mockResolvedValue(session));

    await expect(
      cliAuthSessionsService.completeAuthentication(SESSION_ID, USER_ID, ORG_ID),
    ).rejects.toThrow("Session already authenticated or expired");
  });

  test("a missing/expired session still throws the clear error", async () => {
    track(
      spyOn(cliAuthSessionsRepository, "findActiveBySessionId").mockResolvedValue(
        undefined as never,
      ),
    );

    await expect(
      cliAuthSessionsService.completeAuthentication(SESSION_ID, USER_ID, ORG_ID),
    ).rejects.toThrow("Invalid or expired session");
  });
});
