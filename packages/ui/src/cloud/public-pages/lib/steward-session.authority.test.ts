/** Verifies a real login persistence and cookie-sync sequence publishes one authority epoch. */
// @vitest-environment jsdom

import {
  readStoredStewardToken,
  STEWARD_SESSION_CHANGE_EVENT,
  type StewardSessionChangeDetail,
  writeStoredStewardToken,
} from "@elizaos/plugin-elizacloud/steward-session-client";
import { afterEach, expect, it, vi } from "vitest";
import {
  consumeStewardServerCookieSynced,
  invalidateStewardServerCookieSyncMarker,
} from "../../lib/steward-session-cookie-sync-marker";
import {
  consumeStewardEmailBrowserProof,
  discardStewardEmailBrowserBinding,
  prepareStewardEmailBrowserBinding,
} from "./steward-email-login";
import { syncStewardSessionCookie } from "./steward-session";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  invalidateStewardServerCookieSyncMarker();
});

it("publishes exactly one present transition across login persistence and cookie sync", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const transitions: StewardSessionChangeDetail[] = [];
  const listener = (event: Event) => {
    transitions.push((event as CustomEvent<StewardSessionChangeDetail>).detail);
  };
  window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);

  try {
    await writeStoredStewardToken("login-token");
    await syncStewardSessionCookie("login-token");
  } finally {
    window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);
  }

  expect(transitions.map(({ state }) => state)).toEqual(["present"]);
});

it.each(["cancel", "newer-session"])(
  "real session sync refuses local publication after %s during its POST",
  async (mode) => {
    await writeStoredStewardToken("initial-token");
    const controller = new AbortController();
    let finishFetch!: (response: Response) => void;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishFetch = resolve;
        }),
    );
    const observedTokens: Array<string | null> = [];
    const changed = () => observedTokens.push(readStoredStewardToken());
    const legacy = vi.fn();
    window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, changed);
    window.addEventListener("steward-token-sync", legacy);
    try {
      const pending = syncStewardSessionCookie("phone-token", null, {
        verifiedPhone: "+14155552671",
        expectedToken: "initial-token",
        signal: controller.signal,
      });
      const refused = expect(pending).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
      if (mode === "cancel") controller.abort();
      else await writeStoredStewardToken("newer-token");
      finishFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      await refused;
      expect(readStoredStewardToken()).toBe(
        mode === "cancel" ? "initial-token" : "newer-token",
      );
      expect(observedTokens).toEqual(mode === "cancel" ? [] : ["newer-token"]);
      expect(legacy).not.toHaveBeenCalled();
      expect(
        consumeStewardServerCookieSynced(
          "phone-token",
          "/api/auth/steward-session",
        ),
      ).toBe(false);
    } finally {
      window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, changed);
      window.removeEventListener("steward-token-sync", legacy);
    }
  },
);

it("makes the owned cookie-sync marker visible during canonical publication", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  const proofs: boolean[] = [];
  const listener = () => {
    proofs.push(
      consumeStewardServerCookieSynced(
        "owned-phone-token",
        "/api/auth/steward-session",
      ),
    );
  };
  window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);
  try {
    await syncStewardSessionCookie("owned-phone-token", null, {
      expectedToken: null,
      signal: new AbortController().signal,
    });
    expect(proofs).toEqual([true]);
    expect(readStoredStewardToken()).toBe("owned-phone-token");
  } finally {
    window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);
  }
});

it("refuses an already superseded owned sync before posting", async () => {
  await writeStoredStewardToken("newer-token");
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  await expect(
    syncStewardSessionCookie("old-phone-token", null, {
      expectedToken: "initial-token",
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(readStoredStewardToken()).toBe("newer-token");
});

it("treats abort from a publication listener as committed authority", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("{}", { status: 200 }),
  );
  const controller = new AbortController();
  const abort = () => controller.abort();
  window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, abort);
  try {
    await expect(
      syncStewardSessionCookie("committed-token", null, {
        expectedToken: null,
        signal: controller.signal,
      }),
    ).resolves.toBeUndefined();
    expect(readStoredStewardToken()).toBe("committed-token");
    expect(
      consumeStewardServerCookieSynced(
        "committed-token",
        "/api/auth/steward-session",
      ),
    ).toBe(true);
  } finally {
    window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, abort);
  }
});

it("reuses same-email resend proof while isolating sibling email flows and rejecting wrong tenant/redirect", async () => {
  const first = await prepareStewardEmailBrowserBinding({
    email: "owner@example.test",
    tenantId: "tenant-a",
    redirectUri: `${window.location.origin}/login`,
    returnTo: "/auth/cli-login?session=local-fixture",
  });
  const resend = await prepareStewardEmailBrowserBinding({
    email: " Owner@Example.Test ",
    tenantId: "tenant-a",
    redirectUri: `${window.location.origin}/login`,
    returnTo: "/changed-during-resend",
    previousState: first.state,
  });
  expect(resend).toEqual(first);
  const sibling = await prepareStewardEmailBrowserBinding({
    email: "other@example.test",
    tenantId: "tenant-a",
    redirectUri: `${window.location.origin}/login`,
    returnTo: "/join",
    previousState: first.state,
  });
  expect(sibling.state).not.toBe(first.state);
  expect(
    consumeStewardEmailBrowserProof(
      first.state,
      "tenant-b",
      `${window.location.origin}/login`,
    ),
  ).toBeNull();
  expect(
    consumeStewardEmailBrowserProof(
      first.state,
      "tenant-a",
      "https://other.example/login",
    ),
  ).toBeNull();
  const own = consumeStewardEmailBrowserProof(
    first.state,
    "tenant-a",
    `${window.location.origin}/login`,
  );
  expect(own?.returnTo).toBe("/auth/cli-login?session=local-fixture");
  expect(
    consumeStewardEmailBrowserProof(
      first.state,
      "tenant-a",
      `${window.location.origin}/login`,
    ),
  ).toBeNull();
  expect(
    consumeStewardEmailBrowserProof(
      sibling.state,
      "tenant-a",
      `${window.location.origin}/login`,
    ),
  ).not.toBeNull();
});

it("cancels only the chosen email proof and refuses to initiate when browser proof storage is unavailable", async () => {
  const input = {
    email: "owner@example.test",
    tenantId: "tenant-a",
    redirectUri: `${window.location.origin}/login`,
    returnTo: "/join",
  };
  const first = await prepareStewardEmailBrowserBinding(input);
  const sibling = await prepareStewardEmailBrowserBinding(input);
  discardStewardEmailBrowserBinding(first.state);
  expect(
    consumeStewardEmailBrowserProof(
      first.state,
      input.tenantId,
      input.redirectUri,
    ),
  ).toBeNull();
  expect(
    consumeStewardEmailBrowserProof(
      sibling.state,
      input.tenantId,
      input.redirectUri,
    ),
  ).not.toBeNull();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Storage blocked", "SecurityError");
  });
  await expect(prepareStewardEmailBrowserBinding(input)).rejects.toThrow(
    "This browser cannot keep sign-in proof",
  );
});
