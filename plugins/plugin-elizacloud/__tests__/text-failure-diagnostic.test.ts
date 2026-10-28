import ts from "typescript";
import { expect, test } from "vitest";
import { redactLogValue } from "../../../packages/core/src/security/log-redaction";
import { readCloudTextFailureDiagnostic as read } from "../src/utils/cloud-text-failure-diagnostic";

test("400 diagnostic retains real machine error, parameter, trace and request controls without text/tool contents", () => {
  const out = read(
    new Response(null, {
      status: 400,
      headers: { "x-eliza-trace-id": "e0bac1dc-86ad-4866-8c65-5d52984db547" },
    }),
    {
      error: {
        message: "Invalid reasoning_effort parameter: private prompt",
        code: "invalid_reasoning_effort",
        type: "invalid_request_error",
        param: "reasoning_effort",
      },
    },
    {
      model: "qwen-3.8-27b",
      messages: [{ content: "private prompt" }],
      reasoning_effort: "none",
      max_tokens: 4096,
      tools: [{ name: "private tool", secret: "sk-private" }],
      response_format: { type: "json_schema", schema: { private: "secret" } },
      stream: false,
    }
  );
  expect(out).toMatchObject({
    status: 400,
    code: "invalid_reasoning_effort",
    type: "invalid_request_error",
    param: "reasoning_effort",
    controls: {
      model: "qwen-3.8-27b",
      outputBudget: 4096,
      reasoningEffort: "none",
      toolCount: 1,
      responseFormat: "json_schema",
      stream: false,
    },
  });
  expect(JSON.stringify(out)).not.toMatch(/private|sk-private/);
  expect(out.messageFields).toEqual(["reasoning_effort"]);
});
test("top-level gateway error shape and malformed metadata never become raw logs", () => {
  const out = read(
    new Response(null, {
      status: 400,
      headers: { "x-eliza-trace-id": "Bearer secret" },
    }),
    {
      error: "Bad Request secret prompt",
      code: "validation_error",
      param: "messages.0.content",
      details: { prompt: "secret" },
    },
    {
      model: "sk-private-key",
      temperature: NaN,
      reasoning_effort: "arbitrary secret",
      tool_choice: { function: { name: "secret" } },
    }
  );
  expect(out.errorShape).toBe("string");
  expect(out.param).toBe("messages.0.content");
  expect(out.controls.toolChoice).toBe("object");
  expect(out.controls.model).toBeUndefined();
  expect(out.controls.temperature).toBeUndefined();
  expect(out.traceId).toBeUndefined();
  expect(JSON.stringify(out)).not.toMatch(/secret|private|Bearer/);
});
test("absent/hostile machine fields are omitted and no response body is consumed", async () => {
  const response = new Response("must remain unread", { status: 503 });
  const out = read(response, {
    error: {
      code: "sk-secret",
      param: "raw prompt words",
      type: "a".repeat(81),
      message: "my secret message",
    },
  });
  expect(out.code).toBeUndefined();
  expect(out.param).toBeUndefined();
  expect(out.type).toBeUndefined();
  expect(await response.text()).toBe("must remain unread");
});

test("structured validation issue retains bounded code/path only, never message or received value", () => {
  const out = read(new Response(null, { status: 400 }), {
    details: {
      issues: [
        {
          code: "invalid_type",
          path: ["messages", 0, "content"],
          message: "private schema detail",
          received: "secret",
        },
        {
          code: "invalid_type",
          path: ["private schema property"],
          message: "secret",
        },
      ],
    },
  });
  expect(out.validationIssues).toEqual([
    { code: "invalid_type", path: "messages.0.content" },
    { code: "invalid_type", path: undefined },
  ]);
  expect(JSON.stringify(out)).not.toMatch(/private|secret|received/);
});

test("actual central text error boundary emits only projected metadata while preserving error status/body/rate contract", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/models/text.ts", import.meta.url), "utf8");
  const start = source.indexOf("export function cloudTextRequestError("),
    end = source.indexOf("\nfunction parseJsonRecord", start);
  const js = ts.transpileModule(source.slice(start, end).replace("export function", "function"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }).outputText;
  const logs: unknown[] = [];
  const rate = { kind: "rate_limited", retryAfterMs: 10 };
  const fn = new Function(
    "logger",
    "readCloudTextFailureDiagnostic",
    "asRecord",
    "firstString",
    "readCloudRateLimit",
    js + ";return cloudTextRequestError;"
  )(
    { warn: (data: unknown, _: string) => logs.push(data) },
    read,
    (v: unknown) => (v && typeof v === "object" ? v : {}),
    (v: unknown) => (typeof v === "string" ? v : undefined),
    () => rate
  );
  const body = {
    error: {
      message: "private provider message",
      code: "invalid_request_error",
      param: "response_format",
    },
  };
  const error = fn(new Response(null, { status: 400 }), body, {
    model: "qwen-3.8-27b",
    messages: [{ content: "private prompt" }],
    max_tokens: 2048,
    max_completion_tokens: 4096,
    max_output_tokens: 8192,
  });
  expect(error.status).toBe(400);
  expect(error.message).toBe("private provider message");
  expect(error.error).toBe(body.error);
  expect(error.rateLimit).toBe(rate);
  expect(logs).toHaveLength(1);
  expect(JSON.stringify(logs)).not.toMatch(/private/);
  expect(logs[0]).toMatchObject({
    status: 400,
    code: "invalid_request_error",
    param: "response_format",
  });
  expect(redactLogValue(logs[0], new WeakSet<object>(), 0)).toMatchObject({
    controls: {
      outputBudget: 2048,
      completionBudget: 4096,
      responseBudget: 8192,
    },
  });
  expect(source.match(/cloudTextRequestError\(response, [^\n]+requestBody\)/g)).toHaveLength(4);
});
