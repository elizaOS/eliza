/**
 * Tests the OAuth flow orchestrator's state broadcast: the `FlowState`
 * emitted to `/api/accounts/:provider/oauth/status` SSE subscribers must
 * never carry the OAuth access/refresh tokens, while the in-process
 * `OAuthFlowHandle.completion` promise and the on-disk credential record
 * keep the full credentials.
 *
 * Only the vendor OAuth network layer (`startCodexLogin`) is faked — the
 * real `startGenericFlow`, `persistAccount`/`saveAccount`, `setTerminal`,
 * and listener emit paths all run for real against a temp ELIZA_HOME.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAccount } from "./account-storage";
import {
  _resetFlowRegistry,
  type FlowState,
  startCodexOAuthFlow,
  submitProviderFlowCode,
  subscribeFlow,
} from "./oauth-flow";
import type { CodexFlow } from "./openai-codex";
import { startCodexLogin } from "./openai-codex";
import type { OAuthCredentials } from "./types";

vi.mock("./openai-codex.ts", () => ({
  startCodexLogin: vi.fn(),
}));

const ACCESS_TOKEN = "codex-access-token-SECRET";
const REFRESH_TOKEN = "codex-refresh-token-SECRET";
const ID_TOKEN = "codex-id-token-SECRET";

const tempHomes: string[] = [];

function useTempElizaHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-oauth-flow-test-"));
  tempHomes.push(dir);
  vi.stubEnv("ELIZA_HOME", dir);
  vi.stubEnv("HOME", dir);
  vi.stubEnv("USERPROFILE", dir);
  return dir;
}

/** A controllable fake vendor flow: the test resolves the token exchange. */
function stubCodexLogin(): {
  resolveCredentials: (creds: OAuthCredentials) => void;
} {
  let resolveCredentials!: (creds: OAuthCredentials) => void;
  const credentials = new Promise<OAuthCredentials>((resolve) => {
    resolveCredentials = resolve;
  });
  const flow: CodexFlow = {
    authUrl: "https://auth.openai.com/authorize?fake",
    state: "fake-state",
    submitCode: () => undefined,
    credentials,
    close: () => undefined,
  };
  vi.mocked(startCodexLogin).mockResolvedValue(flow);
  return { resolveCredentials };
}

