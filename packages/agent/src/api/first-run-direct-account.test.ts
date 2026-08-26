/**
 * Verifies first-run paid-provider adoption against real encrypted account
 * storage and a deterministic host pool; provider HTTP calls are mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listAccounts } from "@elizaos/auth/account-storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  accounts: [] as Array<Record<string, unknown>>,
  upsert: vi.fn(),
  deleteMetadata: vi.fn(),
}));

vi.mock("../runtime/host-bridge.ts", () => ({
  getAgentHostBridge: () => ({
    getDefaultAccountPool: () => ({
      list: () => state.accounts,
      upsert: state.upsert,
      deleteMetadata: state.deleteMetadata,
    }),
  }),
}));

import { adoptFirstRunDirectAccount } from "./first-run-direct-account.ts";

let stateRoot = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  stateRoot = mkdtempSync(path.join(tmpdir(), "first-run-direct-account-"));
  previousStateDir = process.env.ELIZA_STATE_DIR;
  process.env.ELIZA_STATE_DIR = stateRoot;
  state.accounts = [];
  state.upsert.mockReset().mockImplementation(async (account) => {
    state.accounts.push(account);
  });
  state.deleteMetadata.mockReset().mockImplementation(async (_provider, id) => {
    state.accounts = state.accounts.filter((account) => account.id !== id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = previousStateDir;
  rmSync(stateRoot, { recursive: true, force: true });
});

describe("first-run direct account adoption", () => {
  it("rejects an invalid OpenRouter key without account persistence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );

    await expect(
      adoptFirstRunDirectAccount({
        providerId: "openrouter-api",
        apiKey: "invalid-key",
      }),
    ).rejects.toMatchObject({ code: "FIRST_RUN_DIRECT_CREDENTIAL_INVALID" });

    expect(state.upsert).not.toHaveBeenCalled();
    expect(await listAccounts("openrouter-api")).toEqual([]);
  });

  it("stores a proven OpenRouter key only in the canonical account record", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { label: "primary" } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "openai/gpt-5" }] }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const adopted = await adoptFirstRunDirectAccount({
      providerId: "openrouter-api",
      apiKey: "sk-or-valid",
    });

    expect(state.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "openrouter-api",
        health: "ok",
      }),
    );
    const records = await listAccounts("openrouter-api");
    expect(records).toHaveLength(1);
    expect(records[0]?.credentials.access).toBe("sk-or-valid");
    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
    await adopted.rollback();
    expect(await listAccounts("openrouter-api")).toEqual([]);
    expect(state.accounts).toEqual([]);
  });

  it("adopts a proven xAI key through the same account authority", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ id: "grok-code-fast-1" }] }), {
            status: 200,
          }),
      ),
    );

    await adoptFirstRunDirectAccount({
      providerId: "xai-api",
      apiKey: "xai-valid",
    });

    expect(state.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "xai-api", health: "ok" }),
    );
    expect((await listAccounts("xai-api"))[0]?.credentials.access).toBe(
      "xai-valid",
    );
    expect(process.env.XAI_API_KEY).toBeUndefined();
  });
});
