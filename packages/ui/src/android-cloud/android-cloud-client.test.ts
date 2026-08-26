// @vitest-environment jsdom

/**
 * Exercises the Play-safe Cloud transport with deterministic HTTP responses,
 * including authority, session, transcript, logout, and malformed-body cases.
 */

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANDROID_CLOUD_PENDING_LOGIN_KEY,
  AndroidCloudClient,
  resolveAndroidCloudChatAuthority,
} from "./android-cloud-client";

const ACCOUNT_ID = "20000000-0000-4000-8000-000000000002";
const PERSONAL_ID = "personal:org-1:user-1";
const RUNTIME_ID = "30000000-0000-4000-8000-000000000003";
const RUNTIME_BASE = `https://${RUNTIME_ID}.cloud.eliza.app`;
const MOBILE_CREDENTIAL_ID = "40000000-0000-4000-8000-000000000004";
const MOBILE_SECRET = `eliza_mobile_${"b".repeat(64)}`;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AndroidCloudClient", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("pins configuration to an official Cloud authority", () => {
    expect(
      new AndroidCloudClient({ cloudApiBase: "https://attacker.example" })
        .apiBase,
    ).toBe("https://api.eliza.app");
  });

  it("accepts only the canonical API or UUID-shaped managed runtime hosts", () => {
    expect(
      resolveAndroidCloudChatAuthority(
        `https://api.eliza.app/api/v1/eliza/agents/${ACCOUNT_ID}`,
        ACCOUNT_ID,
      ),
    ).toBe(`https://api.eliza.app/api/v1/eliza/agents/${ACCOUNT_ID}`);
    expect(resolveAndroidCloudChatAuthority(RUNTIME_BASE)).toBe(RUNTIME_BASE);
    expect(() =>
      resolveAndroidCloudChatAuthority(`${RUNTIME_BASE}/api`),
    ).toThrow("untrusted chat authority");
    expect(() =>
      resolveAndroidCloudChatAuthority("https://not-a-uuid.cloud.eliza.app"),
    ).toThrow("untrusted chat authority");
    expect(() =>
      resolveAndroidCloudChatAuthority("http://api.eliza.app"),
    ).toThrow("untrusted chat authority");
  });

  it("uses hosted Eliza Cloud login and activates the returned mobile credential", async () => {
    let secureToken: string | null = null;
    const credentialStore = {
      read: vi.fn(async () => secureToken),
      write: vi.fn(async (token: string) => {
        secureToken = token;
      }),
      clear: vi.fn(async () => {
        secureToken = null;
      }),
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(200, {
          success: true,
          clientId: "ai.elizaos.app",
          environment: "production",
          redirectUri: "https://eliza.app/auth/callback",
          codeChallengeMethod: "S256",
          app: { name: "Eliza" },
        }),
      )
      .mockResolvedValueOnce(
        json(200, {
          credentialId: MOBILE_CREDENTIAL_ID,
          secret: MOBILE_SECRET,
        }),
      )
      .mockResolvedValueOnce(
        json(200, {
          success: true,
          status: "acknowledged",
          credentialId: MOBILE_CREDENTIAL_ID,
        }),
      );
    const client = new AndroidCloudClient({ credentialStore, fetchImpl });
    const attempt = await client.beginLogin();
    const loginUrl = new URL(attempt.browserUrl);
    const returnTo = loginUrl.searchParams.get("returnTo");
    const authorizeUrl = new URL(returnTo ?? "", loginUrl.origin);

    expect(loginUrl.origin).toBe("https://cloud.eliza.app");
    expect(loginUrl.pathname).toBe("/login");
    expect(authorizeUrl.pathname).toBe("/app-auth/authorize");
    expect(authorizeUrl.searchParams.get("flow")).toBe("mobile_pkce");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("ai.elizaos.app");
    expect(authorizeUrl.searchParams.get("state")).toBe(attempt.state);
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );

    await expect(
      client.completeLogin(
        `elizaos://auth/callback?code=emac_${"a".repeat(64)}&state=${encodeURIComponent(attempt.state)}`,
      ),
    ).resolves.toEqual({
      apiBase: "https://api.eliza.app",
      pendingCleanupRequired: false,
      state: attempt.state,
    });
    expect(credentialStore.write).toHaveBeenCalledWith(MOBILE_SECRET);
    expect(fetchImpl.mock.calls.map(([input]) => String(input))).toEqual([
      expect.stringContaining("/api/v1/app-auth/mobile/config?"),
      "https://api.eliza.app/api/v1/app-auth/mobile/token",
      "https://api.eliza.app/api/v1/app-auth/mobile/ack",
    ]);
    const tokenRequest = fetchImpl.mock.calls[1]?.[1];
    const acknowledgementRequest = fetchImpl.mock.calls[2]?.[1];
    expect(JSON.parse(String(tokenRequest?.body))).toMatchObject({
      clientId: "ai.elizaos.app",
      environment: "production",
      redirectUri: "https://eliza.app/auth/callback",
      state: attempt.state,
      grantType: "authorization_code",
    });
    expect(JSON.parse(String(acknowledgementRequest?.body))).toEqual({
      clientId: "ai.elizaos.app",
      environment: "production",
      redirectUri: "https://eliza.app/auth/callback",
      credentialId: MOBILE_CREDENTIAL_ID,
      secret: MOBILE_SECRET,
      state: attempt.state,
      code: `emac_${"a".repeat(64)}`,
      codeVerifier: expect.any(String),
    });
  });

  it("completes PKCE after Android recreates the renderer behind the Custom Tab", async () => {
    let pendingLogin: string | null = null;
    const pendingLoginStore = {
      read: vi.fn(async () => pendingLogin),
      write: vi.fn(async (value: string) => {
        pendingLogin = value;
      }),
      clear: vi.fn(async () => {
        pendingLogin = null;
      }),
    };
    let secureToken: string | null = null;
    const credentialStore = {
      read: vi.fn(async () => secureToken),
      write: vi.fn(async (token: string) => {
        secureToken = token;
      }),
      clear: vi.fn(async () => {
        secureToken = null;
      }),
    };
    const config = json(200, {
      success: true,
      clientId: "ai.elizaos.app",
      environment: "production",
      redirectUri: "https://eliza.app/auth/callback",
      codeChallengeMethod: "S256",
    });
    const firstClient = new AndroidCloudClient({
      credentialStore,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValueOnce(config),
      pendingLoginStore,
    });
    const attempt = await firstClient.beginLogin();

    const recreatedClient = new AndroidCloudClient({
      credentialStore,
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          json(200, {
            credentialId: MOBILE_CREDENTIAL_ID,
            secret: MOBILE_SECRET,
          }),
        )
        .mockResolvedValueOnce(
          json(200, {
            success: true,
            status: "acknowledged",
            credentialId: MOBILE_CREDENTIAL_ID,
          }),
        ),
      pendingLoginStore,
    });
    await expect(
      recreatedClient.completeLogin(
        `elizaos://auth/callback?code=emac_${"a".repeat(64)}&state=${encodeURIComponent(attempt.state)}`,
      ),
    ).resolves.toEqual({
      apiBase: "https://api.eliza.app",
      pendingCleanupRequired: false,
      state: attempt.state,
    });

    expect(secureToken).toBe(MOBILE_SECRET);
    expect(pendingLoginStore.clear).toHaveBeenCalledOnce();
    expect(pendingLogin).toBeNull();
  });

  it("uses the persisted staging authority after renderer recreation", async () => {
    let pendingLogin: string | null = null;
    const pendingLoginStore = {
      read: vi.fn(async () => pendingLogin),
      write: vi.fn(async (value: string) => {
        pendingLogin = value;
      }),
      clear: vi.fn(async () => {
        pendingLogin = null;
      }),
    };
    const firstClient = new AndroidCloudClient({
      cloudApiBase: "https://api-staging.eliza.app",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValueOnce(
        json(200, {
          success: true,
          clientId: "ai.elizaos.app",
          environment: "staging",
          redirectUri: "https://eliza.app/auth/callback",
          codeChallengeMethod: "S256",
        }),
      ),
      pendingLoginStore,
    });
    const attempt = await firstClient.beginLogin();
    const recreatedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(200, {
          credentialId: MOBILE_CREDENTIAL_ID,
          secret: MOBILE_SECRET,
        }),
      )
      .mockResolvedValueOnce(
        json(200, {
          success: true,
          status: "acknowledged",
          credentialId: MOBILE_CREDENTIAL_ID,
        }),
      );
    const recreatedClient = new AndroidCloudClient({
      cloudApiBase: "https://api.eliza.app",
      fetchImpl: recreatedFetch,
      pendingLoginStore,
    });

    await recreatedClient.completeLogin(
      `elizaos://auth/callback?code=current&state=${attempt.state}`,
    );
    expect(recreatedFetch.mock.calls.map(([input]) => String(input))).toEqual([
      "https://api-staging.eliza.app/api/v1/app-auth/mobile/token",
      "https://api-staging.eliza.app/api/v1/app-auth/mobile/ack",
    ]);
  });

  it("rejects a callback that does not match the in-memory PKCE state", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      json(200, {
        success: true,
        clientId: "ai.elizaos.app",
        environment: "production",
        redirectUri: "https://eliza.app/auth/callback",
        codeChallengeMethod: "S256",
        app: { name: "Eliza" },
      }),
    );
    const client = new AndroidCloudClient({ fetchImpl });
    await client.beginLogin();

    await expect(
      client.completeLogin(
        `elizaos://auth/callback?code=emac_${"a".repeat(64)}&state=attacker`,
      ),
    ).rejects.toThrow("state did not match");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("restores the previous credential when acknowledgement fails", async () => {
    let secureToken: string | null = "previous-secret";
    const credentialStore = {
      read: vi.fn(async () => secureToken),
      write: vi.fn(async (token: string) => {
        secureToken = token;
      }),
      clear: vi.fn(async () => {
        secureToken = null;
      }),
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(200, {
          success: true,
          clientId: "ai.elizaos.app",
          environment: "production",
          redirectUri: "https://eliza.app/auth/callback",
          codeChallengeMethod: "S256",
          app: { name: "Eliza" },
        }),
      )
      .mockResolvedValueOnce(
        json(200, {
          credentialId: MOBILE_CREDENTIAL_ID,
          secret: MOBILE_SECRET,
        }),
      )
      .mockResolvedValueOnce(json(503, { error: "temporarily_unavailable" }));

    const client = new AndroidCloudClient({ credentialStore, fetchImpl });
    const attempt = await client.beginLogin();
    await expect(
      client.completeLogin(
        `elizaos://auth/callback?code=emac_${"a".repeat(64)}&state=${encodeURIComponent(attempt.state)}`,
      ),
    ).rejects.toThrow();
    expect(secureToken).toBe("previous-secret");
    expect(credentialStore.write).toHaveBeenNthCalledWith(1, MOBILE_SECRET);
    expect(credentialStore.write).toHaveBeenNthCalledWith(2, "previous-secret");
    expect(credentialStore.clear).not.toHaveBeenCalled();
    expect(
      localStorage.getItem(ANDROID_CLOUD_PENDING_LOGIN_KEY),
    ).not.toBeNull();
  });

  it("retains retry authority after a transient acknowledgement failure", async () => {
    let secureToken: string | null = null;
    const credentialStore = {
      read: vi.fn(async () => secureToken),
      write: vi.fn(async (token: string) => {
        secureToken = token;
      }),
      clear: vi.fn(async () => {
        secureToken = null;
      }),
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(200, {
          success: true,
          clientId: "ai.elizaos.app",
          environment: "production",
          redirectUri: "https://eliza.app/auth/callback",
          codeChallengeMethod: "S256",
        }),
      )
      .mockResolvedValueOnce(
        json(200, {
          credentialId: MOBILE_CREDENTIAL_ID,
          secret: MOBILE_SECRET,
        }),
      )
      .mockResolvedValueOnce(json(503, { error: "temporarily_unavailable" }))
      .mockResolvedValueOnce(
        json(200, {
          credentialId: MOBILE_CREDENTIAL_ID,
          secret: MOBILE_SECRET,
        }),
      )
      .mockResolvedValueOnce(
        json(200, {
          success: true,
          status: "acknowledged",
          credentialId: MOBILE_CREDENTIAL_ID,
        }),
      );
    const client = new AndroidCloudClient({ credentialStore, fetchImpl });
    const attempt = await client.beginLogin();
    const callback = `elizaos://auth/callback?code=emac_${"a".repeat(64)}&state=${encodeURIComponent(attempt.state)}`;

    await expect(client.completeLogin(callback)).rejects.toMatchObject({
      disposition: "retry",
    });
    expect(
      localStorage.getItem(ANDROID_CLOUD_PENDING_LOGIN_KEY),
    ).not.toBeNull();
    await expect(client.completeLogin(callback)).resolves.toMatchObject({
      state: attempt.state,
    });
    expect(secureToken).toBe(MOBILE_SECRET);
    expect(localStorage.getItem(ANDROID_CLOUD_PENDING_LOGIN_KEY)).toBeNull();
  });

  it.each(
    ([408, 425, 429] as const).flatMap((status) =>
      (["token", "ack"] as const).map((step) => ({ status, step })),
    ),
  )(
    "retains and replays the pending attempt after a $status from $step",
    async ({ status, step: rateLimitedStep }) => {
      let secureToken: string | null = null;
      const credentialStore = {
        read: vi.fn(async () => secureToken),
        write: vi.fn(async (token: string) => {
          secureToken = token;
        }),
        clear: vi.fn(async () => {
          secureToken = null;
        }),
      };
      const config = json(200, {
        success: true,
        clientId: "ai.elizaos.app",
        environment: "production",
        redirectUri: "https://eliza.app/auth/callback",
        codeChallengeMethod: "S256",
      });
      const token = json(200, {
        credentialId: MOBILE_CREDENTIAL_ID,
        secret: MOBILE_SECRET,
      });
      const ack = json(200, {
        success: true,
        status: "acknowledged",
        credentialId: MOBILE_CREDENTIAL_ID,
      });
      const fetchImpl =
        rateLimitedStep === "token"
          ? vi
              .fn<typeof fetch>()
              .mockResolvedValueOnce(config)
              .mockResolvedValueOnce(json(status, { error: "retryable" }))
              .mockResolvedValueOnce(token)
              .mockResolvedValueOnce(ack)
          : vi
              .fn<typeof fetch>()
              .mockResolvedValueOnce(config)
              .mockResolvedValueOnce(token)
              .mockResolvedValueOnce(json(status, { error: "retryable" }))
              .mockResolvedValueOnce(
                json(200, {
                  credentialId: MOBILE_CREDENTIAL_ID,
                  secret: MOBILE_SECRET,
                }),
              )
              .mockResolvedValueOnce(ack);
      const client = new AndroidCloudClient({ credentialStore, fetchImpl });
      const attempt = await client.beginLogin();
      const callback = `elizaos://auth/callback?code=current&state=${attempt.state}`;

      await expect(client.completeLogin(callback)).rejects.toMatchObject({
        disposition: "retry",
      });
      expect(
        localStorage.getItem(ANDROID_CLOUD_PENDING_LOGIN_KEY),
      ).not.toBeNull();
      await expect(client.completeLogin(callback)).resolves.toMatchObject({
        pendingCleanupRequired: false,
        state: attempt.state,
      });
      expect(secureToken).toBe(MOBILE_SECRET);
    },
  );

  it("commits an acknowledged credential when pending cleanup fails", async () => {
    let pendingLogin: string | null = null;
    const pendingLoginStore = {
      read: vi.fn(async () => pendingLogin),
      write: vi.fn(async (value: string) => {
        pendingLogin = value;
      }),
      clear: vi.fn(async () => {
        throw new Error("Keystore cleanup unavailable");
      }),
    };
    let secureToken: string | null = null;
    const credentialStore = {
      read: vi.fn(async () => secureToken),
      write: vi.fn(async (token: string) => {
        secureToken = token;
      }),
      clear: vi.fn(async () => {
        secureToken = null;
      }),
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(200, {
          success: true,
          clientId: "ai.elizaos.app",
          environment: "production",
          redirectUri: "https://eliza.app/auth/callback",
          codeChallengeMethod: "S256",
        }),
      )
      .mockResolvedValueOnce(
        json(200, {
          credentialId: MOBILE_CREDENTIAL_ID,
          secret: MOBILE_SECRET,
        }),
      )
      .mockResolvedValueOnce(
        json(200, {
          success: true,
          status: "acknowledged",
          credentialId: MOBILE_CREDENTIAL_ID,
        }),
      );
    const client = new AndroidCloudClient({
      credentialStore,
      fetchImpl,
      pendingLoginStore,
    });
    const attempt = await client.beginLogin();

    await expect(
      client.completeLogin(
        `elizaos://auth/callback?code=current&state=${attempt.state}`,
      ),
    ).resolves.toEqual({
      apiBase: "https://api.eliza.app",
      pendingCleanupRequired: true,
      state: attempt.state,
    });
    expect(secureToken).toBe(MOBILE_SECRET);
    expect(pendingLogin).not.toBeNull();
  });

  it("does not acknowledge success when protected credential readback fails", async () => {
    const credentialStore = {
      read: vi.fn(async () => null),
      write: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(200, {
          success: true,
          clientId: "ai.elizaos.app",
          environment: "production",
          redirectUri: "https://eliza.app/auth/callback",
          codeChallengeMethod: "S256",
        }),
      )
      .mockResolvedValueOnce(
        json(200, {
          credentialId: MOBILE_CREDENTIAL_ID,
          secret: MOBILE_SECRET,
        }),
      );
    const client = new AndroidCloudClient({ credentialStore, fetchImpl });
    const attempt = await client.beginLogin();

    await expect(
      client.completeLogin(
        `elizaos://auth/callback?code=current&state=${attempt.state}`,
      ),
    ).rejects.toMatchObject({ disposition: "retry" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      localStorage.getItem(ANDROID_CLOUD_PENDING_LOGIN_KEY),
    ).not.toBeNull();
  });

  it("clears a terminal 4xx exchange while preserving typed acknowledgement", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(200, {
          success: true,
          clientId: "ai.elizaos.app",
          environment: "production",
          redirectUri: "https://eliza.app/auth/callback",
          codeChallengeMethod: "S256",
        }),
      )
      .mockResolvedValueOnce(json(400, { error: "invalid_grant" }));
    const client = new AndroidCloudClient({ fetchImpl });
    const attempt = await client.beginLogin();

    await expect(
      client.completeLogin(
        `elizaos://auth/callback?code=emac_${"a".repeat(64)}&state=${attempt.state}`,
      ),
    ).rejects.toMatchObject({ disposition: "acknowledge" });
    expect(localStorage.getItem(ANDROID_CLOUD_PENDING_LOGIN_KEY)).toBeNull();
  });

  it("preserves callback cancellation when protected pending cleanup fails", async () => {
    let pendingLogin: string | null = null;
    const pendingLoginStore = {
      read: vi.fn(async () => pendingLogin),
      write: vi.fn(async (value: string) => {
        pendingLogin = value;
      }),
      clear: vi.fn(async () => {
        throw new Error("Keystore cleanup unavailable");
      }),
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      json(200, {
        success: true,
        clientId: "ai.elizaos.app",
        environment: "production",
        redirectUri: "https://eliza.app/auth/callback",
        codeChallengeMethod: "S256",
      }),
    );
    const client = new AndroidCloudClient({ fetchImpl, pendingLoginStore });
    const attempt = await client.beginLogin();

    await expect(
      client.completeLogin(
        `elizaos://auth/callback?error=access_denied&error_description=Not%20now&state=${attempt.state}`,
      ),
    ).rejects.toMatchObject({
      attemptId: attempt.state,
      disposition: "acknowledge",
      message: "Not now",
    });
    expect(pendingLoginStore.clear).toHaveBeenCalledOnce();
  });

  it("preserves a missing-code acknowledgement when protected pending cleanup fails", async () => {
    let pendingLogin: string | null = null;
    const pendingLoginStore = {
      read: vi.fn(async () => pendingLogin),
      write: vi.fn(async (value: string) => {
        pendingLogin = value;
      }),
      clear: vi.fn(async () => {
        throw new Error("Keystore cleanup unavailable");
      }),
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      json(200, {
        success: true,
        clientId: "ai.elizaos.app",
        environment: "production",
        redirectUri: "https://eliza.app/auth/callback",
        codeChallengeMethod: "S256",
      }),
    );
    const client = new AndroidCloudClient({ fetchImpl, pendingLoginStore });
    const attempt = await client.beginLogin();

    await expect(
      client.completeLogin(`elizaos://auth/callback?state=${attempt.state}`),
    ).rejects.toMatchObject({
      attemptId: attempt.state,
      disposition: "acknowledge",
      message: "Eliza Cloud returned no authorization code.",
    });
    expect(pendingLoginStore.clear).toHaveBeenCalledOnce();
  });

  it("preserves a terminal exchange error when protected pending cleanup fails", async () => {
    let pendingLogin: string | null = null;
    const pendingLoginStore = {
      read: vi.fn(async () => pendingLogin),
      write: vi.fn(async (value: string) => {
        pendingLogin = value;
      }),
      clear: vi.fn(async () => {
        throw new Error("Keystore cleanup unavailable");
      }),
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(200, {
          success: true,
          clientId: "ai.elizaos.app",
          environment: "production",
          redirectUri: "https://eliza.app/auth/callback",
          codeChallengeMethod: "S256",
        }),
      )
      .mockResolvedValueOnce(
        json(400, {
          error: "invalid_grant",
          errorDescription: "Authorization code expired.",
        }),
      );
    const client = new AndroidCloudClient({ fetchImpl, pendingLoginStore });
    const attempt = await client.beginLogin();

    await expect(
      client.completeLogin(
        `elizaos://auth/callback?code=emac_${"a".repeat(64)}&state=${attempt.state}`,
      ),
    ).rejects.toMatchObject({
      attemptId: attempt.state,
      disposition: "acknowledge",
      message: "Authorization code expired.",
    });
    expect(pendingLoginStore.clear).toHaveBeenCalledOnce();
  });

  it.each([
    "elizaos://user@auth/callback?code=x&state=s",
    "elizaos://auth/callback?code=x&state=s#fragment",
    "elizaos://auth/callback?code=x&code=y&state=s",
    "elizaos://auth/callback?code=x&state=s&state=t",
    "elizaos://wrong/callback?code=x&state=s",
  ])("rejects noncanonical callback grammar: %s", async (callback) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      json(200, {
        success: true,
        clientId: "ai.elizaos.app",
        environment: "production",
        redirectUri: "https://eliza.app/auth/callback",
        codeChallengeMethod: "S256",
      }),
    );
    const client = new AndroidCloudClient({ fetchImpl });
    await client.beginLogin();
    await expect(client.completeLogin(callback)).rejects.toMatchObject({
      disposition: "acknowledge",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("translates a mobile-auth configuration failure into product language", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      json(503, {
        success: false,
        error: "server_configuration_error",
        errorDescription: "Configured mobile App Auth app is not active",
      }),
    );
    const client = new AndroidCloudClient({ fetchImpl });

    await expect(client.beginLogin()).rejects.toThrow(
      "Eliza Cloud sign-in is not configured for this app yet.",
    );
  });

  it("restores identity and resolves its managed runtime before chat", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "steward-token");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      json(200, {
        success: true,
        data: {
          identity: {
            id: ACCOUNT_ID,
            displayName: "Ada",
            runtime: "dedicated",
            apiBase: RUNTIME_BASE,
          },
        },
      }),
    );
    const client = new AndroidCloudClient({ fetchImpl });

    await expect(client.restoreSession()).resolves.toEqual({
      identity: { id: ACCOUNT_ID, displayName: "Ada" },
      token: "steward-token",
      chatApiBase: RUNTIME_BASE,
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://api.eliza.app/api/v1/eliza/personal",
      { headers: { Authorization: "Bearer steward-token" } },
    );
  });

  it("constructs the exact shared adapter path for a shared identity", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "steward-token");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      json(200, {
        data: {
          identity: {
            id: PERSONAL_ID,
            displayName: "Ada",
            runtime: "shared",
          },
        },
      }),
    );
    const restored = await new AndroidCloudClient({
      fetchImpl,
    }).restoreSession();
    expect(restored?.chatApiBase).toBe(
      `https://api.eliza.app/api/v1/eliza/agents/${encodeURIComponent(PERSONAL_ID)}`,
    );
  });

  it("clears an expired token when Cloud rejects session restoration", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "expired-token");
    const client = new AndroidCloudClient({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValueOnce(json(401, {})),
    });

    await expect(client.restoreSession()).resolves.toBeNull();
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
  });

  it("uses an injected secure credential store without touching localStorage", async () => {
    let secureToken: string | null = "secure-token";
    const credentialStore = {
      read: vi.fn(async () => secureToken),
      write: vi.fn(async (token: string) => {
        secureToken = token;
      }),
      clear: vi.fn(async () => {
        secureToken = null;
      }),
    };
    const client = new AndroidCloudClient({
      credentialStore,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValueOnce(json(401, {})),
    });

    await expect(client.restoreSession()).resolves.toBeNull();
    expect(credentialStore.read).toHaveBeenCalledOnce();
    expect(credentialStore.clear).toHaveBeenCalledOnce();
    expect(secureToken).toBeNull();
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
  });

  it("restores only valid visible user and assistant transcript messages", async () => {
    const client = new AndroidCloudClient({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValueOnce(
        json(200, {
          messages: [
            { id: "user-1", role: "user", text: "Hello" },
            { id: "assistant-1", role: "assistant", text: "Hi" },
            { id: "internal-1", role: "assistant", text: "" },
            { id: "tool-1", role: "tool", text: "hidden" },
          ],
        }),
      ),
    });

    await expect(
      client.getConversationMessages(
        {
          identity: { id: PERSONAL_ID, displayName: "Ada" },
          token: "steward-token",
          chatApiBase: RUNTIME_BASE,
        },
        "conversation-1",
      ),
    ).resolves.toEqual([
      { id: "user-1", role: "user", text: "Hello" },
      { id: "assistant-1", role: "assistant", text: "Hi" },
    ]);
  });

  it("fails closed when Cloud returns an unknown runtime binding", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "steward-token");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      json(200, {
        data: {
          identity: {
            id: ACCOUNT_ID,
            displayName: "Ada",
            runtime: "unknown",
          },
        },
      }),
    );
    await expect(
      new AndroidCloudClient({ fetchImpl }).restoreSession(),
    ).rejects.toThrow("invalid runtime binding");
  });

  it("clears the local Steward token even when remote logout fails", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "steward-token");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("network unavailable"));
    const client = new AndroidCloudClient({ fetchImpl });
    await expect(client.signOut()).resolves.toBeUndefined();
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.eliza.app/api/auth/logout",
      {
        method: "POST",
        headers: { Authorization: "Bearer steward-token" },
      },
    );
  });

  it("creates a server conversation and sends a text turn to that id", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(200, { conversation: { id: "conversation-1" } }),
      )
      .mockResolvedValueOnce(json(200, { text: "Hello from Eliza" }));
    const client = new AndroidCloudClient({ fetchImpl });
    const session = {
      identity: { id: ACCOUNT_ID, displayName: "Ada" },
      token: "steward-token",
      chatApiBase: RUNTIME_BASE,
    };
    const conversationId = await client.createConversation(session);
    const onText = vi.fn();

    await expect(
      client.sendChat(session, conversationId, "Hello", onText),
    ).resolves.toBe("Hello from Eliza");
    expect(onText).toHaveBeenCalledWith("Hello from Eliza");
    expect(fetchImpl).toHaveBeenLastCalledWith(
      `${RUNTIME_BASE}/api/conversations/conversation-1/messages`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer steward-token",
        }),
      }),
    );
  });

  it("does not rewrite a chat protocol error as a sign-in failure", async () => {
    const client = new AndroidCloudClient({
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          json(503, { error: "server_configuration_error" }),
        ),
    });
    const session = {
      identity: { id: ACCOUNT_ID, displayName: "Ada" },
      token: "steward-token",
      chatApiBase: RUNTIME_BASE,
    };

    await expect(
      client.sendChat(session, "conversation-1", "Hello", vi.fn()),
    ).rejects.toThrow("server_configuration_error");
  });

  it("pairs the hosted sign-in page with the selected Cloud environment", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      json(200, {
        success: true,
        clientId: "ai.elizaos.app",
        environment: "staging",
        redirectUri: "https://eliza.app/auth/callback",
        codeChallengeMethod: "S256",
        app: { name: "Eliza" },
      }),
    );
    const client = new AndroidCloudClient({
      fetchImpl,
      cloudApiBase: "https://api-staging.eliza.app",
    });

    const attempt = await client.beginLogin();

    const loginUrl = new URL(attempt.browserUrl);
    expect(loginUrl.origin).toBe("https://cloud-staging.eliza.app");
    const authorizeUrl = new URL(
      loginUrl.searchParams.get("returnTo") ?? "",
      loginUrl.origin,
    );
    expect(authorizeUrl.searchParams.get("environment")).toBe("staging");
  });

  it("reports unreadable mobile configuration instead of opening hosted auth", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response("<html>gateway error</html>", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = new AndroidCloudClient({ fetchImpl });

    await expect(client.beginLogin()).rejects.toThrow(/could not be read/);
  });

  it.each([
    ["null", null],
    ["an array", [{ status: "authenticated", token: "attacker-token" }]],
    ["a string", "pending"],
    ["a number", 0],
    ["a boolean", false],
  ])("rejects %s mobile configuration body", async (_label, body) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(200, body));
    const client = new AndroidCloudClient({ fetchImpl });

    await expect(client.beginLogin()).rejects.toThrow(/invalid JSON response/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects a genuinely empty mobile configuration response", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    const client = new AndroidCloudClient({ fetchImpl });

    await expect(client.beginLogin()).rejects.toThrow(
      "invalid mobile sign-in metadata",
    );
  });
});
