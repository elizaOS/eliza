/** Real runtime, SQLite, HTTP history and connector delivery with an unavailable local model. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  createMessageMemory,
  ElizaError,
  ensureAgentVoice,
  ModelType,
  systemNoticeText,
  type UUID,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { LocalInferenceUnavailableError } from "../../../plugins/plugin-local-inference/src/provider.ts";
import { startApiServer } from "../src/api/server.ts";
import { registerErrorEscalation } from "../src/runtime/error-escalation.ts";
import { EscalationService } from "../src/services/escalation.ts";

const AGENT_NAME = "Notice evidence";

it("keeps diagnostics while delivering and restoring safe system notices without rewriting them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-system-notice-"));
  const configPath = join(directory, "config.json");
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: configPath,
    ELIZA_PERSIST_CONFIG_PATH: configPath,
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: "notice-test-token",
    ELIZA_REQUIRE_LOCAL_AUTH: "1",
  }))
    vi.stubEnv(key, value);
  const agentId = randomUUID() as UUID;
  let runtime: AgentRuntime | undefined;
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
  let modelCalls = 0;
  const open = async () => {
    const next = new AgentRuntime({
      agentId,
      character: { name: AGENT_NAME, bio: [], settings: {} },
      logLevel: "fatal",
      enableAutonomy: false,
    });
    next.registerDatabaseAdapter(
      SQLiteDatabaseAdapter.create(join(directory, "state.sqlite"), agentId),
    );
    await next.init();
    next.registerModel(
      ModelType.TEXT_SMALL,
      async () => {
        modelCalls++;
        throw new LocalInferenceUnavailableError(
          ModelType.TEXT_SMALL,
          "backend_unavailable",
          "No local text model is assigned or loaded.",
        );
      },
      "unavailable-local-model",
      100,
    );
    return next;
  };
  try {
    runtime = await open();
    server = await startApiServer({
      port: 0,
      runtime,
      skipDeferredStartupWork: true,
    });
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/api/conversations`)).status).toBe(401);
    const headers = {
      authorization: "Bearer notice-test-token",
      "content-type": "application/json",
    };
    const created = await fetch(`${base}/api/conversations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "System notices" }),
    });
    expect(created.status).toBe(200);
    const { conversation } = await created.json();
    await writeFile(
      configPath,
      JSON.stringify({
        agents: {
          defaults: {
            ownerContacts: { client_chat: { roomId: conversation.roomId } },
            escalation: {
              channels: ["client_chat"],
              waitMinutes: 60,
              maxRetries: 3,
            },
          },
        },
      }),
    );
    registerErrorEscalation(runtime);
    // A deliberately disabled capability or unsupported local capability does
    // not prove provider configuration is missing. Exercise real event delivery,
    // SQLite persistence, and authenticated history for both classifications.
    for (const [code, reason] of [
      ["NO_MODEL_PROVIDER_CONFIGURED", "capability-disabled"],
      ["LOCAL_INFERENCE_UNAVAILABLE", "capability_unavailable"],
    ]) {
      for (let i = 0; i < 3; i++) {
        runtime.reportError(
          "notice-capability",
          new ElizaError("Capability is unavailable", {
            code,
            context: { reason, modelType: ModelType.TEXT_EMBEDDING },
          }),
        );
      }
      await vi.waitFor(async () => {
        if (!runtime)
          throw new Error("Runtime closed during capability notice");
        const notice = await EscalationService.getActiveEscalation(runtime);
        expect(notice?.systemNotice).toBe("runtime-error");
      });
      const notice = await EscalationService.getActiveEscalation(runtime);
      if (!notice) throw new Error("Capability notice was not persisted");
      expect(notice.text).toBe(systemNoticeText("runtime-error", AGENT_NAME));
      const capabilityHistory = await fetch(
        `${base}/api/conversations/${conversation.id}/messages`,
        { headers },
      );
      expect(capabilityHistory.status).toBe(200);
      const capabilityMessages = (await capabilityHistory.json()).messages;
      expect(
        capabilityMessages.some(
          (message: { text: string }) =>
            message.text === systemNoticeText("runtime-error", AGENT_NAME),
        ),
      ).toBe(true);
      expect(
        capabilityMessages.some(
          (message: { text: string }) =>
            message.text === systemNoticeText("model-unavailable", AGENT_NAME),
        ),
      ).toBe(false);
      await EscalationService.resolveEscalation(notice.id, runtime);
    }
    expect(modelCalls).toBe(0);
    for (let i = 0; i < 3; i++) {
      const original = { text: `Owner update ${i}`, source: "notice-test" };
      const delivered = await ensureAgentVoice(runtime, original, {
        source: "notice-test",
      });
      expect(delivered.agentVoiced).toBeUndefined();
      expect(delivered.text).toBe(original.text);
    }
    await vi.waitFor(async () => {
      if (!runtime) throw new Error("Runtime closed during delivery");
      const messages = await runtime.getMemories({
        roomId: conversation.roomId,
        tableName: "messages",
      });
      expect(
        messages.some((m) => m.content.systemNotice === "model-unavailable"),
      ).toBe(true);
    });
    expect(modelCalls).toBe(3);
    expect(runtime.getRecentReportedErrors()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "LOCAL_INFERENCE_UNAVAILABLE",
          scope: "voice-gate",
          message: "No local text model is assigned or loaded.",
          context: expect.objectContaining({
            source: "notice-test",
            reason: "backend_unavailable",
            modelType: ModelType.TEXT_SMALL,
          }),
        }),
      ]),
    );
    const state = await EscalationService.getActiveEscalation(runtime);
    expect(state?.systemNotice).toBe("model-unavailable");
    if (!state) throw new Error("Escalation was not persisted");
    await EscalationService.checkEscalation(runtime, state.id);
    expect(modelCalls).toBe(3);
    const combined = await EscalationService.startEscalation(
      runtime,
      "Systemic failure STORAGE_UNAVAILABLE reported 3 times within 10m",
      systemNoticeText("runtime-error", AGENT_NAME),
      "runtime-error",
    );
    await EscalationService.checkEscalation(runtime, combined.id);
    expect(modelCalls).toBe(3);
    expect(combined.systemNotice).toBe("model-and-runtime-error");
    expect(combined.text).toContain(
      systemNoticeText("model-unavailable", AGENT_NAME),
    );
    expect(combined.text).toContain(
      systemNoticeText("runtime-error", AGENT_NAME),
    );
    expect(
      await runtime.getCache<{ systemNotice?: string; text: string }>(
        `agent:escalation:active:${agentId}`,
      ),
    ).toMatchObject({
      systemNotice: "model-and-runtime-error",
      text: combined.text,
    });
    const raw =
      'Repeated runtime failure "UNCLASSIFIED" from [voice-gate]: No local text model is assigned or loaded. {"private":"preserved-evidence"}';
    const legacyId = randomUUID() as UUID;
    await runtime.createMemory(
      createMessageMemory({
        id: legacyId,
        entityId: agentId,
        roomId: conversation.roomId,
        content: {
          text: raw,
          source: "client_chat",
          metadata: { escalation: true },
        },
      }),
      "messages",
    );
    await runtime.createMemory(
      createMessageMemory({
        id: randomUUID() as UUID,
        entityId: agentId,
        roomId: conversation.roomId,
        content: { text: raw, source: "client_chat" },
      }),
      "messages",
    );
    const mixedId = randomUUID() as UUID;
    await runtime.createMemory(
      createMessageMemory({
        id: mixedId,
        entityId: agentId,
        roomId: conversation.roomId,
        content: {
          text: `${raw}\n---\nYour scheduled appointment still needs confirmation.`,
          source: "client_chat",
          metadata: { escalation: true },
        },
      }),
      "messages",
    );
    const checkinId = randomUUID() as UUID;
    const rawBrief =
      "Morning check-in: 0 overdue todos, 0 meetings today, 0 yesterday's wins, and 0 tracked habits. X DMs: unavailable X timeline: unavailable";
    await runtime.createMemory(
      createMessageMemory({
        id: checkinId,
        entityId: agentId,
        roomId: conversation.roomId,
        content: {
          text: rawBrief,
          source: "lifeops-scheduled-task",
          agentVoiced: true,
        },
      }),
      "messages",
    );
    const realBriefId = randomUUID() as UUID;
    await runtime.createMemory(
      createMessageMemory({
        id: realBriefId,
        entityId: agentId,
        roomId: conversation.roomId,
        content: {
          text: "Morning check-in: Your meeting starts at nine.",
          source: "lifeops-scheduled-task",
          agentVoiced: true,
        },
      }),
      "messages",
    );
    const historicalProviderFailures = [] as Array<{ id: UUID; raw: string }>;
    for (const message of [
      "This agent has no model provider configured",
      "No provider registered for TEXT_SMALL",
    ]) {
      const record = {
        id: randomUUID() as UUID,
        raw: `Repeated runtime failure "UNCLASSIFIED" from [model-router]: ${message}`,
      };
      historicalProviderFailures.push(record);
      await runtime.createMemory(
        createMessageMemory({
          id: record.id,
          entityId: agentId,
          roomId: conversation.roomId,
          content: {
            text: record.raw,
            source: "client_chat",
            metadata: { escalation: true },
          },
        }),
        "messages",
      );
    }
    // Canonical system notices own their visible copy even on interrupted turns.
    // Ordinary partial replies still round-trip exactly; history projection must
    // retain typed failure/recovery metadata and never rewrite durable content.
    const interruptedTerminalFailure = {
      kind: "planner_exhaustion",
      message: "The turn stopped after preparing an action for review.",
      transient: false,
      code: "PLANNER_INTERRUPTED_AFTER_ACTION",
    };
    const interruptedRecords = [
      {
        id: randomUUID() as UUID,
        systemNotice: "runtime-error" as const,
        text: "Private fixture diagnostic detail",
      },
      {
        id: randomUUID() as UUID,
        systemNotice: undefined,
        text: "Keep two  spaces.\nPartial Ω🙂 reply.",
      },
      { id: randomUUID() as UUID, systemNotice: undefined, text: "" },
    ];
    for (const record of interruptedRecords) {
      await runtime.createMemory(
        createMessageMemory({
          id: record.id,
          entityId: agentId,
          roomId: conversation.roomId,
          content: {
            text: record.text,
            source: "client_chat",
            ...(record.systemNotice
              ? { systemNotice: record.systemNotice }
              : {}),
            interrupted: true,
            failureKind: "planner_exhaustion",
            terminalFailure: interruptedTerminalFailure,
            replyRecoveryAvailable: true,
          },
        }),
        "messages",
      );
    }
    const historyResponse = await fetch(
      `${base}/api/conversations/${conversation.id}/messages`,
      { headers },
    );
    expect(historyResponse.status).toBe(200);
    const history = await historyResponse.json();
    for (const record of interruptedRecords) {
      expect(
        history.messages.find(
          (message: { id: string }) => message.id === record.id,
        ),
      ).toMatchObject({
        role: "assistant",
        text: record.systemNotice
          ? systemNoticeText("runtime-error", AGENT_NAME)
          : record.text,
        interrupted: true,
        failureKind: "planner_exhaustion",
        terminalFailure: interruptedTerminalFailure,
        replyRecoveryAvailable: true,
      });
      const stored = (
        await runtime.getMemoriesByIds([record.id], "messages")
      )[0];
      expect(stored.content.text).toBe(record.text);
      expect(stored.content.terminalFailure).toEqual(
        interruptedTerminalFailure,
      );
    }
    expect(
      history.messages.find((m: { id: string }) => m.id === checkinId).text,
    ).toBe(systemNoticeText("runtime-error", AGENT_NAME));
    expect(
      history.messages.find((m: { id: string }) => m.id === realBriefId).text,
    ).toBe("Morning check-in: Your meeting starts at nine.");
    expect(
      (await runtime.getMemoriesByIds([checkinId], "messages"))[0].content.text,
    ).toBe(rawBrief);
    for (const record of historicalProviderFailures) {
      expect(
        history.messages.find(
          (message: { id: string }) => message.id === record.id,
        ),
      ).toMatchObject({
        text: systemNoticeText("model-unavailable", AGENT_NAME),
        failureKind: "no_provider",
      });
      expect(
        (await runtime.getMemoriesByIds([record.id], "messages"))[0].content
          .text,
      ).toBe(record.raw);
    }
    const legacy = history.messages.find(
      (m: { id: string }) => m.id === legacyId,
    );
    expect(
      history.messages.find((m: { id: string }) => m.id === mixedId).text,
    ).toBe(
      `${systemNoticeText("model-unavailable", AGENT_NAME)}\n---\nYour scheduled appointment still needs confirmation.`,
    );
    expect(legacy.text).toBe(systemNoticeText("model-unavailable", AGENT_NAME));
    expect(legacy.failureKind).toBe("no_provider");
    expect(history.messages.some((m: { text: string }) => m.text === raw)).toBe(
      true,
    );
    expect(
      (await runtime.getMemoriesByIds([legacyId], "messages"))[0].content.text,
    ).toBe(raw);
    const storedNotices = await runtime.getMemories({
      roomId: conversation.roomId,
      tableName: "messages",
    });
    for (const message of storedNotices.filter((m) => m.content.systemNotice)) {
      expect(message.content.agentVoiced).not.toBe(true);
      expect(message.content.text).not.toMatch(
        /UNCLASSIFIED|voice-gate|agentId|\{/,
      );
    }
    await EscalationService.stop(runtime);
    // An older unresolved alert survives disk reopen. Its retry projection must
    // be safe without deleting the historical diagnostic payload.
    await runtime.setCache(`agent:escalation:active:${agentId}`, {
      ...state,
      reason: "Systemic failure UNCLASSIFIED reported 3 times within 10m",
      text: raw,
      systemNotice: undefined,
    });
    await server.close();
    server = undefined;
    await runtime.close();
    runtime = await open();
    const restored = await EscalationService.getActiveEscalation(runtime);
    expect(restored).toMatchObject({
      id: state.id,
      systemNotice: "model-unavailable",
      text: systemNoticeText("model-unavailable", AGENT_NAME),
    });
    expect(
      (
        await runtime.getCache<{ text: string }>(
          `agent:escalation:active:${agentId}`,
        )
      )?.text,
    ).toBe(raw);
    const coalesced = await EscalationService.startEscalation(
      runtime,
      "Systemic failure LOCAL_INFERENCE_UNAVAILABLE reported 3 times within 10m",
      systemNoticeText("model-unavailable", AGENT_NAME),
      "model-unavailable",
    );
    expect(coalesced.text).toBe(
      systemNoticeText("model-unavailable", AGENT_NAME),
    );
    expect(modelCalls).toBe(3);
    // Mixed alerts retain both parts on disk and deliver them as separate
    // messages so the system segment keeps its classification and bypass.
    await EscalationService.resolveEscalation(coalesced.id, runtime);
    server = await startApiServer({
      port: 0,
      runtime,
      skipDeferredStartupWork: true,
    });
    for (const ordinaryFirst of [true, false]) {
      runtime.setSetting("OUTBOUND_VOICE_REWRITE", false);
      const ordinaryText = `Appointment confirmation ${ordinaryFirst}`;
      await EscalationService.startEscalation(
        runtime,
        "First mixed alert",
        ordinaryFirst
          ? ordinaryText
          : systemNoticeText("model-unavailable", AGENT_NAME),
        ordinaryFirst ? undefined : "model-unavailable",
      );
      const mixed = await EscalationService.startEscalation(
        runtime,
        "Second mixed alert",
        ordinaryFirst
          ? systemNoticeText("model-unavailable", AGENT_NAME)
          : ordinaryText,
        ordinaryFirst ? "model-unavailable" : undefined,
      );
      if (ordinaryFirst)
        await EscalationService.startEscalation(
          runtime,
          "Additional runtime failure",
          systemNoticeText("runtime-error", AGENT_NAME),
          "runtime-error",
        );
      const expectedNotice = ordinaryFirst
        ? "model-and-runtime-error"
        : "model-unavailable";
      expect(mixed).toMatchObject({
        systemNotice: expectedNotice,
        ordinaryText,
      });
      expect(mixed.text).toContain(ordinaryText);
      expect(mixed.text).toContain(
        systemNoticeText("model-unavailable", AGENT_NAME),
      );
      await EscalationService.stop(runtime);
      await server.close();
      server = undefined;
      await runtime.close();
      runtime = await open();
      runtime.setSetting("OUTBOUND_VOICE_REWRITE", false);
      server = await startApiServer({
        port: 0,
        runtime,
        skipDeferredStartupWork: true,
      });
      expect(
        await EscalationService.getActiveEscalation(runtime),
      ).toMatchObject({
        id: mixed.id,
        systemNotice: expectedNotice,
        ordinaryText,
        text: mixed.text,
      });
      const before = new Set(
        (
          await runtime.getMemories({
            roomId: conversation.roomId,
            tableName: "messages",
          })
        ).map((message) => message.id),
      );
      await EscalationService.checkEscalation(runtime, mixed.id);
      const delivered = (
        await runtime.getMemories({
          roomId: conversation.roomId,
          tableName: "messages",
        })
      ).filter((message) => !before.has(message.id));
      expect(delivered).toHaveLength(2);
      expect(delivered.map((message) => message.content)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: systemNoticeText(expectedNotice, AGENT_NAME),
            systemNotice: expectedNotice,
            failureKind: "no_provider",
          }),
          expect.objectContaining({ text: ordinaryText }),
        ]),
      );
      expect(
        delivered.find((message) => message.content.text === ordinaryText)
          ?.content.systemNotice,
      ).toBeUndefined();
      await EscalationService.resolveEscalation(mixed.id, runtime);
    }
    expect(modelCalls).toBe(3);
  } finally {
    if (runtime) await EscalationService.stop(runtime);
    if (server) await server.close();
    if (runtime) await runtime.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
