/**
 * Opt-in, finite public/synthetic Shared QA. Not a native, account or deployment test.
 * The existing App Live E2E manual workflow owns the only credential recipient.
 * Run --plan for source review; a real run requires its reviewed-SHA/job gates.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

const LIMITS = {
  cases: 9,
  modelRequests: 24,
  modelRequestsPerCase: 6,
  networkRequests: 60,
  caseMs: 60_000,
  totalMs: 360_000,
  artifactBytes: 50 * 1024 * 1024,
  modelBodyBytes: 1024 * 1024,
} as const;
const suite = process.argv.find((arg) => arg.startsWith("--suite="))?.split("=")[1] ?? "baseline";
if (!["baseline", "bare-weather", "typed-weather", "behavior", "full"].includes(suite))
  throw new Error("QA_SUITE_INVALID");
const weather =
  suite === "bare-weather" || suite === "typed-weather"
    ? "What's the current temperature in San Francisco? Please include a source."
    : "What is the current temperature in San Francisco, California? Please give the source.";
const cases =
  suite === "behavior"
    ? [
        {
          id: "reaction-thumbs-up",
          message: "Please react to this message with a thumbs-up and don't send a text reply.",
        },
        {
          id: "search-behavior",
          message: "Why did you search the web? I'm asking about your behavior.",
        },
      ]
    : [
        { id: "sf-weather", message: weather },
        { id: "math-after-search", message: "What is 17 plus 26? Reply briefly." },
        ...(suite === "bare-weather" || suite === "typed-weather"
          ? []
          : [
              {
                id: "public-fact",
                message:
                  "Search the web for the official Python 3.13 release date. Give the date and its source.",
              },
            ]),
        ...(suite === "full"
          ? [
              {
                id: "sf-bare-place",
                message:
                  "What's the current temperature in San Francisco? Please include a source.",
              },
              { id: "closing-thanks", message: "Thanks" },
              { id: "closing-ok", message: "OK" },
              { id: "closing-emoji", message: "❤️" },
              {
                id: "matching-deferred",
                message:
                  "My profile is saved. Does that mean you are watching for matches and will text me later?",
              },
            ]
          : []),
      ];
if (process.argv.includes("--plan")) {
  console.log(
    JSON.stringify(
      {
        state: "SOURCE_PLAN_ONLY_NOT_LIVE_PROOF",
        suite,
        cases,
        limits: LIMITS,
        provider: "normal Shared resolver; Cerebras credential only",
        nativeDelivery: false,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const root = path.resolve(
  process.env.SHARED_RUNTIME_LIVE_QA_DIR ??
    path.join(process.cwd(), "test-results/shared-runtime-live-qa", randomUUID()),
);
const raw = path.join(root, "private");
const publish = path.join(root, "publish");
const secret = process.env.CEREBRAS_API_KEY?.trim() ?? "";
const cleanText = (value: string) =>
  (secret ? value.split(secret).join("[REDACTED_SECRET]") : value).replace(
    /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*\b/gi,
    "Bearer [REDACTED_TOKEN]",
  );
const cleanJson = (value: unknown) =>
  JSON.stringify(
    value,
    (key, item) =>
      /^(?:authorization|api[_-]?key|token|password|secret|credential|cookie)$/i.test(key)
        ? "[REDACTED]"
        : typeof item === "string"
          ? cleanText(item)
          : item,
    2,
  );
const report: Record<string, unknown> = {
  state: "RUNNING",
  suite,
  limits: LIMITS,
  context: "PUBLIC_SYNTHETIC_ONLY; synthetic auth principal; not native/account/signup acceptance",
  productionChanged: false,
  nativeDelivery: false,
  credentialName: "CEREBRAS_API_KEY",
  cases: [],
};
const network: Array<Record<string, unknown>> = [];
const diagnostics: Array<Record<string, unknown>> = [];
const typedVerifications: Array<Record<string, unknown>> = [];
const sourceDiagnostics: Array<Record<string, unknown>> = [];
const exportRedactions: Record<string, number> = {};
const omitted = (kind: string) => {
  exportRedactions[kind] = (exportRedactions[kind] ?? 0) + 1;
};
function projectFinal(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectFinal).filter((item) => item !== undefined);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (
      (typeof record.type === "string" && /reasoning|analysis|thinking/i.test(record.type)) ||
      (typeof record.channel === "string" &&
        /^(?:analysis|reasoning|thought)$/i.test(record.channel)) ||
      (typeof record.role === "string" &&
        /^(?:analysis|reasoning|thought|thinking)$/i.test(record.role))
    ) {
      omitted("private_channel_part");
      return undefined;
    }
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      if (
        /^(?:(?:private|hidden))?(?:analysis|thoughts?|thinking|chainofthought|reasoning(?:content|text|details|summary)?)$/i.test(
          key.replace(/[_-]/g, ""),
        )
      ) {
        omitted("private_reasoning_field");
        continue;
      }
      if (key === "prompt" && ("modelType" in record || "response" in record)) {
        omitted("flattened_prompt_see_sdk_request");
        continue;
      }
      const projected = projectFinal(item);
      if (projected !== undefined) output[key] = projected;
    }
    return output;
  }
  if (typeof value !== "string") return value;
  const text = cleanText(value);
  if (/^\s*[[{]/.test(text)) {
    try {
      return JSON.stringify(projectFinal(JSON.parse(text)));
    } catch {
      /* Plain source text is not necessarily JSON. */
    }
  }
  if (/<\|channel\|>(?:analysis|reasoning|thought)/i.test(text)) {
    omitted("private_harmony_channel");
    return (
      text
        .match(/<\|channel\|>final(?:<\|message\|>)?([\s\S]*)/i)?.[1]
        ?.replace(/<\|(?:return|end|im_end)\|>/g, "") ?? "[PRIVATE_REASONING_OMITTED]"
    );
  }
  if (/<(?:think|analysis|reasoning)>/i.test(text)) {
    omitted("private_reasoning_tag");
    return text.replace(
      /<(think|analysis|reasoning)>[\s\S]*?(?:<\/\1>|$)/gi,
      "[PRIVATE_REASONING_OMITTED]",
    );
  }
  if (/(?:^|\n)\s*(?:analysis|reasoning|thought|thinking)\s*:/i.test(text)) {
    omitted("private_reasoning_transcript");
    return (
      text
        .split(/\r?\n/)
        .filter((line) =>
          /^\s*(?:replyText|shouldRespond|contexts|intents|candidateActionNames)\s*:/i.test(line),
        )
        .join("\n") || "[PRIVATE_REASONING_OMITTED]"
    );
  }
  return text;
}
function projectSdkBody(text: string): unknown {
  try {
    return {
      format: "json-final-fields",
      data: projectFinal(JSON.parse(text)),
    };
  } catch {
    /* Try actual streaming protocol below. */
  }
  const frames = text.includes("data:")
    ? text
        .split(/\r?\n\r?\n/)
        .map((frame) =>
          frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n"),
        )
        .filter((line) => line && line !== "[DONE]")
    : text.split(/\r?\n/).filter((line) => line.trim());
  const choices = new Map<
    number,
    {
      content: string;
      tools: Map<number, { id?: string; name: string; arguments: string }>;
      finishReason?: unknown;
    }
  >();
  let model: unknown;
  let usage: unknown;
  for (const frame of frames) {
    const event = JSON.parse(frame) as Record<string, unknown>;
    if (!Array.isArray(event.choices)) fail("QA_SDK_STREAM_FORMAT_UNSUPPORTED_NOT_EXPORTED");
    model = event.model ?? model;
    usage = event.usage ?? usage;
    for (const rawChoice of event.choices) {
      const choice = rawChoice as Record<string, unknown>;
      const index = typeof choice.index === "number" ? choice.index : 0;
      let landed = choices.get(index);
      if (!landed) landed = { content: "", tools: new Map() };
      const delta = (choice.delta ?? choice.message) as Record<string, unknown> | undefined;
      if (delta) {
        if (typeof delta.content === "string") landed.content += delta.content;
        // Never collect reasoning_content or analysis channels. Tool arguments are assembled first, then redacted as complete JSON.
        if (Array.isArray(delta.tool_calls))
          for (const rawTool of delta.tool_calls) {
            const tool = rawTool as Record<string, unknown>;
            const fn = tool.function as Record<string, unknown> | undefined;
            const toolIndex = typeof tool.index === "number" ? tool.index : 0;
            let joined = landed.tools.get(toolIndex);
            if (!joined) joined = { name: "", arguments: "" };
            if (typeof tool.id === "string") joined.id = tool.id;
            if (typeof fn?.name === "string") joined.name += fn.name;
            if (typeof fn?.arguments === "string") joined.arguments += fn.arguments;
            landed.tools.set(toolIndex, joined);
          }
      }
      landed.finishReason = choice.finish_reason ?? landed.finishReason;
      choices.set(index, landed);
    }
  }
  if (!choices.size) fail("QA_SDK_STREAM_FINAL_FIELDS_MISSING_NOT_EXPORTED");
  return {
    format: "stream-final-fields-projection",
    model,
    usage: projectFinal(usage),
    choices: [...choices].map(([index, choice]) => ({
      index,
      content: projectFinal(choice.content),
      finishReason: choice.finishReason,
      toolCalls: [...choice.tools.values()].map((tool) => ({
        id: tool.id,
        name: tool.name,
        arguments: projectFinal(JSON.parse(tool.arguments)),
      })),
    })),
  };
}

