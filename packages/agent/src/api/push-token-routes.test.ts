/**
 * Exercises handlePushTokenRoute (register/list/unregister device push tokens
 * under /api/notifications/push-tokens) against a real NotificationPushService
 * and PushTokenRegistry backed by an in-memory Map cache — covering 201
 * register, 400 validation, GET count with per-platform breakdown, DELETE
 * existence reporting, and the 503 returned when the push service is
 * unregistered.
 *
 * Also covers the uniform UTF-8 byte-cap rejection (POST body and the
 * `:token` DELETE shape) and the typed-error HTTP mapping: a token-validation
 * failure becomes 400 on every register/delete shape, while a genuine
 * persistence failure propagates (server boundary → 500) and is never swallowed
 * into a fake success.
 */
import type http from "node:http";
import { ElizaError } from "@elizaos/core";
import { createMockRuntime } from "@elizaos/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationPushService } from "../services/push/notification-push-service.ts";
import {
  PUSH_TOKEN_INVALID_CODE,
  PUSH_TOKEN_PERSIST_FAILED_CODE,
  type PushTokenRegistry,
} from "../services/push/push-token-registry.ts";
import { handlePushTokenRoute } from "./push-token-routes.ts";

async function makeRuntimeWithService(): Promise<{
  runtime: { getService: (t: string) => unknown };
  registry: PushTokenRegistry;
}> {
  const cache = new Map<string, unknown>();
  const baseRuntime = createMockRuntime({
    agentId: "00000000-0000-0000-0000-0000000000aa",
    getCache: async <T>(key: string): Promise<T | undefined> =>
      cache.get(key) as T | undefined,
    setCache: async <T>(key: string, value: T): Promise<boolean> => {
      cache.set(key, value);
      return true;
    },
    deleteCache: async (key: string): Promise<boolean> => cache.delete(key),
    // No AGENT_EVENT bus → the service starts dormant (fine for route tests).
    getService: () => null,
  });
  const service = (await NotificationPushService.start(
    baseRuntime,
  )) as NotificationPushService;
  const runtime = {
    getService: (t: string) =>
      t === NotificationPushService.serviceType ? service : null,
  };
  return { runtime, registry: service.getRegistry() };
}

function makeHelpers() {
  const json = vi.fn();
  const error = vi.fn();
  const readJsonBody = vi.fn();
  return { json, error, readJsonBody };
}

const req = (url: string) => ({ url }) as http.IncomingMessage;
const res = {} as http.ServerResponse;
const PREFIX = "/api/notifications/push-tokens";

