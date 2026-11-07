import { once } from "node:events";
import { chmod, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";
import { handleStandaloneWhisperRoute } from "./standalone-whisper-routes";

vi.mock("./auth", () => ({
  resolveAuthorizedRouteRole: async () => ({
    ok: true,
    role: "OWNER",
    identityId: "owner-1",
  }),
}));

// tiny.en at ggerganov/whisper.cpp 5359861c; configuration() only accepts these sizes.
const MODEL_BYTES = 77_704_715;
const BINARY_SHA = "a".repeat(64);

let directory: string;
let server: Server;
let origin: string;

async function stageModel(): Promise<string> {
  const model = join(directory, "ggml-tiny.en.bin");
  const handle = await open(model, "w");
  await handle.truncate(MODEL_BYTES);
  await handle.close();
  return model;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "whisper-config-"));
  vi.stubEnv("ELIZA_WHISPER_ENABLED", "1");
  vi.stubEnv("ELIZA_WHISPER_BACKEND", "cpu");
  server = createServer(async (req, res) => {
    const handled = await handleStandaloneWhisperRoute(
      req,
      res,
      {} as CompatRuntimeState,
    );
    if (!handled) {
      res.statusCode = 404;
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  server.close();
  await once(server, "close");
  await rm(directory, { recursive: true, force: true });
});

describe("standalone whisper provider configuration", () => {
  it("reports an unreadable configured binary as unavailable instead of not configured", async () => {
    const binary = join(directory, "whisper-cli");
    await writeFile(binary, "#!/bin/sh\n");
    await chmod(binary, 0o000);
    vi.stubEnv("ELIZA_WHISPER_BINARY", binary);
    vi.stubEnv("ELIZA_WHISPER_MODEL", await stageModel());
    vi.stubEnv("ELIZA_WHISPER_BINARY_SHA256", BINARY_SHA);

    const response = await fetch(`${origin}/api/asr/whisper/status`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "provider_unavailable" });
  });

  it("reports a configured binary that fails its pinned digest as unavailable", async () => {
    const binary = join(directory, "whisper-cli");
    await writeFile(binary, "#!/bin/sh\n");
    await chmod(binary, 0o755);
    vi.stubEnv("ELIZA_WHISPER_BINARY", binary);
    vi.stubEnv("ELIZA_WHISPER_MODEL", await stageModel());
    vi.stubEnv("ELIZA_WHISPER_BINARY_SHA256", BINARY_SHA);

    const response = await fetch(`${origin}/api/asr/whisper/status`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "provider_unavailable" });
  });

  it("keeps a genuinely absent install indistinguishable from disabled", async () => {
    vi.stubEnv("ELIZA_WHISPER_BINARY", join(directory, "missing-cli"));
    vi.stubEnv("ELIZA_WHISPER_MODEL", join(directory, "missing-model.bin"));
    vi.stubEnv("ELIZA_WHISPER_BINARY_SHA256", BINARY_SHA);

    const response = await fetch(`${origin}/api/asr/whisper/status`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ready: false });
  });
});
