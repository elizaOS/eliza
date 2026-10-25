/** A real upstream sends headers then stalls its response body. */
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgentRuntime, runWithStreamingContext } from "@elizaos/core";
import { expect, it, vi } from "vitest";
import { saveElizaConfig } from "../src/config/config.ts";
import { fetchWithTimeout } from "../src/providers/media-provider.ts";
import { AgentMediaGenerationService } from "../src/services/media-generation.ts";

it("allows a caller-owned body to complete after the former shared deadline", async () => {
  let release: (() => void) | undefined;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"complete":');
    release = () => res.end("true}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const controller = new AbortController();
  try {
    const response = await fetchWithTimeout(
      `http://127.0.0.1:${address.port}`,
      { signal: controller.signal },
    );
    const body = response.text().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await delay(31_000);
    release?.();
    expect(await body).toEqual({ value: '{"complete":true}' });
  } finally {
    controller.abort();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
}, 60_000);

it.each(["deadline", "caller"])(
  "cancels a pending HTTP response (%s)",
  async (mode) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"pending":');
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    try {
      const controller = new AbortController();
      const pending = fetchWithTimeout(
        `http://127.0.0.1:${address.port}`,
        { signal: controller.signal },
        mode === "deadline" ? 250 : undefined,
      );
      if (mode === "deadline") {
        // The selected deadline covers both headers and the stalled body.
        await expect(
          pending.then((response) => response.text()),
        ).rejects.toThrow();
      } else {
        const response = await pending;
        expect(response.status).toBe(200);
        const body = response.text();
        controller.abort();
        await expect(body).rejects.toThrow();
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  },
);

it.each(["success", "caller", "runtime"] as const)(
  "preserves audio fields and cancellation through the configured service (%s)",
  async (mode) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "media-request-"));
    vi.stubEnv("ELIZA_STATE_DIR", directory);
    vi.stubEnv("ELIZA_CONFIG_PATH", path.join(directory, "eliza.json"));
    let received: { url?: string; body?: Record<string, unknown> } = {};
    let markResponseStarted!: () => void;
    const responseStarted = new Promise<void>((resolve) => {
      markResponseStarted = resolve;
    });
    const server = http.createServer(async (req, res) => {
      const parts: Buffer[] = [];
      for await (const part of req) parts.push(Buffer.from(part));
      received = {
        url: req.url,
        body: JSON.parse(Buffer.concat(parts).toString()),
      };
      res.writeHead(200, { "content-type": "audio/wav" });
      res.write("fixture-audio-bytes");
      markResponseStarted();
      if (mode === "success") res.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    const runtime = new AgentRuntime({
      character: { name: "Media", bio: [] },
      logLevel: "fatal",
    });
    try {
      saveElizaConfig({
        media: {
          audio: {
            mode: "own-key",
            provider: "elevenlabs",
            elevenlabs: {
              apiKey: "test-key",
              baseUrl: `http://127.0.0.1:${address.port}`,
            },
          },
        },
      });
      const service = await AgentMediaGenerationService.start(runtime);
      const controller = new AbortController();
      const pending = runWithStreamingContext(
        { abortSignal: controller.signal },
        () =>
          service.generateMedia({
            mediaType: "audio",
            audioKind: "tts",
            voice: "selected-voice",
            prompt: "Read this text",
            seed: 42,
          }),
      );
      const outcome = pending.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await Promise.race([responseStarted, pending]);
      expect(received).toMatchObject({
        url: "/text-to-speech/selected-voice",
        body: { text: "Read this text", seed: 42 },
      });
      if (mode !== "success") {
        if (mode === "caller") controller.abort();
        else await runtime.stop();
        const result = await outcome;
        if (!("error" in result))
          throw new Error("Generation completed after cancellation");
        const reason =
          mode === "caller"
            ? controller.signal.reason
            : runtime.getStopSignal().reason;
        expect(result.error).toBe(reason);
        expect(result.error).toMatchObject({ name: "AbortError" });
        return;
      }
      const result = await pending;
      expect(result).toMatchObject({ audioKind: "tts", mimeType: "audio/wav" });
      expect(result.audioUrl).toBe(
        `data:audio/wav;base64,${Buffer.from("fixture-audio-bytes").toString("base64")}`,
      );
    } finally {
      await runtime.stop();
      vi.unstubAllEnvs();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
