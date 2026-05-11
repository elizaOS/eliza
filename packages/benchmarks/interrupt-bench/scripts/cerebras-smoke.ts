#!/usr/bin/env bun
/**
 * Cerebras smoke test — one round trip with the composed Stage-1 schema.
 *
 * Useful for verifying CEREBRAS_API_KEY is wired and the model is reachable
 * before kicking off the full bench. Prints the parsed JSON response.
 *
 * Usage:
 *   bun run scripts/cerebras-smoke.ts
 *   bun run scripts/cerebras-smoke.ts --model=gpt-oss-120b
 */

import { buildBenchRegistry } from "../src/registry.ts";
import { callCerebras, isCerebrasConfigured } from "../src/llm-cerebras.ts";

async function main(): Promise<void> {
  if (!isCerebrasConfigured()) {
    process.stderr.write("CEREBRAS_API_KEY not set. Aborting.\n");
    process.exit(1);
  }
  const modelArg = process.argv.find((a) => a.startsWith("--model="));
  const model = modelArg ? modelArg.slice("--model=".length) : undefined;

  const registry = buildBenchRegistry();
  const schema = registry.composeSchema();
  process.stdout.write(`Schema fields: ${registry.list().map((e) => e.name).join(", ")}\n`);
  process.stdout.write("Calling Cerebras...\n");

  const result = await callCerebras({
    systemPrompt:
      "You are the Stage-1 response handler. Emit JSON only. The user is fragmenting a request across messages — coalesce intent.",
    messages: [
      {
        role: "user",
        content: [
          "## Rooms",
          "- dm-alice (kind=dm, owner=alice)",
          "",
          "## Conversation history",
          "[dm-alice] alice: i need to",
          "[dm-alice] alice: send",
          "[dm-alice] alice: an email",
          "",
          "## New message",
          "[dm-alice] alice: to bob about lunch tomorrow",
          "",
          "Respond with the JSON object only.",
        ].join("\n"),
      },
    ],
    schema,
    model,
  });

  process.stdout.write(`\nLatency: ${result.latencyMs}ms\n`);
  process.stdout.write("Parsed:\n");
  process.stdout.write(JSON.stringify(result.parsed, null, 2));
  process.stdout.write("\n");
}

main().catch((err) => {
  process.stderr.write(`Smoke failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
