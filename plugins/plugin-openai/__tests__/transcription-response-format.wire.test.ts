/** Real loopback HTTP verifies every declared text transcription format. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { handleTranscription } from "../models/audio";
import type { TranscriptionResponseFormat } from "../types";

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server?.close((error) => (error ? reject(error) : resolve()))
  );
  server = undefined;
});

describe("transcription response format HTTP boundary", () => {
  it.each([
    ["text", "Plain transcript"],
    ["srt", "1\n00:00:00,000 --> 00:00:01,000\nSubtitle transcript"],
    ["vtt", "WEBVTT\n\n00:00.000 --> 00:01.000\nCaption transcript"],
  ] satisfies Array<[TranscriptionResponseFormat, string]>)(
    "returns the provider's raw %s transcript",
    async (responseFormat, expectedTranscript) => {
      let receivedFormat: FormDataEntryValue | null = null;
      server = createServer(async (request, response) => {
        const body = await new Response(request as unknown as BodyInit, {
          headers: request.headers as unknown as HeadersInit,
        }).formData();
        receivedFormat = body.get("response_format");
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end(expectedTranscript);
      });
      await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
      const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const runtime = new AgentRuntime({
        character: {
          name: "TranscriptionFormatTest",
          settings: {
            OPENAI_API_KEY: "local-test-key",
            OPENAI_BASE_URL: baseURL,
            OPENAI_TRANSCRIPTION_MODEL: "whisper-1",
          },
        },
      });

      const transcript = await handleTranscription(runtime, {
        audio: Buffer.from("RIFF0000WAVEfmt "),
        mimeType: "audio/wav",
        responseFormat,
      });

      expect(receivedFormat).toBe(responseFormat);
      expect(transcript).toBe(expectedTranscript);
    }
  );
});
