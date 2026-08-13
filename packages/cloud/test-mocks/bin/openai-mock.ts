#!/usr/bin/env bun
/** Runs the deterministic OpenAI-compatible mock as a standalone local service. */

import { startOpenAiMock } from "../src/openai/server";

function numericPort(value: string | undefined): number {
  const port = Number(value ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid OPENAI_MOCK_PORT/PORT: ${JSON.stringify(value)}`);
  }
  return port;
}

const running = await startOpenAiMock({
  host: process.env.HOST ?? "127.0.0.1",
  port: numericPort(process.env.OPENAI_MOCK_PORT ?? process.env.PORT),
  reply: process.env.OPENAI_MOCK_REPLY,
  echoContext: process.env.OPENAI_MOCK_ECHO_CONTEXT !== "0",
});

console.log(`[openai-mock] listening at ${running.url}`);

const shutdown = async (): Promise<void> => {
  await running.stop();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
