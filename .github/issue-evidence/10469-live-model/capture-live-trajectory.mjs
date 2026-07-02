/**
 * Live-model trajectory capture for #10469 (no mock, no proxy).
 *
 * Uses the REAL SecretSwapSession against the REAL Cerebras provider
 * (gpt-oss-120b) to prove: with the swap layer applied, the provider receives
 * ONLY placeholders, yet the real value is recoverable at the execution
 * boundary. Run: CEREBRAS_API_KEY=... bun capture-live-trajectory.mjs
 */
import { writeFileSync } from "node:fs";
import { SecretSwapSession } from "../../../packages/core/src/security/secret-swap.ts";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: evidence script reads the provider key from the environment
const KEY = process.env.CEREBRAS_API_KEY;
if (!KEY) throw new Error("CEREBRAS_API_KEY required");

const REAL_SECRET =
  "sk-ant-api03-9fK3xQ7zL2mNpR8tV4wYbC1dE6gH0jKlMnOpQrStUvWxYz";
const REAL_CARD = "4242 4242 4242 4242";
// A benign config-templating turn: the model fills a token into an env-export
// line. The swap hides the value, so the model templates an opaque token it
// never recognises as a secret — exactly the design intent.
const userMessage =
  `Fill this local shell line, substituting the value, and output ONLY the line:\n` +
  `export ANTHROPIC_API_KEY="<value>"\n` +
  `The value is: ${REAL_SECRET}`;

const session = new SecretSwapSession();
const swappedMessage = session.substituteText(userMessage);

const providerRequest = {
  model: "gpt-oss-120b",
  messages: [
    {
      role: "system",
      content:
        "You are a helpful ops assistant. Use tokens exactly as given; do not invent values.",
    },
    { role: "user", content: swappedMessage },
  ],
  max_tokens: 400,
  temperature: 0,
};

const requestJson = JSON.stringify(providerRequest);
const leaks = [REAL_SECRET, "4242424242424242", REAL_CARD].filter((v) =>
  requestJson.includes(v),
);
if (leaks.length > 0) {
  throw new Error(`ABORT: raw secret in provider request: ${leaks.join(", ")}`);
}

const res = await fetch("https://api.cerebras.ai/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json",
  },
  body: requestJson,
});
const data = await res.json();
const msg = data.choices?.[0]?.message ?? {};
const modelOutput = `${msg.content ?? ""}\n${msg.reasoning ?? ""}`.trim();

const restored = session.restoreText(modelOutput, { failOnUnresolved: false });

const report = {
  stage1_userMessage_raw: userMessage,
  stage2_providerRequest_messages: providerRequest.messages,
  stage2_assert_noRawSecretInProviderRequest: leaks.length === 0,
  stage3_modelOutput_keepsPlaceholder: modelOutput,
  stage3_modelOutput_containsPlaceholder: /__ELIZA_SECRET_[0-9a-f]+_\d+__/.test(
    modelOutput,
  ),
  stage3_modelOutput_containsRawSecret: modelOutput.includes(REAL_SECRET),
  stage4_restoredAtExecutionBoundary: restored,
  stage4_restored_containsRealSecret: restored.includes(REAL_SECRET),
  entries: session.entries.map((e) => ({
    kind: e.kind,
    placeholder: e.placeholder,
    valuePreview: `${e.value.slice(0, 6)}…(${e.value.length} chars)`,
  })),
  provider: { name: "cerebras", model: data.model, id: data.id },
};

writeFileSync(
  new URL("./trajectory-report.json", import.meta.url),
  JSON.stringify(report, null, 2),
);

console.log("=== LIVE-MODEL TRAJECTORY (#10469) ===");
console.log("provider:", report.provider.name, report.provider.model);
console.log(
  "[a] no raw secret in provider request:",
  report.stage2_assert_noRawSecretInProviderRequest,
);
console.log(
  "[b] model output keeps placeholder:",
  report.stage3_modelOutput_containsPlaceholder,
  "| contains raw secret:",
  report.stage3_modelOutput_containsRawSecret,
);
console.log(
  "[c] restored real value at execution boundary:",
  report.stage4_restored_containsRealSecret,
);
console.log("entries:", JSON.stringify(report.entries));
console.log("--- provider request (user turn) ---");
console.log(report.stage2_providerRequest_messages[1].content);
console.log("--- model output (placeholders kept) ---");
console.log(report.stage3_modelOutput_keepsPlaceholder.slice(0, 400));
