import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AgentRuntime,
  isInsufficientCreditsError,
  isModelProviderFallbackError,
  ModelType,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleTextLarge } from "../models/text";

const CREDIT_BALANCE_MESSAGE =
  "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: CREDIT_BALANCE_MESSAGE },
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("Anthropic credit balance exhaustion", () => {
  it("classifies the HTTP 400 credit balance rejection as insufficient credits", async () => {
    const agent = new AgentRuntime({
      character: { name: "Credit balance test", bio: [] },
      logLevel: "fatal",
      settings: {
        ANTHROPIC_API_KEY: "placeholder-not-a-key",
        ANTHROPIC_BASE_URL: baseUrl,
      },
    });
    agent.registerDatabaseAdapter({ createLogs: async () => undefined } as never);
    agent.registerModel(ModelType.TEXT_LARGE, handleTextLarge, "anthropic", 10);

    const error = await agent.useModel(ModelType.TEXT_LARGE, { prompt: "Say hi" }).then(
      () => undefined,
      (failure: unknown) => failure
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      `[Anthropic] TEXT_LARGE request using claude-opus-4-8 failed: ${CREDIT_BALANCE_MESSAGE}`
    );
    expect(isInsufficientCreditsError(error)).toBe(true);
    expect(isModelProviderFallbackError(error, ModelType.TEXT_LARGE)).toBe(false);
  });
});
