// Smoke test for the Cerebras eval/training helper.
// Run: bun run plugins/app-lifeops/scripts/verify-cerebras-wiring.ts
//
// Confirms that getEvalModelClient and getTrainingModelClient can both
// reach Cerebras gpt-oss-120b and that the response shape is parsed.

import {
  getEvalModelClient,
  getTrainingModelClient,
  judgeWithCerebras,
} from "../test/helpers/lifeops-eval-model.ts";

async function main(): Promise<void> {
  console.log("[verify-cerebras] starting smoke test");
  console.log("[verify-cerebras] env:", {
    CEREBRAS_BASE_URL:
      process.env.CEREBRAS_BASE_URL ?? "(default https://api.cerebras.ai/v1)",
    CEREBRAS_MODEL: process.env.CEREBRAS_MODEL ?? "(default gpt-oss-120b)",
    EVAL_MODEL: process.env.EVAL_MODEL,
    TRAIN_MODEL: process.env.TRAIN_MODEL,
    EVAL_MODEL_PROVIDER: process.env.EVAL_MODEL_PROVIDER,
    TRAIN_MODEL_PROVIDER: process.env.TRAIN_MODEL_PROVIDER,
    has_CEREBRAS_API_KEY: !!process.env.CEREBRAS_API_KEY,
  });

  const evalClient = getEvalModelClient();
  const evalResult = await evalClient({
    prompt: 'Reply with the JSON {"ok": true} and nothing else.',
    maxTokens: 256,
    temperature: 0,
  });
  console.log("[verify-cerebras] eval text:", evalResult.text);
  console.log("[verify-cerebras] eval usage:", evalResult.usage);
  if (!evalResult.text.toLowerCase().includes("ok")) {
    throw new Error(
      `eval client did not return parseable JSON: ${evalResult.text}`,
    );
  }

  const trainClient = getTrainingModelClient();
  const trainResult = await trainClient({
    prompt:
      "Generate one short user message asking for tomorrow's weather. Reply with only the user message.",
    systemPrompt: "You produce realistic synthetic training utterances.",
    maxTokens: 256,
    temperature: 0.9,
  });
  console.log("[verify-cerebras] train text:", trainResult.text);
  console.log("[verify-cerebras] train usage:", trainResult.usage);
  if (trainResult.text.trim().length === 0) {
    throw new Error("training client returned empty text");
  }

  const judged = await judgeWithCerebras(
    "Score this on a scale of 1-10: 'The cat sat on the mat.' Reply with just the integer.",
    { maxTokens: 128 },
  );
  console.log("[verify-cerebras] judge text:", judged);

  console.log(
    "[verify-cerebras] OK — Cerebras gpt-oss-120b is reachable for both eval and training",
  );
}

await main();
