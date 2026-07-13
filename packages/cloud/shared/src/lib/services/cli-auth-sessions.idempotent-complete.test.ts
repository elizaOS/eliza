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
 * Only the completion boundary and lifecycle repositories are doubled; the
 * CLI-auth service logic under test is real.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { cliAuthSessionsRepository } from "../../db/repositories";
import type { CliAuthSession } from "../../db/schemas/cli-auth-sessions";
import { cliAuthSessionCompletionService } from "./cli-auth-session-completion";
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

function completionState(session: CliAuthSession, keyPrefix?: string) {
  return {
    session,
    apiKey: keyPrefix
      ? ({
          id: API_KEY_ID,
          key_prefix: keyPrefix,
          expires_at: null,
          user_id: USER_ID,
          organization_id: ORG_ID,
        } as never)
      : undefined,
  };
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
      spyOn(cliAuthSessionCompletionService, "findActive").mockResolvedValue(
        completionState(pendingSession()),
      ),
    );
    const createSpy = track(
      spyOn(cliAuthSessionCompletionService, "claimPending").mockResolvedValue({
        claimed: true,
        session: authenticatedSession(USER_ID),
        apiKey: {
          id: API_KEY_ID,
          key_prefix: "ek_live_pre",
          expires_at: null,
        } as never,
      } as never),
    );
    const result = await cliAuthSessionsService.completeAuthentication(SESSION_ID, USER_ID, ORG_ID);

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(result.alreadyAuthenticated).toBe(false);
    expect(result.keyPrefix).toBe("ek_live_pre");
  });

  test("a same-user loser resolves the winning key metadata from the primary claim", async () => {
    track(
      spyOn(cliAuthSessionCompletionService, "findActive").mockResolvedValue(
        completionState(pendingSession()),
      ),
    );
    track(
      spyOn(cliAuthSessionCompletionService, "claimPending").mockResolvedValue({
        claimed: false,
        session: authenticatedSession(USER_ID),
        apiKey: {
          id: API_KEY_ID,
          key_prefix: "ek_live_pre",
          expires_at: null,
          user_id: USER_ID,
          organization_id: ORG_ID,
        } as never,
      }),
    );
    const result = await cliAuthSessionsService.completeAuthentication(SESSION_ID, USER_ID, ORG_ID);

    expect(result).toMatchObject({
      alreadyAuthenticated: true,
      keyPrefix: "ek_live_pre",
    });
  });

  test("re-completing an already-authenticated session by the SAME user is idempotent — success, no second key minted", async () => {
    track(
      spyOn(cliAuthSessionCompletionService, "findActive").mockResolvedValue(
        completionState(authenticatedSession(USER_ID), "ek_live_pre"),
      ),
    );
    const createSpy = track(spyOn(cliAuthSessionCompletionService, "claimPending"));

    const result = await cliAuthSessionsService.completeAuthentication(SESSION_ID, USER_ID, ORG_ID);

    // The crux of the regression fix: NO error thrown, and NO duplicate key.
    expect(result.alreadyAuthenticated).toBe(true);
    expect(result.keyPrefix).toBe("ek_live_pre");
    expect(createSpy).not.toHaveBeenCalled();
  });

  test("fails fast when an authenticated session references no API-key row", async () => {
    track(
      spyOn(cliAuthSessionCompletionService, "findActive").mockResolvedValue(
        completionState(authenticatedSession(USER_ID)),
      ),
    );

    await expect(
      cliAuthSessionsService.completeAuthentication(SESSION_ID, USER_ID, ORG_ID),
    ).rejects.toMatchObject({ code: "CLI_AUTH_SESSION_INTEGRITY" });
  });

  test("rejects an authenticated legacy session whose owner cannot be proven", async () => {
    const session = authenticatedSession(null);
    session.api_key_id = null;
    track(
      spyOn(cliAuthSessionCompletionService, "findActive").mockResolvedValue(
        completionState(session),
      ),
    );
    const createSpy = track(spyOn(cliAuthSessionCompletionService, "claimPending"));

    await expect(
      cliAuthSessionsService.completeAuthentication(SESSION_ID, USER_ID, ORG_ID),
    ).rejects.toThrow("Session already authenticated or expired");
    expect(createSpy).not.toHaveBeenCalled();
  });

  test("does NOT leak a session authenticated by a DIFFERENT user", async () => {
    track(
      spyOn(cliAuthSessionCompletionService, "findActive").mockResolvedValue(
        completionState(authenticatedSession(OTHER_USER_ID), "ek_live_pre"),
      ),
    );

    await expect(
      cliAuthSessionsService.completeAuthentication(SESSION_ID, USER_ID, ORG_ID),
    ).rejects.toThrow("Session already authenticated or expired");
  });

  test("rejects any other non-pending terminal state", async () => {
    const session = pendingSession();
    session.status = "expired";
    track(
      spyOn(cliAuthSessionCompletionService, "findActive").mockResolvedValue(
        completionState(session),
      ),
    );

    await expect(
      cliAuthSessionsService.completeAuthentication(SESSION_ID, USER_ID, ORG_ID),
    ).rejects.toThrow("Session already authenticated or expired");
  });

  test("a missing/expired session still throws the clear error", async () => {
    track(spyOn(cliAuthSessionCompletionService, "findActive").mockResolvedValue(undefined));

    await expect(
      cliAuthSessionsService.completeAuthentication(SESSION_ID, USER_ID, ORG_ID),
    ).rejects.toThrow("Invalid or expired session");
  });
});

