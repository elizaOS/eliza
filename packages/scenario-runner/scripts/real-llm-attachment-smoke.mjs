#!/usr/bin/env node
/**
 * Real-LLM attachment smoke (#8876).
 *
 * The scenario-runner's deterministic lane is a *zero-cost mock* substrate — by
 * design it never calls a real provider. This script is the complement the goal
 * asks for ("we ALSO test/validate with a real LLM"): it calls a REAL model
 * provider directly and checks that a real model correctly consumes attachment
 * content — a text/document note (text extraction) and an image (vision).
 *
 * It is CI-safe and turnkey: with a valid provider key it runs and asserts; with
 * no key — or an invalid/expired one (auth error) — it SKIPS cleanly (exit 0)
 * so it never red-fails a build that simply has no credentials. Exit 1 only on a
 * real, authenticated model giving a wrong answer.
 *
 * Run: `node packages/scenario-runner/scripts/real-llm-attachment-smoke.mjs`
 * (reads OPENAI_API_KEY / ANTHROPIC_API_KEY / XAI_API_KEY / CEREBRAS_API_KEY
 * from the env).
 */

const NOTE = "Project kickoff is Tuesday at 10am in room 4.";
// A stable public image with an unmistakable man-made structure (a boardwalk).
// NOTE: the /thumb/…/640px-… variant of this URL started returning HTTP 400
// from Wikimedia (observed 2026-07-02), which silently broke the vision leg
// for every provider — use the canonical full-size Commons URL instead.
const IMAGE_URL =
  "https://upload.wikimedia.org/wikipedia/commons/d/dd/Gfp-wisconsin-madison-the-nature-boardwalk.jpg";

function skip(reason) {
  console.log(`SKIP real-llm-attachment-smoke: ${reason}`);
  process.exit(0);
}

class AuthError extends Error {}

/**
 * Fetch the reference image and inline it as a base64 data URI. Cerebras
 * rejects remote image URLs (`invalid_multimodal_input`) — its multimodal
 * models accept data URIs only.
 */
async function imageAsDataUri() {
  // Wikimedia rejects UA-less programmatic fetches with HTTP 400.
  const r = await fetch(IMAGE_URL, {
    headers: { "user-agent": "elizaos-real-llm-attachment-smoke/1.0" },
  });
  if (!r.ok) throw new Error(`image fetch failed: HTTP ${r.status}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

async function callOpenAICompatible({ base, key, model, vision, imageUri }) {
  const userContent = vision
    ? [
        {
          type: "text",
          text: "What is the main man-made structure in this image? One or two words.",
        },
        { type: "image_url", image_url: { url: imageUri ?? IMAGE_URL } },
      ]
    : `Attached note:\n"""${NOTE}"""\nWhat day is the kickoff? Reply with one word.`;
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 60,
      temperature: 0,
      messages: [{ role: "user", content: userContent }],
    }),
  });
  const body = await r.text();
  if (
    r.status === 401 ||
    r.status === 403 ||
    /incorrect api key|invalid.*api.?key/i.test(body)
  ) {
    throw new AuthError(`auth failed (HTTP ${r.status})`);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${body.slice(0, 160)}`);
  const j = JSON.parse(body);
  return { text: j.choices?.[0]?.message?.content ?? "", usage: j.usage };
}

async function callAnthropic({ key, model, vision }) {
  // Anthropic needs base64 image input; skip vision for it here (text only).
  if (vision) return null;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 40,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: `Attached note:\n"""${NOTE}"""\nWhat day is the kickoff? One word.`,
        },
      ],
    }),
  });
  const body = await r.text();
  if (r.status === 401 || r.status === 403)
    throw new AuthError(`auth failed (HTTP ${r.status})`);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${body.slice(0, 160)}`);
  const j = JSON.parse(body);
  return { text: j.content?.[0]?.text ?? "", usage: j.usage };
}

const PROVIDERS = [
  {
    name: "openai",
    keyEnv: "OPENAI_API_KEY",
    run: (key, vision) =>
      callOpenAICompatible({
        base: "https://api.openai.com/v1",
        key,
        model: "gpt-4o-mini",
        vision,
      }),
  },
  {
    name: "xai",
    keyEnv: "XAI_API_KEY",
    run: (key, vision) =>
      callOpenAICompatible({
        base: "https://api.x.ai/v1",
        key,
        model: "grok-4",
        vision,
      }),
  },
  {
    name: "anthropic",
    keyEnv: "ANTHROPIC_API_KEY",
    run: (key, vision) =>
      callAnthropic({ key, model: "claude-haiku-4-5-20251001", vision }),
  },
  {
    // Cerebras is the repo's first-class live eval provider (see the
    // scenario-runner Cerebras judge). Text runs on CEREBRAS_MODEL (default
    // gpt-oss-120b); vision runs on gemma-4-31b (the multimodal model Cerebras
    // hosts — gpt-oss-120b is text-only) with the image inlined as a data URI.
    name: "cerebras",
    keyEnv: "CEREBRAS_API_KEY",
    run: async (key, vision) =>
      callOpenAICompatible({
        base: "https://api.cerebras.ai/v1",
        key,
        model: vision
          ? "gemma-4-31b"
          : (process.env.CEREBRAS_MODEL ?? "gpt-oss-120b").trim(),
        vision,
        imageUri: vision ? await imageAsDataUri() : undefined,
      }),
  },
];

const available = PROVIDERS.filter((p) => (process.env[p.keyEnv] ?? "").trim());
if (available.length === 0)
  skip("no provider key in env (OPENAI/XAI/ANTHROPIC/CEREBRAS)");

let lastAuthError = "";
for (const provider of available) {
  const key = process.env[provider.keyEnv].trim();
  try {
    const text = await provider.run(key, false);
    const textPass = /tuesday/i.test(text.text);
    let visionLine = "vision: (not run)";
    let visionPass = true;
    try {
      const v = await provider.run(key, true);
      if (v) {
        visionPass = /board ?walk|walkway|path|bridge|dock|pier/i.test(v.text);
        visionLine = `vision: "${v.text.trim()}" → ${visionPass ? "PASS" : "FAIL"} (usage=${JSON.stringify(v.usage)})`;
      }
    } catch (ve) {
      if (ve instanceof AuthError) throw ve;
      visionLine = `vision: error ${String(ve).slice(0, 100)}`;
    }
    console.log(
      [
        `provider: ${provider.name} (REAL api)`,
        `text-doc-attachment: "${text.text.trim()}" → ${textPass ? "PASS" : "FAIL"} (usage=${JSON.stringify(text.usage)})`,
        visionLine,
      ].join("\n"),
    );
    process.exit(textPass && visionPass ? 0 : 1);
  } catch (e) {
    if (e instanceof AuthError) {
      lastAuthError = `${provider.name}: ${e.message}`;
      continue; // try the next provider
    }
    console.error(
      `provider ${provider.name} error: ${String(e).slice(0, 200)}`,
    );
    process.exit(1);
  }
}

skip(
  `all available provider keys failed auth (${lastAuthError}) — set a valid key to run`,
);
