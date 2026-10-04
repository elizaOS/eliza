import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const fixture = `
globalThis.fetch = async (url, options) => {
  if (!options?.signal) throw new Error('request has no deadline');
  if (process.env.SMOKE_OUTCOME === 'auth') return new Response('{}', {status:401});
  const body = JSON.parse(options.body);
  const vision = Array.isArray(body.messages[0].content);
  if (vision && process.env.SMOKE_OUTCOME === 'vision-error') return new Response('{}', {status:500});
  return Response.json({choices:[{message:{content:vision ? 'boardwalk' : 'Tuesday'}}]});
};`;

it.each([
  ["real-llm-attachment-smoke.ts", "pass", 0],
  ["real-llm-attachment-smoke.ts", "vision-error", 1],
  ["real-llm-attachment-smoke.ts", "auth", 1],
  ["real-service-audio-roundtrip.ts", "auth", 1],
  ["real-service-voice-e2e.ts", "auth", 1],
] as const)("%s reports %s truthfully", (script, outcome, status) => {
  const result = spawnSync(
    "node",
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(fixture)}`,
      fileURLToPath(new URL(script, import.meta.url)),
    ],
    {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        PATH: process.env.PATH,
        OPENAI_API_KEY: "fixture",
        ELEVENLABS_API_KEY: "fixture",
        CEREBRAS_API_KEY: "fixture",
        SMOKE_OUTCOME: outcome,
      },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(status);
  expect(result.stdout).not.toContain("SKIP");
});
