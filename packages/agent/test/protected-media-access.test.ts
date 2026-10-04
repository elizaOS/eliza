/**
 * Protected-profile media access. Under `ELIZA_PROTECTED_PROFILE=dstack-cpu`
 * a content-addressed media URL is no longer a bearer capability: the media
 * route registered through the real host plugin lifecycle is private, so the
 * canonical dispatcher (used by native IPC and the HTTP runtime-route gate)
 * refuses an unauthorized caller and serves the stored bytes to an authorized
 * one. The HTTP listener itself cannot boot here: protected admission requires
 * a real dstack CVM (see protected-profile-boot.test.ts), so the pre-/post-auth
 * ordering in server.ts is exercised by media-capability-http.test.ts only for
 * ordinary hosts.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installHttpPluginLifecycle } from "@elizaos/host/protocol";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { dispatchRoute } from "../src/api/dispatch-route.ts";
import { mediaFileRoute } from "../src/api/media-runtime.ts";
import {
  isMediaAuthRequired,
  persistMediaBytes,
} from "../src/api/media-store.ts";
import { captureProtectedProfile } from "../src/security/protected-profile-state.ts";

// Captured once at first use; set before anything in this process reads it.
vi.hoisted(() => {
  process.env.ELIZA_PROTECTED_PROFILE = "dstack-cpu";
});

const BYTES = Buffer.from("protected media bytes for access control");
let stateDirectory: string;
let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let mediaUrl: string;

beforeAll(async () => {
  expect(captureProtectedProfile().profile).toBe("dstack-cpu");
  stateDirectory = await mkdtemp(path.join(tmpdir(), "eliza-protected-media-"));
  vi.stubEnv("ELIZA_STATE_DIR", stateDirectory);
  fixture = await createTestRuntime({ characterName: "ProtectedMedia" });
  installHttpPluginLifecycle(fixture.runtime);
  await fixture.runtime.registerPlugin({
    name: "protected-media-access",
    description: "Registers the host media route",
    routes: [mediaFileRoute],
  });
  mediaUrl = persistMediaBytes(BYTES, "text/plain").url;
}, 120_000);

afterAll(async () => {
  if (fixture) await fixture.cleanup();
  vi.unstubAllEnvs();
  if (stateDirectory)
    await rm(stateDirectory, { recursive: true, force: true });
}, 120_000);

const fetchMedia = (authorized: boolean) =>
  dispatchRoute({
    runtime: fixture.runtime,
    method: "GET",
    path: mediaUrl,
    headers: {},
    inProcess: true,
    isAuthorized: () => authorized,
  });

it("requires authentication for media under the protected profile", async () => {
  expect(isMediaAuthRequired()).toBe(true);
  expect(mediaFileRoute.public).toBe(false);
  const denied = await fetchMedia(false);
  expect(denied?.status).toBe(401);
  expect(denied?.body).toEqual({ error: "Unauthorized" });
});

it("serves the stored bytes to an authorized caller", async () => {
  const served = await fetchMedia(true);
  expect(served?.status).toBe(200);
  expect(Buffer.from(served?.body as Buffer).equals(BYTES)).toBe(true);
});

it("keeps media private when the environment is relaxed after entry", async () => {
  delete process.env.ELIZA_PROTECTED_PROFILE;
  expect(isMediaAuthRequired()).toBe(true);
  expect((await fetchMedia(false))?.status).toBe(401);
});