if (process.argv.includes("--check-export")) {
  const hidden = "PRIVATE_REASONING_SENTINEL_NOT_REAL_MODEL_DATA";
  const json = JSON.stringify(
    projectSdkBody(
      JSON.stringify({
        choices: [
          {
            message: {
              reasoning_content: hidden,
              content: null,
              tool_calls: [
                {
                  function: {
                    name: "HANDLE_RESPONSE",
                    arguments: JSON.stringify({
                      thought: hidden,
                      shouldRespond: "RESPOND",
                      replyText: "43",
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { reasoning_tokens: 12 },
      }),
    ),
  );
  const streamed = `${[
    { choices: [{ index: 0, delta: { reasoning_content: hidden } }] },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-public",
                function: {
                  name: "HANDLE_RESPONSE",
                  arguments: `{"thought":"${hidden}`,
                },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '","replyText":"43"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")}data: [DONE]\n\n`;
  const sse = JSON.stringify(projectSdkBody(streamed));
  const core = JSON.stringify(
    projectFinal({
      stages: [
        {
          model: {
            modelType: "TEXT_SMALL",
            prompt: hidden,
            messages: [
              { role: "analysis", content: hidden },
              { role: "user", content: "public" },
            ],
            responseContent: [
              { type: "reasoning", text: hidden },
              { type: "text", text: "43" },
            ],
            response: JSON.stringify({ thought: hidden, replyText: "43" }),
          },
        },
        { evaluation: { thought: hidden } },
      ],
    }),
  );
  const harmony = String(
    projectFinal(`<|channel|>analysis<|message|>${hidden}<|channel|>final<|message|>43<|return|>`),
  );
  if (
    [json, sse, core, harmony].some((text) => text.includes(hidden)) ||
    !json.includes("replyText") ||
    !sse.includes("43") ||
    harmony !== "43"
  )
    fail("QA_EXPORT_SCOPE_CONTROL_FAILED");
  let closed = false;
  try {
    projectSdkBody(
      'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"incomplete"}}]}}]}\n\n',
    );
  } catch {
    closed = true;
  }
  if (!closed) fail("QA_UNPARSEABLE_STREAM_NOT_CLOSED");
  if (secret && cleanText(secret).includes(secret)) fail("QA_SECRET_REDACTION_CONTROL_FAILED");
  console.log("SOURCE_EXPORT_CONTROLS_PASSED_NOT_LIVE_QA");
  process.exit(0);
}

const captures: Array<Record<string, unknown>> = [];
const pendingCaptures: Promise<void>[] = [];

async function boundedBody(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > LIMITS.modelBodyBytes) {
        void reader.cancel().catch(() => {});
        fail("QA_MODEL_BODY_LIMIT_EXCEEDED_NOT_TRUNCATED");
      }
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } finally {
    reader.releaseLock();
  }
}
function captureBody(
  name: string,
  kind: "request" | "response",
  body: string | ReadableStream<Uint8Array> | null,
  caseId = activeCase,
) {
  const record: Record<string, unknown> = {
    name,
    kind,
    complete: false,
    case: caseId,
  };
  captures.push(record);
  const task = (async () => {
    const started = Date.now();
    try {
      const text = typeof body === "string" ? body : await boundedBody(body);
      record.readMs = Date.now() - started;
      if (Buffer.byteLength(text) > LIMITS.modelBodyBytes)
        fail("QA_MODEL_BODY_LIMIT_EXCEEDED_NOT_TRUNCATED");
      record.originalBodySHA256 = hash(text);
      const clean = cleanText(text);
      const writing = Date.now();
      await mkdir(path.join(raw, "sdk-private"), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(path.join(raw, "sdk-private", `${name}.${kind}.body.txt`), clean, {
        mode: 0o600,
      });
      const projection = cleanJson(projectSdkBody(clean));
      await mkdir(path.join(raw, "sdk-final"), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(path.join(raw, "sdk-final", `${name}.${kind}.json`), projection, {
        mode: 0o600,
      });
      record.writeMs = Date.now() - writing;
      record.bytes = Buffer.byteLength(clean);
      record.exportSHA256 = hash(projection);
      record.complete = true;
    } catch (error) {
      record.error = error instanceof Error ? cleanText(error.message) : "capture unavailable";
    }
  })();
  pendingCaptures.push(task);
}

let ownsOutput = false;
let activeCase = "bootstrap";
let modelRequests = 0;
let caseModelRequests = 0;
let callsBeforeMath = false;
let deadline = Date.now() + LIMITS.totalMs;
const originalFetch = globalThis.fetch;
const originalInfo = console.info;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function save(name: string, value: unknown) {
  await writeFile(path.join(raw, name), `${cleanJson(value)}\n`, {
    mode: 0o600,
  });
}
function fail(code: string): never {
  throw new Error(code);
}
function forbiddenHost(host: string) {
  return (
    isIP(host.replace(/^\[|\]$/g, "")) !== 0 ||
    host === "localhost" ||
    [
      ".localhost",
      ".internal",
      ".local",
      "blooio.com",
      "eliza.app",
      "elizacloud.ai",
      "slop.date",
      "friends.help",
      "ntwrk.party",
      "peon.biz",
    ].some(
      (suffix) => host === suffix || host.endsWith(suffix.startsWith(".") ? suffix : `.${suffix}`),
    )
  );
}
async function publishSanitizedArtifacts() {
  const files: Array<{ relative: string; data: string }> = [];
  let bytes = 0;
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) fail("QA_UNEXPECTED_ARTIFACT_SYMLINK");
      if (entry.isDirectory()) {
        if (entry.name !== "sdk-private") await walk(file);
      } else if (entry.name.endsWith(".json")) {
        const input = await readFile(file, "utf8");
        const text = cleanJson(projectFinal(JSON.parse(input)));
        bytes += Buffer.byteLength(text);
        if (bytes > LIMITS.artifactBytes) fail("QA_ARTIFACT_LIMIT_EXCEEDED_NOT_TRUNCATED");
        files.push({ relative: path.relative(raw, file), data: text });
      }
    }
  }
  await walk(raw);
  await mkdir(publish, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const target = path.join(publish, file.relative);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.data, { mode: 0o600 });
  }
  await writeFile(
    path.join(publish, "SANITIZED.json"),
    `${JSON.stringify({
      publicSyntheticOnly: true,
      secretValuesRedacted: true,
      files: files.length,
      bytes,
      complete: true,
    })}\n`,
  );
}

async function run() {
  if (
    process.platform !== "linux" ||
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.SHARED_RUNTIME_LIVE_QA_APPROVED !== "1"
  )
    fail("QA_HOSTED_MANUAL_JOB_REQUIRED");
  await mkdir(root, { recursive: false, mode: 0o700 });
  ownsOutput = true;
  await mkdir(raw, { mode: 0o700 });
  if (
    cases.length +
      (suite !== "bare-weather" && suite !== "typed-weather" && suite !== "behavior" ? 1 : 0) >
    LIMITS.cases
  )
    fail("QA_CASE_LIMIT");
  if (!secret) fail("QA_CEREBRAS_KEY_MISSING");
  const unexpected = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GROQ_API_KEY",
    "OPENROUTER_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "XAI_API_KEY",
    "BLOOIO_API_KEY",
    "ELIZA_APP_BLOOIO_API_KEY",
    "ELIZAOS_CLOUD_API_KEY",
    "DATABASE_URL",
    "REDIS_URL",
    "GATEWAY_INTERNAL_SECRET",
  ].filter((name) => process.env[name]?.trim());
  if (unexpected.length) fail(`QA_UNEXPECTED_CREDENTIALS:${unexpected.join(",")}`);
  if (process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING === "1")
    fail("QA_TRAJECTORIES_DISABLED_BY_OPERATOR");
  const source = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
  }).trim();
  if (
    !/^[0-9a-f]{40}$/.test(source) ||
    source !== process.env.SHARED_RUNTIME_LIVE_QA_REVIEWED_SHA ||
    source !== process.env.GITHUB_SHA
  )
    fail("QA_REVIEWED_SOURCE_MISMATCH");
  report.source = source;
  const hostNode = execFileSync("node", ["--version"], {
    encoding: "utf8",
  }).trim();
  const bunVersion = process.versions["bun"];
  report.versions = {
    bun: bunVersion,
    hostNode,
    bunNodeCompatibility: process.version,
    source,
  };
  if (bunVersion !== "1.4.2" || hostNode !== "v24.15.0") fail("QA_TOOLCHAIN_VERSION_MISMATCH");
  process.env.ELIZA_STATE_DIR = path.join(raw, "state");
  process.env.ELIZA_TRAJECTORY_DIR = path.join(raw, "trajectories");
  process.env.ELIZA_TRAJECTORY_LOGGING = "1";
  process.env.ELIZA_TRAJECTORY_REVIEW_MODE = "1";
  deadline = Date.now() + LIMITS.totalMs;
  globalThis.fetch = new Proxy(originalFetch, {
    apply: async (target, receiver, args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.protocol !== "https:" || url.username || url.password || forbiddenHost(url.hostname))
        fail("QA_NETWORK_SCOPE_REFUSED");
      if (Date.now() >= deadline || network.length >= LIMITS.networkRequests)
        fail("QA_NETWORK_OR_TIME_LIMIT");
      const model =
        url.hostname === "api.cerebras.ai" && url.pathname.endsWith("/chat/completions");
      if (
        model &&
        (modelRequests >= LIMITS.modelRequests || caseModelRequests >= LIMITS.modelRequestsPerCase)
      )
        fail("QA_MODEL_REQUEST_LIMIT");
      if (model) {
        modelRequests++;
        caseModelRequests++;
      }
      const entry: Record<string, unknown> = {
        case: activeCase,
        kind: model ? "model" : "public-read",
        host: url.hostname,
        path: url.pathname,
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        startedAt: new Date().toISOString(),
      };
      if (model && typeof init?.body === "string") {
        try {
          const body: unknown = JSON.parse(init.body);
          if (
            body &&
            typeof body === "object" &&
            typeof (body as Record<string, unknown>).model === "string"
          )
            entry.requestedModel = (body as Record<string, unknown>).model;
        } catch {
          entry.requestedModelUnavailable = true;
        }
      }
      const captureName = `model-${String(modelRequests).padStart(2, "0")}-${activeCase}`;
      if (model) {
        const setup = Date.now();
        try {
          if (typeof init?.body === "string") captureBody(captureName, "request", init.body);
          else if (init?.body === undefined && input instanceof Request)
            captureBody(captureName, "request", input.clone().body);
          else
            captures.push({
              name: captureName,
              kind: "request",
              case: activeCase,
              complete: false,
              error: "QA_SDK_REQUEST_BODY_UNAVAILABLE",
            });
        } catch {
          captures.push({
            name: captureName,
            kind: "request",
            case: activeCase,
            complete: false,
            error: "QA_SDK_REQUEST_CLONE_UNAVAILABLE",
          });
        }
        entry.captureSetupMs = Date.now() - setup;
      }
      network.push(entry);
      const start = Date.now();
      try {
        const response = await Reflect.apply(target, receiver, args);
        entry.status = response.status;
        entry.providerHeadersMs = Date.now() - start;
        if (model) {
          const setup = Date.now();
          try {
            captureBody(captureName, "response", response.clone().body, String(entry.case));
          } catch {
            captures.push({
              name: captureName,
              kind: "response",
              case: activeCase,
              complete: false,
              error: "QA_SDK_RESPONSE_CLONE_UNAVAILABLE",
            });
          }
          entry.captureSetupMs = Number(entry.captureSetupMs ?? 0) + Date.now() - setup;
        }
        return response;
      } catch (error) {
        entry.error = error instanceof Error ? cleanText(error.message) : "network failure";
        throw error;
      } finally {
        entry.elapsedMs = Date.now() - start;
      }
    },
  });
  // Observe the existing, closed binding audit without replacing any model/tool implementation.
  console.info = (...args: unknown[]) => {
    if (
      args[0] === "[shared-realtime] claim binding refused" &&
      args[1] &&
      typeof args[1] === "object"
    )
      diagnostics.push({
        case: activeCase,
        ...(args[1] as Record<string, unknown>),
      });
    if (
      args[0] === "[shared-realtime] source receipt refused" &&
      args[1] &&
      typeof args[1] === "object"
    )
      sourceDiagnostics.push({ case: activeCase, ...(args[1] as Record<string, unknown>) });
    if (
      args[0] === "[shared-typed-read] egress verification" &&
      args[1] &&
      typeof args[1] === "object"
    ) {
      const audit = args[1] as Record<string, unknown>;
      typedVerifications.push({
        case: activeCase,
        traceId: audit.traceId,
        verified: audit.verified === true,
        requirementCount: audit.requirementCount,
      });
    }
    originalInfo.apply(console, args);
  };
  const { ChannelType } = await import("@elizaos/core");
  const { runSharedAgentTurn, resolveSharedAgentTurnModel } = await import(
    "../lib/services/shared-runtime/run-shared-agent-turn"
  );
  const { isVerifiedCurrentNwsObservation } = await import(
    "../lib/services/shared-runtime/shared-current-weather"
  );
  report.resolvedModel = resolveSharedAgentTurnModel();
  if (!report.resolvedModel) fail("QA_NORMAL_MODEL_RESOLVER_UNAVAILABLE");
  type Input = Parameters<typeof runSharedAgentTurn>[0];
  let history: Input["history"] = [];
  const results: Array<Record<string, unknown>> = [];
  report.cases = results;
  for (const item of cases) {
    activeCase = item.id;
    caseModelRequests = 0;
    if (Date.now() >= deadline) {
      results.push({ id: item.id, status: "failed", error: "QA_TIME_LIMIT" });
      break;
    }
    const start = Date.now();
    const networkStart = network.length;
    const diagnosticStart = diagnostics.length;
    const timings: unknown[] = [];
    const observation: Record<string, unknown> = {
      id: item.id,
      input: item.message,
      status: "running",
      principal: "synthetic, not account authentication",
    };
    results.push(observation);
    try {
      const turn = await runSharedAgentTurn({
        character: {
          name: "Eliza",
          system: "You are Eliza, a helpful conversational assistant. Be brief and clear.",
        },
        history,
        message: item.message,
        capabilityText: item.message,
        messageIds: {
          user: `shared-live-qa:${item.id}:user`,
          assistant: `shared-live-qa:${item.id}:assistant`,
        },
        traceId: hash(`${source}:${item.id}`).slice(0, 32),
        execution: {
          agentKey: "shared-live-qa:synthetic-agent",
          roomKey: "shared-live-qa:synthetic-room",
          channel: { type: ChannelType.DM, source: "blooio" },
          authenticatedPersonalSharedUser: true,
          ...(suite === "typed-weather" && item.id === "sf-weather"
            ? { typedPublicReadReplies: true as const }
            : {}),
        },
        abortSignal: AbortSignal.timeout(Math.min(LIMITS.caseMs, deadline - Date.now())),
        onRuntimeTiming: (value) => {
          timings.push(value);
        },
      });
      history = turn.history;
      const emitted = turn as typeof turn & {
        acknowledgementReaction?: unknown;
      };
      observation.output = turn.reply;
      observation.responded = turn.responded;
      observation.acknowledgementCandidate = emitted.acknowledgementReaction ?? null;
      observation.usage = turn.usage ?? null;
      observation.model = turn.model;
      observation.providerReceipts = turn.actionResults ?? [];
      observation.internalGrounding = turn.internalGrounding ?? null;
      observation.bindingDiagnostics = diagnostics.slice(diagnosticStart);
      const ownReads = network.slice(networkStart).filter((r) => r.kind === "public-read");
      const publicTools = (turn.actionResults ?? []).filter((r) =>
        ["WEB_SEARCH", "WEB_FETCH"].includes(String(r.data?.actionName)),
      );
      if (item.id === "sf-weather" || item.id === "sf-bare-place") {
        callsBeforeMath ||= publicTools.length > 0 || ownReads.length > 0;
        const grounding = turn.internalGrounding;
        const verifiedObservation =
          grounding?.kind === "web_search" &&
          grounding.provider === "nws" &&
          isVerifiedCurrentNwsObservation(grounding.weatherObservation, grounding.query);
        observation.verifiedCurrentObservation = verifiedObservation;
        if (suite === "typed-weather") {
          // The caller independently verified the original opaque proof before
          // removing it. Observe only its content-free audit, never serialize it.
          const expectedTrace = hash(`${source}:${item.id}`).slice(0, 32);
          const verifiedAudit = typedVerifications.filter(
            (entry) =>
              entry.case === item.id &&
              entry.traceId === expectedTrace &&
              entry.verified === true &&
              entry.requirementCount === 1,
          );
          const freshProducer = publicTools.find((result) => {
            const data = result.data;
            return (
              result.success === true &&
              data?.provider === "nws" &&
              typeof data.query === "string" &&
              typeof data.observedAt === "number" &&
              data.observedAt >= start &&
              data.observedAt <= Date.now() &&
              isVerifiedCurrentNwsObservation(data.weatherObservation, data.query, Date.now())
            );
          });
          const qualifiedPlace =
            /San Francisco,\s*(?:CA|California)(?:,?\s*(?:United States|US|USA))?:/i.test(
              turn.reply,
            );
          const awkwardPlaceDisclaimer = /couldn[’' ]t verify.*place you meant/i.test(turn.reply);
          observation.syntheticTrustedTypedQa = true;
          observation.opaqueVerificationAudit = verifiedAudit;
          observation.freshProducerObservation = Boolean(freshProducer);
          observation.honestQualifiedPlace = qualifiedPlace;
          observation.status =
            freshProducer &&
            verifiedAudit.length === 1 &&
            qualifiedPlace &&
            !awkwardPlaceDisclaimer &&
            turn.responded === true &&
            turn.reply.trim() &&
            diagnostics.length === diagnosticStart &&
            /\d/.test(turn.reply) &&
            /https?:\/\//.test(turn.reply) &&
            /temperature|°|degrees?|celsius/i.test(turn.reply)
              ? "passed-controls-review-required"
              : "failed";
        } else
          observation.status =
            verifiedObservation &&
            turn.reply.trim() &&
            publicTools.some((r) => r.success) &&
            diagnostics.length === diagnosticStart &&
            /\d/.test(turn.reply) &&
            /https?:\/\//.test(turn.reply) &&
            /temperature|°|degrees?|celsius|fahrenheit/i.test(turn.reply)
              ? "passed-controls-review-required"
              : "failed";
      } else if (item.id === "math-after-search") {
        observation.afterSearchHistory = callsBeforeMath;
        observation.status =
          callsBeforeMath &&
          /\b43\b/.test(turn.reply) &&
          publicTools.length === 0 &&
          ownReads.length === 0
            ? "passed"
            : "failed";
      } else if (item.id === "public-fact") {
        observation.status =
          publicTools.some((r) => r.success) &&
          diagnostics.length === diagnosticStart &&
          /2024/.test(turn.reply) &&
          /python\.org/.test(turn.reply)
            ? "passed-controls-review-required"
            : "failed";
      } else if (item.id === "reaction-thumbs-up") {
        const { parseImessageReaction } = await import("@elizaos/contracts/imessage-reaction");
        const candidate = parseImessageReaction(emitted.acknowledgementReaction);
        observation.candidateNotDelivered = true;
        observation.validatedAcknowledgementCandidate = candidate ?? null;
        observation.status =
          turn.responded === false &&
          !turn.reply.trim() &&
          (candidate === "like" || candidate === "👍") &&
          publicTools.length === 0 &&
          ownReads.length === 0
            ? "passed-controls-review-required"
            : "failed";
      } else if (item.id === "search-behavior") {
        observation.candidateNotDelivered = true;
        observation.possibleUnsupportedPromise =
          /\b(?:i['’]ll|i will|we will)\b[^.!?]{0,100}\b(?:watch|monitor|reach out|text|ping|match)\b/i.test(
            turn.reply,
          );
        observation.status =
          turn.responded === true &&
          /[A-Za-z]{3}/.test(turn.reply) &&
          turn.reply.length <= 1200 &&
          !/<(?:tool_call|analysis|think)>/i.test(turn.reply) &&
          !observation.possibleUnsupportedPromise &&
          publicTools.length === 0 &&
          ownReads.length === 0
            ? "passed-controls-review-required"
            : "failed";
      } else if (item.id.startsWith("closing-")) {
        observation.status =
          turn.responded === false &&
          !turn.reply.trim() &&
          publicTools.length === 0 &&
          ownReads.length === 0
            ? "passed"
            : "failed";
        observation.candidateNotDelivered = true;
      } else {
        observation.possibleUnsupportedPromise =
          /\b(?:i['’]ll|i will|we will)\b[^.!?]{0,100}\b(?:watch|monitor|reach out|text|ping|match)\b/i.test(
            turn.reply,
          );
        observation.status =
          observation.possibleUnsupportedPromise || publicTools.length || ownReads.length
            ? "failed"
            : "passed-controls-review-required";
      }
      if (turn.degraded || (caseModelRequests === 0 && !item.id.startsWith("closing-"))) {
        observation.status = "failed";
        observation.error = "QA_NO_REAL_MODEL_TURN";
      }
    } catch (error) {
      observation.status = "failed";
      observation.error =
        error instanceof Error ? cleanText(error.stack ?? error.message) : "unknown failure";
    }
    observation.elapsedMs = Date.now() - start;
    observation.modelRequests = caseModelRequests;
    observation.runtimeTimings = timings;
    await save(`${item.id}.json`, observation);
  }
  // A separate real public transport probe. It is NOT a model WEB_FETCH/Shared-path claim.
  if (
    suite !== "bare-weather" &&
    suite !== "typed-weather" &&
    suite !== "behavior" &&
    Date.now() < deadline
  ) {
    activeCase = "public-fetch-transport";
    const { fetchKeylessWeb } = await import("@elizaos/plugin-web-search/edge");
    try {
      const fetched = await fetchKeylessWeb(
        ["https://www.python.org/downloads/release/python-3130/"],
        { signal: AbortSignal.timeout(15_000) },
      );
      report.publicFetchTransport = {
        scope: "standalone actual public transport, not Shared tool coverage",
        result: fetched ?? null,
        success: Boolean(fetched?.text.trim() && fetched.truncated === false),
      };
    } catch (error) {
      report.publicFetchTransport = {
        failed: true,
        error: error instanceof Error ? cleanText(error.message) : "unknown",
      };
    }
  }
  await Promise.all(pendingCaptures);
  report.sdkBodyCaptures = captures;
  // Canonical Core stores trajectories under an agent UUID, not only at the root.
  // Inspect only this run's owned directory and its direct agent subdirectories.
  const trajectoryRoot = process.env.ELIZA_TRAJECTORY_DIR;
  const entries = await readdir(trajectoryRoot, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".json")) files.push(entry.name);
    else if (entry.isDirectory() && /^[0-9a-f-]{36}$/.test(entry.name)) {
      const children = await readdir(path.join(trajectoryRoot, entry.name), {
        withFileTypes: true,
      });
      for (const child of children)
        if (child.isFile() && child.name.endsWith(".json"))
          files.push(path.join(entry.name, child.name));
    }
  }
  const trajectories: unknown[] = [];
  for (const file of files)
    trajectories.push(JSON.parse(await readFile(path.join(trajectoryRoot, file), "utf8")));
  const stages = trajectories.flatMap((t) =>
    t && typeof t === "object" && Array.isArray((t as Record<string, unknown>).stages)
      ? (t as { stages: unknown[] }).stages
      : [],
  );
  const modelStages = stages.filter(
    (s) => s && typeof s === "object" && (s as Record<string, unknown>).model,
  );
  report.trajectoryFiles = files;
  report.recordedModelStages = modelStages.length;
  report.modelObservations = modelStages.map((stage) => {
    const model = (stage as { model: Record<string, unknown> }).model;
    return {
      provider: model.provider ?? null,
      model: model.modelName ?? null,
      modelType: model.modelType ?? null,
      usage: model.usage ?? null,
      finishReason: model.finishReason ?? null,
    };
  });
  report.modelRequests = modelRequests;
  report.network = network;
  report.bindingDiagnostics = diagnostics;
  report.sourceReceiptDiagnostics = sourceDiagnostics;
  report.manualPublicOutputReviewRequired = true;
  report.exportScope =
    "Public synthetic requests, final responses, tool calls/parsed decisions and source evidence only. Private reasoning/analysis/thought fields, flattened Core prompts, raw SDK bodies and Markdown logs are not published. Complete original SDK bodies are hashed and retained only in the ephemeral private runner directory.";
  report.exportRedactions = exportRedactions;
  report.captureObservations = {
    setupMs: network.reduce((sum, request) => sum + Number(request.captureSetupMs ?? 0), 0),
    readMs: captures.reduce((sum, capture) => sum + Number(capture.readMs ?? 0), 0),
    writeAndProjectionMs: captures.reduce((sum, capture) => sum + Number(capture.writeMs ?? 0), 0),
    note: "Clone reads and disk writes overlap model execution; these are observed work times, not additive latency or a performance benchmark.",
  };
  report.state =
    results.length === cases.length &&
    !results.some((r) => r.status === "failed") &&
    modelRequests > 0 &&
    modelStages.length > 0 &&
    captures.length >= modelRequests * 2 &&
    captures.every((capture) => capture.complete === true) &&
    (suite === "bare-weather" ||
      suite === "typed-weather" ||
      suite === "behavior" ||
      (report.publicFetchTransport as { success?: boolean } | undefined)?.success === true)
      ? "LIVE_CONTROLS_PASSED_PUBLIC_TRANSCRIPTS_REQUIRE_REVIEW"
      : "FAILED_NOT_ACCEPTANCE";
}

let status = 1;
const watchdog = setTimeout(() => {
  process.stderr.write("QA_HARD_TIME_LIMIT_NO_UNSANITIZED_UPLOAD\n");
  process.exit(124);
}, LIMITS.totalMs + 10_000);
try {
  await run();
  status = report.state === "LIVE_CONTROLS_PASSED_PUBLIC_TRANSCRIPTS_REQUIRE_REVIEW" ? 0 : 1;
} catch (error) {
  report.state = "FAILED_NOT_ACCEPTANCE";
  report.error =
    error instanceof Error
      ? modelRequests === 0
        ? cleanText(error.stack ?? error.message)
        : `${error.name}: inspect final-field captures and binding diagnostics`
      : "unknown failure";
} finally {
  globalThis.fetch = originalFetch;
  console.info = originalInfo;
  try {
    if (!ownsOutput) fail("QA_OUTPUT_NOT_OWNED");
    await Promise.all(pendingCaptures);
    report.sdkBodyCaptures = captures;
    if (captures.some((capture) => capture.complete !== true)) {
      report.state = "FAILED_INCOMPLETE_CAPTURE";
      status = 1;
    }
    await save("summary.json", report);
    await publishSanitizedArtifacts();
    if (process.env.GITHUB_OUTPUT)
      await writeFile(
        process.env.GITHUB_OUTPUT,
        `artifact_ready=true\nartifact_path=${publish}\n`,
        { flag: "a" },
      );
  } catch {
    process.stderr.write("QA_ARTIFACT_SANITIZATION_FAILED\n");
    status = 1;
  }
  clearTimeout(watchdog);
}
console.log(
  `shared-runtime-live-qa status=${status === 0 ? "controls-passed-review-required" : "failed"} model_requests=${modelRequests}`,
);
process.exitCode = status;
