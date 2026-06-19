/**
 * E2E: voice → entity binding round-trip (issue #8234).
 *
 * Proves the full production chain across BOTH plugins with no test doubles
 * in the seam: a recognized voice turn flows
 *
 *   plugin-local-inference `emitVoiceTurnObserved`
 *     → AgentRuntime.emitEvent(VOICE_TURN_OBSERVED)
 *     → plugin-lifeops `handleVoiceTurnObserved` (the handler registered on
 *       `personalAssistantPlugin.events`) → `VoiceObserver` → real `EntityStore`
 *       merge engine on a real PGLite-backed runtime
 *     → AgentRuntime.emitEvent(VOICE_ENTITY_BOUND)
 *     → plugin-local-inference `handleVoiceEntityBound` (the handler
 *       registered on `localInferencePlugin.events`)
 *     → `VoiceProfileStore.bindEntity` persists `entityId` to disk.
 *
 * Also covers the two user-facing runtime paths the issue called out as
 * missing:
 *   - the `IDENTIFY_SPEAKER` agent action ("that was Sam"), and
 *   - the HTTP bind/unbind routes served from `localInferencePlugin.routes`.
 *
 * The only injected pieces are storage locations: the voice-profile store
 * roots in a temp dir (instead of `~/.eliza/voice-profiles`) and PGLite
 * stands in for Postgres. The lifeops side builds its observer through the
 * real `LifeOpsRepository` — no `setVoiceObserverFactory` override.
 */

import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { KNOWLEDGE_GRAPH_SERVICE, KnowledgeGraphService } from "@elizaos/agent";
import {
  type AgentRuntime,
  EventType,
  type Memory,
  type Plugin,
} from "@elizaos/core";
// plugin-local-inference modules are imported by relative source path:
// the package's subpath export aliases resolve to (possibly stale) dist
// bundles in the test graph, while the root barrel resolves to src — mixing
// them would split module identity and the injectable store seams
// (`setVoiceEntityBindingStore` etc.) would target the wrong module copy.
import {
  identifySpeakerAction,
  localInferencePlugin,
} from "@elizaos/plugin-local-inference";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/test/helpers/real-runtime.ts";
import {
  handleVoiceProfilesManagementRoutes,
  setVoiceProfilesManagementStore,
} from "../../plugin-local-inference/src/routes/voice-profiles-management-routes.js";
import {
  handleVoiceSpeakerProfileRoutes,
  setVoiceSpeakerProfileStore,
} from "../../plugin-local-inference/src/routes/voice-speaker-profile-routes.js";
import {
  emitVoiceTurnObserved,
  handleVoiceEntityBound,
  setVoiceEntityBindingStore,
} from "../../plugin-local-inference/src/runtime/voice-entity-binding.js";
import { VoiceProfileStore } from "../../plugin-local-inference/src/services/voice/profile-store.js";
import { WESPEAKER_RESNET34_LM_INT8_MODEL_ID } from "../../plugin-local-inference/src/services/voice/speaker/encoder.js";
import { EntityStore } from "../src/lifeops/entities/store.js";
import { handleVoiceTurnObserved } from "../src/lifeops/entities/voice-observer-bridge.js";
import { LifeOpsRepository } from "../src/lifeops/repository.js";

const MODEL = WESPEAKER_RESNET34_LM_INT8_MODEL_ID;

function unit(values: number[]): Float32Array {
  let sumSq = 0;
  for (const v of values) sumSq += v * v;
  const inv = sumSq > 0 ? 1 / Math.sqrt(sumSq) : 1;
  return new Float32Array(values.map((v) => v * inv));
}

/**
 * The seam under test: the production handlers both plugins register. The
 * local-inference handler array is taken from the plugin object itself; the
 * lifeops handler is the same `handleVoiceTurnObserved` that
 * `personalAssistantPlugin.events` registers (asserted by the registration test in
 * `src/lifeops/entities/voice-observer-bridge.test.ts` — importing the full
 * lifeops plugin barrel here would drag the `@elizaos/agent` server graph
 * into the e2e lane). Registering a thin seam plugin skips both plugins'
 * unrelated init (model downloads, schedulers, connectors).
 */
