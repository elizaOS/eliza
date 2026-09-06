#!/usr/bin/env bun
/** Produces the fixed five-by-six live-model trajectory matrix through production content targets. */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { verifyProgressiveContentCorpus } from "../corpus-tools/src/progressive-content.ts";
import {
  CONTENT_CONTEXT_FAMILIES,
  CONTENT_CONTEXT_LIVE_OBSERVER_SCHEMA_VERSION,
  CONTENT_CONTEXT_LIVE_TRAJECTORY_SCHEMA_VERSION,
  contentContextCanonicalEvidenceSha256,
} from "../corpus-tools/src/progressive-content-evidence.ts";
import {
  createProgressiveContentProductionFactories,
  createProgressiveContentProductionTarget,
} from "./lib/progressive-content-production-targets.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const PAGE_BYTES = 64 * 1024;
const MAX_TOOL_CALLS = 64;

function required(value, name) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} is required`);
  return value.trim();
}

export function parseLiveTrajectoryArgs(argv) {
  const options = {};
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.*)$/u.exec(argument);
    if (!match) throw new Error(`unknown argument: ${argument}`);
    options[match[1]] = match[2];
  }
  return options;
}

export function resolveLiveTrajectoryConfig(options, env = process.env) {
  const config = {
    corpusRoot: path.resolve(required(options["corpus-root"], "--corpus-root")),
    output: path.resolve(required(options.output, "--output")),
    commit: required(options.commit, "--commit"),
    apiKey: required(env.OPENAI_API_KEY, "OPENAI_API_KEY"),
    model: required(
      options.model ?? env.OPENAI_LIVE_TRAJECTORY_MODEL,
      "controller model",
    ),
    judgeModel: required(
      options["judge-model"] ?? env.OPENAI_LIVE_TRAJECTORY_JUDGE_MODEL,
      "judge model",
    ),
    inputUsdPerMillion: Number(
      options["input-usd-per-million"] ?? env.OPENAI_LIVE_INPUT_USD_PER_MILLION,
    ),
    outputUsdPerMillion: Number(
      options["output-usd-per-million"] ??
        env.OPENAI_LIVE_OUTPUT_USD_PER_MILLION,
    ),
  };
  if (!/^[0-9a-f]{40}$/u.test(config.commit))
    throw new Error("--commit must be an exact SHA");
  if (config.model === config.judgeModel) {
    throw new Error("controller and judge models must be distinct");
  }
  for (const [name, value] of [
    ["input USD rate", config.inputUsdPerMillion],
    ["output USD rate", config.outputUsdPerMillion],
  ]) {
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(`${name} must be a positive number`);
  }
  return config;
}

export function selectLiveTrajectoryObjects(manifest) {
  return CONTENT_CONTEXT_FAMILIES.map((family) => {
    const candidates = manifest.objects.filter((object) => {
      const end = object.canaries.find(({ label }) => label === "end");
      return (
        object.family === family &&
        object.format !== "binary" &&
        object.format !== "invalid-utf8" &&
        end &&
        end.byteStart >= PAGE_BYTES &&
        object.byteLength <= PAGE_BYTES * MAX_TOOL_CALLS
      );
    });
    candidates.sort((left, right) => left.byteLength - right.byteLength);
    if (!candidates[0])
      throw new Error(`${family} lacks a bounded multi-page live object`);
    return candidates[0];
  });
}

export function buildLiveControllerPrompt(family) {
  return [
    `Recover the complete end canary from the ${family} content object.`,
    "Call read_content first with offset 0, then follow only each returned nextOffset.",
    "Continue until the end canary is observed. Return only that exact canary and no other text.",
  ].join(" ");
}

async function openAiResponse(config, body) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      `OpenAI Responses API failed (${response.status}): ${JSON.stringify(payload)}`,
    );
  }
  if (payload.status !== "completed") {
    throw new Error(`OpenAI response did not complete: ${payload.status}`);
  }
  return payload;
}

function usageOf(response) {
  return {
    inputTokens: Number(response.usage?.input_tokens ?? 0),
    outputTokens: Number(response.usage?.output_tokens ?? 0),
  };
}

function responseText(response) {
  return response.output
    .filter(({ type }) => type === "message")
    .flatMap(({ content }) => content ?? [])
    .filter(({ type }) => type === "output_text")
    .map(({ text }) => text)
    .join("");
}

const READ_TOOL = {
  type: "function",
  name: "read_content",
  description:
    "Read the next bounded UTF-8 page. Offsets must follow the returned continuation.",
  strict: true,
  parameters: {
    type: "object",
    properties: { offset: { type: "integer", minimum: 0 } },
    required: ["offset"],
    additionalProperties: false,
  },
};

async function runController(config, target, object) {
  const prompt = buildLiveControllerPrompt(object.family);
  const expected = object.canaries.find(({ label }) => label === "end");
  if (!expected) throw new Error("selected object lacks an end canary");
  if (
    prompt.includes(expected.text) ||
    prompt.includes(String(expected.byteStart))
  ) {
    throw new Error(
      "controller prompt leaked expected answer or target offset",
    );
  }
  const modelCalls = [];
  const toolCalls = [];
  let expectedOffset = 0;
  let response = await openAiResponse(config, {
    model: config.model,
    instructions:
      "Use only the supplied content tool. Never guess an offset or fabricate content.",
    input: prompt,
    tools: [READ_TOOL],
    tool_choice: "required",
    parallel_tool_calls: false,
    store: true,
    truncation: "disabled",
  });
  let usage = usageOf(response);
  let foundExpected = false;
  for (;;) {
    modelCalls.push({
      id: response.id,
      model: response.model,
      status: response.status,
      usage: response.usage,
    });
    const calls = response.output.filter(
      ({ type }) => type === "function_call",
    );
    const finalAnswer = responseText(response).trim();
    if (calls.length === 0) {
      if (!finalAnswer) throw new Error("controller stopped without an answer");
      return {
        prompt,
        finalAnswer,
        modelCalls,
        toolCalls,
        usage,
        foundExpected,
      };
    }
    if (calls.length !== 1 || toolCalls.length >= MAX_TOOL_CALLS) {
      throw new Error("controller emitted parallel or excessive tool calls");
    }
    const call = calls[0];
    const args = JSON.parse(call.arguments);
    if (call.name !== "read_content" || args.offset !== expectedOffset) {
      throw new Error(
        `controller broke continuation chain at ${String(expectedOffset)}`,
      );
    }
    const page = await target.read({
      access: "authorized",
      offset: args.offset,
      limit: PAGE_BYTES,
      expectedRevision: target.object.revision,
    });
    if (page.bytes.byteLength === 0)
      throw new Error("production target returned a no-progress page");
    const text = Buffer.from(page.bytes).toString("utf8");
    foundExpected ||= text.includes(expected.text);
    expectedOffset = page.view.slice.nextOffset ?? page.view.slice.range.end;
    toolCalls.push({
      name: call.name,
      offset: args.offset,
      end: page.view.slice.range.end,
      nextOffset: page.view.slice.nextOffset ?? null,
      sliceSha256: page.view.slice.sliceSha256,
    });
    response = await openAiResponse(config, {
      model: config.model,
      previous_response_id: response.id,
      input: [
        {
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify({
            text,
            nextOffset: page.view.slice.nextOffset ?? null,
            hasMore: page.view.slice.hasMore,
          }),
        },
      ],
      tools: [READ_TOOL],
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: true,
      truncation: "disabled",
    });
    const nextUsage = usageOf(response);
    usage = {
      inputTokens: usage.inputTokens + nextUsage.inputTokens,
      outputTokens: usage.outputTokens + nextUsage.outputTokens,
    };
  }
}

async function runJudge(config, expected, controller) {
  const response = await openAiResponse(config, {
    model: config.judgeModel,
    instructions:
      "Independently grade exact equality. Return only the required JSON object.",
    input: JSON.stringify({
      expectedAnswer: expected,
      observedAnswer: controller.finalAnswer,
      chainedToolCalls: controller.toolCalls,
    }),
    truncation: "disabled",
    store: true,
    text: {
      format: {
        type: "json_schema",
        name: "trajectory_judgment",
        strict: true,
        schema: {
          type: "object",
          properties: {
            decision: { type: "string", enum: ["qualified", "rejected"] },
            exactAnswer: { type: "boolean" },
            continuationValid: { type: "boolean" },
          },
          required: ["decision", "exactAnswer", "continuationValid"],
          additionalProperties: false,
        },
      },
    },
  });
  return { response, judgment: JSON.parse(responseText(response)) };
}

async function runCoordinate(config, manifest, family, repetition) {
  const object = selectLiveTrajectoryObjects(manifest).find(
    (candidate) => candidate.family === family,
  );
  if (!object) throw new Error(`missing selected object for ${family}`);
  const workRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), `content-live-${family}-`),
  );
  const startedAt = performance.now();
  let target;
  try {
    const factories = await createProgressiveContentProductionFactories({
      workRoot,
    });
    target = await createProgressiveContentProductionTarget({
      corpusRoot: config.corpusRoot,
      object,
      factories,
    });
    const controller = await runController(config, target, object);
    const expected = object.canaries.find(({ label }) => label === "end")?.text;
    if (!expected) throw new Error("end canary disappeared");
    const judge = await runJudge(config, expected, controller);
    const exactAnswer = controller.finalAnswer === expected;
    const qualified =
      exactAnswer &&
      controller.foundExpected &&
      controller.toolCalls.length >= 2 &&
      judge.judgment.decision === "qualified" &&
      judge.judgment.exactAnswer === true &&
      judge.judgment.continuationValid === true;
    if (!qualified)
      throw new Error(`live coordinate was rejected: ${family}:${repetition}`);
    const trajectory = {
      schemaVersion: "elizaos.content-context.normalized-trajectory.v1",
      messages: [
        { role: "user", content: controller.prompt },
        { role: "assistant", content: controller.finalAnswer },
      ],
      toolCalls: controller.toolCalls,
      modelCalls: controller.modelCalls,
      finalAnswer: controller.finalAnswer,
    };
    const judgeUsage = usageOf(judge.response);
    const inputTokens = controller.usage.inputTokens + judgeUsage.inputTokens;
    const outputTokens =
      controller.usage.outputTokens + judgeUsage.outputTokens;
    const observerEvidence = {
      schemaVersion: CONTENT_CONTEXT_LIVE_OBSERVER_SCHEMA_VERSION,
      judgeProvider: "openai",
      judgeModel: config.judgeModel,
      judgeResponse: {
        id: judge.response.id,
        model: judge.response.model,
        ...judge.judgment,
      },
      expectedAnswerSha256: createHash("sha256").update(expected).digest("hex"),
      observedAnswerSha256: createHash("sha256")
        .update(controller.finalAnswer)
        .digest("hex"),
      continuationDiscovered: true,
      lateEvidenceRecovered: true,
      exactAnswer: true,
      answerLeakageDetected: false,
      canaryLeakageDetected: false,
      toolCalls: controller.toolCalls.length,
      noProgressReads: 0,
    };
    return {
      schemaVersion: CONTENT_CONTEXT_LIVE_TRAJECTORY_SCHEMA_VERSION,
      repetition,
      family,
      status: "passed",
      commit: config.commit,
      corpusManifestSha256: manifest.manifestSha256,
      providerQualified: true,
      provider: "openai",
      model: config.model,
      continuationDiscovered: true,
      lateEvidenceRecovered: true,
      exactAnswer: true,
      answerLeakageDetected: false,
      canaryLeakageDetected: false,
      toolCalls: controller.toolCalls.length,
      noProgressReads: 0,
      latencyMs: performance.now() - startedAt,
      inputTokens,
      outputTokens,
      costUsd:
        (inputTokens * config.inputUsdPerMillion +
          outputTokens * config.outputUsdPerMillion) /
        1_000_000,
      controllerDecision: "qualified",
      observerEvidence,
      observerEvidenceSha256:
        contentContextCanonicalEvidenceSha256(observerEvidence),
      trajectory,
      trajectorySha256: contentContextCanonicalEvidenceSha256(trajectory),
    };
  } finally {
    await target?.cleanup();
    await fs.rm(workRoot, { recursive: true, force: true });
  }
}

async function spawnCoordinate(options, family, repetition) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        SCRIPT,
        ...Object.entries(options).map(([key, value]) => `--${key}=${value}`),
        `--coordinate=${family}:${repetition}`,
      ],
      { env: process.env, stdio: ["ignore", "pipe", "inherit"] },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0)
        return reject(new Error(`live coordinate failed (${String(code)})`));
      const line = stdout
        .trim()
        .split("\n")
        .findLast((entry) => entry.startsWith("{"));
      if (!line) return reject(new Error("live coordinate omitted JSON"));
      resolve(JSON.parse(line));
    });
  });
}

async function main() {
  const options = parseLiveTrajectoryArgs(process.argv.slice(2));
  const config = resolveLiveTrajectoryConfig(options);
  const manifest = await verifyProgressiveContentCorpus(config.corpusRoot);
  if (options.coordinate) {
    const [family, repetitionText] = options.coordinate.split(":");
    const repetition = Number(repetitionText);
    if (
      !CONTENT_CONTEXT_FAMILIES.includes(family) ||
      !Number.isSafeInteger(repetition) ||
      repetition < 0 ||
      repetition >= 5
    )
      throw new Error("invalid internal coordinate");
    console.log(
      JSON.stringify(await runCoordinate(config, manifest, family, repetition)),
    );
    return;
  }
  const rows = [];
  for (let repetition = 0; repetition < 5; repetition += 1) {
    for (const family of CONTENT_CONTEXT_FAMILIES)
      rows.push(await spawnCoordinate(options, family, repetition));
  }
  if (rows.length !== 30)
    throw new Error("live trajectory matrix is incomplete");
  const pending = `${config.output}.pending-${randomUUID()}`;
  await fs.mkdir(path.dirname(config.output), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(
      pending,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await fs.rename(pending, config.output);
  } catch (error) {
    await fs.rm(pending, { force: true });
    throw error;
  }
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
