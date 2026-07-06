/**
 * Request-shape and response-parsing tests for both backends. These assert the
 * EXACT JSON body our client puts on the wire (image block structure, system
 * rubric, response_format) and that the strict answer parser rejects every
 * non-conforming shape rather than rescuing it. This is deterministic client
 * plumbing — the real-model path is covered by vision-qa.live.test.ts.
 */

import { describe, expect, it } from "vitest";
import { EvidenceError } from "../errors.ts";
import {
  ANTHROPIC_VERSION,
  AnthropicBackend,
  DEFAULT_ANTHROPIC_MODEL,
  OpenAiCompatibleBackend,
  parseAnswers,
  renderQuestionPrompt,
  SYSTEM_RUBRIC,
} from "./backends.ts";
import type { PreparedImage } from "./image.ts";
import type { VisionQuestion } from "./types.ts";

const IMAGE: PreparedImage = {
  base64: "QUJD",
  mediaType: "image/png",
  dimensions: {
    originalWidth: 100,
    originalHeight: 50,
    sentWidth: 100,
    sentHeight: 50,
  },
  sourceSha256: "a".repeat(64),
};

const QUESTIONS: VisionQuestion[] = [
  { id: "q1", question: "What does the button say?" },
  { id: "q2", question: "What color is it?", expected: "orange" },
];

describe("AnthropicBackend.buildRequest", () => {
  it("puts a base64 image block, rubric, and question text on the wire", () => {
    const backend = new AnthropicBackend(DEFAULT_ANTHROPIC_MODEL, "test-key");
    const request = backend.buildRequest(IMAGE, QUESTIONS, null);

    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request.headers["x-api-key"]).toBe("test-key");
    expect(request.headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    expect(request.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(request.body);
    expect(body.model).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(body.system).toBe(SYSTEM_RUBRIC);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "QUJD" },
    });
    expect(body.messages[0].content[1]).toEqual({
      type: "text",
      text: renderQuestionPrompt(QUESTIONS),
    });
  });

  it("appends the corrective message as a third content block on retry", () => {
    const backend = new AnthropicBackend(DEFAULT_ANTHROPIC_MODEL, "k");
    const request = backend.buildRequest(IMAGE, QUESTIONS, "FIX YOUR JSON");
    const body = JSON.parse(request.body);
    expect(body.messages[0].content).toHaveLength(3);
    expect(body.messages[0].content[2]).toEqual({
      type: "text",
      text: "FIX YOUR JSON",
    });
  });

  it("extracts joined text and token usage from a Messages response", () => {
    const backend = new AnthropicBackend(DEFAULT_ANTHROPIC_MODEL, "k");
    const extracted = backend.extractResponse({
      content: [
        { type: "text", text: '{"answers":' },
        { type: "text", text: "[]}" },
      ],
      usage: { input_tokens: 1200, output_tokens: 42 },
    });
    expect(extracted.text).toBe('{"answers":[]}');
    expect(extracted.usage).toEqual({ inputTokens: 1200, outputTokens: 42 });
  });

  it("throws typed when the response shape is unexpected", () => {
    const backend = new AnthropicBackend(DEFAULT_ANTHROPIC_MODEL, "k");
    expect(() => backend.extractResponse({ nope: true })).toThrowError(
      EvidenceError,
    );
  });
});

describe("OpenAiCompatibleBackend.buildRequest", () => {
  it("uses a data-URI image_url, json_object response_format, and a system message", () => {
    const backend = new OpenAiCompatibleBackend(
      "gpt-5.5",
      "sk-test",
      "https://api.openai.com/v1",
    );
    const request = backend.buildRequest(IMAGE, QUESTIONS, null);

    expect(request.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(request.headers.authorization).toBe("Bearer sk-test");

    const body = JSON.parse(request.body);
    expect(body.model).toBe("gpt-5.5");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0]).toEqual({
      role: "system",
      content: SYSTEM_RUBRIC,
    });
    expect(body.messages[1].content[0]).toEqual({
      type: "text",
      text: renderQuestionPrompt(QUESTIONS),
    });
    expect(body.messages[1].content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,QUJD" },
    });
  });

  it("omits the auth header when the key is empty (local llama-server)", () => {
    const backend = new OpenAiCompatibleBackend(
      "qwen3-vl",
      "",
      "http://127.0.0.1:8080/v1",
    );
    const request = backend.buildRequest(IMAGE, QUESTIONS, null);
    expect(request.headers.authorization).toBeUndefined();
    expect(request.url).toBe("http://127.0.0.1:8080/v1/chat/completions");
  });

  it("extracts content and usage, mapping prompt/completion tokens", () => {
    const backend = new OpenAiCompatibleBackend("gpt-5.5", "k", "https://x/v1");
    const extracted = backend.extractResponse({
      choices: [{ message: { content: '{"answers":[]}' } }],
      usage: { prompt_tokens: 900, completion_tokens: 30 },
    });
    expect(extracted.text).toBe('{"answers":[]}');
    expect(extracted.usage).toEqual({ inputTokens: 900, outputTokens: 30 });
  });

  it("throws typed when content is null", () => {
    const backend = new OpenAiCompatibleBackend("gpt-5.5", "k", "https://x/v1");
    expect(() =>
      backend.extractResponse({
        choices: [{ message: { content: null } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    ).toThrowError(EvidenceError);
  });
});

describe("parseAnswers", () => {
  it("accepts a conforming response covering every asked id", () => {
    const raw = JSON.stringify({
      answers: [
        {
          id: "q1",
          answer: "Send",
          confidence: 0.98,
          details: "text on button",
        },
        {
          id: "q2",
          answer: "orange",
          confidence: 0.9,
          details: "accent color",
        },
      ],
    });
    const answers = parseAnswers(raw, QUESTIONS);
    expect(answers).toHaveLength(2);
    expect(answers[0].answer).toBe("Send");
  });

  it("rejects non-JSON output (no regex rescue)", () => {
    expect(() =>
      parseAnswers("Here are the answers: the button says Send", QUESTIONS),
    ).toThrowError(EvidenceError);
  });

  it("rejects a missing answer id", () => {
    const raw = JSON.stringify({
      answers: [{ id: "q1", answer: "Send", confidence: 1, details: "x" }],
    });
    expect(() => parseAnswers(raw, QUESTIONS)).toThrowError(/do not match/);
  });

  it("rejects an extra unasked id", () => {
    const raw = JSON.stringify({
      answers: [
        { id: "q1", answer: "a", confidence: 1, details: "x" },
        { id: "q2", answer: "b", confidence: 1, details: "x" },
        { id: "q3", answer: "c", confidence: 1, details: "x" },
      ],
    });
    expect(() => parseAnswers(raw, QUESTIONS)).toThrowError(EvidenceError);
  });

  it("rejects out-of-range confidence", () => {
    const raw = JSON.stringify({
      answers: [
        { id: "q1", answer: "a", confidence: 1.5, details: "x" },
        { id: "q2", answer: "b", confidence: 0.5, details: "x" },
      ],
    });
    expect(() => parseAnswers(raw, QUESTIONS)).toThrowError(EvidenceError);
  });

  it("rejects extra properties on an answer (strict object)", () => {
    const raw = JSON.stringify({
      answers: [
        { id: "q1", answer: "a", confidence: 1, details: "x", extra: 1 },
        { id: "q2", answer: "b", confidence: 1, details: "x" },
      ],
    });
    expect(() => parseAnswers(raw, QUESTIONS)).toThrowError(EvidenceError);
  });
});