function buildSeamPlugin(): Plugin {
  const boundHandlers =
    localInferencePlugin.events?.[EventType.VOICE_ENTITY_BOUND];
  if (!boundHandlers?.length) {
    throw new Error(
      "VOICE_ENTITY_BOUND handler is not registered on localInferencePlugin",
    );
  }
  return {
    name: "voice-binding-seam-e2e",
    description:
      "Registers the real voice-binding event handlers from both plugins",
    events: {
      [EventType.VOICE_TURN_OBSERVED]: [handleVoiceTurnObserved],
      [EventType.VOICE_ENTITY_BOUND]: boundHandlers,
    },
  } as Plugin;
}

describe("voice → entity binding round-trip (issue #8234)", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;
  let tmpRoot: string;
  let store: VoiceProfileStore;
  let entityStore: EntityStore;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "voice-binding-e2e-"));
    store = new VoiceProfileStore({ rootDir: tmpRoot });
    await store.init();
    setVoiceEntityBindingStore(store);

    testResult = await createRealTestRuntime({
      characterName: "voice-binding-e2e",
      plugins: [buildSeamPlugin()],
    });
    runtime = testResult.runtime;
    await runtime.registerService(KnowledgeGraphService);
    await runtime.getServiceLoadPromise(KNOWLEDGE_GRAPH_SERVICE);
    await LifeOpsRepository.bootstrapSchema(runtime);
    entityStore = new EntityStore(runtime, runtime.agentId);
    await entityStore.ensureSelf();
  }, 180_000);

  afterAll(async () => {
    setVoiceEntityBindingStore(null);
    await testResult?.cleanup();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("registers the binding seam on the local-inference plugin object", () => {
    // (The lifeops side — personalAssistantPlugin.events[VOICE_TURN_OBSERVED] —
    // is asserted in src/lifeops/entities/voice-observer-bridge.test.ts.)
    expect(
      localInferencePlugin.events?.[EventType.VOICE_ENTITY_BOUND],
    ).toContain(handleVoiceEntityBound);
    expect(
      localInferencePlugin.actions?.some((a) => a.name === "IDENTIFY_SPEAKER"),
    ).toBe(true);

    // The HTTP bind paths must be on `plugin.routes` (rawPath) — no server
    // forwards these namespaces to the local-inference route dispatcher.
    const routes = (localInferencePlugin.routes ?? []).map(
      (r) => `${r.type} ${r.path}`,
    );
    expect(routes).toContain("POST /v1/voice/speaker-profiles/:id/bind");
    expect(routes).toContain("POST /v1/voice/speaker-profiles/:id/unbind");
    expect(routes).toContain("POST /api/voice/profiles/:id/bind");
    expect(routes).toContain("POST /api/voice/profiles/:id/unbind");
    expect(
      (localInferencePlugin.routes ?? []).every((r) => r.rawPath === true),
    ).toBe(true);
  });

  it("binds a self-claimed speaker through the live event round-trip", async () => {
    const profile = await store.createProfile({
      centroid: unit([1, 0, 0, 0]),
      embeddingModel: MODEL,
      imprintClusterId: "cluster_jill",
      confidence: 0.9,
      durationMs: 4000,
    });
    expect(profile.entityId).toBeNull();

    // The producer half of the seam — emitEvent awaits every handler, so the
    // full round trip (merge engine → VOICE_ENTITY_BOUND → bindEntity) has
    // completed when this resolves.
    await emitVoiceTurnObserved(runtime, {
      text: "Hey there, I'm Jill",
      imprintClusterId: "cluster_jill",
      matchConfidence: 0.92,
      matchedEntityId: null,
    });

    const bound = await store.get(profile.profileId);
    expect(bound?.entityId).toBeTruthy();

    // The entity is real and in the PGLite-backed relationship graph, with
    // the voice identity attached by the merge engine.
    const entity = await entityStore.get(bound?.entityId ?? "");
    expect(entity?.preferredName).toBe("Jill");
    expect(
      entity?.identities.some(
        (i) => i.platform === "voice" && i.handle === "cluster_jill",
      ),
    ).toBe(true);

    // Disk persistence: a fresh store instance sees the binding.
    const reloaded = new VoiceProfileStore({ rootDir: tmpRoot });
    await reloaded.init();
    expect((await reloaded.get(profile.profileId))?.entityId).toBe(
      bound?.entityId,
    );
  });

  it("re-observing the same cluster resolves to the same entity (cross-session memory)", async () => {
    const before = await store.get(
      (await store.list()).find((r) => r.imprintClusterId === "cluster_jill")
        ?.profileId ?? "",
    );
    expect(before?.entityId).toBeTruthy();

    await emitVoiceTurnObserved(runtime, {
      text: "morning! it's me again",
      imprintClusterId: "cluster_jill",
      matchConfidence: 0.95,
      matchedEntityId: before?.entityId ?? null,
    });

    const after = await store.get(before?.profileId ?? "");
    expect(after?.entityId).toBe(before?.entityId);
    const entities = await entityStore.list();
    expect(
      entities.filter((e) =>
        e.identities.some(
          (i) => i.platform === "voice" && i.handle === "cluster_jill",
        ),
      ),
    ).toHaveLength(1);
  });

  it("IDENTIFY_SPEAKER binds the most recent unidentified voice by name", async () => {
    const profile = await store.createProfile({
      centroid: unit([0, 1, 0, 0]),
      embeddingModel: MODEL,
      imprintClusterId: "cluster_sam",
      confidence: 0.8,
      durationMs: 2500,
    });
    expect(profile.entityId).toBeNull();

    const replies: string[] = [];
    const message = {
      content: { text: "that was Sam" },
    } as unknown as Memory;
    const result = await identifySpeakerAction.handler(
      runtime,
      message,
      undefined,
      undefined,
      async (content) => {
        if (typeof content.text === "string") replies.push(content.text);
        return [];
      },
    );

    expect(result?.success).toBe(true);
    const bound = await store.get(profile.profileId);
    expect(bound?.entityId).toBeTruthy();
    const entity = await entityStore.get(bound?.entityId ?? "");
    expect(entity?.preferredName).toBe("Sam");
    expect(replies.join(" ")).toContain("Sam");
  });

  it("serves HTTP bind/unbind from the plugin route handlers", async () => {
    setVoiceSpeakerProfileStore(store);
    setVoiceProfilesManagementStore(store);

    const server = http.createServer((req, res) => {
      void (async () => {
        if (await handleVoiceSpeakerProfileRoutes(req, res)) return;
        if (await handleVoiceProfilesManagementRoutes(req, res)) return;
        res.statusCode = 404;
        res.end();
      })();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;

    try {
      const profile = await store.createProfile({
        centroid: unit([0, 0, 1, 0]),
        embeddingModel: MODEL,
        imprintClusterId: "cluster_wally",
        confidence: 0.7,
        durationMs: 1800,
      });
      const contact = await entityStore.upsert({
        type: "person",
        preferredName: "Wally",
        identities: [],
        tags: [],
        visibility: "owner_agent_admin",
        state: {},
      });

      // Bind via the speaker-profile namespace.
      const bindRes = await fetch(
        `${base}/v1/voice/speaker-profiles/${profile.profileId}/bind`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ entityId: contact.entityId, label: "Wally" }),
        },
      );
      expect(bindRes.status).toBe(200);
      const bindDto = (await bindRes.json()) as { entityId: string | null };
      expect(bindDto.entityId).toBe(contact.entityId);
      expect((await store.get(profile.profileId))?.entityId).toBe(
        contact.entityId,
      );

      // List reflects the binding.
      const listRes = await fetch(`${base}/v1/voice/speaker-profiles`);
      expect(listRes.status).toBe(200);
      const listDto = (await listRes.json()) as {
        profiles: Array<{ profileId: string; entityId: string | null }>;
      };
      expect(
        listDto.profiles.find((p) => p.profileId === profile.profileId)
          ?.entityId,
      ).toBe(contact.entityId);

      // Unbind via the management namespace (the VoiceProfileSection UI path).
      const unbindRes = await fetch(
        `${base}/api/voice/profiles/${profile.profileId}/unbind`,
        { method: "POST" },
      );
      expect(unbindRes.status).toBe(200);
      expect((await store.get(profile.profileId))?.entityId).toBeNull();
    } finally {
      setVoiceSpeakerProfileStore(null);
      setVoiceProfilesManagementStore(null);
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});