describe("handlePushTokenRoute", () => {
  let runtime: { getService: (t: string) => unknown };
  let registry: PushTokenRegistry;

  beforeEach(async () => {
    ({ runtime, registry } = await makeRuntimeWithService());
  });

  it("ignores non push-token paths", async () => {
    const helpers = makeHelpers();
    const handled = await handlePushTokenRoute(
      req("/api/notifications"),
      res,
      "/api/notifications",
      "GET",
      { runtime },
      helpers,
    );
    expect(handled).toBe(false);
  });

  it("POST registers a token (201) and persists it", async () => {
    const helpers = makeHelpers();
    helpers.readJsonBody.mockResolvedValue({
      platform: "ios",
      token: "tok-1",
    });
    await handlePushTokenRoute(
      req(PREFIX),
      res,
      PREFIX,
      "POST",
      { runtime },
      helpers,
    );
    expect(helpers.json).toHaveBeenCalledWith(res, { ok: true }, 201);
    expect(await registry.count()).toBe(1);
    expect((await registry.list())[0]).toMatchObject({
      token: "tok-1",
      platform: "ios",
    });
  });

  it("POST rejects an invalid platform with 400", async () => {
    const helpers = makeHelpers();
    helpers.readJsonBody.mockResolvedValue({ platform: "web", token: "x" });
    await handlePushTokenRoute(
      req(PREFIX),
      res,
      PREFIX,
      "POST",
      { runtime },
      helpers,
    );
    expect(helpers.error).toHaveBeenCalledWith(res, expect.any(String), 400);
    expect(await registry.count()).toBe(0);
  });

  it("POST rejects a missing token with 400", async () => {
    const helpers = makeHelpers();
    helpers.readJsonBody.mockResolvedValue({
      platform: "android",
      token: "  ",
    });
    await handlePushTokenRoute(
      req(PREFIX),
      res,
      PREFIX,
      "POST",
      { runtime },
      helpers,
    );
    expect(helpers.error).toHaveBeenCalledWith(res, expect.any(String), 400);
  });

  it("DELETE accepts a body token without exposing it in the request URL", async () => {
    await registry.register("ios", "private/device-token");
    const helpers = makeHelpers();
    helpers.readJsonBody.mockResolvedValue({ token: "private/device-token" });
    await handlePushTokenRoute(
      req(PREFIX),
      res,
      PREFIX,
      "DELETE",
      { runtime },
      helpers,
    );
    expect(helpers.json).toHaveBeenCalledWith(res, { ok: true });
    expect(await registry.count()).toBe(0);
  });

  it("GET returns count + per-platform breakdown", async () => {
    await registry.register("ios", "i1");
    await registry.register("ios", "i2");
    await registry.register("android", "a1");
    const helpers = makeHelpers();
    await handlePushTokenRoute(
      req(PREFIX),
      res,
      PREFIX,
      "GET",
      { runtime },
      helpers,
    );
    expect(helpers.json).toHaveBeenCalledWith(res, {
      count: 3,
      platforms: { ios: 2, android: 1 },
    });
  });

  it("DELETE :token unregisters and reports existence", async () => {
    await registry.register("ios", "tok-del");
    const helpers = makeHelpers();
    await handlePushTokenRoute(
      req(`${PREFIX}/tok-del`),
      res,
      `${PREFIX}/tok-del`,
      "DELETE",
      { runtime },
      helpers,
    );
    expect(helpers.json).toHaveBeenCalledWith(res, { ok: true });
    expect(await registry.count()).toBe(0);
  });

  it("DELETE :token returns ok:false for an unknown token", async () => {
    const helpers = makeHelpers();
    await handlePushTokenRoute(
      req(`${PREFIX}/missing`),
      res,
      `${PREFIX}/missing`,
      "DELETE",
      { runtime },
      helpers,
    );
    expect(helpers.json).toHaveBeenCalledWith(res, { ok: false });
  });

  it("returns 503 when the push service is not registered", async () => {
    const helpers = makeHelpers();
    const emptyRuntime = { getService: () => null };
    await handlePushTokenRoute(
      req(PREFIX),
      res,
      PREFIX,
      "GET",
      { runtime: emptyRuntime },
      helpers,
    );
    expect(helpers.error).toHaveBeenCalledWith(res, expect.any(String), 503);
  });

  it("DELETE :token returns 400 on malformed percent-encoded token", async () => {
    const helpers = makeHelpers();
    const unregister = vi.spyOn(registry, "unregister");
    for (const badToken of ["%", "%2", "%ZZ", "%E0%A4"]) {
      const path = `${PREFIX}/${badToken}`;
      await handlePushTokenRoute(
        req(path),
        res,
        path,
        "DELETE",
        { runtime },
        helpers,
      );
      expect(helpers.error).toHaveBeenCalledWith(
        res,
        "invalid push token",
        400,
      );
    }
    expect(unregister).not.toHaveBeenCalled();
  });

  it("POST over the UTF-8 byte cap is rejected 400 by registry validation", async () => {
    const helpers = makeHelpers();
    // '€' is 3 bytes; 2000 chars = 6000 bytes, over the 4096-byte cap while the
    // char count stays small (a char-only guard would wrongly accept it).
    helpers.readJsonBody.mockResolvedValue({
      platform: "ios",
      token: "€".repeat(2000),
    });
    await handlePushTokenRoute(
      req(PREFIX),
      res,
      PREFIX,
      "POST",
      { runtime },
      helpers,
    );
    expect(helpers.error).toHaveBeenCalledWith(res, "invalid push token", 400);
    expect(helpers.json).not.toHaveBeenCalled();
    expect(await registry.count()).toBe(0);
  });

  it("DELETE :token over the UTF-8 byte cap is rejected 400 without persisting", async () => {
    const helpers = makeHelpers();
    const unregister = vi.spyOn(registry, "unregister");
    // decodeURIComponent("%E2%82%AC") === '€' (3 bytes); 2000 copies = 6000 bytes.
    const path = `${PREFIX}/${"%E2%82%AC".repeat(2000)}`;
    await handlePushTokenRoute(
      req(path),
      res,
      path,
      "DELETE",
      { runtime },
      helpers,
    );
    expect(helpers.error).toHaveBeenCalledWith(res, "invalid push token", 400);
    expect(helpers.json).not.toHaveBeenCalled();
    // The over-cap token cannot exist, but the response must be a 400, not a
    // silent ok:false; unregister still runs and fails validation internally.
    unregister.mockRestore();
  });

  it("POST maps typed validation to 400 and persistence failure to 500", async () => {
    const register = vi.spyOn(registry, "register");

    const badHelpers = makeHelpers();
    badHelpers.readJsonBody.mockResolvedValue({ platform: "ios", token: "t" });
    register.mockRejectedValueOnce(
      new ElizaError("invalid", { code: PUSH_TOKEN_INVALID_CODE }),
    );
    await handlePushTokenRoute(
      req(PREFIX),
      res,
      PREFIX,
      "POST",
      { runtime },
      badHelpers,
    );
    expect(badHelpers.error).toHaveBeenCalledWith(
      res,
      "invalid push token",
      400,
    );
    expect(badHelpers.json).not.toHaveBeenCalled();

    const downHelpers = makeHelpers();
    downHelpers.readJsonBody.mockResolvedValue({ platform: "ios", token: "t" });
    register.mockRejectedValueOnce(
      new ElizaError("persist failed", {
        code: PUSH_TOKEN_PERSIST_FAILED_CODE,
      }),
    );
    // A genuine persistence failure propagates so the server boundary serves
    // 500 — it must never be swallowed into a fake 201 or a 400.
    await expect(
      handlePushTokenRoute(
        req(PREFIX),
        res,
        PREFIX,
        "POST",
        { runtime },
        downHelpers,
      ),
    ).rejects.toThrow(/persist/);
    expect(downHelpers.error).not.toHaveBeenCalled();
    register.mockRestore();
  });

  it("DELETE maps validation to 400 and persistence to 500 for BOTH route shapes", async () => {
    const unregister = vi.spyOn(registry, "unregister");
    const bodyPath = PREFIX;
    const tokenPath = `${PREFIX}/tok`;

    // ── body shape ──────────────────────────────────────────────────
    const bodyBad = makeHelpers();
    bodyBad.readJsonBody.mockResolvedValue({ token: "tok" });
    unregister.mockRejectedValueOnce(
      new ElizaError("invalid", { code: PUSH_TOKEN_INVALID_CODE }),
    );
    await handlePushTokenRoute(
      req(bodyPath),
      res,
      bodyPath,
      "DELETE",
      { runtime },
      bodyBad,
    );
    expect(bodyBad.error).toHaveBeenCalledWith(res, "invalid push token", 400);

    const bodyDown = makeHelpers();
    bodyDown.readJsonBody.mockResolvedValue({ token: "tok" });
    unregister.mockRejectedValueOnce(
      new ElizaError("persist failed", {
        code: PUSH_TOKEN_PERSIST_FAILED_CODE,
      }),
    );
    await expect(
      handlePushTokenRoute(
        req(bodyPath),
        res,
        bodyPath,
        "DELETE",
        { runtime },
        bodyDown,
      ),
    ).rejects.toThrow(/persist/);
    expect(bodyDown.error).not.toHaveBeenCalled();

    // ── :token shape ────────────────────────────────────────────────
    const tokenBad = makeHelpers();
    unregister.mockRejectedValueOnce(
      new ElizaError("invalid", { code: PUSH_TOKEN_INVALID_CODE }),
    );
    await handlePushTokenRoute(
      req(tokenPath),
      res,
      tokenPath,
      "DELETE",
      { runtime },
      tokenBad,
    );
    expect(tokenBad.error).toHaveBeenCalledWith(res, "invalid push token", 400);

    const tokenDown = makeHelpers();
    unregister.mockRejectedValueOnce(
      new ElizaError("persist failed", {
        code: PUSH_TOKEN_PERSIST_FAILED_CODE,
      }),
    );
    await expect(
      handlePushTokenRoute(
        req(tokenPath),
        res,
        tokenPath,
        "DELETE",
        { runtime },
        tokenDown,
      ),
    ).rejects.toThrow(/persist/);
    expect(tokenDown.error).not.toHaveBeenCalled();
    unregister.mockRestore();
  });

  it("DELETE :token decodes valid percent-encoded token before unregister", async () => {
    await registry.register("ios", "tok/with-slash");
    const helpers = makeHelpers();
    const unregister = vi.spyOn(registry, "unregister");
    const path = `${PREFIX}/tok%2Fwith-slash`;
    await handlePushTokenRoute(
      req(path),
      res,
      path,
      "DELETE",
      { runtime },
      helpers,
    );
    expect(unregister).toHaveBeenCalledWith("tok/with-slash");
    expect(helpers.json).toHaveBeenCalledWith(res, { ok: true });
    expect(await registry.count()).toBe(0);
  });

  // ── #23106 recipient binding + policy seam ─────────────────────────

  describe("#23106 recipient-bound registration", () => {
    const OWNER = "22222222-2222-4222-8222-222222222222";

    function makeStateWithOwner(): {
      runtime: {
        getService: (t: string) => unknown;
        getSetting: (k: string) => string;
      };
    } {
      return {
        runtime: {
          ...runtime,
          getSetting: (key: string) =>
            key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER : ("" as string),
        },
      };
    }

    it("POST binds the token to the canonical owner when the body omits one", async () => {
      const state = makeStateWithOwner();
      const helpers = makeHelpers();
      helpers.readJsonBody.mockResolvedValue({
        platform: "ios",
        token: "tok-owned",
      });
      await handlePushTokenRoute(
        req(PREFIX),
        res,
        PREFIX,
        "POST",
        state,
        helpers,
      );
      expect(helpers.json).toHaveBeenCalledWith(res, { ok: true }, 201);
      expect((await registry.listByOwner(OWNER)).map((r) => r.token)).toEqual([
        "tok-owned",
      ]);
    });

    it("POST accepts an explicit ownerEntityId only when it IS the canonical owner", async () => {
      const state = makeStateWithOwner();
      const helpers = makeHelpers();
      helpers.readJsonBody.mockResolvedValue({
        platform: "ios",
        token: "tok-explicit",
        ownerEntityId: OWNER,
      });
      await handlePushTokenRoute(
        req(PREFIX),
        res,
        PREFIX,
        "POST",
        state,
        helpers,
      );
      expect((await registry.listByOwner(OWNER)).map((r) => r.token)).toEqual([
        "tok-explicit",
      ]);
    });

    it("POST rejects (400) an explicit ownerEntityId naming ANOTHER principal — body ids are not authorization", async () => {
      const state = makeStateWithOwner();
      const helpers = makeHelpers();
      helpers.readJsonBody.mockResolvedValue({
        platform: "ios",
        token: "tok-hijack",
        ownerEntityId: "99999999-9999-4999-8999-999999999999",
      });
      await handlePushTokenRoute(
        req(PREFIX),
        res,
        PREFIX,
        "POST",
        state,
        helpers,
      );
      expect(helpers.error).toHaveBeenCalledWith(
        res,
        expect.stringContaining("canonical owner"),
        400,
      );
      expect(await registry.count()).toBe(0);
    });

    it("POST rejects (400) a null ownerEntityId — only omission means canonical default", async () => {
      const state = makeStateWithOwner();
      const helpers = makeHelpers();
      helpers.readJsonBody.mockResolvedValue({
        platform: "ios",
        token: "tok-null-owner",
        ownerEntityId: null,
      });
      await handlePushTokenRoute(
        req(PREFIX),
        res,
        PREFIX,
        "POST",
        state,
        helpers,
      );
      expect(helpers.error).toHaveBeenCalledWith(
        res,
        expect.stringContaining("canonical owner"),
        400,
      );
      expect(await registry.count()).toBe(0);
    });

    it("POST rejects (400) a malformed ownerEntityId instead of silently defaulting", async () => {
      const state = makeStateWithOwner();
      const helpers = makeHelpers();
      helpers.readJsonBody.mockResolvedValue({
        platform: "ios",
        token: "tok-bad-owner",
        ownerEntityId: 42,
      });
      await handlePushTokenRoute(
        req(PREFIX),
        res,
        PREFIX,
        "POST",
        state,
        helpers,
      );
      expect(helpers.error).toHaveBeenCalledWith(
        res,
        expect.stringContaining("canonical owner"),
        400,
      );
      expect(await registry.count()).toBe(0);
    });

    it("POST registers unowned (fail-closed) when no owner is resolvable anywhere", async () => {
      const noOwnerState = { runtime: { ...runtime, getSetting: undefined } };
      const helpers = makeHelpers();
      helpers.readJsonBody.mockResolvedValue({
        platform: "ios",
        token: "tok-free",
      });
      await handlePushTokenRoute(
        req(PREFIX),
        res,
        PREFIX,
        "POST",
        noOwnerState,
        helpers,
      );
      expect(helpers.json).toHaveBeenCalledWith(res, { ok: true }, 201);
      const all = await registry.list();
      expect(all[0].ownerEntityId).toBeUndefined();
    });
  });

  describe("#23106 push-policy routes", () => {
    const POLICY_PATH = "/api/notifications/push-policy";
    const OWNER = "22222222-2222-4222-8222-222222222222";

    function ownerState(): {
      runtime: {
        getService: (t: string) => unknown;
        getSetting: (k: string) => string;
      };
    } {
      return {
        runtime: {
          ...runtime,
          getSetting: (key: string) =>
            key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER : ("" as string),
        },
      };
    }

    it("GET returns null policy before any write (the fail-closed default)", async () => {
      const helpers = makeHelpers();
      await handlePushTokenRoute(
        req(POLICY_PATH),
        res,
        POLICY_PATH,
        "GET",
        ownerState(),
        helpers,
      );
      expect(helpers.json).toHaveBeenCalledWith(res, { policy: null });
    });

    it("PUT persists an allow policy, versions it, and GET round-trips", async () => {
      const put = makeHelpers();
      put.readJsonBody.mockResolvedValue({ pushEnabled: true });
      await handlePushTokenRoute(
        req(POLICY_PATH),
        res,
        POLICY_PATH,
        "PUT",
        ownerState(),
        put,
      );
      expect(put.json).toHaveBeenCalled();
      const saved = put.json.mock.calls[0][1] as {
        policy: { pushEnabled: boolean; version: number };
      };
      expect(saved.policy.pushEnabled).toBe(true);
      expect(saved.policy.version).toBe(1);

      const second = makeHelpers();
      second.readJsonBody.mockResolvedValue({ pushEnabled: false });
      await handlePushTokenRoute(
        req(POLICY_PATH),
        res,
        POLICY_PATH,
        "PUT",
        ownerState(),
        second,
      );
      const bumped = second.json.mock.calls[0][1] as {
        policy: { version: number };
      };
      expect(bumped.policy.version).toBe(2);

      const get = makeHelpers();
      await handlePushTokenRoute(
        req(POLICY_PATH),
        res,
        POLICY_PATH,
        "GET",
        ownerState(),
        get,
      );
      const read = get.json.mock.calls[0][1] as {
        policy: { pushEnabled: boolean; version: number };
      };
      expect(read.policy.pushEnabled).toBe(false);
      expect(read.policy.version).toBe(2);
    });

    it("PUT rejects a non-boolean pushEnabled with 400", async () => {
      const helpers = makeHelpers();
      helpers.readJsonBody.mockResolvedValue({ pushEnabled: "yes" });
      await handlePushTokenRoute(
        req(POLICY_PATH),
        res,
        POLICY_PATH,
        "PUT",
        ownerState(),
        helpers,
      );
      expect(helpers.error).toHaveBeenCalledWith(
        res,
        expect.stringContaining("pushEnabled"),
        400,
      );
    });

    it("concurrent PUTs for one principal serialize to distinct monotonic versions (no lost opt-out)", async () => {
      // Two PUTs in flight through the REAL route handler + real service and
      // store, with the store's FIRST cache read blocked until both requests
      // are queued — without per-principal serialization both would load the
      // same absent row and both report version 1, silently losing one
      // opt-out.
      const cache = new Map<string, unknown>();
      let resolveFirstRead: (() => void) | undefined;
      const firstRead = new Promise<void>((resolve) => {
        resolveFirstRead = resolve;
      });
      let reads = 0;
      const baseRuntime = createMockRuntime({
        agentId: "00000000-0000-0000-0000-0000000000aa",
        getCache: async <T>(key: string): Promise<T | undefined> => {
          reads += 1;
          if (reads === 1) await firstRead;
          return cache.get(key) as T | undefined;
        },
        setCache: async <T>(key: string, value: T): Promise<boolean> => {
          cache.set(key, value);
          return true;
        },
        getService: () => null,
      });
      const service = (await NotificationPushService.start(
        baseRuntime,
      )) as NotificationPushService;
      const gatedState = {
        runtime: {
          getService: (t: string) =>
            t === NotificationPushService.serviceType ? service : null,
          getSetting: (key: string) =>
            key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER : ("" as string),
        },
      };

      const put = (pushEnabled: boolean) => {
        const helpers = makeHelpers();
        helpers.readJsonBody.mockResolvedValue({ pushEnabled });
        return handlePushTokenRoute(
          req(POLICY_PATH),
          res,
          POLICY_PATH,
          "PUT",
          gatedState,
          helpers,
        ).then(() => {
          const payload = helpers.json.mock.calls[0]?.[1] as {
            policy: { pushEnabled: boolean; version: number };
          };
          return payload.policy;
        });
      };

      const enable = put(true);
      const disable = put(false);
      resolveFirstRead?.();
      const [enabledPolicy, disabledPolicy] = await Promise.all([
        enable,
        disable,
      ]);
      // The route routes PUT through PushPolicyStore.update: distinct
      // monotonic versions (1 then 2) prove the two requests serialized and
      // neither opt-out was lost to a same-version overwrite.
      expect(enabledPolicy.version).toBe(1);
      expect(disabledPolicy.version).toBe(2);

      const get = makeHelpers();
      await handlePushTokenRoute(
        req(POLICY_PATH),
        res,
        POLICY_PATH,
        "GET",
        gatedState,
        get,
      );
      const read = get.json.mock.calls[0][1] as {
        policy: { pushEnabled: boolean; version: number };
      };
      expect(read.policy.pushEnabled).toBe(false);
      expect(read.policy.version).toBe(2);
    });

    it("fails closed with 409 when no canonical recipient is configured", async () => {
      const helpers = makeHelpers();
      const bare = { runtime: { ...runtime, getSetting: undefined } };
      await handlePushTokenRoute(
        req(POLICY_PATH),
        res,
        POLICY_PATH,
        "GET",
        bare,
        helpers,
      );
      expect(helpers.error).toHaveBeenCalledWith(
        res,
        expect.stringContaining("no canonical recipient"),
        409,
      );
    });
  });
});
