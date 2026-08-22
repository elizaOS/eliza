/**
 * Unit tests for Instagram account-config resolution (`accounts.ts`) against a
 * mocked runtime — professional-account default, named `INSTAGRAM_ACCOUNTS`, and
 * character-settings sources. No live Instagram API.
 */
import { type Content, ElizaError, type IAgentRuntime, type TargetInfo } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  listInstagramAccountIds,
  resolveDefaultInstagramAccountId,
  resolveInstagramAccountConfig,
} from "../accounts.js";
import { InstagramService } from "../service.js";

function runtime(
  settings: Record<string, string>,
  characterSettings: Record<string, unknown> = {}
): IAgentRuntime {
  return {
    character: { settings: characterSettings },
    getSetting: vi.fn((key: string) => settings[key] ?? null),
  } as IAgentRuntime;
}

describe("Instagram account config", () => {
  it("resolves Graph credentials as the default professional account", () => {
    const rt = runtime({
      INSTAGRAM_GRAPH_ACCOUNT_ID: "owner",
      INSTAGRAM_ACCESS_TOKEN: "password",
    });

    expect(resolveDefaultInstagramAccountId(rt)).toBe("default");
    expect(listInstagramAccountIds(rt)).toContain("default");
    expect(resolveInstagramAccountConfig(rt).accountId).toBe("default");
  });

  it("does not reinterpret private username/password settings as Graph credentials", () => {
    const config = resolveInstagramAccountConfig(
      runtime({ INSTAGRAM_USERNAME: "consumer", INSTAGRAM_PASSWORD: "private-password" })
    );
    expect(config.accessToken).toBe("");
    expect(config.instagramAccountId).toBe("");
    expect(JSON.stringify(config)).not.toContain("private-password");
  });

  it("resolves named accounts from INSTAGRAM_ACCOUNTS", () => {
    const rt = runtime({
      INSTAGRAM_DEFAULT_ACCOUNT_ID: "brand",
      INSTAGRAM_ACCOUNTS: JSON.stringify({
        brand: {
          instagramAccountId: "brand",
          accessToken: "brand-password",
        },
      }),
    });

    const config = resolveInstagramAccountConfig(rt);
    expect(config.accountId).toBe("brand");
    expect(config.instagramAccountId).toBe("brand");
  });
});