describe("cliAuthSessionsService single-use reveal preconditions", () => {
  test("returns an explicit not-found result when the primary has no session", async () => {
    track(spyOn(cliAuthSessionsRepository, "findApiKeyRevealState").mockResolvedValue(undefined));
    const claim = track(spyOn(cliAuthSessionsRepository, "claimConsumed"));

    await expect(cliAuthSessionsService.getAndClearApiKey(SESSION_ID)).resolves.toEqual({
      status: "unavailable",
      reason: "not-found",
    });
    expect(claim).not.toHaveBeenCalled();
  });

  test("reports incomplete encrypted key material as an integrity failure", async () => {
    track(
      spyOn(cliAuthSessionsRepository, "findApiKeyRevealState").mockResolvedValue({
        session: authenticatedSession(USER_ID),
        apiKey: {
          id: API_KEY_ID,
          user_id: USER_ID,
          organization_id: ORG_ID,
          key_hash: "hash",
          key_ciphertext: null,
          key_nonce: "nonce",
          key_auth_tag: "auth-tag",
          key_kms_key_id: "kms-key",
          key_kms_key_version: 1,
          is_active: true,
          deleted_at: null,
          expires_at: null,
        } as never,
      }),
    );
    const claim = track(spyOn(cliAuthSessionsRepository, "claimConsumed"));

    await expect(cliAuthSessionsService.getAndClearApiKey(SESSION_ID)).rejects.toMatchObject({
      code: "CLI_AUTH_SESSION_INTEGRITY",
    });
    expect(claim).not.toHaveBeenCalled();
  });
});

describe("cliAuthSessionsService lifecycle", () => {
  test("creates a pending session with a ten-minute expiry", async () => {
    const create = track(
      spyOn(cliAuthSessionsRepository, "create").mockImplementation(async (input) => ({
        ...pendingSession(),
        ...input,
      })),
    );

    const before = Date.now();
    const session = await cliAuthSessionsService.createSession(SESSION_ID);
    const after = Date.now();

    expect(session.status).toBe("pending");
    expect(session.expires_at.getTime()).toBeGreaterThanOrEqual(before + 10 * 60_000);
    expect(session.expires_at.getTime()).toBeLessThanOrEqual(after + 10 * 60_000);
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("marks a stale repository result expired and returns no active session", async () => {
    const expired = pendingSession();
    expired.expires_at = new Date(Date.now() - 1_000);
    track(spyOn(cliAuthSessionsRepository, "findActiveBySessionId").mockResolvedValue(expired));
    const markExpired = track(
      spyOn(cliAuthSessionsRepository, "markExpired").mockResolvedValue(undefined),
    );

    await expect(cliAuthSessionsService.getActiveSession(SESSION_ID)).resolves.toBeNull();
    expect(markExpired).toHaveBeenCalledWith(SESSION_ID);
  });

  test("delegates expired-session cleanup to the repository", async () => {
    const removeExpired = track(
      spyOn(cliAuthSessionsRepository, "deleteExpiredSessions").mockResolvedValue(undefined),
    );

    await cliAuthSessionsService.cleanupExpiredSessions();
    expect(removeExpired).toHaveBeenCalledTimes(1);
  });
});
