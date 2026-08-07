/**
 * Unit tests for the AI SDK → native Ollama `/api/chat` body rewrite used against
 * strict Ollama forks (zerollama) that reject top-level sampling fields.
 */
import { describe, expect, it, vi } from "vitest";
import {
  resolveOllamaFetch,
  rewriteOllamaChatBody,
  wrapOllamaNativeChatFetch,
} from "../utils/ollama-chat-compat-fetch";

describe("rewriteOllamaChatBody", () => {
  it("moves temperature / top_p / max_output_tokens into options and drops tool_choice", () => {
    const rewritten = rewriteOllamaChatBody({
      model: "eliza-1:9b",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
      top_p: 0.9,
      max_output_tokens: 1024,
      tool_choice: "required",
      tools: [{ type: "function", function: { name: "ping" } }],
      stream: true,
      think: false,
    });

    expect(rewritten).toEqual({
      model: "eliza-1:9b",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "ping" } }],
      stream: true,
      think: false,
      options: {
        temperature: 0.7,
        top_p: 0.9,
        num_predict: 1024,
      },
    });
    expect(rewritten).not.toHaveProperty("temperature");
    expect(rewritten).not.toHaveProperty("max_output_tokens");
    expect(rewritten).not.toHaveProperty("tool_choice");
  });

  it("does not overwrite existing options.num_predict", () => {
    const rewritten = rewriteOllamaChatBody({
      max_output_tokens: 64,
      options: { num_predict: 32, temperature: 0.1 },
    });
    expect(rewritten.options).toEqual({ num_predict: 32, temperature: 0.1 });
    expect(rewritten).not.toHaveProperty("max_output_tokens");
  });

  it("returns the same object when nothing needs rewriting", () => {
    const body = {
      model: "eliza-1:9b",
      messages: [],
      options: { temperature: 0.2 },
    };
    expect(rewriteOllamaChatBody(body)).toBe(body);
  });
});

describe("wrapOllamaNativeChatFetch", () => {
  it("rewrites POST /api/chat bodies before calling the base fetch", async () => {
    const baseFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const wrapped = wrapOllamaNativeChatFetch(
      baseFetch as unknown as typeof fetch,
    );

    await wrapped("http://192.168.255.164:8080/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "eliza-1:9b",
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.7,
        max_output_tokens: 64,
        tool_choice: "required",
      }),
    });

    expect(baseFetch).toHaveBeenCalledOnce();
    const init = baseFetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      model: "eliza-1:9b",
      messages: [{ role: "user", content: "hi" }],
      options: { temperature: 0.7, num_predict: 64 },
    });
  });

  it("leaves non-chat requests untouched", async () => {
    const body = JSON.stringify({ model: "embeddinggemma:300m", input: "hi" });
    const baseFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const wrapped = wrapOllamaNativeChatFetch(
      baseFetch as unknown as typeof fetch,
    );

    await wrapped("http://192.168.255.164:8080/api/embed", {
      method: "POST",
      body,
    });

    expect(baseFetch.mock.calls[0]?.[1]).toMatchObject({ body });
  });

  it("resolveOllamaFetch prefers runtime.fetch", async () => {
    const runtimeFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const wrapped = resolveOllamaFetch({
      fetch: runtimeFetch as unknown as typeof fetch,
    });
    await wrapped("http://host/api/tags");
    expect(runtimeFetch).toHaveBeenCalledOnce();
  });
});
