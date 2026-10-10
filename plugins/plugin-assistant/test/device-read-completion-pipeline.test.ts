/** Real loopback HTTP, canonical message pipeline and PGlite; only model/media ports are closed fixtures. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  ModelType,
  resolveOwnerEntityIdOrDefault,
} from "@elizaos/core";
import { expect, it, vi } from "vitest";
import { startApiServer } from "../../../packages/agent/src/api/server.ts";
import {
  getAgentHostBridge,
  setAgentHostBridge,
} from "../../../packages/agent/src/runtime/host-bridge.ts";
import { createMachineSession } from "../../../packages/app/src/api/auth/sessions.ts";
import { installMobileAuthHostBridge } from "../../../packages/app/src/runtime/install-mobile-auth-host-bridge.ts";
import {
  AuthStore,
  type DrizzleDatabase,
} from "../../../packages/app/src/services/auth-store.ts";
import { createRealTestRuntime } from "../../../packages/app/test/helpers/real-runtime.ts";
import { queryLocalNotes } from "../../plugin-notes/src/client/notes-query.ts";
import { NotesStore } from "../../plugin-notes/src/client/notes-store.ts";
import { proposeDeviceAction } from "../src/services/device-actions/action.ts";

const APPROVED_BODY = "  Chosen approved body.\nSecond line!\n\n";

it.each(["bound", "string", "missing"] as const)(
  "completes the real approved Notes HTTP pipeline with %s source parts",
  async (replyShape) => {
    const stateDir = await mkdtemp(
      path.join(tmpdir(), "approved-note-pipeline-"),
    );
    await writeFile(path.join(stateDir, "eliza.json"), "{}");
    vi.stubEnv("ELIZA_STATE_DIR", stateDir);
    vi.stubEnv("ELIZA_CONFIG_PATH", path.join(stateDir, "eliza.json"));
    vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", path.join(stateDir, "eliza.json"));
    vi.stubEnv("ELIZA_API_BIND_HOST", "127.0.0.1");
    vi.stubEnv("ELIZA_TRAJECTORY_RECORDING", "0");
    vi.stubEnv(
      "ELIZA_HOST_CONTEXT_REVISION",
      "closed-stable-provider-revision",
    );
    const originalFetch = globalThis.fetch;
    const fetchPort = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) => {
        const url = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        if (url.hostname !== "127.0.0.1")
          throw Error(
            "External provider/network forbidden in closed pipeline test",
          );
        return originalFetch(input, init);
      });
    const savedBridge = getAgentHostBridge();
    let fixture: Awaited<ReturnType<typeof createRealTestRuntime>> | undefined,
      server: Awaited<ReturnType<typeof startApiServer>> | undefined;
    try {
      fixture = await createRealTestRuntime({
        characterName: "OriginalApprovedNotes",
        withLLM: false,
      });
      const runtime = fixture.runtime;
      const owner = resolveOwnerEntityIdOrDefault(runtime);
      runtime.registerAction(proposeDeviceAction);
      const authStore = new AuthStore(runtime.adapter.db as DrizzleDatabase);
      await authStore.createIdentity({
        id: owner,
        kind: "owner",
        displayName: "Closed Notes owner",
        createdAt: Date.now(),
        passwordHash: null,
      });
      const { session } = await createMachineSession(authStore, {
        identityId: owner,
        scopes: [],
      });
      installMobileAuthHostBridge();
      const operation = {
        type: "notes_query",
        query: { kind: "title", text: "Synthetic shared title" },
      };
      let operationKey = randomUUID();
      let phase = "initial",
        handlerCalls = 0,
        plannerCalls = 0,
        replyCalls = 0;
      const respond = async (type: string, parameters: unknown) => {
        if (type === ModelType.TEXT_EMBEDDING)
          return Array(384).fill(0) as never;
        if (phase === "initial" && handlerCalls === 0) {
          handlerCalls++;
          return {
            text: "",
            toolCalls: [
              {
                id: "closed-handle-original-read",
                name: "HANDLE_RESPONSE",
                arguments: {
                  shouldRespond: "RESPOND",
                  thought: "",
                  contexts: ["general"],
                  intents: [
                    "Read the requested native note and quote its body after explicit sharing",
                  ],
                  candidateActionNames: ["PROPOSE_DEVICE_ACTION"],
                  contextRequests: [],
                  replyText: "Review the note request on your phone.",
                  facts: [],
                  relationships: [],
                  addressedTo: [],
                  replyEffectStatus: "pending",
                },
              },
            ],
          } as never;
        }
        if (phase === "initial" && type === ModelType.ACTION_PLANNER) {
          plannerCalls++;
          const tools =
            (parameters as { tools?: Array<{ name: string }> }).tools ?? [];
          if (!tools.some((tool) => tool.name === "PROPOSE_DEVICE_ACTION"))
            return {
              text: "",
              toolCalls: [
                {
                  id: "load-native-notes",
                  name: "DISCOVER_ACTIONS",
                  arguments: {
                    names: ["PROPOSE_DEVICE_ACTION"],
                    mode: "load",
                    eliza_turn_scope: "more_work_pending",
                  },
                },
              ],
            } as never;
          if (plannerCalls > 2)
            throw Error("Replanned after a durable owner-input pause");
          return {
            text: "",
            toolCalls: [
              {
                id: "propose-native-note",
                name: "PROPOSE_DEVICE_ACTION",
                arguments: {
                  operation,
                  operationKey,
                  reason: "Read and quote this requested native note.",
                  eliza_turn_scope: "more_work_pending",
                },
              },
            ],
          } as never;
        }
        if (phase === "shared" && type === ModelType.ACTION_PLANNER) {
          replyCalls++;
          const params = parameters as {
            tools?: unknown[];
            messages?: Array<{ role: string; content: unknown }>;
          };
          expect(params.tools).toBeUndefined();
          const content =
            params.messages
              ?.filter((message) => message.role === "tool")
              .map((message) =>
                typeof message.content === "string"
                  ? message.content
                  : JSON.stringify(message.content),
              )
              .join("\n") ?? "";
          expect(content).toContain("Chosen approved body.");
          expect(content).not.toContain("UNSELECTED_BODY");
          expect(content).not.toContain("Edited after Share");
          return JSON.stringify({
            completed: true,
            toolCalls: [],
            messageToUser:
              replyShape === "string"
                ? "Retyped approved body."
                : replyShape === "missing"
                  ? undefined
                  : [{ kind: "source", value: "approved_note_body" }],
          }) as never;
        }
        throw Error(`Unexpected model after ${phase}: ${type}`);
      };
      for (const type of [ModelType.RESPONSE_HANDLER, ModelType.ACTION_PLANNER])
        runtime.registerModel(
          type,
          async (_active, params) => respond(type, params),
          "closed-native-read",
        );
      runtime.registerModel(
        ModelType.TEXT_EMBEDDING,
        async () => Array(384).fill(0),
        "closed-native-read",
      );
      server = await startApiServer({
        port: 0,
        runtime,
        skipDeferredStartupWork: true,
      });
      const base = `http://127.0.0.1:${server.port}`;
      const headers = {
        "content-type": "application/json",
        authorization: `Bearer ${session.id}`,
        "x-eliza-device-id": randomUUID(),
        "x-eliza-device-key": "c".repeat(64),
        "x-eliza-device-capabilities": "notes.local-record.v1,notes.query.v1",
      };
      const request = async (route: string, body?: unknown) => {
        const response = await fetch(base + route, {
          method: body === undefined ? "GET" : "POST",
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return {
          status: response.status,
          body: (await response.json()) as Record<string, any>,
        };
      };
      expect(
        (
          await request("/api/client-devices/register", {
            label: "Closed owned phone",
          })
        ).status,
      ).toBe(200);
      const created = await request("/api/conversations", {
        title: "Synthetic original Notes request",
      });
      expect(created.status).toBeLessThan(300);
      const conversationId = created.body.conversation?.id ?? created.body.id;
      expect(typeof conversationId).toBe("string");
      const clientMessageId = randomUUID();
      const initial = await request(
        `/api/conversations/${conversationId}/messages`,
        {
          text: "Read the note titled Synthetic shared title and quote its body.",
          clientMessageId,
          channelType: "DM",
          metadata: {
            uiView: "notes",
            uiTab: "notes",
            uiViewPath: "/notes",
            clientDevice: {
              context: { sensitive: false, revision: 1, timeZone: "UTC" },
            },
          },
        },
      );
      expect(initial.status, JSON.stringify(initial.body)).toBe(200);
      expect(JSON.stringify(initial.body)).not.toContain("runtime step failed");
      const listed = await request("/api/client-devices/proposals");
      const proposal = listed.body.proposals.find(
        (item: any) => item.state === "pending",
      );
      expect(proposal).toBeTruthy();
      expect(proposal.readReplyOrigin).toMatchObject({
        version: 1,
        requestId: clientMessageId,
        conversationId,
      });
      expect(proposal.readReplyOrigin.inReplyTo).toBeTruthy();
      expect(JSON.stringify(listed.body)).not.toContain(
        "original_notes_read_reply",
      );
      expect(replyCalls).toBe(0);
      const rootMessage = await runtime.getMemoryById(
        proposal.readReplyOrigin.inReplyTo,
      );
      expect(rootMessage).toBeTruthy();
      expect(rootMessage!.roomId).not.toBe(conversationId);
      const values = new Map<string, string>();
      const store = new NotesStore(
        { current: "closed-notes", legacy: "closed-legacy" },
        {
          getItem: (key) => values.get(key) ?? null,
          setItem: (key, value) => {
            values.set(key, value);
          },
        },
        [
          {
            id: "owned-a",
            kind: "text",
            title: "Synthetic shared title A",
            body: "UNSELECTED_BODY",
            createdAt: 100,
          },
          {
            id: "owned-b",
            kind: "text",
            title: "Synthetic shared title B",
            body: APPROVED_BODY,
            createdAt: 200,
          },
        ],
      );
      const candidates = queryLocalNotes(
        store.list,
        operation.query as { kind: "title"; text: string },
      ).candidates;
      expect(candidates).toHaveLength(2);
      // Explicit owner choice, not an inferred newest/default candidate.
      const chosen = candidates.find((note) => note.id === "owned-b")!;
      const target = await store.target(chosen.id);
      const record = await store.execute(
        { type: "notes_read_selected", target },
        "owned-share",
        new AbortController().signal,
        () => {},
      );
      expect(
        (
          await request(
            `/api/client-devices/proposals/${proposal.id}/decision`,
            {
              digest: proposal.digest,
              decision: "approve",
            },
          )
        ).status,
      ).toBe(200);
      const claim = await request(
        `/api/client-devices/proposals/${proposal.id}/claim`,
        { digest: proposal.digest },
      );
      expect(claim.status).toBe(200);
      const attemptId = claim.body.proposal.execution.attemptId;
      const typed = {
        version: 1,
        kind: "notes_query",
        query: operation.query,
        basis: "title-match",
        target,
        record,
      };
      const receipt = await request(
        `/api/client-devices/proposals/${proposal.id}/receipt`,
        {
          digest: proposal.digest,
          attemptId,
          receipt: {
            outcome: "applied",
            operationId: randomUUID(),
            result: typed,
          },
        },
      );
      expect(receipt.status).toBe(200);
      expect(replyCalls).toBe(0);
      // Edits after Share cannot change the already-approved immutable snapshot.
      await store.execute(
        {
          type: "notes_update",
          target,
          fields: { title: chosen.title, body: "Edited after Share" },
        },
        "edit-after-share",
        new AbortController().signal,
        () => {},
      );
      const hint = {
        ...proposal.readReplyOrigin,
        proposalId: proposal.id,
        digest: proposal.digest,
        attemptId,
      };
      expect(receipt.body.readCompletion).toBeUndefined();
      phase = "shared";
      const completionWrites = vi.spyOn(runtime, "createMemory");
      const completion = await request(
        `/api/client-devices/proposals/${proposal.id}/read-completion`,
        hint,
      );
      if (replyShape !== "bound") {
        expect(completion.status).toBeGreaterThanOrEqual(400);
        expect(completion.body.reply).toBeUndefined();
        expect(replyCalls).toBe(1);
        expect(completionWrites).not.toHaveBeenCalled();
        completionWrites.mockRestore();
        return;
      }
      completionWrites.mockRestore();
      expect(completion.status, JSON.stringify(completion.body)).toBe(200);
      expect(completion.body.reply).toMatchObject({
        conversationId,
        requestId: clientMessageId,
        inReplyTo: rootMessage!.id,
        text: APPROVED_BODY,
      });
      expect(replyCalls).toBe(1);
      const memory = await runtime.getMemoryById(
        completion.body.reply.messageId,
      );
      expect(memory?.roomId).toBe(rootMessage!.roomId);
      expect(memory?.content.inReplyTo).toBe(rootMessage!.id);
      expect(memory?.content.text).toBe(completion.body.reply.text);
      const replay = await request(
        `/api/client-devices/proposals/${proposal.id}/read-completion`,
        hint,
      );
      expect(replay.status).toBe(200);
      expect(replay.body.reply).toEqual(completion.body.reply);
      expect(replyCalls).toBe(1);
      // A second genuine original request is paused/applied, then runtime adoption
      // changes while fresh OWNER resolution is held. The old runtime must not
      // infer or persist a completion after that await resumes.
      phase = "initial";
      handlerCalls = 0;
      plannerCalls = 0;
      operationKey = randomUUID();
      const secondRequest = randomUUID();
      expect(
        (
          await request(`/api/conversations/${conversationId}/messages`, {
            text: "Read the note titled Synthetic shared title and quote its body.",
            clientMessageId: secondRequest,
            channelType: "DM",
          })
        ).status,
      ).toBe(200);
      const second = (
        await request("/api/client-devices/proposals")
      ).body.proposals.find(
        (item: Record<string, unknown>) => item.state === "pending",
      );
      expect(second?.readReplyOrigin?.requestId).toBe(secondRequest);
      expect(
        (
          await request(`/api/client-devices/proposals/${second.id}/decision`, {
            digest: second.digest,
            decision: "approve",
          })
        ).status,
      ).toBe(200);
      const secondClaim = await request(
        `/api/client-devices/proposals/${second.id}/claim`,
        { digest: second.digest },
      );
      expect(
        (
          await request(`/api/client-devices/proposals/${second.id}/receipt`, {
            digest: second.digest,
            attemptId: secondClaim.body.proposal.execution.attemptId,
            receipt: {
              outcome: "applied",
              operationId: randomUUID(),
              result: typed,
            },
          })
        ).status,
      ).toBe(200);
      const secondHint = {
        ...second.readReplyOrigin,
        proposalId: second.id,
        digest: second.digest,
        attemptId: secondClaim.body.proposal.execution.attemptId,
      };
      const admittedBridge = getAgentHostBridge(),
        resolve = admittedBridge.resolveHttpRequestAuthorization!;
      let authCalls = 0,
        entered!: () => void,
        release!: () => void;
      const held = new Promise<void>((yes) => {
          entered = yes;
        }),
        gate = new Promise<void>((yes) => {
          release = yes;
        });
      setAgentHostBridge({
        ...admittedBridge,
        resolveHttpRequestAuthorization: async (req, rt, options) => {
          const fresh = await resolve(req, rt, options);
          if (req.url?.endsWith("/read-completion") && ++authCalls === 2) {
            entered();
            await gate;
          }
          return fresh;
        },
      });
      const persist = vi.spyOn(runtime, "createMemory");
      phase = "shared";
      const pending = request(
        `/api/client-devices/proposals/${second.id}/read-completion`,
        secondHint,
      );
      await held;
      const replacement = new AgentRuntime({
        agentId: runtime.agentId,
        character: runtime.character,
        enableAutonomy: false,
        logLevel: "fatal",
      });
      replacement.registerDatabaseAdapter(runtime.adapter);
      server.updateRuntime(replacement);
      release();
      const retired = await pending;
      expect(retired.status).toBeGreaterThanOrEqual(400);
      expect(replyCalls).toBe(1);
      expect(persist).not.toHaveBeenCalled();
      setAgentHostBridge(admittedBridge);
      server.updateRuntime(runtime);
      persist.mockRestore();
      expect(
        (
          await request(
            `/api/client-devices/proposals/${second.id}/read-completion`,
            secondHint,
          )
        ).status,
      ).toBeGreaterThanOrEqual(400);
      expect(replyCalls).toBe(1);
    } finally {
      if (server) await server.close();
      setAgentHostBridge(savedBridge);
      if (fixture) await fixture.cleanup();
      fetchPort.mockRestore();
      vi.unstubAllEnvs();
      await rm(stateDir, { recursive: true, force: true });
    }
  },
  120000,
);
