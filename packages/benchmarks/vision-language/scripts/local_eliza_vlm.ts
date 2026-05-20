#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

type Payload = {
  tier?: string;
  imagePath?: string;
  question?: string;
  maxTokens?: number;
};

async function readStdin(): Promise<Payload> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? (JSON.parse(raw) as Payload) : {};
}

function elizaModelsDir(): string {
  const explicit = process.env.ELIZA_STATE_DIR ?? process.env.MILADY_STATE_DIR;
  const ns = process.env.ELIZA_NAMESPACE ?? "eliza";
  const stateDir = explicit ?? path.join(homedir(), `.${ns}`);
  return path.join(stateDir, "local-inference", "models");
}

function resolveModelPath(tier: string): string {
  const root = elizaModelsDir();
  const candidates = [path.join(root, `${tier}.bundle`), path.join(root, tier)];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `no local Eliza-1 bundle found for tier '${tier}' under ${root}`,
  );
}

async function main(): Promise<void> {
  const payload = await readStdin();
  const tier = (payload.tier || "eliza-1-9b").trim();
  const imagePath = (payload.imagePath || "").trim();
  const question = (payload.question || "").trim();
  if (!imagePath || !question) {
    throw new Error("local_eliza_vlm requires imagePath and question");
  }

  const mod = await import(
    "../../../../plugins/plugin-local-inference/src/services/index.ts"
  );
  const createImageDescriptionRuntime = mod.createImageDescriptionRuntime as
    | ((args: { tier: string; modelPath: string }) => Promise<{
        describe(args: {
          imagePath: string;
          prompt: string;
          maxTokens?: number;
        }): Promise<string>;
        cleanup?(): Promise<void>;
      }>)
    | undefined;
  if (typeof createImageDescriptionRuntime !== "function") {
    throw new Error(
      "plugin-local-inference image-description runtime unavailable",
    );
  }

  const runtime = await createImageDescriptionRuntime({
    tier,
    modelPath: resolveModelPath(tier),
  });
  try {
    const text = await runtime.describe({
      imagePath,
      prompt: question,
      maxTokens: payload.maxTokens,
    });
    process.stdout.write(`${JSON.stringify({ text })}\n`);
  } finally {
    await runtime.cleanup?.();
  }
}

main().catch((err) => {
  process.stderr.write(
    `${err instanceof Error ? err.stack || err.message : String(err)}\n`,
  );
  process.exit(1);
});
