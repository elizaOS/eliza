import fs from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { AgentRuntime } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { saveElizaConfig } from "../src/config/config.ts";
import { AgentMediaGenerationService } from "../src/services/media-generation.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

it("rejects a successful Suno response that has no audio URL", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "suno-audio-"));
  vi.stubEnv("ELIZA_STATE_DIR", directory);
  vi.stubEnv("ELIZA_CONFIG_PATH", path.join(directory, "eliza.json"));

  const requests: Array<{ authorization?: string; body: unknown }> = [];
  const suno = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => suno.listen(0, "127.0.0.1", resolve));
  const address = suno.address() as AddressInfo;
  const runtime = new AgentRuntime({
    character: { name: "Media", bio: [] },
    logLevel: "fatal",
  });

  try {
    saveElizaConfig({
      media: {
        audio: {
          mode: "own-key",
          provider: "suno",
          suno: {
            apiKey: "suno-test-key",
            baseUrl: `http://127.0.0.1:${address.port}`,
          },
        },
      },
    });
    const service = await AgentMediaGenerationService.start(runtime);

    await expect(
      service.generateMedia({
        mediaType: "audio",
        audioKind: "music",
        prompt: "A quiet piano melody",
      }),
    ).rejects.toThrow("No audio returned from Suno");
    expect(requests).toEqual([
      {
        authorization: "Bearer suno-test-key",
        body: {
          prompt: "A quiet piano melody",
          model: "chirp-v3.5",
        },
      },
    ]);
  } finally {
    await runtime.stop();
    await new Promise<void>((resolve, reject) =>
      suno.close((error) => (error ? reject(error) : resolve())),
    );
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
