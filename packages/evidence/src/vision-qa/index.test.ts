/**
 * Public-surface tests for the vision-qa barrel (`src/vision-qa/index.ts`) —
 * the module consumers import. Every case drives the real implementation
 * through that entry so a broken re-export, rename, or wiring change fails
 * here even when submodule suites stay green. The only injected seam is the
 * process runner the CLI backend itself defines for protocol tests; no mock's
 * return value is ever asserted as its own expectation.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvidenceError } from "../errors.ts";
import {
  ANTHROPIC_BASE_URL,
  ANTHROPIC_VERSION,
  AnthropicBackend,
  buildQaRecord,
  CACHE_DIR_NAME,
  CliVisionBackend,
  cacheFilePath,
  OpenAiCompatibleBackend,
  type PreparedImage,
  parseAnswers,
  parseClaudeEnvelope,
  parseCodexUsage,
  queryHash,
  readCache,
  renderQuestionPrompt,
  SYSTEM_RUBRIC,
  scaleToMaxEdge,
  suggestQuestions,
  writeCache,
} from "./index.ts";
import type { AskResult, VisionQuestion } from "./types.ts";

const QUESTIONS: VisionQuestion[] = [
  { id: "q1", question: "What does the primary button say?" },
  { id: "q2", question: "Is the accent orange?", expected: "yes" },
];

const IMAGE: PreparedImage = {
  base64: "aGVsbG8=",
  mediaType: "image/png",
  dimensions: {
    originalWidth: 100,
    originalHeight: 50,
    sentWidth: 100,
    sentHeight: 50,
  },
  sourceSha256: "a".repeat(64),
};

const RESULT: AskResult = {
  answers: [
    { id: "q1", answer: "Send", confidence: 1, details: "label" },
    { id: "q2", answer: "yes", confidence: 0.9, details: "accent" },
  ],
  provenance: {
    backend: "anthropic",
    model: "claude-opus-4-8",
    usage: { inputTokens: 1000, outputTokens: 20 },
    latencyMs: 500,
    retries: 0,
    timestamp: "2026-01-01T00:00:00.000Z",
    cached: false,
    dimensions: {
      originalWidth: 100,
      originalHeight: 50,
      sentWidth: 100,
      sentHeight: 50,
    },
  },
};

function errorCodeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof EvidenceError) return error.code;
    throw error;
  }
  throw new Error("expected the call to throw an EvidenceError");
}

async function errorCodeOfAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof EvidenceError) return error.code;
    throw error;
  }
  throw new Error("expected the call to reject with an EvidenceError");
}

describe("renderQuestionPrompt via the barrel", () => {
  it("renders one id-labeled bullet per question in input order", () => {
    const lines = renderQuestionPrompt(QUESTIONS).split("\n");
    expect(lines[0]).toContain("Answer each of these questions");
    expect(lines[1]).toBe('- id "q1": What does the primary button say?');
    expect(lines[2]).toBe('- id "q2": Is the accent orange?');
  });
});

describe("parseAnswers via the barrel", () => {
  it("returns validated answers covering exactly the asked ids", () => {
    const raw = JSON.stringify({
      answers: [
        { id: "q1", answer: "Send", confidence: 0.95, details: "label" },
        { id: "q2", answer: "yes", confidence: 0.8, details: "accent" },
      ],
    });
    const answers = parseAnswers(raw, QUESTIONS);
    expect(answers).toHaveLength(2);
    expect(answers[0]).toEqual({
      id: "q1",
      answer: "Send",
      confidence: 0.95,
      details: "label",
    });
  });

  it("rejects a reply missing one of the asked ids", () => {
    const raw = JSON.stringify({
      answers: [{ id: "q1", answer: "Send", confidence: 1, details: "d" }],
    });
    expect(errorCodeOf(() => parseAnswers(raw, QUESTIONS))).toBe(
      "VISION_RESPONSE_INVALID",
    );
  });

  it("rejects output that is not JSON", () => {
    expect(errorCodeOf(() => parseAnswers("not json", QUESTIONS))).toBe(
      "VISION_RESPONSE_INVALID",
    );
  });

  it("rejects unknown fields on an answer (strict shape)", () => {
    const raw = JSON.stringify({
      answers: [
        {
          id: "q1",
          answer: "Send",
          confidence: 1,
          details: "d",
          extra: true,
        },
      ],
    });
    expect(errorCodeOf(() => parseAnswers(raw, QUESTIONS))).toBe(
      "VISION_RESPONSE_INVALID",
    );
  });

  it("rejects out-of-range confidence", () => {
    const raw = JSON.stringify({
      answers: [
        { id: "q1", answer: "Send", confidence: 1.5, details: "d" },
        { id: "q2", answer: "yes", confidence: 0.5, details: "d" },
      ],
    });
    expect(errorCodeOf(() => parseAnswers(raw, QUESTIONS))).toBe(
      "VISION_RESPONSE_INVALID",
    );
  });
});

describe("AnthropicBackend wire requests via the barrel", () => {
  const backend = new AnthropicBackend("test-model", "key-123");

  interface ContentBlock {
    type: string;
    text?: string;
    source?: { media_type: string; data: string };
  }
  interface RequestBody {
    model: string;
    max_tokens: number;
    system: string;
    messages: Array<{ role: string; content: ContentBlock[] }>;
  }

  it("targets the Messages API with auth and version headers", () => {
    const request = backend.buildRequest(IMAGE, QUESTIONS, null);
    expect(request.url).toBe(`${ANTHROPIC_BASE_URL}/messages`);
    expect(request.headers["x-api-key"]).toBe("key-123");
    expect(request.headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
  });

  it("embeds the rubric as the system prompt and the image as a base64 block", () => {
    const body = JSON.parse(
      backend.buildRequest(IMAGE, QUESTIONS, null).body,
    ) as RequestBody;
    expect(body.model).toBe("test-model");
    expect(body.system).toBe(SYSTEM_RUBRIC);
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content[0]).toMatchObject({
      type: "image",
      source: { media_type: "image/png", data: IMAGE.base64 },
    });
    expect(body.messages[0].content[1].text).toContain(
      '- id "q2": Is the accent orange?',
    );
  });

  it("appends the corrective turn as a trailing text block when retrying", () => {
    const body = JSON.parse(
      backend.buildRequest(IMAGE, QUESTIONS, "Reply with only JSON.").body,
    ) as RequestBody;
    expect(body.messages[0].content[2]).toEqual({
      type: "text",
      text: "Reply with only JSON.",
    });
  });

  it("joins text blocks and reports the provider's real token usage", () => {
    const response = backend.extractResponse({
      content: [
        { type: "text", text: "Hel" },
        { type: "text", text: "lo" },
      ],
      usage: { input_tokens: 120, output_tokens: 34 },
    });
    expect(response.text).toBe("Hello");
    expect(response.usage).toEqual({ inputTokens: 120, outputTokens: 34 });
  });

  it("throws typed when the response carries no text content", () => {
    expect(
      errorCodeOf(() =>
        backend.extractResponse({
          content: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ),
    ).toBe("VISION_BACKEND_RESPONSE");
  });
});

describe("OpenAiCompatibleBackend wire requests via the barrel", () => {
  interface MessageContentPart {
    type: string;
    text?: string;
    image_url?: { url: string };
  }
  interface RequestBody {
    messages: Array<{ role: string; content: string | MessageContentPart[] }>;
  }

  it("omits Authorization for a keyless local server", () => {
    const local = new OpenAiCompatibleBackend(
      "qwen3-vl",
      "",
      "http://127.0.0.1:8080/v1",
    );
    const request = local.buildRequest(IMAGE, QUESTIONS, null);
    expect(request.url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect("authorization" in request.headers).toBe(false);
  });

  it("sends Bearer auth when a key exists and pins the system rubric", () => {
    const keyed = new OpenAiCompatibleBackend(
      "gpt-x",
      "sk-test",
      "https://api.openai.com/v1",
    );
    const request = keyed.buildRequest(IMAGE, QUESTIONS, null);
    expect(request.headers.authorization).toBe("Bearer sk-test");
    const body = JSON.parse(request.body) as RequestBody;
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toBe(SYSTEM_RUBRIC);
    const parts = body.messages[1].content as MessageContentPart[];
    expect(parts[1].image_url?.url).toBe(
      `data:${IMAGE.mediaType};base64,${IMAGE.base64}`,
    );
  });

  it("appends the corrective turn after the image block when retrying", () => {
    const keyed = new OpenAiCompatibleBackend(
      "gpt-x",
      "sk-test",
      "https://api.openai.com/v1",
    );
    const body = JSON.parse(
      keyed.buildRequest(IMAGE, QUESTIONS, "JSON only, please.").body,
    ) as RequestBody;
    const parts = body.messages[1].content as MessageContentPart[];
    expect(parts[2]).toEqual({ type: "text", text: "JSON only, please." });
  });

  it("maps provider usage fields into canonical token counts", () => {
    const openai = new OpenAiCompatibleBackend(
      "gpt-x",
      "sk-test",
      "https://api.openai.com/v1",
    );
    const response = openai.extractResponse({
      choices: [{ message: { content: '{"answers":[]}' } }],
      usage: { prompt_tokens: 9, completion_tokens: 4 },
    });
    expect(response.text).toBe('{"answers":[]}');
    expect(response.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
  });

  it("throws typed when message content is null", () => {
    const openai = new OpenAiCompatibleBackend(
      "gpt-x",
      "sk-test",
      "https://api.openai.com/v1",
    );
    expect(
      errorCodeOf(() =>
        openai.extractResponse({
          choices: [{ message: { content: null } }],
          usage: { prompt_tokens: 9, completion_tokens: 4 },
        }),
      ),
    ).toBe("VISION_BACKEND_RESPONSE");
  });
});

describe("CliVisionBackend protocol via the barrel", () => {
  it("drives the claude CLI end to end through the injectable runner", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const backend = new CliVisionBackend({
      cli: "claude",
      model: "claude-code",
      runner: async (command, args) => {
        calls.push({ command, args });
        return {
          code: 0,
          stdout: JSON.stringify({
            result:
              '{"answers":[{"id":"q1","answer":"Send","confidence":1,"details":"btn"}]}',
            usage: { input_tokens: 210, output_tokens: 19 },
          }),
          stderr: "",
        };
      },
    });
    const response = await backend.invoke(IMAGE, [QUESTIONS[0]], null);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("claude");
    expect(calls[0].args[0]).toBe("-p");
    expect(calls[0].args).toContain("--output-format");
    expect(calls[0].args).toContain("json");
    expect(calls[0].args).toContain("--add-dir");
    expect(calls[0].args[1]).toContain("Read the image file at ");
    expect(calls[0].args[1]).toContain(
      '- id "q1": What does the primary button say?',
    );
    expect(response.text).toBe(
      '{"answers":[{"id":"q1","answer":"Send","confidence":1,"details":"btn"}]}',
    );
    expect(response.usage).toEqual({ inputTokens: 210, outputTokens: 19 });
  });

  it("surfaces a nonzero CLI exit as a typed VISION_CLI_EXIT error", async () => {
    const backend = new CliVisionBackend({
      cli: "codex",
      model: "codex-cli",
      runner: async () => ({ code: 3, stdout: "", stderr: "boom" }),
    });
    await expect(
      errorCodeOfAsync(() => backend.invoke(IMAGE, QUESTIONS, null)),
    ).resolves.toBe("VISION_CLI_EXIT");
  });
});

describe("parseClaudeEnvelope via the barrel", () => {
  it("canonicalizes snake_case usage into TokenUsage", () => {
    const response = parseClaudeEnvelope(
      JSON.stringify({
        result: "the reply",
        usage: { input_tokens: 5, output_tokens: 6 },
      }),
    );
    expect(response.text).toBe("the reply");
    expect(response.usage).toEqual({ inputTokens: 5, outputTokens: 6 });
  });

  it("refuses an error envelope instead of reading its result", () => {
    expect(
      errorCodeOf(() =>
        parseClaudeEnvelope(
          JSON.stringify({
            is_error: true,
            result: "x",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        ),
      ),
    ).toBe("VISION_CLI_RESPONSE");
  });

  it("refuses an envelope without a usage block — usage is never estimated", () => {
    expect(
      errorCodeOf(() => parseClaudeEnvelope(JSON.stringify({ result: "R" }))),
    ).toBe("VISION_CLI_RESPONSE");
  });
});

describe("parseCodexUsage via the barrel", () => {
  it("takes usage from the final turn.completed event, skipping log noise", () => {
    const stdout = [
      "codex: starting session",
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
      "",
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 30, output_tokens: 40 },
      }),
    ].join("\n");
    expect(parseCodexUsage(stdout)).toEqual({
      inputTokens: 30,
      outputTokens: 40,
    });
  });

  it("throws typed when no turn.completed event appeared", () => {
    expect(
      errorCodeOf(() => parseCodexUsage("banner line\nanother non-event")),
    ).toBe("VISION_CLI_RESPONSE");
  });
});

describe("queryHash and cache round trip via the barrel", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-qa-index-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("hashes canonically: key order of questions cannot change the hash", () => {
    const reordered: VisionQuestion[] = QUESTIONS.map(
      (q) =>
        ({
          expected: q.expected,
          question: q.question,
          id: q.id,
        }) as VisionQuestion,
    );
    expect(queryHash("m", "anthropic", reordered)).toBe(
      queryHash("m", "anthropic", QUESTIONS),
    );
  });

  it("binds the hash to the dimensions actually sent to the model", () => {
    const dims = {
      originalWidth: 100,
      originalHeight: 50,
      sentWidth: 100,
      sentHeight: 50,
    };
    const smaller = { ...dims, sentWidth: 50, sentHeight: 25 };
    expect(queryHash("m", "anthropic", QUESTIONS, dims)).not.toBe(
      queryHash("m", "anthropic", QUESTIONS, smaller),
    );
  });

  it("writeCache creates <root>/<CACHE_DIR_NAME>/<sha>/<query>.json and readCache hits it", () => {
    const imgSha = "b".repeat(64);
    const q = queryHash("m", "anthropic", QUESTIONS);
    writeCache(dir, imgSha, q, RESULT);
    expect(
      fs.existsSync(path.join(dir, CACHE_DIR_NAME, imgSha, `${q}.json`)),
    ).toBe(true);
    expect(readCache(dir, imgSha, q)).toEqual(RESULT);
  });

  it("a corrupt cache file degrades to a miss, and an absent key misses too", () => {
    const imgSha = "c".repeat(64);
    const q = queryHash("m", "anthropic", QUESTIONS);
    const file = cacheFilePath(dir, imgSha, q);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ this is not json", "utf8");
    expect(readCache(dir, imgSha, q)).toBeNull();
    expect(readCache(dir, imgSha, "never-written")).toBeNull();
  });
});

describe("scaleToMaxEdge via the barrel", () => {
  it("leaves images at or under the cap untouched (never upscales)", () => {
    expect(scaleToMaxEdge(800, 600, 1568)).toEqual({ width: 800, height: 600 });
    expect(scaleToMaxEdge(1568, 100, 1568)).toEqual({
      width: 1568,
      height: 100,
    });
  });

  it("downscales the longest edge preserving aspect ratio", () => {
    expect(scaleToMaxEdge(3128, 1600, 1568)).toEqual({
      width: 1568,
      height: 802,
    });
    expect(scaleToMaxEdge(900, 2700, 900)).toEqual({ width: 300, height: 900 });
  });

  it("never rounds a dimension down to zero on extreme aspect ratios", () => {
    expect(scaleToMaxEdge(20000, 1, 100)).toEqual({ width: 100, height: 1 });
  });
});

describe("suggestQuestions via the barrel", () => {
  it("returns nothing for a clean or below-threshold analysis", () => {
    expect(suggestQuestions({})).toEqual([]);
    expect(
      suggestQuestions({ color_fractions: { blue_fraction: 0.01 } }),
    ).toEqual([]);
  });

  it("asks about blue pixels above the brand threshold in either naming convention", () => {
    const snake = suggestQuestions(
      { color_fractions: { blue_fraction: 0.03 } },
      { viewName: "Chat" },
    );
    expect(snake).toHaveLength(1);
    expect(snake[0].id).toBe("q-blue");
    expect(snake[0].expected).toBe("no");
    expect(snake[0].question).toContain("3.0%");
    expect(snake[0].question).toContain("the Chat screenshot");

    const camel = suggestQuestions({ colorFractions: { blueFraction: 0.05 } });
    expect(camel).toHaveLength(1);
    expect(camel[0].id).toBe("q-blue");
  });

  it("asks about a large diff region only when a bbox accompanies it", () => {
    const withoutBbox = suggestQuestions({
      change_vs_baseline: { changed_fraction: 0.4 },
    });
    expect(withoutBbox).toEqual([]);

    const withBbox = suggestQuestions({
      change_vs_baseline: {
        changed_fraction: 0.4,
        changed_bbox_norm: [0.1, 0.2, 0.3, 0.4],
      },
    });
    expect(withBbox).toHaveLength(1);
    expect(withBbox[0].id).toBe("q-diff");
    expect(withBbox[0].question).toContain("(0.10, 0.20)");
    expect(withBbox[0].question).toContain("(0.30, 0.40)");
  });

  it("flags OCR dev strings case-insensitively by pattern order", () => {
    const questions = suggestQuestions({ ocr_text: "click TODO to continue" });
    expect(questions).toHaveLength(1);
    expect(questions[0].id).toBe("q-dev-0");
    expect(questions[0].question).toContain('"TODO"');
    expect(questions[0].expected).toBe("no");
  });

  it("turns unmet required copy into a question and satisfied copy into none", () => {
    const context = { expectations: { requireText: ["Save changes"] } };
    const missing = suggestQuestions({ ocr_text: "nothing helpful" }, context);
    expect(missing).toHaveLength(1);
    expect(missing[0].id).toBe("q-missing-0");
    expect(missing[0].expected).toBe("yes");
    expect(
      suggestQuestions({ ocr_text: "please save CHANGES now" }, context),
    ).toEqual([]);
  });

  it("questions forbidden copy that OCR did find", () => {
    const questions = suggestQuestions(
      { ocr_text: "banner reads legacy mode enabled" },
      { expectations: { forbidText: ["legacy mode"] } },
    );
    expect(questions).toHaveLength(1);
    expect(questions[0].id).toBe("q-forbidden-0");
    expect(questions[0].expected).toBe("no");
    expect(questions[0].question).toContain('"legacy mode"');
  });
});

describe("buildQaRecord via the barrel", () => {
  it("projects the ask result into the schema-1 audit record", () => {
    const record = buildQaRecord("visual/chat/send.png", QUESTIONS, RESULT);
    expect(record.schema).toBe(1);
    expect(record.subject).toBe("visual/chat/send.png");
    expect(record.backend).toBe("anthropic");
    expect(record.model).toBe("claude-opus-4-8");
    expect(record.questions).toBe(QUESTIONS);
    expect(record.answers).toEqual(RESULT.answers);
    expect(record.usage).toEqual({ inputTokens: 1000, outputTokens: 20 });
    expect(record.latencyMs).toBe(500);
    expect(record.retries).toBe(0);
    expect(record.cached).toBe(false);
    expect(record.dimensions).toEqual(RESULT.provenance.dimensions);
    expect(record.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });
});
