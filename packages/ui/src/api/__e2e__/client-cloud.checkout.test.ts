// @vitest-environment jsdom

import {
  clearStoredStewardToken,
  replaceStoredStewardTokenIfCurrent,
  STEWARD_TOKEN_KEY,
  writeStoredStewardToken,
} from "@elizaos/plugin-elizacloud/steward-session-client";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopSecureStoreKind } from "../../bridge/electrobun-rpc";
import { initializeStorageBridge } from "../../bridge/storage-bridge";
import { resolveCloudApiBase } from "../../platform/ios-runtime";
import {
  hasSameOriginStewardLogin,
  shouldUseSameTabCloudLogin,
} from "../../state/cloud-login-launch";
import { savePersistedActiveServer } from "../../state/persistence";
import { isTrustedCloudApiBaseUrl } from "../../state/runtime-url-trust";
import {
  currentOwnedElizaPagesOrigin,
  isManagedCloudSharedAgentBase,
  isTrustedHostedCloudOnboardingBase,
} from "../../utils/cloud-agent-base";
import { ElizaClient } from "../client-base";
import "../client-cloud";

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
  localStorage.clear();
});

describe("createCloudBillingCheckout", () => {
  it("sends one idempotency key that the client retry loop can reuse", async () => {
    const requests: RequestInit[] = [];
    const client = new ElizaClient("https://cloud.example");
    client.setRequestTransport({
      request: async (_url, init) => {
        requests.push(init);
        if (requests.length === 1) {
          return new Response(JSON.stringify({ status: "starting" }), {
            status: 202,
            headers: { "Retry-After": "0" },
          });
        }
        return new Response(
          JSON.stringify({
            checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_1",
            sessionId: "cs_test_1",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    await client.createCloudBillingCheckout({ amountUsd: 5 });

    expect(requests).toHaveLength(2);
    const idempotencyKey = new Headers(requests[0].headers).get(
      "Idempotency-Key",
    );
    expect(idempotencyKey).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
    expect(new Headers(requests[1].headers).get("Idempotency-Key")).toBe(
      idempotencyKey,
    );
  });

  it("creates checkout on the control plane for a Shared agent base", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      requests.push({ url: String(input), init: init ?? {} });
      return new Response(
        JSON.stringify({
          url: "https://checkout.stripe.com/c/pay/cs_test_2",
          sessionId: "cs_test_2",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    await writeStoredStewardToken("cloud-session-token");
    const client = new ElizaClient(
      "https://api.eliza.app/api/v1/eliza/agents/personal:11111111-1111-5111-8111-111111111111",
      "cloud-session-token",
    );

    const response = await client.createCloudBillingCheckout({ amountUsd: 5 });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "https://api.eliza.app/api/v1/credits/checkout",
    );
    const headers = new Headers(requests[0].init.headers);
    expect(headers.get("Authorization")).toBe("Bearer cloud-session-token");
    expect(headers.get("Idempotency-Key")).toMatch(
      /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/,
    );
    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      amountUsd: 5,
      success_url: "https://cloud.eliza.app/cloud/billing/success?from=eliza",
      cancel_url:
        "https://cloud.eliza.app/cloud/billing?from=eliza&tab=billing&canceled=1",
    });
    expect(response).toEqual({
      success: true,
      provider: "stripe",
      mode: "hosted",
      checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_2",
      sessionId: "cs_test_2",
    });
  });
});

it("uses the current account session on an already selected web Shared runtime", async () => {
  const base =
    "https://api-staging.eliza.app/api/v1/eliza/agents/personal%3A00000001-1111-5111-8111-111111111111";
  await writeStoredStewardToken("old-session");
  const client = new ElizaClient(base, "old-session");
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async () => new Response(JSON.stringify({ ui: {} }), { status: 200 }),
    );

  expect(
    await replaceStoredStewardTokenIfCurrent("old-session", "fresh-session"),
  ).toBe(true);
  await client.fetch("/api/config");
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [url, init] = fetchSpy.mock.calls[0];
  expect(String(url)).toBe(`${base}/api/config`);
  expect(new Headers(init?.headers).get("authorization")).toBe(
    "Bearer fresh-session",
  );
  expect(client.getBaseUrl()).toBe(base);

  await clearStoredStewardToken();
  await client.fetch("/api/config");
  expect(fetchSpy).toHaveBeenCalledTimes(2);
  expect(
    new Headers(fetchSpy.mock.calls[1][1]?.headers).get("authorization"),
  ).toBeNull();
  expect(client.getRestAuthToken()).toBeNull();
});

it.each([
  "http://127.0.0.1:43123",
  "https://agent.example.test",
  "https://agent.example.test/api/v1/eliza/agents/personal%3A00000001-1111-5111-8111-111111111111",
  "https://agent-a.cloud.eliza.app",
  "http://api-staging.eliza.app/api/v1/eliza/agents/personal%3A00000001-1111-5111-8111-111111111111",
  "https://api-staging.eliza.app:8443/api/v1/eliza/agents/personal%3A00000001-1111-5111-8111-111111111111",
  "https://user:pass@api-staging.eliza.app/api/v1/eliza/agents/personal%3A00000001-1111-5111-8111-111111111111",
  "https://api-staging.eliza.app/api/v1/eliza/agents/personal%3A00000001-1111-5111-8111-111111111111?mode=other",
  "https://api-staging.eliza.app/api/v1/eliza/agents/personal%3A00000001-1111-5111-8111-111111111111#other",
])(
  "preserves independent runtime authority on %s during account rotation and logout",
  async (base) => {
    await writeStoredStewardToken("old-account");
    const client = new ElizaClient(base, "agent-credential");
    expect(
      await replaceStoredStewardTokenIfCurrent("old-account", "new-account"),
    ).toBe(true);
    expect(client.getRestAuthToken()).toBe("agent-credential");
    await clearStoredStewardToken();
    expect(client.getRestAuthToken()).toBe("agent-credential");
    expect(client.getBaseUrl()).toBe(base);
  },
);

it.each(["native", "electrobun"])(
  "preserves the installed managed runtime credential on %s",
  async (platform) => {
    const desktop =
      platform === "electrobun"
        ? new JSDOM("", {
            url: "https://staging.eliza-app.pages.dev/chat",
          })
        : null;
    const protectedValues = new Map<DesktopSecureStoreKind, string>();
    let rawGetItem: Storage["getItem"] | undefined;
    if (desktop) {
      vi.stubGlobal("window", desktop.window);
      vi.stubGlobal("localStorage", desktop.window.localStorage);
      vi.stubGlobal("CustomEvent", desktop.window.CustomEvent);
      rawGetItem = desktop.window.localStorage.getItem.bind(
        desktop.window.localStorage,
      );
      Object.defineProperty(desktop.window, "__electrobunWindowId", {
        configurable: true,
        value: 1,
      });
    } else vi.stubGlobal("Capacitor", { isNativePlatform: () => true });
    try {
      if (desktop) {
        await expect(writeStoredStewardToken("old-account")).rejects.toThrow(
          "Protected storage rejected write",
        );
        expect(rawGetItem?.(STEWARD_TOKEN_KEY)).toBeNull();
        Object.defineProperty(desktop.window, "__ELIZA_ELECTROBUN_RPC__", {
          configurable: true,
          value: {
            request: {
              secureStoreGet: async ({
                kind,
              }: {
                kind: DesktopSecureStoreKind;
              }) =>
                protectedValues.has(kind)
                  ? { ok: true, value: protectedValues.get(kind) }
                  : { ok: false, reason: "not_found" },
              secureStoreSet: async ({
                kind,
                value,
              }: {
                kind: DesktopSecureStoreKind;
                value: string;
              }) => {
                protectedValues.set(kind, value);
                return { ok: true };
              },
              secureStoreDelete: async ({
                kind,
              }: {
                kind: DesktopSecureStoreKind;
              }) => {
                protectedValues.delete(kind);
                return { ok: true, deleted: true };
              },
            },
            onMessage: vi.fn(),
            offMessage: vi.fn(),
          },
        });
        await initializeStorageBridge();
      }
      await writeStoredStewardToken("old-account");
      const client = new ElizaClient(
        "https://api-staging.eliza.app/api/v1/eliza/agents/personal%3A00000001-1111-5111-8111-111111111111",
        "eliza_owner-key",
      );
      expect(
        await replaceStoredStewardTokenIfCurrent("old-account", "new-account"),
      ).toBe(true);
      expect(client.getRestAuthToken()).toBe("eliza_owner-key");
      if (desktop) {
        expect(protectedValues.get("session.steward_token")).toBe(
          "new-account",
        );
        expect(rawGetItem?.(STEWARD_TOKEN_KEY)).toBeNull();
      }
      await clearStoredStewardToken();
      expect(client.getRestAuthToken()).toBe("eliza_owner-key");
      if (desktop)
        expect(protectedValues.has("session.steward_token")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      desktop?.window.close();
    }
  },
);

it("keeps a build-pinned remote credential outside account session ownership", async () => {
  const base = "https://paired.example.test";
  vi.stubGlobal("__ELIZA_BUILD_CONFIGURED_REMOTE_API_BASE__", base);
  savePersistedActiveServer({
    id: "remote:paired",
    kind: "remote",
    label: "Paired",
    apiBase: base,
    accessToken: "paired-credential",
  });
  await writeStoredStewardToken("old-account");
  const client = new ElizaClient(base, "installed-credential");
  await replaceStoredStewardTokenIfCurrent("old-account", "new-account");
  expect(client.getRestAuthToken()).toBe("paired-credential");
  await clearStoredStewardToken();
  expect(client.getRestAuthToken()).toBe("paired-credential");
  expect(client.getBaseUrl()).toBe(base);
});

it("keeps owned Pages boot, personal identity and refreshed requests on one origin", async () => {
  const dom = new JSDOM("", {
    url: "https://staging.eliza-app.pages.dev/chat",
  });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("localStorage", dom.window.localStorage);
  vi.stubGlobal("CustomEvent", dom.window.CustomEvent);
  try {
    const origin = dom.window.location.origin;
    const personalId = "personal:00000001-1111-5111-8111-111111111111";
    const cloudApiBase = resolveCloudApiBase({
      VITE_ELIZA_CLOUD_BASE: "https://eliza.app",
    });
    expect(currentOwnedElizaPagesOrigin()).toBe(origin);
    expect(cloudApiBase).toBe(origin);
    expect(hasSameOriginStewardLogin()).toBe(true);
    const popup = { closed: false } as Window;
    expect(shouldUseSameTabCloudLogin(popup, { hasAgentProxy: false })).toBe(
      true,
    );
    expect(shouldUseSameTabCloudLogin(popup, { hasAgentProxy: true })).toBe(
      false,
    );
    expect(isTrustedHostedCloudOnboardingBase(origin, false)).toBe(true);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input) =>
        new Response(
          JSON.stringify(
            String(input) === `${origin}/api/v1/eliza/personal`
              ? {
                  success: true,
                  data: {
                    identity: {
                      id: personalId,
                      displayName: "Eliza",
                      runtime: "shared",
                    },
                  },
                }
              : { ui: {} },
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    await writeStoredStewardToken("old-account");
    const client = new ElizaClient(origin, "old-account");
    const personal = await client.getPersonalSharedEliza({
      cloudApiBase,
      authToken: "old-account",
    });
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      `${origin}/api/v1/eliza/personal`,
    );
    expect(
      new Headers(fetchSpy.mock.calls[0][1]?.headers).get("Authorization"),
    ).toBe("Bearer old-account");
    expect(personal.personalElizaId).toBe(personalId);
    expect(personal.apiBase).toBe(
      `${origin}/api/v1/eliza/agents/${encodeURIComponent(personalId)}`,
    );
    expect(isTrustedCloudApiBaseUrl(personal.apiBase, personalId)).toBe(true);
    expect(
      isTrustedCloudApiBaseUrl(
        personal.apiBase,
        "personal:00000002-1111-5111-8111-111111111111",
      ),
    ).toBe(false);
    client.setBaseUrl(personal.apiBase, { persist: false });
    expect(
      await replaceStoredStewardTokenIfCurrent("old-account", "fresh-account"),
    ).toBe(true);
    await client.fetch("/api/config");
    expect(String(fetchSpy.mock.calls[1][0])).toBe(
      `${personal.apiBase}/api/config`,
    );
    expect(
      new Headers(fetchSpy.mock.calls[1][1]?.headers).get("Authorization"),
    ).toBe("Bearer fresh-account");
    await clearStoredStewardToken();
    await client.fetch("/api/config");
    expect(
      new Headers(fetchSpy.mock.calls[2][1]?.headers).get("Authorization"),
    ).toBeNull();
    expect(client.getBaseUrl()).toBe(personal.apiBase);

    await writeStoredStewardToken("unrelated-account");
    for (const base of [
      origin,
      `${origin}/api/v1/eliza/agents`,
      `${origin}/api/v1/eliza/agents/unrelated-runtime`,
      personal.apiBase.replace("staging.", "other."),
    ]) {
      expect(isManagedCloudSharedAgentBase(base)).toBe(false);
      expect(isTrustedCloudApiBaseUrl(base, personalId)).toBe(false);
      expect(
        new ElizaClient(base, "independent-credential").getRestAuthToken(),
      ).toBe("independent-credential");
    }
  } finally {
    vi.unstubAllGlobals();
    dom.window.close();
  }
});

it("does not grant owned Pages boot or bearer authority to other URL shapes", () => {
  for (const url of [
    "https://staging.other-app.pages.dev/chat",
    "https://nested.staging.eliza-app.pages.dev/chat",
    "http://staging.eliza-app.pages.dev/chat",
    "https://staging.eliza-app.pages.dev:8443/chat",
    "https://user:pass@staging.eliza-app.pages.dev/chat",
  ]) {
    const dom = new JSDOM("", { url });
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("localStorage", dom.window.localStorage);
    vi.stubGlobal("CustomEvent", dom.window.CustomEvent);
    try {
      const base = `${dom.window.location.origin}/api/v1/eliza/agents/personal%3A00000001-1111-5111-8111-111111111111`;
      expect(currentOwnedElizaPagesOrigin()).toBeNull();
      expect(
        resolveCloudApiBase({ VITE_ELIZA_CLOUD_BASE: "https://eliza.app" }),
      ).toBe("https://eliza.app");
      expect(isManagedCloudSharedAgentBase(base)).toBe(false);
      expect(isTrustedCloudApiBaseUrl(base)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      dom.window.close();
    }
  }
});

it("keeps native and Electrobun off the owned Pages direct-login path", () => {
  for (const platform of ["native", "electrobun"]) {
    const dom = new JSDOM("", {
      url: "https://staging.eliza-app.pages.dev/chat",
    });
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("localStorage", dom.window.localStorage);
    vi.stubGlobal("CustomEvent", dom.window.CustomEvent);
    if (platform === "native")
      vi.stubGlobal("Capacitor", { isNativePlatform: () => true });
    else
      Object.defineProperty(dom.window, "__electrobunWindowId", {
        configurable: true,
        value: 1,
      });
    try {
      expect(currentOwnedElizaPagesOrigin()).toBeNull();
      expect(
        resolveCloudApiBase({ VITE_ELIZA_CLOUD_BASE: "https://eliza.app" }),
      ).toBe("https://eliza.app");
      expect(
        shouldUseSameTabCloudLogin({ closed: false } as Window, {
          hasAgentProxy: false,
        }),
      ).toBe(false);
      const base = `${dom.window.location.origin}/api/v1/eliza/agents/personal%3A00000001-1111-5111-8111-111111111111`;
      expect(isManagedCloudSharedAgentBase(base)).toBe(false);
      expect(isTrustedCloudApiBaseUrl(base)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      dom.window.close();
    }
  }
});
