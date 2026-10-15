/** Real SQL enrollment and Maps service; no location, provider credential or model call. */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Memory } from "@elizaos/core";
import { expect, test } from "vitest";
import { handleDeviceActionRoutes } from "../../../packages/agent/src/api/device-action-routes.ts";
import { handleMapsNavigationRelay } from "../../../packages/agent/src/api/maps-navigation-relay.ts";
import { createMachineSession } from "../../../packages/app/src/api/auth/sessions.ts";
import { resolveAuthorizedRouteRole } from "../../../packages/app/src/api/auth.ts";
import {
  AuthStore,
  type DrizzleDatabase,
} from "../../../packages/app/src/services/auth-store.ts";
import { createTestRuntime } from "../../../packages/testing/src/pglite-runtime.ts";
import {
  mapsAction,
  mapsNavigationAction,
} from "../../plugin-maps/src/action.ts";
import { withMapsNavigationRelay } from "../../plugin-maps/src/client/navigation-relay.ts";
import { mapsPlugin } from "../../plugin-maps/src/plugin.ts";
import { MapsService } from "../../plugin-maps/src/service.ts";
import {
  DeviceActionService,
  setDeviceReadReplyConversation,
  withDeviceActionTurn,
} from "../src/services/device-actions/service.ts";

test("Maps requests reach only their enrolled conversation, once, and require a live enrollment for the result", async () => {
  const { runtime, cleanup } = await createTestRuntime({
    characterName: "MapsRelayFixture",
  });
  const devices = new DeviceActionService(runtime);
  const credential = {
    subjectUserId: randomUUID(),
    installationId: randomUUID(),
    deviceKey: "a".repeat(64),
  };
  const other = {
    ...credential,
    subjectUserId: randomUUID(),
    installationId: randomUUID(),
    deviceKey: "b".repeat(64),
  };
  const conversationId = randomUUID(),
    offerId = randomUUID();
  try {
    await devices.register(credential, "Maps fixture");
    await devices.register(other, "Other fixture");
    await runtime.registerService(MapsService);
    await runtime.getServiceLoadPromise(MapsService.serviceType);
    const maps = runtime.getService<MapsService>(MapsService.serviceType);
    if (!maps) throw Error("Maps service unavailable");
    const poll = (who = credential, conversation = conversationId) =>
      handleMapsNavigationRelay(runtime, who, {
        offerId,
        phase: "poll",
        conversationId: conversation,
      });
    await handleMapsNavigationRelay(runtime, credential, {
      phase: "open",
      offerId,
      conversationId,
    });
    await handleMapsNavigationRelay(runtime, other, {
      phase: "open",
      offerId,
      conversationId,
    });
    expect(await poll()).toEqual({ protocol: 1, request: null });
    await expect(maps.requireDeviceNavigation().stop()).rejects.toMatchObject({
      code: "MAPS_DEVICE_UNAVAILABLE",
    });
    await withDeviceActionTurn(runtime, credential, async () => {
      setDeviceReadReplyConversation(runtime, conversationId, randomUUID());
      const completed = maps.requireDeviceNavigation().stop();
      // Yield until the canonical enrollment lookup completes and queues the request.
      let delivered: Awaited<ReturnType<typeof poll>>;
      do {
        await new Promise((resolve) => setTimeout(resolve, 5));
        delivered = await poll();
      } while (!delivered.request);
      const request = delivered.request;
      expect(request.operation).toEqual({ kind: "stop" });
      expect(await poll(other)).toEqual({ protocol: 1, request: null });
      expect(await poll()).toEqual({ protocol: 1, request: null });
      await expect(
        handleMapsNavigationRelay(runtime, other, {
          offerId,
          phase: "result",
          conversationId,
          id: request.id,
          status: { state: "stopped" },
        }),
      ).rejects.toThrow();
      await expect(
        handleMapsNavigationRelay(runtime, credential, {
          offerId,
          phase: "result",
          conversationId,
          id: request.id,
          status: {
            state: "stopped",
            coordinates: { latitude: 1, longitude: 2 },
          },
        }),
      ).rejects.toThrow();
      for (const malformed of [
        ...[{}, 1].flatMap((value) => [
          { phase: value, status: { state: "stopped" } },
          { phase: "result", status: { state: value } },
          { phase: "result", status: { state: "stopped", travelMode: value } },
        ]),
        { phase: ["result"], status: { state: "stopped" } },
        { phase: "result", status: { state: ["stopped"] } },
        {
          phase: "result",
          status: { state: "stopped", travelMode: ["drive"] },
        },
      ]) {
        await expect(
          handleMapsNavigationRelay(runtime, credential, {
            offerId,
            conversationId,
            id: request.id,
            ...malformed,
          }),
        ).rejects.toThrow();
      }
      await handleMapsNavigationRelay(runtime, credential, {
        offerId,
        phase: "result",
        conversationId,
        id: request.id,
        status: { state: "stopped" },
      });
      await expect(completed).resolves.toEqual({ state: "stopped" });
      await expect(
        handleMapsNavigationRelay(runtime, credential, {
          offerId,
          phase: "result",
          conversationId,
          id: request.id,
          status: { state: "stopped" },
        }),
      ).rejects.toThrow();
    });
    // An old turn's retirement cannot withdraw a new offer in the same conversation.
    const nextOfferId = randomUUID();
    await handleMapsNavigationRelay(runtime, credential, {
      phase: "open",
      conversationId,
      offerId: nextOfferId,
    });
    await handleMapsNavigationRelay(runtime, credential, {
      phase: "retire",
      conversationId,
      offerId,
    });
    await withDeviceActionTurn(runtime, credential, async () => {
      setDeviceReadReplyConversation(runtime, conversationId, randomUUID());
      const completed = maps.requireDeviceNavigation().stop();
      const delivered = await handleMapsNavigationRelay(runtime, credential, {
        phase: "poll",
        conversationId,
        offerId: nextOfferId,
      });
      if (!delivered.request)
        throw Error("New offer was retired by stale cleanup");
      await handleMapsNavigationRelay(runtime, credential, {
        phase: "result",
        conversationId,
        offerId: nextOfferId,
        id: delivered.request.id,
        status: { state: "stopped" },
      });
      await expect(completed).resolves.toEqual({ state: "stopped" });
    });
    // Switching conversations retires queued work instead of moving it to the other turn.
    await withDeviceActionTurn(runtime, credential, async () => {
      setDeviceReadReplyConversation(runtime, conversationId, randomUUID());
      const pending = maps.requireDeviceNavigation().stop();
      const rejected = expect(pending).rejects.toMatchObject({
        code: "MAPS_DEVICE_UNAVAILABLE",
      });
      await devices.context(credential);
      await handleMapsNavigationRelay(runtime, credential, {
        phase: "open",
        conversationId: randomUUID(),
        offerId: randomUUID(),
      });
      await rejected;
    });
    await handleMapsNavigationRelay(runtime, credential, {
      phase: "open",
      conversationId,
      offerId,
    });
    // Authority is rechecked after a long poll wait, not just when the request starts.
    const waiting = { ...credential, installationId: randomUUID() };
    await devices.register(waiting, "Revocation during wait");
    await handleMapsNavigationRelay(runtime, waiting, {
      phase: "open",
      conversationId,
      offerId,
    });
    const wait = poll(waiting),
      denied = expect(wait).rejects.toThrow("Device unavailable");
    await devices.context(waiting);
    await devices.revoke(waiting);
    await denied;
    await withDeviceActionTurn(runtime, credential, async () => {
      setDeviceReadReplyConversation(runtime, conversationId, randomUUID());
      const completed = maps.requireDeviceNavigation().stop();
      const rejected = expect(completed).rejects.toMatchObject({
        code: "MAPS_DEVICE_UNAVAILABLE",
      });
      let delivered: Awaited<ReturnType<typeof poll>>;
      do {
        await new Promise((resolve) => setTimeout(resolve, 5));
        delivered = await poll();
      } while (!delivered.request);
      const request = delivered.request;
      await devices.revoke(credential);
      await expect(
        handleMapsNavigationRelay(runtime, credential, {
          offerId,
          phase: "result",
          conversationId,
          id: request.id,
          status: { state: "stopped" },
        }),
      ).rejects.toThrow();
      // Re-enrollment creates a new scope: the old request is neither delivered nor settled by it.
      const replacement = { ...credential, installationId: randomUUID() };
      await devices.register(replacement, "Re-enrolled fixture");
      await handleMapsNavigationRelay(runtime, replacement, {
        phase: "open",
        offerId,
        conversationId,
      });
      expect(await poll(replacement)).toEqual({ protocol: 1, request: null });
      await expect(
        handleMapsNavigationRelay(runtime, replacement, {
          phase: "result",
          offerId,
          conversationId,
          id: request.id,
          status: { state: "stopped" },
        }),
      ).rejects.toThrow();
      // The bounded request expires without replay or acceptance of a new enrollment.
      await rejected;
    });
  } finally {
    await cleanup();
  }
});

