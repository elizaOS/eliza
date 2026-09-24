/**
 * Exercises the real personal client service, account policy, encrypted storage
 * and runtime connector registry. GramJS network/auth responses are controlled;
 * this is not evidence of a live Telegram connection.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  getConnectorAccountManager,
  InMemoryConnectorAccountStorage,
} from "@elizaos/core";
import {
  type RouteRequest,
  type RouteResponse,
} from "@elizaos/core/api/http-plugin";
import { Api, TelegramClient } from "telegram";
import { AuthKey } from "telegram/crypto/AuthKey.js";
import { readBigIntFromBuffer } from "telegram/Helpers.js";
import { StringSession } from "telegram/sessions/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchTelegramMessagesWithRuntimeService } from "../../plugin-personal-assistant/src/lifeops/runtime-service-delegates";
import {
  loadTelegramAccountSessionString,
  saveTelegramAccountSessionString,
} from "./account-auth-service";
import {
  type TelegramAccountClientDeps,
  TelegramAccountService,
} from "./account-client-service";
import { telegramAccountRoutes } from "./account-setup-routes";
import { createTelegramConnectorAccountProvider } from "./connector-account-provider";

vi.mock("@elizaos/core", async () => vi.importActual("@elizaos/core"));
const userId = readBigIntFromBuffer(Buffer.from([71]));
const oldEnvironment = { ...process.env };
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const key of [
    "ELIZA_STATE_DIR",
    "ELIZA_VAULT_DISABLE_KEYCHAIN",
    "ELIZA_VAULT_PASSPHRASE",
  ]) {
    if (oldEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = oldEnvironment[key];
  }
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
async function harness(
  binding = true,
  options: {
    connectionError?: Error;
    identity?: Api.User;
  } = {},
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tg-personal-"));
  directories.push(directory);
  process.env.ELIZA_STATE_DIR = directory;
  process.env.ELIZA_VAULT_DISABLE_KEYCHAIN = "1";
  process.env.ELIZA_VAULT_PASSPHRASE = "telegram-personal-test";
  const session = new StringSession("");
  session.setDC(2, "149.154.167.51", 443);
  session.authKey = new AuthKey();
  await session.authKey.setKey(Buffer.alloc(256, 17));
  const runtime = new AgentRuntime({
    character: {
      name: "History owner",
      settings: {
        telegram: {
          accounts: {
            me: {
              personal: {
                enabled: true,
                phone: "+15551234567",
                subjectId: "71",
                appId: "12345",
                appHash: "test-hash",
                session: session.save(),
              },
            },
          },
        },
      },
    },
  });
  const storage = new InMemoryConnectorAccountStorage();
  if (binding)
    storage.upsertOwnerBindingForTest({
      id: "binding",
      identityId: "owner",
      connector: "telegram",
      externalId: "71",
      displayHandle: "owner",
      instanceId: String(runtime.runtimeInstanceId),
      verifiedAt: Date.now(),
    });
  const manager = getConnectorAccountManager(runtime, storage);
  const clients: TelegramClient[] = [];
  const deps: TelegramAccountClientDeps = {
    createClient(saved, credentials) {
      const client = new TelegramClient(
        saved,
        credentials.apiId,
        credentials.apiHash,
        {},
      );
      vi.spyOn(client, "connect").mockImplementation(async () => {
        await saved.load();
        if (options.connectionError) throw options.connectionError;
        return true;
      });
      vi.spyOn(client, "disconnect").mockResolvedValue(undefined);
      vi.spyOn(client, "checkAuthorization").mockResolvedValue(true);
      vi.spyOn(client, "getMe").mockResolvedValue(
        options.identity ??
          new Api.User({
            id: userId,
            phone: "15551234567",
            firstName: "Owner",
          }),
      );
      vi.spyOn(client, "getInputEntity").mockResolvedValue(
        new Api.InputPeerUser({ userId, accessHash: userId }),
      );
      vi.spyOn(client, "invoke").mockImplementation(async (request) => {
        if (
          !(request instanceof Api.messages.GetHistory) &&
          !(request instanceof Api.messages.GetReplies)
        )
          throw new Error(`Unexpected RPC ${request.className}`);
        const rows = Array.from({ length: 205 }, (_, i) => 205 - i)
          .filter((id) => !request.offsetId || id < request.offsetId)
          .slice(0, request.limit);
        return new Api.messages.Messages({
          messages: rows.map(
            (id) =>
              new Api.Message({
                id,
                date: 1700000000 + id,
                peerId: new Api.PeerUser({ userId }),
                fromId: new Api.PeerUser({ userId }),
                message: id === 1 ? "final-page owner fact" : `row ${id}`,
              }),
          ),
          users: [],
          chats: [],
        });
      });
      clients.push(client);
      return client;
    },
  };
  const service = new TelegramAccountService(runtime, deps);
  const original = runtime.getService.bind(runtime);
  vi.spyOn(runtime, "getService").mockImplementation((type) =>
    type === "telegram-account" ? service : original(type),
  );
  manager.registerProvider(createTelegramConnectorAccountProvider(runtime));
  return { runtime, storage, service, clients, deps };
}
const target = {
  source: "telegram",
  accountId: "me:personal",
  channelId: "71",
};
describe("personal service account-bound history", () => {
  it("connects a saved session and reaches the provider final page without bot cache", async () => {
    const { runtime, service, clients } = await harness();
    await service.refreshAccount("me:personal");
    const connector = runtime
      .getMessageConnectors()
      .find((candidate) => candidate.accountId === "me:personal");
    expect(connector?.fetchMessages).toBeDefined();
    if (!connector?.fetchMessages)
      throw new Error("Personal read connector was not registered");
    const result = await connector.fetchMessages(
      { runtime, accountId: "me:personal", target },
      { target },
    );
    expect(result).toHaveLength(205);
    expect(result.at(-1)?.content.text).toBe("final-page owner fact");
    expect(new Set(result.map((row) => row.id)).size).toBe(205);
    expect(
      result.every((row) => row.metadata?.accountId === "me:personal"),
    ).toBe(true);
    expect(
      loadTelegramAccountSessionString({
        agentId: String(runtime.agentId),
        accountId: "me:personal",
      }),
    ).not.toBe("");
    await service.stop();
    expect(clients[0].disconnect).toHaveBeenCalled();
    expect(service.isConnected("me:personal")).toBe(false);
  });
  it("refuses an unbound owner before history RPC", async () => {
    const { runtime, service, clients } = await harness(false);
    await service.refreshAccount("me:personal");
    await expect(
      service.fetchConnectorMessages(
        { runtime, accountId: "me:personal", target },
        { target },
      ),
    ).rejects.toMatchObject({ code: "TELEGRAM_ACCOUNT_READ_DENIED" });
    expect(clients[0].invoke).not.toHaveBeenCalled();
    await service.stop();
  });
  it("rejects conflicting account selection and refuses reads after stop", async () => {
    const { runtime, service, clients } = await harness();
    await service.refreshAccount("me:personal");
    await expect(
      service.fetchConnectorMessages(
        { runtime, accountId: "another:personal", target },
        { target },
      ),
    ).rejects.toMatchObject({ code: "TELEGRAM_ACCOUNT_MISMATCH" });
    expect(clients[0].invoke).not.toHaveBeenCalled();
    await service.stop();
    await expect(
      service.fetchConnectorMessages(
        { runtime, accountId: "me:personal", target },
        { target },
      ),
    ).rejects.toMatchObject({ code: "TELEGRAM_ACCOUNT_NOT_CONNECTED" });
  });
  it("reconstructs the service from encrypted session storage and retains provider identities", async () => {
    const { runtime, service, deps } = await harness();
    await service.refreshAccount("me:personal");
    const first = await service.fetchConnectorMessages(
      { runtime, accountId: "me:personal", target },
      { target },
    );
    await service.stop();
    const telegram = runtime.character.settings?.telegram as {
      accounts: {
        me: {
          personal: {
            session?: string;
          };
        };
      };
    };
    delete telegram.accounts.me.personal.session;
    const replacement = new TelegramAccountService(runtime, deps);
    const fallback = vi.mocked(runtime.getService).getMockImplementation();
    if (!fallback) throw new Error("Runtime fixture lookup required");
    vi.spyOn(runtime, "getService").mockImplementation((type) =>
      type === "telegram-account" ? replacement : fallback(type),
    );
    await replacement.refreshAccount("me:personal");
    const second = await replacement.fetchConnectorMessages(
      { runtime, accountId: "me:personal", target },
      { target },
    );
    expect(second.map((row) => row.id)).toEqual(first.map((row) => row.id));
    expect(second.at(-1)?.content.text).toBe("final-page owner fact");
    await replacement.stop();
  });
  it("does not return a partial result if disconnect commits during an RPC", async () => {
    const { runtime, service, clients } = await harness();
    await service.refreshAccount("me:personal");
    const original = vi.mocked(clients[0].invoke).getMockImplementation();
    if (!original) throw new Error("RPC fixture implementation required");
    vi.spyOn(clients[0], "invoke").mockImplementation(async (request) => {
      const response = await original(request);
      await service.stopAccount("me:personal");
      return response;
    });
    await expect(
      service.fetchConnectorMessages(
        { runtime, accountId: "me:personal", target },
        { target },
      ),
    ).rejects.toMatchObject({ code: "TELEGRAM_ACCOUNT_NOT_CONNECTED" });
  });
  it("searches the complete peer before applying the requested match count", async () => {
    const { runtime, service } = await harness();
    await service.refreshAccount("me:personal");
    const result = await service.searchConnectorMessages(
      { runtime, accountId: "me:personal", target },
      { target, query: "final-page", limit: 1 },
    );
    expect(result.map((row) => row.content.text)).toEqual([
      "final-page owner fact",
    ]);
    await service.stop();
  });
  it("does not turn an unsupported room-only scope into an account-wide search", async () => {
    const { runtime, service, clients } = await harness();
    await service.refreshAccount("me:personal");
    const dialogs = vi.spyOn(clients[0], "iterDialogs");
    await expect(
      service.searchConnectorMessages(
        { runtime, accountId: "me:personal" },
        { roomId: "unmapped-room", query: "secret" },
      ),
    ).rejects.toMatchObject({ code: "TELEGRAM_HISTORY_TARGET_INVALID" });
    expect(dialogs).not.toHaveBeenCalled();
    expect(clients[0].invoke).not.toHaveBeenCalled();
    await service.stop();
  });
  it("rejects conflicting context and request targets before history RPCs", async () => {
    const { runtime, service, clients } = await harness();
    await service.refreshAccount("me:personal");
    try {
      const cases = [
        {
          contextTarget: target,
          params: { target: { ...target, channelId: "72" } },
          kind: "peer",
        },
        {
          contextTarget: { ...target, roomId: crypto.randomUUID() },
          params: { target: { ...target, roomId: crypto.randomUUID() } },
          kind: "room",
        },
        {
          contextTarget: { ...target, threadId: "1" },
          params: { target: { ...target, threadId: "2" } },
          kind: "thread",
        },
        {
          contextTarget: { ...target, threadId: "1" },
          params: { target, threadId: 2 },
          kind: "thread",
        },
      ];
      for (const { contextTarget, params, kind } of cases) {
        await expect(
          service.fetchConnectorMessages(
            { runtime, accountId: "me:personal", target: contextTarget },
            params,
          ),
        ).rejects.toMatchObject({
          code: "TELEGRAM_HISTORY_TARGET_INVALID",
          message: `Telegram ${kind} selectors disagree. Select one conversation.`,
        });
      }
      expect(clients[0].invoke).not.toHaveBeenCalled();
      const matching = { ...target, threadId: "1" };
      const rows = await service.fetchConnectorMessages(
        { runtime, accountId: "me:personal", target: matching },
        {
          target: matching,
          channelId: target.channelId,
          threadId: 1,
          limit: 1,
        },
      );
      expect(rows).toHaveLength(1);
      expect(clients[0].invoke).toHaveBeenCalledWith(
        expect.any(Api.messages.GetReplies),
      );
    } finally {
      await service.stop();
    }
  });
  it("projects a migrated application hash into the actual personal client", async () => {
    const { runtime, service, clients } = await harness();
    const telegram = runtime.character.settings?.telegram as {
      accounts: {
        me: {
          personal: {
            appHash: string;
          };
        };
      };
    };
    telegram.accounts.me.personal.appHash =
      "vault://connector.host.telegramAccount.default.appHash";
    runtime.setSetting("TELEGRAM_ACCOUNT_APP_ID", "12345");
    runtime.setSetting("TELEGRAM_ACCOUNT_APP_HASH", "projected-app-hash");
    try {
      await service.refreshAccount("me:personal");
      expect(clients[0].apiId).toBe(12345);
      expect(clients[0].apiHash).toBe("projected-app-hash");
      expect(service.isConnected("me:personal")).toBe(true);
    } finally {
      await service.stop();
    }
  });
  it("fails a migrated application credential without a resolved projection", async () => {
    const { runtime, service, clients } = await harness();
    const telegram = runtime.character.settings?.telegram as {
      accounts: {
        me: {
          personal: {
            appHash: string;
          };
        };
      };
    };
    telegram.accounts.me.personal.appHash = "vault://missing-projection";
    await expect(service.refreshAccount("me:personal")).rejects.toMatchObject({
      code: "TELEGRAM_ACCOUNT_CONFIG_INVALID",
    });
    expect(clients).toHaveLength(0);
    expect(service.getAccountStatus("me:personal")).toBe("error");
  });
  it("classifies connection failure and tears down the unusable client", async () => {
    const cause = new Error("fixture connection rejected");
    const { runtime, service, clients } = await harness(true, {
      connectionError: cause,
    });
    try {
      await expect(service.refreshAccount("me:personal")).rejects.toMatchObject(
        {
          code: "TELEGRAM_ACCOUNT_CONNECT_FAILED",
          cause,
        },
      );
      expect(service.getAccountStatus("me:personal")).toBe("error");
      expect(service.isConnected("me:personal")).toBe(false);
      expect(runtime.getMessageConnectors()).toHaveLength(0);
      expect(clients[0].disconnect).toHaveBeenCalled();
    } finally {
      await service.stop();
    }
  });
  it.each([
    {
      field: "phone",
      identity: new Api.User({ id: userId, phone: "15557654321" }),
    },
    {
      field: "subject",
      identity: new Api.User({
        id: readBigIntFromBuffer(Buffer.from([72])),
        phone: "15551234567",
      }),
    },
  ])(
    "rejects a mismatched $field before registering or reading history",
    async ({ identity }) => {
      const { runtime, service, clients } = await harness(true, { identity });
      try {
        await expect(
          service.refreshAccount("me:personal"),
        ).rejects.toMatchObject({
          code: "TELEGRAM_ACCOUNT_IDENTITY_MISMATCH",
        });
        expect(service.getAccountStatus("me:personal")).toBe("error");
        expect(runtime.getMessageConnectors()).toHaveLength(0);
        expect(clients[0].invoke).not.toHaveBeenCalled();
        expect(clients[0].disconnect).toHaveBeenCalled();
      } finally {
        await service.stop();
      }
    },
  );
  it("reports invalid configured credentials as account error", async () => {
    const { runtime, service, clients } = await harness();
    const telegram = runtime.character.settings?.telegram as {
      accounts: {
        me: {
          personal: {
            appId: string;
          };
        };
      };
    };
    telegram.accounts.me.personal.appId = "invalid";
    await expect(service.refreshAccount("me:personal")).rejects.toMatchObject({
      code: "TELEGRAM_ACCOUNT_CONFIG_INVALID",
    });
    expect(service.getAccountStatus("me:personal")).toBe("error");
    expect(clients).toHaveLength(0);
  });
  it("persists personal disconnect across reconstruction despite fallback character credentials", async () => {
    const { runtime, service, clients, deps } = await harness();
    const telegram = runtime.character.settings?.telegram as {
      accounts: Record<
        string,
        {
          personal: Record<string, unknown>;
        }
      >;
    };
    telegram.accounts.default = structuredClone(telegram.accounts.me);
    const stateDir = process.env.ELIZA_STATE_DIR;
    if (!stateDir) throw new Error("Fixture state directory required");
    const configPath = path.join(stateDir, "connector-config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        connectors: { telegramAccount: telegram.accounts.default.personal },
      }),
    );
    const setup = {
      getConfig: (): Record<string, unknown> =>
        JSON.parse(fs.readFileSync(configPath, "utf8")),
      persistConfig: (config: Record<string, unknown>) =>
        fs.writeFileSync(configPath, JSON.stringify(config)),
      updateConfig(updater: (config: Record<string, unknown>) => void) {
        const config = this.getConfig();
        updater(config);
        this.persistConfig(config);
      },
    };
    const lookup = vi.mocked(runtime.getService).getMockImplementation();
    if (!lookup) throw new Error("Runtime service fixture lookup required");
    vi.mocked(runtime.getService).mockImplementation((type) =>
      type === "connector-setup" ? (setup as never) : lookup(type),
    );
    const configuredSession = telegram.accounts.default.personal.session;
    if (typeof configuredSession !== "string")
      throw new Error("Default fixture session required");
    saveTelegramAccountSessionString(configuredSession, {
      agentId: String(runtime.agentId),
      accountId: "default:personal",
    });
    await service.refreshAccount("default:personal");
    await service.refreshAccount("me:personal");
    expect(service.isConnected("default:personal")).toBe(true);
    const route = telegramAccountRoutes.find(
      (entry) => entry.path === "/api/setup/telegram-account/cancel",
    );
    if (!route) throw new Error("Personal cancel route required");
    let status = 0;
    const response = {
      status(code: number) {
        status = code;
        return this;
      },
      json() {
        return this;
      },
    };
    try {
      await route.handler(
        {} as RouteRequest,
        response as RouteResponse,
        runtime,
      );
      expect(status).toBe(200);
      expect(service.isConnected("default:personal")).toBe(false);
      expect(service.isConnected("me:personal")).toBe(true);
      const count = clients.length;
      const replacement = new TelegramAccountService(runtime, deps);
      await replacement.refreshAccount("default:personal");
      expect(replacement.isConnected("default:personal")).toBe(false);
      expect(clients).toHaveLength(count);
      await replacement.stop();
    } finally {
      await service.stop();
    }
  });
  it("never adopts the unscoped legacy session automatically", async () => {
    const { runtime, service, clients } = await harness();
    const telegram = runtime.character.settings?.telegram as {
      accounts: Record<
        string,
        {
          personal: {
            session?: string;
          };
        }
      >;
    };
    const saved = telegram.accounts.me.personal.session;
    if (!saved) throw new Error("Session fixture missing");
    telegram.accounts.default = telegram.accounts.me;
    delete telegram.accounts.me;
    delete telegram.accounts.default.personal.session;
    saveTelegramAccountSessionString(saved);
    await service.refreshAccount("default:personal");
    expect(clients).toHaveLength(0);
    expect(service.isConnected("default:personal")).toBe(false);
    expect(loadTelegramAccountSessionString()).toBe(saved);
  });
  it("routes an actual PA personal search to MTProto and refuses a conflicting grant", async () => {
    const { runtime, service, clients } = await harness();
    await service.refreshAccount("me:personal");
    const grant = {
      id: "owner-read",
      connectorAccountId: "me:personal",
      cloudConnectionId: null,
      metadata: {},
    };
    const result = await searchTelegramMessagesWithRuntimeService({
      runtime,
      grant,
      query: "final-page",
      channelId: "71",
      limit: 1,
    });
    expect(result.status).toBe("handled");
    if (result.status !== "handled") throw new Error(result.reason);
    expect(result.value.map((row) => row.content.text)).toEqual([
      "final-page owner fact",
    ]);
    const calls = vi.mocked(clients[0].invoke).mock.calls.length;
    const denied = await searchTelegramMessagesWithRuntimeService({
      runtime,
      grant,
      accountId: "other:personal",
      query: "secret",
      channelId: "71",
    });
    expect(denied.status).toBe("unavailable");
    expect(vi.mocked(clients[0].invoke).mock.calls).toHaveLength(calls);
    await service.stop();
  });
  it("keeps identical peer/message numbers distinct across explicitly configured accounts", async () => {
    const { runtime, service } = await harness();
    const telegram = runtime.character.settings?.telegram as {
      accounts: Record<
        string,
        {
          personal: {
            session?: string;
          };
        }
      >;
    };
    telegram.accounts.other = structuredClone(telegram.accounts.me);
    await service.refreshAccount("me:personal");
    await service.refreshAccount("other:personal");
    const first = await service.fetchConnectorMessages(
      { runtime, accountId: "me:personal", target },
      { target, limit: 1 },
    );
    const otherTarget = { ...target, accountId: "other:personal" };
    const second = await service.fetchConnectorMessages(
      { runtime, accountId: "other:personal", target: otherTarget },
      { target: otherTarget, limit: 1 },
    );
    expect(first[0].metadata?.platformMessageId).toBe(
      second[0].metadata?.platformMessageId,
    );
    expect(first[0].id).not.toBe(second[0].id);
    expect(first[0].roomId).not.toBe(second[0].roomId);
    await service.stop();
  });
});
