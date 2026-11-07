/** A real paired-session HTTP turn must settle durably even when its SSE client disconnects. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCharacter, ModelType } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { createAssistantPlugin } from "../../../plugins/plugin-assistant/src/index.ts";
import {
  createMachineSession,
  revokeSession,
  subscribeSessionRevocations,
} from "../../app/src/api/auth/sessions.ts";
import { resolveSessionTokenRole } from "../../app/src/api/auth.ts";
import { authStoreForRuntime } from "../../app/src/services/auth-store.ts";
import { startApiServer } from "../src/api/server.ts";
import {
  getAgentHostBridge,
  setAgentHostBridge,
} from "../src/runtime/host-bridge.ts";

it.each([
  "provider failure",
  "generation timeout",
  "session revoked",
  "session revoked in storage",
  "unpaired disconnect",
] as const)(
  "handles %s through real HTTP, cancellation, and persistence",
  async (failure) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "paired-stream-failure-"),
    );
    const originalBridge = getAgentHostBridge();
    const controller = new AbortController();
    for (const [key, value] of Object.entries({
      ELIZA_STATE_DIR: directory,
      ELIZA_CONFIG_PATH: path.join(directory, "config.json"),
      ELIZA_PERSIST_CONFIG_PATH: path.join(directory, "config.json"),
      ELIZA_API_TOKEN: randomUUID(),
      ELIZA_REQUIRE_LOCAL_AUTH: "1",
      ELIZA_CHAT_GENERATION_TIMEOUT_MS:
        failure === "generation timeout" ? "1000" : "180000",
    }))
      vi.stubEnv(key, value);
    const runtime = createSQLiteTestRuntime({
      plugins: [createAssistantPlugin()],
      character: createCharacter({ name: "PairedFailure" }),
      logLevel: "fatal",
      enableAutonomy: false,
    });
    let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
    const started = Promise.withResolvers<void>();
    const transportClosed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const observedAbort = Promise.withResolvers<void>();
    let calls = 0;
    try {
      await runtime.initialize();
      const store = authStoreForRuntime(runtime);
      if (!store) throw new Error("Missing auth store");
      const identityId = randomUUID();
      await store.createIdentity({
        id: identityId,
        kind: "machine",
        displayName: "Paired phone",
        createdAt: Date.now(),
      });
      const { session } = await createMachineSession(store, {
        identityId,
        scopes: [],
      });
      const authorize = async (token: string) =>
        (await resolveSessionTokenRole(token, { store })) ?? {
          ok: false,
          role: "NONE" as const,
        };
      setAgentHostBridge({
        ...originalBridge,
        subscribeSessionRevocations,
        resolveSessionTokenAuthorization: authorize,
        resolveHttpRequestAuthorization: (req) =>
          authorize(
            /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1] ??
              "",
          ),
      });
      const fail: Parameters<typeof runtime.registerModel>[1] = async (
        _runtime,
        params,
      ) => {
        calls++;
        started.resolve();
        await release.promise;
        if (failure !== "provider failure") {
          const signal = params.signal;
          if (!(signal instanceof AbortSignal))
            throw new Error("Missing generation cancellation signal");
          await new Promise<void>((_resolve, reject) => {
            if (signal.aborted) {
              observedAbort.resolve();
              reject(signal.reason);
            } else
              signal.addEventListener(
                "abort",
                () => {
                  observedAbort.resolve();
                  reject(signal.reason);
                },
                { once: true },
              );
          });
        }
        throw new Error(
          "Controlled provider failure after paired transport loss",
        );
      };
      for (const type of [
        ModelType.RESPONSE_HANDLER,
        ModelType.TEXT_LARGE,
        ModelType.TEXT_SMALL,
      ])
        runtime.registerModel(type, fail, "paired-failure", 100);
      server = await startApiServer({
        port: 0,
        runtime,
        skipDeferredStartupWork: true,
        requestMiddleware: async (req, res, next) => {
          if (req.url?.endsWith("/messages/stream")) {
            res.once("close", () => transportClosed.resolve());
          }
          await next();
        },
      });
      const origin = `http://127.0.0.1:${server.port}`;
      const headers = {
        Authorization: `Bearer ${failure === "unpaired disconnect" ? process.env.ELIZA_API_TOKEN : session.id}`,
        "content-type": "application/json",
      };
      const create = await fetch(`${origin}/api/conversations`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "Paired failure" }),
      });
      const created = await create.json();
      expect(create.status, JSON.stringify(created)).toBe(200);
      const conversation = created.conversation;
      const body = JSON.stringify({
        text: "Answer this test request.",
        clientMessageId: randomUUID(),
      });
      const stream = await fetch(
        `${origin}/api/conversations/${conversation.id}/messages/stream`,
        { method: "POST", headers, body, signal: controller.signal },
      );
      expect(stream.status).toBe(200);
      await started.promise;
      // Observe the socket close in the server before allowing the provider to fail.
      const reader = stream.body?.getReader();
      if (!reader) throw new Error("Missing SSE body");
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await transportClosed.promise;
      if (failure === "unpaired disconnect") {
        release.resolve();
        await observedAbort.promise;
        return;
      }
      if (failure === "session revoked in storage") {
        expect(await store.revokeSession(session.id)).toBe(true);
        release.resolve();
        await Promise.race([
          observedAbort.promise,
          new Promise<never>((_resolve, reject) => {
            const timeout = setTimeout(
              () =>
                reject(
                  new Error("Persisted revocation did not cancel generation"),
                ),
              10_000,
            );
            observedAbort.promise.then(() => clearTimeout(timeout));
          }),
        ]);
        return;
      }
      if (failure === "session revoked") {
        expect(
          await revokeSession(session.id, {
            store,
            reason: "test",
            actorIdentityId: identityId,
            ip: null,
            userAgent: null,
          }),
        ).toBe(true);
        release.resolve();
        await observedAbort.promise;
        const retry = await fetch(
          `${origin}/api/conversations/${conversation.id}/messages/stream`,
          { method: "POST", headers, body },
        );
        expect(retry.status).toBe(401);
        return;
      }
      release.resolve();
      await vi.waitFor(
        async () => {
          const messages = await runtime.getMemories({
            tableName: "messages",
            roomId: conversation.roomId,
            count: 20,
          });
          const accepted = messages.find(
            (message) => message.content.chatIdempotency,
          );
          const marker = accepted?.content.chatIdempotency as
            | { outcomeJson?: string }
            | undefined;
          expect(marker?.outcomeJson).toBeTruthy();
          const outcome = JSON.parse(marker?.outcomeJson ?? "{}");
          expect(outcome.text).toBeTruthy();
          if (failure === "generation timeout")
            expect(outcome.failureKind).toBe("generation_timeout");
        },
        { timeout: 15_000, interval: 50 },
      );
      const callsBeforeReplay = calls;
      const replay = await fetch(
        `${origin}/api/conversations/${conversation.id}/messages/stream`,
        { method: "POST", headers, body },
      );
      expect(replay.status).toBe(200);
      expect(await replay.text()).toContain('"type":"done"');
      expect(calls).toBe(callsBeforeReplay);
    } finally {
      release.resolve();
      controller.abort();
      if (server) await server.close();
      await runtime.stop();
      setAgentHostBridge(originalBridge);
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
