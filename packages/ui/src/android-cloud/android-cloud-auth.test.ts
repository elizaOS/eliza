// @vitest-environment jsdom

/**
 * Exercises attempt correlation and idempotent native callback completion with
 * a deterministic Cloud boundary and an in-memory stand-in for Android Keystore.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  pending: null as string | null,
  token: null as string | null,
}));

vi.mock("@capacitor/core", () => ({
  registerPlugin: () => ({
    get: vi.fn(async () => ({ value: harness.pending })),
    remove: vi.fn(async () => {
      harness.pending = null;
    }),
    set: vi.fn(async ({ value }: { value: string }) => {
      harness.pending = value;
    }),
  }),
}));

vi.mock("@elizaos/shared/steward-session-client", () => ({
  clearStoredStewardToken: vi.fn(async () => {
    harness.token = null;
  }),
  readStoredStewardToken: vi.fn(() => harness.token),
  writeStoredStewardToken: vi.fn(async (token: string) => {
    harness.token = token;
  }),
}));

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const config = () =>
  json(200, {
    success: true,
    clientId: "ai.elizaos.app",
    environment: "production",
    redirectUri: "https://eliza.app/auth/callback",
    codeChallengeMethod: "S256",
  });
const credentialId = "40000000-0000-4000-8000-000000000004";
const secret = `eliza_mobile_${"b".repeat(64)}`;
const token = () => json(200, { credentialId, secret });
const acknowledgement = () =>
  json(200, { success: true, status: "acknowledged", credentialId });

describe("Android Cloud native auth handoff", () => {
  beforeEach(() => {
    harness.pending = null;
    harness.token = null;
    localStorage.clear();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("preserves account-switch intent across module recreation", async () => {
    const first = await import("./android-cloud-auth");
    first.markAndroidCloudAccountSwitchPending();
    expect(first.isAndroidCloudAccountSwitchPending()).toBe(true);

    vi.resetModules();
    const recreated = await import("./android-cloud-auth");
    expect(recreated.isAndroidCloudAccountSwitchPending()).toBe(true);
    recreated.clearAndroidCloudAccountSwitchPending();
    expect(recreated.isAndroidCloudAccountSwitchPending()).toBe(false);
  });

  it("keeps launcher login on the first-party HTTPS WebView surface", async () => {
    const auth = await import("./android-cloud-auth");
    const navigate = vi.fn();

    expect(
      auth.navigateAndroidCloudSignInInApp(
        "https://cloud.eliza.app/login?returnTo=%2Fapp-auth%2Fauthorize",
        navigate,
      ),
    ).toBe(true);
    expect(navigate).toHaveBeenCalledWith(
      "https://cloud.eliza.app/login?returnTo=%2Fapp-auth%2Fauthorize",
    );

    for (const url of [
      "http://cloud.eliza.app/login",
      "https://cloud.eliza.app.evil.example/login",
      "javascript:alert(1)",
    ]) {
      expect(auth.navigateAndroidCloudSignInInApp(url, navigate)).toBe(false);
    }
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("single-flights concurrent and sequential delivery of one callback", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(config())
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(acknowledgement());
    vi.stubGlobal("fetch", fetchImpl);
    const auth = await import("./android-cloud-auth");
    const attempt = await auth.beginAndroidCloudSignIn();
    const callback = `elizaos://auth/callback?code=emac_${"a".repeat(64)}&state=${attempt.state}`;
    const results: unknown[] = [];
    window.addEventListener(auth.ANDROID_CLOUD_AUTH_RESULT_EVENT, (event) => {
      results.push((event as CustomEvent).detail);
    });

    const [first, second] = await Promise.all([
      auth.completeAndroidCloudSignIn(callback),
      auth.completeAndroidCloudSignIn(callback),
    ]);
    const sequential = await auth.completeAndroidCloudSignIn(callback);

    expect(first).toEqual(second);
    expect(sequential).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(results).toEqual([
      expect.objectContaining({ attemptId: attempt.state, ok: true }),
    ]);
    expect(harness.token).toBe(secret);
  });

  it("does not let a stale callback consume a newer attempt", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(config())
      .mockResolvedValueOnce(config())
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(acknowledgement());
    vi.stubGlobal("fetch", fetchImpl);
    const auth = await import("./android-cloud-auth");
    const first = await auth.beginAndroidCloudSignIn();
    const second = await auth.beginAndroidCloudSignIn();
    const results: unknown[] = [];
    window.addEventListener(auth.ANDROID_CLOUD_AUTH_RESULT_EVENT, (event) => {
      results.push((event as CustomEvent).detail);
    });

    await expect(
      auth.completeAndroidCloudSignIn(
        `elizaos://auth/callback?code=old&state=${first.state}`,
      ),
    ).rejects.toMatchObject({ disposition: "acknowledge" });
    expect(JSON.parse(harness.pending ?? "{}").state).toBe(second.state);
    await expect(
      auth.completeAndroidCloudSignIn(
        `elizaos://auth/callback?code=current&state=${second.state}`,
      ),
    ).resolves.toMatchObject({ state: second.state });

    expect(results).toEqual([
      expect.objectContaining({ attemptId: first.state, ok: false }),
      expect.objectContaining({ attemptId: second.state, ok: true }),
    ]);
    expect(harness.token).toBe(secret);
  });

  it("validates a repeated callback before consulting the success cache", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(config())
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(acknowledgement());
    vi.stubGlobal("fetch", fetchImpl);
    const auth = await import("./android-cloud-auth");
    const attempt = await auth.beginAndroidCloudSignIn();
    await auth.completeAndroidCloudSignIn(
      `elizaos://auth/callback?code=current&state=${attempt.state}`,
    );

    await expect(
      auth.completeAndroidCloudSignIn(
        `elizaos://user@auth/callback?code=current&state=${attempt.state}`,
      ),
    ).rejects.toMatchObject({ disposition: "acknowledge" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
