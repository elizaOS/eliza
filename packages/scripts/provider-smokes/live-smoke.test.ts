import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const fixture = `
const requests = [];
process.on('exit', () => console.log('SMOKE_REQUESTS:' + JSON.stringify(requests)));
globalThis.fetch = async (url, options) => {
  if (!options?.signal) throw new Error('request has no deadline');
  const parsed = new URL(url);
  if (parsed.hostname === 'upload.wikimedia.org') {
    if (options.method && options.method !== 'GET') throw new Error('unexpected image method');
    requests.push('image');
    return new Response(new Uint8Array([255, 216, 255, 217]), {headers:{'content-type':'image/jpeg'}});
  }
  if (!['https://api.openai.com', 'https://api.cerebras.ai', 'https://api.elevenlabs.io'].includes(parsed.origin)) throw new Error('unexpected provider origin');
  if (process.env.SMOKE_OUTCOME === 'auth') { requests.push('auth'); return new Response('{}', {status:401}); }
  if (options.method !== 'POST' || !parsed.pathname.endsWith('/chat/completions')) throw new Error('unexpected model request');
  const body = JSON.parse(options.body);
  const vision = Array.isArray(body.messages[0].content);
  requests.push(vision ? 'vision' : 'text');
  if (vision && parsed.hostname === 'api.cerebras.ai' && !body.messages[0].content[1].image_url.url.startsWith('data:image/jpeg;base64,')) throw new Error('Cerebras image was not inlined');
  if (vision && process.env.SMOKE_OUTCOME === 'vision-error') return new Response('{}', {status:500});
  return Response.json({choices:[{message:{content:vision ? 'boardwalk' : 'Tuesday'}}]});
};`;

it.each([
  ["real-llm-attachment-smoke.ts", "openai", "pass", 0],
  ["real-llm-attachment-smoke.ts", "openai", "vision-error", 1],
  ["real-llm-attachment-smoke.ts", "openai", "auth", 1],
  ["real-llm-attachment-smoke.ts", "cerebras", "pass", 0],
  ["real-llm-attachment-smoke.ts", "cerebras", "vision-error", 1],
  ["real-llm-attachment-smoke.ts", "cerebras", "auth", 1],
  ["real-service-audio-roundtrip.ts", "elevenlabs", "auth", 1],
  ["real-service-voice-e2e.ts", "elevenlabs", "auth", 1],
] as const)(
  "%s (%s) reports %s truthfully",
  (script, provider, outcome, status) => {
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
          [`${provider.toUpperCase()}_API_KEY`]: "fixture",
          ...(script === "real-service-voice-e2e.ts"
            ? { CEREBRAS_API_KEY: "fixture" }
            : {}),
          SMOKE_OUTCOME: outcome,
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(status);
    expect(result.stdout).not.toContain("SKIP");
    const evidence = result.stdout
      .split("\n")
      .find((line) => line.startsWith("SMOKE_REQUESTS:"));
    expect(evidence).toBeDefined();
    expect(
      JSON.parse(evidence?.slice("SMOKE_REQUESTS:".length) ?? "null"),
    ).toEqual(
      outcome === "auth"
        ? ["auth"]
        : provider === "cerebras"
          ? ["text", "image", "vision"]
          : ["text", "vision"],
    );
  },
);
