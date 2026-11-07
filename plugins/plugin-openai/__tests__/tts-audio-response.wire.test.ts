import { createServer, type Server } from "node:http";
import type { IAgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleTextToSpeech } from "../models/audio";

let server: Server;
let baseUrl: string;
let responseBytes = Buffer.alloc(0);

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "audio/mpeg" });
      response.end(responseBytes);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture failed to bind");
  }
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

beforeEach(() => {
  responseBytes = Buffer.from([0x49, 0x44, 0x33, 0x04]);
});

function runtime(): IAgentRuntime {
  const settings: Record<string, string> = {
    OPENAI_API_KEY: "loopback-only-key",
    OPENAI_BASE_URL: baseUrl,
  };
  return {
    getSetting: (key: string) => settings[key],
    character: { name: "Ada" },
    emitEvent: async () => {},
  } as unknown as IAgentRuntime;
}

describe("OpenAI text-to-speech response validation", () => {
  it("returns provider audio bytes", async () => {
    const audio = await handleTextToSpeech(runtime(), "Hello");

    expect(new Uint8Array(audio)).toEqual(new Uint8Array([0x49, 0x44, 0x33, 0x04]));
  });

  it("rejects a successful response with no audio bytes", async () => {
    responseBytes = Buffer.alloc(0);

    await expect(handleTextToSpeech(runtime(), "Hello")).rejects.toThrow(
      "OpenAI TTS returned an empty audio response"
    );
  });
});