describe("INSTAGRAM_ACCOUNTS fail-closed parsing (#18969)", () => {
  it("throws a typed config error on malformed JSON instead of an empty map", () => {
    const rt = runtime({ INSTAGRAM_ACCOUNTS: "{not json" });

    try {
      listInstagramAccountIds(rt);
      throw new Error("expected malformed INSTAGRAM_ACCOUNTS to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe("INSTAGRAM_CONFIG_INVALID");
      expect((error as ElizaError).severity).toBe("fatal");
      expect((error as ElizaError).context).toEqual({
        setting: "INSTAGRAM_ACCOUNTS",
      });
      expect((error as Error).cause).toBeInstanceOf(SyntaxError);
    }
  });

  it("throws a typed config error on every valid-JSON primitive", () => {
    for (const value of ["just-a-string", 7, null, true]) {
      const rt = runtime({ INSTAGRAM_ACCOUNTS: JSON.stringify(value) });
      try {
        listInstagramAccountIds(rt);
        throw new Error("expected primitive INSTAGRAM_ACCOUNTS to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(ElizaError);
        expect((error as ElizaError).code).toBe("INSTAGRAM_CONFIG_INVALID");
        expect((error as ElizaError).severity).toBe("fatal");
        expect((error as ElizaError).context).toEqual({
          setting: "INSTAGRAM_ACCOUNTS",
          valueType: value === null ? "null" : typeof value,
        });
      }
    }
  });

  it("normalizes padded object keys so listing and lookup agree", () => {
    const rt = runtime({
      INSTAGRAM_DEFAULT_ACCOUNT_ID: "brand",
      INSTAGRAM_ACCOUNTS: JSON.stringify({
        " brand ": { instagramAccountId: "brand-user", accessToken: "brand-password" },
      }),
    });

    expect(listInstagramAccountIds(rt)).toContain("brand");
    const config = resolveInstagramAccountConfig(rt);
    expect(config.accountId).toBe("brand");
    // Pre-#18969 the padded key listed as `brand` but resolved to an empty
    // config (no professional account ID) because lookup used the raw map key.
    expect(config.instagramAccountId).toBe("brand-user");
  });

  it("keeps well-formed object and array shapes working", () => {
    const objectRt = runtime({
      INSTAGRAM_ACCOUNTS: JSON.stringify({ a: { instagramAccountId: "a-user" } }),
    });
    expect(listInstagramAccountIds(objectRt)).toContain("a");

    const arrayRt = runtime({
      INSTAGRAM_ACCOUNTS: JSON.stringify([{ accountId: "b", instagramAccountId: "b-user" }]),
    });
    expect(listInstagramAccountIds(arrayRt)).toContain("b");
  });

  it("normalizes padded array ids and skips junk entries in both shapes", () => {
    const arrayRt = runtime({
      INSTAGRAM_ACCOUNTS: JSON.stringify([
        null,
        "junk",
        [],
        { id: " work ", instagramAccountId: "work-user" },
      ]),
    });
    expect(listInstagramAccountIds(arrayRt)).toEqual(["work"]);
    expect(resolveInstagramAccountConfig(arrayRt, "work").instagramAccountId).toBe("work-user");

    const objectRt = runtime({
      INSTAGRAM_ACCOUNTS: JSON.stringify({
        junk: "not-an-account",
        nestedArray: [],
        " brand ": { instagramAccountId: "brand-user" },
      }),
    });
    expect(listInstagramAccountIds(objectRt)).toEqual(["brand"]);
    expect(resolveInstagramAccountConfig(objectRt, "brand").instagramAccountId).toBe("brand-user");
  });

  it("fails closed when distinct entries normalize to the same id", () => {
    const rt = runtime({
      INSTAGRAM_ACCOUNTS: JSON.stringify({
        brand: { instagramAccountId: "first" },
        " brand ": { instagramAccountId: "second" },
      }),
    });
    expect(() => listInstagramAccountIds(rt)).toThrowError(/duplicate account id "brand"/);
  });

  it("normalizes character account keys before listing and lookup", () => {
    const rt = runtime(
      {},
      {
        instagram: {
          accounts: {
            " brand ": { instagramAccountId: "character-brand" },
          },
        },
      }
    );
    expect(listInstagramAccountIds(rt)).toEqual(["brand"]);
    expect(resolveInstagramAccountConfig(rt, "brand").instagramAccountId).toBe("character-brand");
  });
});

describe("Instagram connector accounts", () => {
  it("registers account-scoped connectors and routes sends through the requested account", async () => {
    const messageRegistrations: Array<
      Parameters<NonNullable<IAgentRuntime["registerMessageConnector"]>>[0]
    > = [];
    const registerMessageConnector = vi.fn((registration) => {
      messageRegistrations.push(registration);
    });
    const registerPostConnector = vi.fn();
    const rt = {
      agentId: "agent-1",
      registerMessageConnector,
      registerPostConnector,
      registerSendHandler: vi.fn(),
      getRoom: vi.fn(),
      logger: { info: vi.fn() },
    } as IAgentRuntime;

    const service = Object.create(InstagramService.prototype) as InstagramService;
    const owner = Object.create(InstagramService.prototype) as InstagramService;
    const brand = Object.create(InstagramService.prototype) as InstagramService;
    const ownerSend = vi.fn();
    const brandSend = vi.fn();
    Object.assign(owner, {
      instagramConfig: { accountId: "owner", instagramAccountId: "owner", accessToken: "pw" },
      isRunning: true,
      sendDirectMessage: ownerSend,
    });
    Object.assign(brand, {
      instagramConfig: { accountId: "brand", instagramAccountId: "brand", accessToken: "pw" },
      isRunning: true,
      sendDirectMessage: brandSend,
    });
    Object.assign(service, {
      defaultAccountId: "owner",
      accountServices: new Map([
        ["owner", owner],
        ["brand", brand],
      ]),
    });

    InstagramService.registerSendHandlers(rt, service, "owner");
    InstagramService.registerSendHandlers(rt, service, "brand");

    expect(registerMessageConnector).toHaveBeenCalledTimes(2);
    expect(registerPostConnector).toHaveBeenCalledTimes(2);
    expect(messageRegistrations.map((registration) => registration.accountId)).toEqual([
      "owner",
      "brand",
    ]);

    const brandRegistration = messageRegistrations[1];
    await brandRegistration.sendHandler(
      rt,
      {
        source: "instagram",
        accountId: "brand",
        channelId: "thread-brand",
      } as TargetInfo,
      { text: "hello" } as Content
    );

    expect(brandSend).toHaveBeenCalledWith("thread-brand", "hello");
    expect(ownerSend).not.toHaveBeenCalled();
  });

  it("rejects an unrecognized accountId on handleSendPost instead of posting as the default account", async () => {
    const service = Object.create(InstagramService.prototype) as InstagramService;
    const postComment = vi.fn(async () => "comment-1");
    Object.assign(service, {
      defaultAccountId: "owner",
      instagramConfig: { accountId: "owner", instagramAccountId: "owner", accessToken: "pw" },
      isRunning: true,
      accountServices: new Map(),
      postComment,
    });
    (service as { accountServices: Map<string, InstagramService> }).accountServices.set(
      "owner",
      service
    );
    const runtime = { agentId: "00000000-0000-0000-0000-000000000001" } as IAgentRuntime;

    await expect(
      service.handleSendPost(runtime, {
        text: "hello-from-ghost",
        accountId: "ghost-account",
        metadata: { mediaId: "17895695668004550" },
      } as Content)
    ).rejects.toThrow(
      "Instagram account 'ghost-account' is not available in this service instance"
    );
    expect(postComment).not.toHaveBeenCalled();
  });

  it("still posts when handleSendPost omits accountId", async () => {
    const service = Object.create(InstagramService.prototype) as InstagramService;
    const postComment = vi.fn(async () => "comment-ok");
    Object.assign(service, {
      defaultAccountId: "owner",
      instagramConfig: { accountId: "owner", instagramAccountId: "owner", accessToken: "pw" },
      isRunning: true,
      accountServices: new Map(),
      postComment,
    });
    (service as { accountServices: Map<string, InstagramService> }).accountServices.set(
      "owner",
      service
    );
    const runtime = { agentId: "00000000-0000-0000-0000-000000000001" } as IAgentRuntime;
    const result = await service.handleSendPost(runtime, {
      text: "hello",
      metadata: { mediaId: "17895695668004550" },
    } as Content);

    expect(postComment).toHaveBeenCalledWith("17895695668004550", "hello");
    expect(result.metadata).toMatchObject({ accountId: "owner" });
  });

  it("fails API operations explicitly when the production Graph client is absent", async () => {
    const service = Object.create(InstagramService.prototype) as InstagramService;
    Object.assign(service, {
      isRunning: true,
    });

    for (const operation of [
      service.sendDirectMessage("thread-1", "hello"),
      service.postComment("123", "hello"),
      service.getUserInfo(456),
      service.getThreads(),
    ]) {
      const error = await operation.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe("INSTAGRAM_CONFIG_INVALID");
    }
  });

  it("rejects media IDs with trailing junk instead of prefix-parsing them", async () => {
    const service = Object.create(InstagramService.prototype) as InstagramService;
    const postComment = vi.fn(async () => 99);
    Object.assign(service, {
      defaultAccountId: "default",
      instagramConfig: {
        accountId: "default",
        instagramAccountId: "user",
        accessToken: "password",
      },
      isRunning: true,
      postComment,
    });

    const runtime = { agentId: "00000000-0000-0000-0000-000000000001" } as IAgentRuntime;

    await expect(
      service.handleSendPost(runtime, {
        text: "hello",
        metadata: { mediaId: "123junk" },
      } as Content)
    ).rejects.toThrow("requires mediaId, target, or replyTo");
    expect(postComment).not.toHaveBeenCalled();
  });

  it("preserves media IDs larger than JavaScript's safe integer range", async () => {
    const service = Object.create(InstagramService.prototype) as InstagramService;
    const postComment = vi.fn(async () => "17900000000000001");
    Object.assign(service, {
      defaultAccountId: "default",
      instagramConfig: {
        accountId: "default",
        instagramAccountId: "user",
        accessToken: "password",
      },
      isRunning: true,
      postComment,
    });

    const runtime = { agentId: "00000000-0000-0000-0000-000000000001" } as IAgentRuntime;
    const mediaId = "17895695668004550";
    const result = await service.handleSendPost(runtime, {
      text: "hello",
      metadata: { mediaId },
    } as Content);

    expect(postComment).toHaveBeenCalledWith(mediaId, "hello");
    expect(result.content.metadata).toMatchObject({ instagramMediaId: mediaId });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "0", "000", "1e3", "-1", "1.5"])(
    "rejects non-positive or non-canonical media ID %p",
    async (mediaId) => {
      const service = Object.create(InstagramService.prototype) as InstagramService;
      const postComment = vi.fn(async () => "99");
      Object.assign(service, {
        defaultAccountId: "default",
        instagramConfig: {
          accountId: "default",
          instagramAccountId: "user",
          accessToken: "password",
        },
        isRunning: true,
        postComment,
      });
      const runtime = { agentId: "00000000-0000-0000-0000-000000000001" } as IAgentRuntime;

      await expect(
        service.handleSendPost(runtime, { text: "hello", metadata: { mediaId } } as Content)
      ).rejects.toThrow("requires mediaId, target, or replyTo");
      expect(postComment).not.toHaveBeenCalled();
    }
  );
});
