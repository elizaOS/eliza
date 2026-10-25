/**
 * Tests for the voice-profile plugin-route registration (issue #8234).
 *
 * The bind/unbind HTTP surface is only reachable through `runtime.routes`
 * (no server forwards the `/v1/voice/speaker-profiles` or
 * `/api/voice/profiles` namespaces to the local-inference route dispatcher),
 * so the route table on the plugin object IS the runtime mount. These tests
 * pin the table and prove the delegate handlers drive the real store.
 */

import { mkdtempSync, rmSync } from "node:fs";
import type * as http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localInferencePlugin } from "../src/provider";
import { voiceProfilePluginRoutes } from "../src/routes/voice-profile-plugin-routes";
import { setVoiceSpeakerProfileStore } from "../src/routes/voice-speaker-profile-routes";
import { VoiceProfileStore } from "../src/services/voice/profile-store";
import { WESPEAKER_RESNET34_LM_INT8_MODEL_ID } from "../src/services/voice/speaker/encoder";

function unit(values: number[]): Float32Array {
  let sumSq = 0;
  for (const v of values) sumSq += v * v;
  const inv = sumSq > 0 ? 1 / Math.sqrt(sumSq) : 1;
  return new Float32Array(values.map((v) => v * inv));
}

interface FakeResponse extends http.ServerResponse {
  body: string;
}

function makeRequest(
  method: string,
  url: string,
  body?: unknown,
): http.IncomingMessage {
  const req = new EventEmitter() as unknown as http.IncomingMessage & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = method;
  req.url = url;
  req.headers = { "content-type": "application/json" };
  process.nextTick(() => {
    if (body !== undefined) {
      req.emit("data", Buffer.from(JSON.stringify(body)));
    }
    req.emit("end");
  });
  return req;
}

function makeResponse(): FakeResponse {
  const res = new EventEmitter() as unknown as FakeResponse & {
    statusCode: number;
    headersSent: boolean;
  };
  res.statusCode = 200;
  res.headersSent = false;
  res.body = "";
  res.setHeader = () => res;
  res.writeHead = (status: number) => {
    res.statusCode = status;
    res.headersSent = true;
    return res;
  };
  res.end = ((chunk?: unknown) => {
    if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
      res.body += chunk.toString();
    }
    res.headersSent = true;
    return res;
  }) as FakeResponse["end"];
  return res;
}

describe("voiceProfilePluginRoutes", () => {
  it("is registered on the plugin object so both API servers serve it", () => {
    // The plugin composes voice-profile routes with the transcripts routes
    // (provider.ts: `routes: [...voiceProfilePluginRoutes, ...transcriptsRoutes]`),
    // so assert the voice-profile routes are all present rather than reference-equal.
    expect(localInferencePlugin.routes).toEqual(
      expect.arrayContaining([...voiceProfilePluginRoutes]),
    );
  });

  it("covers the bind/unbind namespaces with rawPath routes", () => {
    const table = voiceProfilePluginRoutes.map((r) => `${r.type} ${r.path}`);
    expect(table).toEqual(
      expect.arrayContaining([
        "GET /v1/voice/speaker-profiles",
        "POST /v1/voice/speaker-profiles/:id/bind",
        "POST /v1/voice/speaker-profiles/:id/unbind",
        "GET /api/voice/profiles",
        "DELETE /api/voice/profiles",
        "POST /api/voice/profiles/export",
        "PATCH /api/voice/profiles/:id",
        "DELETE /api/voice/profiles/:id",
        "GET /api/voice/profiles/:id/sample",
        "POST /api/voice/profiles/:id/merge",
        "POST /api/voice/profiles/:id/split",
        "POST /api/voice/profiles/:id/bind",
        "POST /api/voice/profiles/:id/unbind",
      ]),
    );
    for (const route of voiceProfilePluginRoutes) {
      expect(route.rawPath).toBe(true);
      expect(typeof route.handler).toBe("function");
      // Private: the host dispatcher must 401 unauthenticated callers.
      expect(route.public).toBeUndefined();
    }
  });

  describe("delegate handlers", () => {
    let tmpRoot: string;
    let store: VoiceProfileStore;

    beforeEach(async () => {
      tmpRoot = mkdtempSync(path.join(tmpdir(), "voice-plugin-routes-"));
      store = new VoiceProfileStore({ rootDir: tmpRoot });
      await store.init();
      setVoiceSpeakerProfileStore(store);
    });

    afterEach(() => {
      setVoiceSpeakerProfileStore(null);
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    it("binds a profile through the registered route handler", async () => {
      const profile = await store.createProfile({
        centroid: unit([1, 0, 0, 0]),
        embeddingModel: WESPEAKER_RESNET34_LM_INT8_MODEL_ID,
        imprintClusterId: "cluster_a",
        confidence: 0.8,
        durationMs: 2000,
      });

      const bindRoute = voiceProfilePluginRoutes.find(
        (r) => r.path === "/v1/voice/speaker-profiles/:id/bind",
      );
      expect(bindRoute?.handler).toBeDefined();

      const res = makeResponse();
      await bindRoute?.handler?.(
        makeRequest(
          "POST",
          `/v1/voice/speaker-profiles/${profile.profileId}/bind`,
          { entityId: "ent_test", label: "Test" },
        ) as never,
        res as never,
        undefined as never,
      );

      expect(res.statusCode).toBe(200);
      expect((await store.get(profile.profileId))?.entityId).toBe("ent_test");
    });

    it("answers 404 when the delegate dispatcher rejects the path shape", async () => {
      const bindRoute = voiceProfilePluginRoutes.find(
        (r) => r.path === "/v1/voice/speaker-profiles/:id/bind",
      );
      const res = makeResponse();
      // An id with a slash-escaping character the dispatcher's id regex
      // rejects after decode — handler returns false → delegate 404s.
      await bindRoute?.handler?.(
        makeRequest("POST", "/v1/voice/speaker-profiles/bad%2Fid/bind", {
          entityId: "ent_test",
        }) as never,
        res as never,
        undefined as never,
      );
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    });
  });
});
