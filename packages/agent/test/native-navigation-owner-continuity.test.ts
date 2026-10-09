/** Real root/machine auth, SQLite records, HTTP/SSE and registered view claims; no provider calls. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ActionResult,
  AgentRuntime,
  createCharacter,
  ModelType,
  resolveOwnerEntityIdOrDefault,
} from "@elizaos/core";
import { findViewActionHandoff } from "@elizaos/core/protocol";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { createAssistantPlugin } from "../../../plugins/plugin-assistant/src/index.ts";
import { actionResultToPlannerToolResult } from "../../../plugins/plugin-assistant/src/runtime/planner-loop.ts";
import { createMachineSession } from "../../app/src/api/auth/sessions.ts";
import { installMobileAuthHostBridge } from "../../app/src/runtime/install-mobile-auth-host-bridge.ts";
import { authStoreForRuntime } from "../../app/src/services/auth-store.ts";
import { viewsAction } from "../src/actions/views.ts";
import { isAuthenticatedInProcessRequest } from "../src/api/in-process-request.ts";
import { startApiServer } from "../src/api/server.ts";
import {
  registerBuiltinViews,
  registerPluginViews,
} from "../src/api/views-registry.ts";
import { _resetAgentHostBridge } from "../src/runtime/host-bridge.ts";
import { getViewClientScope } from "../src/runtime/view-client-context.ts";

it.each(["stable", "runtime-replaced", "standalone-root"])(
  "retains paired navigation authority only while its owning runtime is current: %s",
  async (scenario) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "eliza-navigation-auth-"),
    );
    const rootToken = "synthetic-navigation-root";
    for (const [key, value] of Object.entries({
      ELIZA_STATE_DIR: directory,
      ELIZA_CONFIG_PATH: path.join(directory, "config.json"),
      ELIZA_PERSIST_CONFIG_PATH: path.join(directory, "config.json"),
      ELIZA_API_BIND_HOST: "127.0.0.1",
      ELIZA_API_BIND: "127.0.0.1",
      ELIZA_API_TOKEN: rootToken,
      ELIZA_REQUIRE_LOCAL_AUTH: "1",
      ELIZA_ADMIN_ENTITY_ID: "11111111-1111-4111-8111-111111111111",
      ELIZA_DEV_AUTH_BYPASS: "0",
      ELIZA_DISABLE_VAULT_PROFILE_RESOLVER: "1",
    }))
      vi.stubEnv(key, value);
    const runtime = new AgentRuntime({
      character: createCharacter({ name: "Navigation auth fixture" }),
      plugins: [createAssistantPlugin()],
      enableAutonomy: false,
      logLevel: "fatal",
    });
    runtime.registerDatabaseAdapter(
      SQLiteDatabaseAdapter.create(
        path.join(directory, "agent.sqlite"),
        runtime.agentId,
      ),
    );
    runtime.registerModel(
      ModelType.TEXT_EMBEDDING,
      async () => [1, ...Array(383).fill(0)],
      "local-auth-fixture",
    );
    let server: Awaited<ReturnType<typeof startApiServer>> | undefined,
      otherHost: Awaited<ReturnType<typeof startApiServer>> | undefined,
      replacement: AgentRuntime | undefined;
    let nestedStatus: number | undefined;
    let release: () => void = () => {};
    const paused = Promise.withResolvers<void>();
    const resume = new Promise<void>((resolve) => (release = resolve));
    try {
      runtime.registerModel(
        ModelType.RESPONSE_HANDLER,
        async () => {
          throw new Error(
            "Auth-boundary fixture must not execute a response model",
          );
        },
        "local-auth-fixture",
      );
      runtime.registerModel(
        ModelType.ACTION_PLANNER,
        async () => {
          throw new Error(
            "Auth-boundary fixture must not execute a planner model",
          );
        },
        "local-auth-fixture",
      );
      await runtime.initialize();
      registerBuiltinViews(runtime);
      await registerPluginViews(
        runtime,
        {
          name: "paired-navigation-fixture",
          description: "Owned test views",
          views: [
            {
              id: "notes",
              label: "Notes",
              path: "/notes",
              bundleUrl: "/notes.js",
            },
          ],
        },
        { pluginDir: process.cwd(), indexEmbeddings: false },
      );
      runtime.registerAction(viewsAction);
      const store = authStoreForRuntime(runtime);
      if (!store) throw Error("Real auth repository missing");
      const identity = await store.createIdentity({
        id: randomUUID(),
        kind: "owner",
        displayName: "Paired owner",
        createdAt: Date.now(),
        passwordHash: null,
      });
      const other = await store.createIdentity({
        id: randomUUID(),
        kind: "owner",
        displayName: "Different owner identity",
        createdAt: Date.now(),
        passwordHash: null,
      });
      const paired = await createMachineSession(store, {
        identityId: identity.id,
        scopes: [],
      });
      const wrongOwner = await createMachineSession(store, {
        identityId: other.id,
        scopes: [],
      });
      const canonical = resolveOwnerEntityIdOrDefault(runtime);
      expect(identity.id).not.toBe(canonical);
      installMobileAuthHostBridge();
      server = await startApiServer({
        runtime,
        port: 0,
        skipDeferredStartupWork: true,
        requestMiddleware: async (req, res, dispatch) => {
          if (
            scenario === "runtime-replaced" &&
            isAuthenticatedInProcessRequest(req)
          ) {
            paused.resolve();
            await resume;
          }
          await dispatch();
          if (isAuthenticatedInProcessRequest(req))
            nestedStatus = res.statusCode;
        },
      });
      otherHost = await startApiServer({
        runtime,
        port: 0,
        skipDeferredStartupWork: true,
      });
      const origin = `http://127.0.0.1:${server.port}`;
      vi.stubEnv("ELIZA_API_PORT", String(server.port));
      const request = async (
        base: string,
        route: string,
        token: string,
        body?: unknown,
      ) => {
        const response = await fetch(base + route, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      };
      const me = await request(origin, "/api/auth/me", paired.session.id);
      expect(me.status).toBe(200);
      expect(me.body.identity.id).toBe(identity.id);
      expect(me.body.access.role).toBe("OWNER");
      const callerToken =
        scenario === "standalone-root" ? rootToken : paired.session.id;
      if (scenario === "standalone-root") _resetAgentHostBridge();
      const service = runtime.messageService;
      if (!service) throw Error("Message service missing");
      let actionExecutions = 0;
      let actionObserved: unknown;
      vi.spyOn(service, "handleMessage").mockImplementation(
        async (active, message) => {
          expect(message.entityId).toBe(canonical);
          actionExecutions++;
          const action = (await viewsAction.handler(
            active,
            message,
            undefined,
            {
              parameters: { action: "show", view: "notes" },
            },
          )) as ActionResult;
          const scope = getViewClientScope();
          actionObserved = {
            scope: scope
              ? {
                  clientId: scope.clientId,
                  aborted: scope.request?.signal.aborted,
                  runtimeMatches: scope.request?.runtime === active,
                  authorization: scope.request?.authorization,
                }
              : null,
            success: action.success,
            text: action.text,
            data: action.data,
          };
          if (scenario !== "runtime-replaced")
            expect(action.success).toBe(true);
          const result = actionResultToPlannerToolResult({
            ...action,
            data: { ...action.data, actionName: "VIEWS_SHOW" },
          });
          return {
            mode: "actions",
            didRespond: true,
            outcome: { status: "completed", effects: [] },
            responseContent: {
              text: "Opening Notes.",
              actions: ["VIEWS_SHOW"],
            },
            responseMessages: [],
            actionResults: [result],
          } as never;
        },
      );
      const created = await request(origin, "/api/conversations", callerToken, {
        title: "Owned navigation auth turn",
      });
      expect(created.status).toBe(200);
      const responsePending = fetch(
        `${origin}/api/conversations/${created.body.conversation.id}/messages/stream`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${callerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: "Open Notes.",
            clientMessageId: randomUUID(),
            streamProtocol: "delta-v2",
            metadata: {
              viewClientId: "paired-origin-client",
              viewDelivery: "completed-action",
              uiView: "chat",
            },
          }),
        },
      );
      if (scenario === "runtime-replaced") {
        await paused.promise;
        replacement = new AgentRuntime({
          character: createCharacter({
            name: "Replacement navigation runtime",
          }),
          enableAutonomy: false,
          logLevel: "fatal",
        });
        replacement.registerDatabaseAdapter(
          SQLiteDatabaseAdapter.create(
            path.join(directory, "replacement.sqlite"),
            replacement.agentId,
          ),
        );
        await replacement.initialize();
        registerBuiltinViews(replacement);
        await registerPluginViews(
          replacement,
          {
            name: "paired-navigation-fixture",
            description: "Replacement owned test view",
            views: [
              {
                id: "notes",
                label: "Notes",
                path: "/notes",
                bundleUrl: "/notes.js",
              },
            ],
          },
          { pluginDir: process.cwd(), indexEmbeddings: false },
        );
        server.updateRuntime(replacement);
        release();
      }
      const response = await responsePending;
      expect(response.status).toBe(200);
      const wire = await response.text();
      const frames = wire.split(/\r?\n\r?\n/).flatMap((frame) => {
        const line = frame
          .split(/\r?\n/)
          .find((line) => line.startsWith("data: "));
        return line ? [JSON.parse(line.slice(6))] : [];
      });
      if (scenario === "runtime-replaced") {
        expect(nestedStatus).toBe(403);
        expect(actionObserved).toMatchObject({
          success: false,
          text: expect.stringContaining("HTTP 403"),
        });
        expect(actionExecutions).toBe(1);
        for (const frame of frames)
          expect(findViewActionHandoff(frame.actionResults)).toBeNull();
        return;
      }
      const ready = frames.find((frame) => frame.type === "reply_ready"),
        done = frames.find((frame) => frame.type === "done");
      expect(
        ready,
        JSON.stringify(
          frames.map((frame) => ({
            type: frame.type,
            error: frame.error,
            code: frame.code,
            failureKind: frame.failureKind,
            terminalFailure: frame.terminalFailure,
            fullText: frame.fullText,
            actionExecutions,
            actionObserved,
          })),
        ),
      ).toBeDefined();
      expect(done).toBeDefined();
      expect(done.actionResults).toEqual(ready.actionResults);
      expect(actionExecutions).toBe(1);
      const handoff = findViewActionHandoff(done.actionResults);
      expect(handoff?.navigationPrepared).toBe(true);
      const binding = handoff?.navigationBinding;
      if (!binding) throw Error("Prepared binding missing");
      const wrong = await request(
        origin,
        "/api/views/interact-claim",
        wrongOwner.session.id,
        binding,
      );
      expect(wrong.status).toBe(scenario === "standalone-root" ? 401 : 409);
      const wrongClient = await request(
        origin,
        "/api/views/interact-claim",
        callerToken,
        { ...binding, clientId: "other-renderer" },
      );
      expect(wrongClient.status).toBe(409);
      const cross = await request(
        `http://127.0.0.1:${otherHost.port}`,
        "/api/views/interact-claim",
        callerToken,
        binding,
      );
      expect(cross.status).toBe(409);
      const claim = await request(
        origin,
        "/api/views/interact-claim",
        callerToken,
        binding,
      );
      expect(
        claim.status,
        JSON.stringify({ actionObserved, identity: identity.id, canonical }),
      ).toBe(200);
      expect(typeof claim.body.claimId).toBe("string");
      const ack = await request(
        origin,
        "/api/views/interact-result",
        callerToken,
        {
          ...binding,
          claimId: claim.body.claimId,
          success: true,
          result: { switched: true },
        },
      );
      expect(ack.status).toBe(200);
      expect(ack.body.accepted).toBe(true);
    } finally {
      release();
      vi.restoreAllMocks();
      await otherHost?.close();
      await server?.close();
      _resetAgentHostBridge();
      await replacement?.stop();
      await replacement?.close();
      await runtime.stop();
      await runtime.close();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);
