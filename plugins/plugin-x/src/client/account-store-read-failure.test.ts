/**
 * `resolveTwitterAccountConfig` consults the runtime connector-account store
 * before the `TWITTER_ACCOUNTS` registry and the single-account env settings.
 * `readRuntimeAccountRecord` used to swallow a rejected `store.getAccount` and
 * return `null`, so a broken store was indistinguishable from "this account has
 * no record": the default account silently resolved to the env credentials and
 * an explicit account resolved to blank credentials. A rejected read is an
 * infrastructure fault; only a resolved `null` means "no such record".
 */
import type { AgentRuntime } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { describe, expect, it } from "vitest";
import type {
  RuntimeWithXConnectorAccounts,
  XConnectorAccountStore,
} from "./accounts";
import { resolveTwitterAccountConfig } from "./accounts";

function runtimeWith(settings: Record<string, string>): AgentRuntime {
  return createSQLiteTestRuntime({
    logLevel: "fatal",
    character: {
      name: "Agent",
      bio: ["test"],
      settings: {
        TWITTER_API_KEY: "key",
        TWITTER_API_SECRET_KEY: "secret",
        TWITTER_ACCESS_TOKEN: "token",
        TWITTER_ACCESS_TOKEN_SECRET: "token-secret",
        ...settings,
      },
    },
  });
}

function withAccountStore(
  runtime: AgentRuntime,
  store: XConnectorAccountStore,
): AgentRuntime {
  (
    runtime as AgentRuntime & RuntimeWithXConnectorAccounts
  ).getConnectorAccountStore = () => store;
  return runtime;
}

describe("resolveTwitterAccountConfig connector account store", () => {
  it("propagates a failed store read instead of falling back to the env credentials", async () => {
    const runtime = withAccountStore(runtimeWith({}), {
      getAccount: async () => {
        throw new Error("database is locked");
      },
    });

    await expect(resolveTwitterAccountConfig(runtime)).rejects.toThrow(
      /X connector account store failed to read account "default"/,
    );
  });

  it("still falls back to the env credentials when the store has no record", async () => {
    const runtime = withAccountStore(runtimeWith({}), {
      getAccount: async () => null,
    });

    const state = await resolveTwitterAccountConfig(runtime);

    expect(state.TWITTER_API_KEY).toBe("key");
    expect(state.TWITTER_ACCESS_TOKEN).toBe("token");
  });
});
