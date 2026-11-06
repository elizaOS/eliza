/**
 * OAuth account linking must keep distinct provider identities as distinct
 * stored accounts. Drives the real `startAnthropicOAuthFlow` /
 * `startCodexOAuthFlow` orchestration over a real on-disk credential store;
 * only the vendor login modules and the Anthropic profile HTTP call are
 * replaced.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AccountStoragePolicy,
  createIsolatedAccountStoragePolicy,
  listAccounts,
  saveAccount,
} from "./account-storage.ts";
import {
  type FlowState,
  type OAuthFlowHandle,
  startAnthropicOAuthFlow,
  startCodexOAuthFlow,
  subscribeFlow,
} from "./oauth-flow.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const vendor = vi.hoisted(() => ({
  nextCreds: null as null | {
    access: string;
    refresh: string;
    expires: number;
    idToken?: string;
  },
}));

function takeCreds() {
  const creds = vendor.nextCreds;
  if (!creds) throw new Error("test did not stage vendor credentials");
  vendor.nextCreds = null;
  return creds;
}

vi.mock("./vendor/pi-oauth/anthropic-login.ts", () => ({
  startAnthropicOAuthFlowRaw: async () => ({
    authUrl: "https://claude.ai/oauth/authorize?state=test",
    completion: Promise.resolve(takeCreds()),
    submitCode: () => undefined,
    cancel: () => undefined,
  }),
}));

vi.mock("./openai-codex.ts", () => ({
  startCodexLogin: async () => ({
    authUrl: "https://auth.openai.com/oauth/authorize?state=test",
    state: "test",
    submitCode: () => undefined,
    credentials: Promise.resolve(takeCreds()),
    close: () => undefined,
  }),
}));

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000;

interface AnthropicProfile {
  accountUuid: string;
  orgUuid: string;
  email: string;
}

/** Anthropic profiles keyed by the access token the vendor flow returns. */
const anthropicProfiles = new Map<string, AnthropicProfile>();

let home: string;
let policy: AccountStoragePolicy;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "eliza-oauth-dedup-"));
  policy = createIsolatedAccountStoragePolicy(home);
  anthropicProfiles.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      const profile = anthropicProfiles.get(auth.replace(/^Bearer /, ""));
      if (!profile) return new Response("unknown token", { status: 401 });
      return Response.json({
        account: { uuid: profile.accountUuid, email: profile.email },
        organization: { uuid: profile.orgUuid },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

function waitForTerminal(handle: OAuthFlowHandle): Promise<FlowState> {
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | undefined;
    let done = false;
    unsubscribe = subscribeFlow(handle.sessionId, (state) => {
      if (state.status === "pending" || done) return;
      done = true;
      unsubscribe?.();
      resolve(state);
    });
    if (done) unsubscribe();
  });
}

async function linkAnthropic(
  profile: AnthropicProfile,
  tokens: { access: string; refresh: string },
): Promise<void> {
  anthropicProfiles.set(tokens.access, profile);
  vendor.nextCreds = { ...tokens, expires: FAR_FUTURE };
  const handle = await startAnthropicOAuthFlow({
    label: "Claude",
    storagePolicy: policy,
  });
  const state = await waitForTerminal(handle);
  expect(state.error).toBeUndefined();
  expect(state.status).toBe("success");
}

function unsignedJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.sig`;
}

async function linkCodex(
  seat: { workspace: string; email?: string },
  refresh: string,
): Promise<void> {
  vendor.nextCreds = {
    access: unsignedJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: seat.workspace },
    }),
    refresh,
    expires: FAR_FUTURE,
    // The vendor completion's id token is optional; without it no email is known.
    ...(seat.email ? { idToken: unsignedJwt({ email: seat.email }) } : {}),
  };
  const handle = await startCodexOAuthFlow({
    label: "Codex",
    storagePolicy: policy,
  });
  const state = await waitForTerminal(handle);
  expect(state.error).toBeUndefined();
  expect(state.status).toBe("success");
}

function storedRefreshTokens(
  providerId: "anthropic-subscription" | "openai-codex",
) {
  return listAccounts(providerId, policy)
    .map((account) => ({
      email: account.email,
      organizationId: account.organizationId,
      refresh: account.credentials.refresh,
    }))
    .sort((a, b) => a.refresh.localeCompare(b.refresh));
}

describe("OAuth account linking keeps distinct identities apart", () => {
  it("Anthropic: a second seat in the same organization is a new account", async () => {
    await linkAnthropic(
      { accountUuid: "acct-a", orgUuid: "org-o", email: "a@x.test" },
      { access: "access-a", refresh: "refresh-a" },
    );
    await linkAnthropic(
      { accountUuid: "acct-b", orgUuid: "org-o", email: "b@x.test" },
      { access: "access-b", refresh: "refresh-b" },
    );

    expect(storedRefreshTokens("anthropic-subscription")).toEqual([
      { email: "a@x.test", organizationId: "org-o", refresh: "refresh-a" },
      { email: "b@x.test", organizationId: "org-o", refresh: "refresh-b" },
    ]);
  });

  it("Anthropic: the same user logging in again updates its one account", async () => {
    const profile = {
      accountUuid: "acct-a",
      orgUuid: "org-o",
      email: "a@x.test",
    };
    await linkAnthropic(profile, { access: "access-1", refresh: "refresh-1" });
    await linkAnthropic(profile, { access: "access-2", refresh: "refresh-2" });

    expect(storedRefreshTokens("anthropic-subscription")).toEqual([
      { email: "a@x.test", organizationId: "org-o", refresh: "refresh-2" },
    ]);
  });

  it("Anthropic: a personal account stored without a user id is upgraded in place", async () => {
    // Stored before user ids were kept, by an individual subscription that
    // reports no organization.
    saveAccount(
      {
        id: "legacy-personal",
        providerId: "anthropic-subscription",
        label: "Claude",
        source: "oauth",
        credentials: {
          access: "access-old",
          refresh: "refresh-old",
          expires: FAR_FUTURE,
        },
        createdAt: 1,
        updatedAt: 1,
        email: "a@x.test",
      },
      policy,
    );
    await linkAnthropic(
      { accountUuid: "acct-a", orgUuid: "", email: "a@x.test" },
      { access: "access-new", refresh: "refresh-new" },
    );

    expect(
      listAccounts("anthropic-subscription", policy).map((account) => ({
        id: account.id,
        userId: account.userId,
        organizationId: account.organizationId,
        refresh: account.credentials.refresh,
      })),
    ).toEqual([
      {
        id: "legacy-personal",
        userId: "acct-a",
        organizationId: undefined,
        refresh: "refresh-new",
      },
    ]);
  });

  it("Codex: a second seat in the same workspace is a new account", async () => {
    await linkCodex({ workspace: "ws-w", email: "a@x.test" }, "refresh-a");
    await linkCodex({ workspace: "ws-w", email: "b@x.test" }, "refresh-b");

    expect(storedRefreshTokens("openai-codex")).toEqual([
      { email: "a@x.test", organizationId: "ws-w", refresh: "refresh-a" },
      { email: "b@x.test", organizationId: "ws-w", refresh: "refresh-b" },
    ]);
  });

  it("Codex: one email in two workspaces is two accounts", async () => {
    await linkCodex({ workspace: "ws-1", email: "a@x.test" }, "refresh-1");
    await linkCodex({ workspace: "ws-2", email: "a@x.test" }, "refresh-2");

    expect(storedRefreshTokens("openai-codex")).toEqual([
      { email: "a@x.test", organizationId: "ws-1", refresh: "refresh-1" },
      { email: "a@x.test", organizationId: "ws-2", refresh: "refresh-2" },
    ]);
  });

  it("Codex: the same seat logging in again updates its one account", async () => {
    const seat = { workspace: "ws-w", email: "a@x.test" };
    await linkCodex(seat, "refresh-1");
    await linkCodex(seat, "refresh-2");

    expect(storedRefreshTokens("openai-codex")).toEqual([
      { email: "a@x.test", organizationId: "ws-w", refresh: "refresh-2" },
    ]);
  });

  it("Codex: the same workspace logging in again without an email updates its one account", async () => {
    await linkCodex({ workspace: "ws-w" }, "refresh-1");
    await linkCodex({ workspace: "ws-w" }, "refresh-2");

    expect(storedRefreshTokens("openai-codex")).toEqual([
      { email: undefined, organizationId: "ws-w", refresh: "refresh-2" },
    ]);
  });

  it("Codex: an account stored without an email is updated when the email becomes known", async () => {
    await linkCodex({ workspace: "ws-w" }, "refresh-1");
    await linkCodex({ workspace: "ws-w", email: "a@x.test" }, "refresh-2");

    expect(storedRefreshTokens("openai-codex")).toEqual([
      { email: "a@x.test", organizationId: "ws-w", refresh: "refresh-2" },
    ]);
  });
});