afterEach(() => {
  _resetFlowRegistry();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  for (const dir of tempHomes.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("oauth-flow FlowState broadcast", () => {
  it("accepts a pasted localhost callback for remote Codex clients", async () => {
    useTempElizaHome();
    let submitted = "";
    vi.mocked(startCodexLogin).mockResolvedValue({
      authUrl: "https://auth.openai.com/authorize?state=fake-state",
      state: "fake-state",
      submitCode: (code) => {
        submitted = code;
      },
      credentials: new Promise<OAuthCredentials>(() => undefined),
      close: () => undefined,
    });

    const handle = await startCodexOAuthFlow({
      label: "Remote",
      accountId: "acct-remote",
    });
    const callback =
      "http://localhost:1455/auth/callback?code=test-code&state=fake-state";

    expect(handle.needsCodeSubmission).toBe(true);
    expect(
      submitProviderFlowCode(
        "openai-codex",
        "http://localhost:1455/auth/callback?code=wrong&state=other-state",
      ),
    ).toBeNull();
    expect(submitProviderFlowCode("openai-codex", callback)).toBe(handle);
    expect(submitted).toBe(callback);
    handle.cancel();
    await expect(handle.completion).rejects.toThrow("Cancelled");
  });

  it("emits a success state without the OAuth tokens", async () => {
    useTempElizaHome();
    const vendor = stubCodexLogin();

    const handle = await startCodexOAuthFlow({
      label: "Personal",
      accountId: "acct-1",
    });
    const frames: FlowState[] = [];
    subscribeFlow(handle.sessionId, (state) => {
      frames.push(state);
    });

    vendor.resolveCredentials({
      access: ACCESS_TOKEN,
      refresh: REFRESH_TOKEN,
      expires: Date.now() + 60_000,
      idToken: ID_TOKEN,
    });
    await handle.completion;

    const success = frames.find((f) => f.status === "success");
    expect(success).toBeDefined();
    // The account summary is present for the UI…
    expect(success?.account).toMatchObject({
      id: "acct-1",
      providerId: "openai-codex",
      label: "Personal",
      source: "oauth",
    });
    // …but carries no credential material.
    expect(success?.account).not.toHaveProperty("credentials");
    // Exactly what the SSE route writes: JSON.stringify(state). No token
    // string may survive that serialization.
    for (const frame of frames) {
      const wire = JSON.stringify(frame);
      expect(wire).not.toContain(ACCESS_TOKEN);
      expect(wire).not.toContain(REFRESH_TOKEN);
    }
  });

  it("replays a token-free terminal state to late subscribers", async () => {
    useTempElizaHome();
    const vendor = stubCodexLogin();

    const handle = await startCodexOAuthFlow({
      label: "Work",
      accountId: "acct-2",
    });
    vendor.resolveCredentials({
      access: ACCESS_TOKEN,
      refresh: REFRESH_TOKEN,
      expires: Date.now() + 60_000,
    });
    await handle.completion;

    // A subscriber attaching after the flow finished gets the terminal
    // state replayed synchronously — that replay must be clean too.
    let replayed: FlowState | null = null;
    subscribeFlow(handle.sessionId, (state) => {
      replayed = state;
    });
    expect(replayed).not.toBeNull();
    const wire = JSON.stringify(replayed);
    expect(wire).not.toContain(ACCESS_TOKEN);
    expect(wire).not.toContain(REFRESH_TOKEN);
  });

  it("keeps the full credentials on the completion promise and on disk", async () => {
    useTempElizaHome();
    const vendor = stubCodexLogin();

    const handle = await startCodexOAuthFlow({
      label: "Personal",
      accountId: "acct-3",
    });
    vendor.resolveCredentials({
      access: ACCESS_TOKEN,
      refresh: REFRESH_TOKEN,
      expires: Date.now() + 60_000,
      idToken: ID_TOKEN,
    });

    // In-process consumers (CLI, credential pool) still get the tokens.
    const { account } = await handle.completion;
    expect(account.credentials.access).toBe(ACCESS_TOKEN);
    expect(account.credentials.refresh).toBe(REFRESH_TOKEN);
    expect(account.credentials.idToken).toBe(ID_TOKEN);

    // And the persisted record is intact.
    const saved = loadAccount("openai-codex", "acct-3");
    expect(saved?.credentials.access).toBe(ACCESS_TOKEN);
    expect(saved?.credentials.refresh).toBe(REFRESH_TOKEN);
    expect(saved?.credentials.idToken).toBe(ID_TOKEN);
  });

  it("emits an account-free error state when the exchange fails", async () => {
    useTempElizaHome();
    let rejectCredentials!: (err: Error) => void;
    const credentials = new Promise<OAuthCredentials>((_resolve, reject) => {
      rejectCredentials = reject;
    });
    vi.mocked(startCodexLogin).mockResolvedValue({
      authUrl: "https://auth.openai.com/authorize?fake",
      state: "fake-state",
      submitCode: () => undefined,
      credentials,
      close: () => undefined,
    });

    const handle = await startCodexOAuthFlow({
      label: "Personal",
      accountId: "acct-4",
    });
    const frames: FlowState[] = [];
    subscribeFlow(handle.sessionId, (state) => {
      frames.push(state);
    });

    rejectCredentials(new Error("exchange failed"));
    await expect(handle.completion).rejects.toThrow("exchange failed");

    const terminal = frames.find((f) => f.status === "error");
    expect(terminal).toBeDefined();
    expect(terminal?.account).toBeUndefined();
    expect(terminal?.error).toBe("exchange failed");
  });
});