test("the shared phone client completes a Maps turn over authenticated HTTP and cancels pending device work", async () => {
  const { runtime, cleanup } = await createTestRuntime({
    characterName: "MapsHttpFixture",
  });
  const credential = {
    subjectUserId: randomUUID(),
    installationId: randomUUID(),
    deviceKey: "c".repeat(64),
  };
  const store = new AuthStore(runtime.adapter.db as DrizzleDatabase);
  let token = "";
  const server = createServer(async (req, res) => {
    try {
      const resolved = await resolveAuthorizedRouteRole(req, {
        store,
        allowTrustedLocalBypass: false,
        allowCookieAuth: false,
        allowBearerAuth: true,
      });
      const json = (response: typeof res, value: unknown, status = 200) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      await handleDeviceActionRoutes({
        req,
        res,
        method: "POST",
        pathname: "/api/client-devices/maps-navigation",
        runtime,
        revalidateAuthorization: async () => {
          const fresh = await resolveAuthorizedRouteRole(req, {
            store,
            allowTrustedLocalBypass: false,
            allowCookieAuth: false,
            allowBearerAuth: true,
          });
          return { ...fresh, role: fresh.ok ? fresh.role : "NONE" };
        },
        authorization: {
          ...resolved,
          role: resolved.ok ? resolved.role : "NONE",
        },
        json,
        error: (response, message, status) =>
          json(response, { error: message }, status),
        readJsonBody: async () => {
          let text = "";
          for await (const chunk of req) text += chunk;
          return JSON.parse(text);
        },
      });
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  try {
    await store.createIdentity({
      id: credential.subjectUserId,
      kind: "owner",
      displayName: "Maps HTTP owner",
      createdAt: Date.now(),
      passwordHash: null,
    });
    token = (
      await createMachineSession(store, {
        identityId: credential.subjectUserId,
        scopes: [],
      })
    ).session.id;
    await new DeviceActionService(runtime).register(credential, "HTTP phone");
    await runtime.registerPlugin(mapsPlugin);
    await runtime.getServiceLoadPromise(MapsService.serviceType);
    const maps = runtime.getService<MapsService>(MapsService.serviceType);
    if (!maps) throw Error("Maps unavailable");
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("HTTP fixture unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    const request = async (
      path: string,
      body: unknown,
      signal: AbortSignal,
    ) => {
      const response = await fetch(origin + path, {
        method: "POST",
        signal,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-eliza-device-id": credential.installationId,
          "x-eliza-device-key": credential.deviceKey,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      return response.json();
    };
    const owner = {},
      calls: string[] = [],
      connected: boolean[] = [];
    const host = {
      current: () => owner,
      failure: () => "MAPS_DEVICE_UNAVAILABLE",
      connected: (value: boolean) => {
        connected.push(value);
      },
      execute: async (_owner: object, value: unknown, signal: AbortSignal) => {
        signal.throwIfAborted();
        const operation = value as { kind: string };
        calls.push(operation.kind);
        return {
          state:
            operation.kind === "select"
              ? "selected"
              : operation.kind === "start"
                ? "awaiting-confirmation"
                : operation.kind === "reroute"
                  ? "navigating"
                  : "stopped",
        };
      },
    };
    const conversationId = randomUUID();
    await withMapsNavigationRelay(
      host,
      request,
      conversationId,
      new AbortController().signal,
      () =>
        withDeviceActionTurn(runtime, credential, async () => {
          setDeviceReadReplyConversation(runtime, conversationId, randomUUID());
          const message = {
            id: randomUUID(),
            entityId: credential.subjectUserId,
            agentId: runtime.agentId,
            roomId: randomUUID(),
            content: { text: "fixture Maps request" },
          } as Memory;
          const destination = {
            name: "Fixture place",
            latitude: 1,
            longitude: 2,
          };
          expect(
            await mapsAction.handler(runtime, message, undefined, {
              parameters: { action: "select", ...destination },
            }),
          ).toMatchObject({ data: { device: { state: "selected" } } });
          expect(
            await mapsNavigationAction.handler(runtime, message, undefined, {
              parameters: {
                action: "start",
                ...destination,
                travelMode: "walk",
              },
            }),
          ).toMatchObject({
            data: { device: { state: "awaiting-confirmation" } },
          });
          expect(
            await mapsNavigationAction.handler(runtime, message, undefined, {
              parameters: { action: "reroute" },
            }),
          ).toMatchObject({ data: { device: { state: "navigating" } } });
          expect(
            await mapsNavigationAction.handler(runtime, message, undefined, {
              parameters: { action: "stop" },
            }),
          ).toMatchObject({ data: { device: { state: "stopped" } } });
        }),
    );
    expect(calls).toEqual(["select", "start", "reroute", "stop"]);
    expect(connected).toEqual([true, false]);
    // A lost acknowledgement does not dispatch or acknowledge the operation a second time.
    let resultCalls = 0;
    await withMapsNavigationRelay(
      host,
      async (path, body, signal) => {
        const isResult = (body as { phase: string }).phase === "result";
        if (isResult) resultCalls++;
        const value = await request(path, body, signal);
        if (isResult) throw Error("Acknowledgement connection lost");
        return value;
      },
      conversationId,
      new AbortController().signal,
      () =>
        withDeviceActionTurn(runtime, credential, async () => {
          setDeviceReadReplyConversation(runtime, conversationId, randomUUID());
          await expect(maps.requireDeviceNavigation().stop()).resolves.toEqual({
            state: "stopped",
          });
        }),
    );
    expect(resultCalls).toBe(1);
    expect(calls).toEqual(["select", "start", "reroute", "stop", "stop"]);
    // Changing the phone owner while the effect settles cannot acknowledge success for the old owner.
    let currentOwner: object | null = owner;
    await withMapsNavigationRelay(
      {
        ...host,
        current: () => currentOwner,
        execute: async () => {
          currentOwner = null;
          return { state: "stopped" };
        },
      },
      request,
      conversationId,
      new AbortController().signal,
      () =>
        withDeviceActionTurn(runtime, credential, async () => {
          setDeviceReadReplyConversation(runtime, conversationId, randomUUID());
          await expect(
            maps.requireDeviceNavigation().stop(),
          ).rejects.toMatchObject({ code: "MAPS_DEVICE_UNAVAILABLE" });
        }),
    );
    // Cancellation reaches an operation already waiting on the phone and never reports success.
    const cancel = new AbortController();
    let effectSignal: AbortSignal | undefined;
    const waitingHost = {
      ...host,
      execute: async (_owner: object, _value: unknown, signal: AbortSignal) => {
        effectSignal = signal;
        cancel.abort();
        signal.throwIfAborted();
        throw Error("Unreachable effect");
      },
    };
    await withMapsNavigationRelay(
      waitingHost,
      request,
      conversationId,
      cancel.signal,
      () =>
        withDeviceActionTurn(runtime, credential, async () => {
          setDeviceReadReplyConversation(runtime, conversationId, randomUUID());
          await expect(
            maps.requireDeviceNavigation().stop(),
          ).rejects.toMatchObject({ code: "MAPS_DEVICE_UNAVAILABLE" });
        }),
    );
    expect(effectSignal?.aborted).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  }
});
