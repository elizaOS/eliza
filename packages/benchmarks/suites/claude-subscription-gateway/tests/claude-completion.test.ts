/** Verifies fresh SDK sessions and capture-only MCP behavior through an injected deterministic module. */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ClaudeAgentSdkModule } from "../src/index.js";
import {
  assertNoApiBillingEnvironment,
  buildClaudeCodeManagedEnvironment,
  type ClaudeRateLimitError,
  ClaudeSdkCompletionRunner,
  canonicalizeChatCompletion,
  FORBIDDEN_API_BILLING_ENV_NAMES,
} from "../src/index.js";

interface FakeTool {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function fakeUsage() {
  return {
    input_tokens: 20,
    output_tokens: 4,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 3,
  };
}

function createFakeSdk(
  mode: "text" | "tool",
  apiKeySource: "oauth" | "none" | "temporary" = "oauth",
  accountInfo: {
    apiProvider?: string;
    subscriptionType?: string;
    apiKeySource?: string;
  } = {
    apiProvider: "firstParty",
    subscriptionType: "Claude Max",
  },
) {
  const queryCalls: Array<{
    prompt: string;
    options: Record<string, unknown>;
  }> = [];
  let closeCount = 0;
  const sdk: ClaudeAgentSdkModule = {
    tool(name, _description, _schema, handler) {
      return { name, handler } as never;
    },
    createSdkMcpServer(options) {
      return options;
    },
    query(call) {
      queryCalls.push(call);
      const stream = (async function* () {
        yield {
          type: "system",
          subtype: "init",
          model: "claude-opus-4-8-actual",
          claude_code_version: "test-cli",
          apiKeySource,
        };
        if (mode === "tool") {
          const servers = call.options.mcpServers as Record<
            string,
            { tools: FakeTool[] }
          >;
          await servers.benchmark.tools[0].handler({ city: "Paris" });
          yield { type: "assistant", message: { content: [] } };
          yield {
            type: "result",
            subtype: "error_max_turns",
            terminal_reason: "max_turns",
            usage: fakeUsage(),
          };
        } else {
          yield {
            type: "assistant",
            message: { content: [{ type: "text", text: "PONG" }] },
          };
          yield {
            type: "result",
            subtype: "success",
            terminal_reason: "completed",
            result: "PONG",
            usage: fakeUsage(),
          };
        }
      })();
      return {
        [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
        accountInfo: async () => accountInfo,
        close: () => {
          closeCount += 1;
        },
      };
    },
  };
  return { sdk, queryCalls, closeCount: () => closeCount };
}

function createPostResultFailureSdk(options: {
  capture: boolean;
  subtype: string;
  isError: boolean;
  terminalReason?: string;
}): ClaudeAgentSdkModule {
  const base = createFakeSdk("tool").sdk;
  return {
    ...base,
    query(call) {
      const stream = (async function* () {
        yield {
          type: "system",
          subtype: "init",
          model: "claude-sonnet-4-6",
          claude_code_version: "test-cli",
          apiKeySource: "oauth",
        };
        if (options.capture) {
          const servers = call.options.mcpServers as Record<
            string,
            { tools: FakeTool[] }
          >;
          await servers.benchmark.tools[0].handler({ value: "OK" });
          yield { type: "assistant", message: { content: [] } };
        }
        yield {
          type: "result",
          subtype: options.subtype,
          is_error: options.isError,
          terminal_reason: options.terminalReason,
          usage: fakeUsage(),
        };
        throw new Error("sensitive SDK process-exit detail");
      })();
      return {
        [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
        accountInfo: async () => ({
          apiProvider: "firstParty",
          subscriptionType: "Claude Max",
        }),
        close: () => undefined,
      };
    },
  };
}

function requiredCanaryCompletion() {
  return canonicalizeChatCompletion({
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "Call CANARY with value OK." }],
    tools: [
      {
        type: "function",
        function: {
          name: "CANARY",
          description: "Capture a short canary marker.",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "CANARY" } },
    parallel_tool_calls: false,
  });
}

async function expectRedactedFailure(
  operation: Promise<unknown>,
  code: string,
  forbiddenText: string,
): Promise<void> {
  try {
    await operation;
    throw new Error("Expected the SDK operation to fail.");
  } catch (error: unknown) {
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain(forbiddenText);
  }
}

describe("ClaudeSdkCompletionRunner", () => {
  it("creates and closes a fresh query for every text completion", async () => {
    const fake = createFakeSdk("text");
    const runner = new ClaudeSdkCompletionRunner({
      sdkModule: fake.sdk,
      timeoutMs: 1_000,
      environment: { PATH: "/usr/bin" },
    });
    const canonical = canonicalizeChatCompletion({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "Return PONG" }],
      reasoning_effort: "medium",
    });

    const first = await runner.complete({
      requestId: "one",
      harness: "eliza",
      canonical,
    });
    const second = await runner.complete({
      requestId: "two",
      harness: "hermes",
      canonical,
    });

    expect(first.text).toBe("PONG");
    expect(second.model).toBe("claude-opus-4-8-actual");
    expect(fake.queryCalls).toHaveLength(2);
    expect(fake.closeCount()).toBe(2);
    expect(fake.queryCalls[0].options).toMatchObject({
      maxTurns: 1,
      persistSession: false,
      settingSources: [],
      strictMcpConfig: true,
      tools: [],
      effort: "medium",
      env: {
        PATH: "/usr/bin",
        CLAUDE_AGENT_SDK_CLIENT_APP:
          "elizaos-claude-subscription-gateway/0.1.0",
      },
    });
  });

  it("captures MCP arguments and returns them without a benchmark executor", async () => {
    const fake = createFakeSdk("tool");
    const runner = new ClaudeSdkCompletionRunner({
      sdkModule: fake.sdk,
      timeoutMs: 1_000,
      environment: { PATH: "/usr/bin" },
    });
    const canonical = canonicalizeChatCompletion({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "Look up Paris weather" }],
      tools: [
        {
          type: "function",
          function: {
            name: "weather",
            description: "Look up weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ],
      tool_choice: "required",
    });

    const result = await runner.complete({
      requestId: "tool-probe",
      harness: "openclaw",
      canonical,
    });

    expect(result.text).toBe("");
    expect(result.toolCalls).toEqual([
      {
        id: "call_tool-probe_1",
        name: "weather",
        arguments: { city: "Paris" },
      },
    ]);
    expect(fake.queryCalls[0].options.tools).toEqual([]);
    expect(fake.queryCalls[0].options.allowedTools).toEqual([
      "mcp__benchmark__weather",
    ]);
    expect(fake.queryCalls[0].options.permissionMode).toBe("dontAsk");
    expect(fake.queryCalls[0].options.promptSuggestions).toBeUndefined();
    expect(fake.queryCalls[0].options.disallowedTools).toBeUndefined();
    expect(fake.queryCalls[0].options.abortController).toBeInstanceOf(
      AbortController,
    );
    expect(
      fake.queryCalls[0].options.allowDangerouslySkipPermissions,
    ).toBeUndefined();
    expect(fake.queryCalls[0].options.tools).not.toContain(
      "mcp__benchmark__weather",
    );
  });

  it("keeps the native Eliza HANDLE_RESPONSE MCP tool out of the SDK built-in tool set", async () => {
    const fixture: unknown = JSON.parse(
      readFileSync(
        new URL(
          "./fixtures/eliza-handle-response-required.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    if (
      typeof fixture !== "object" ||
      fixture === null ||
      !("request" in fixture)
    ) {
      throw new Error("Eliza HANDLE_RESPONSE regression fixture is invalid.");
    }
    const canonical = canonicalizeChatCompletion(fixture.request);
    expect(canonical.toolSchemaSha256).toBe(
      "b918bab7e164ced9452d284df592d186bb2bd56bb5c0ad3f7eeba429b7516e24",
    );

    const fake = createFakeSdk("tool");
    const runner = new ClaudeSdkCompletionRunner({
      sdkModule: fake.sdk,
      timeoutMs: 1_000,
      environment: { PATH: "/usr/bin" },
    });
    await runner.complete({
      requestId: "eliza-handle-response-regression",
      harness: "eliza",
      canonical,
    });

    expect(fake.queryCalls[0].options.tools).toEqual([]);
    expect(fake.queryCalls[0].options.allowedTools).toEqual([
      "mcp__benchmark__HANDLE_RESPONSE",
    ]);
  });

  it("accepts the SDK max-turn process exit only after a captured tool terminal", async () => {
    const runner = new ClaudeSdkCompletionRunner({
      sdkModule: createPostResultFailureSdk({
        capture: true,
        subtype: "error_max_turns",
        isError: true,
        terminalReason: "max_turns",
      }),
      timeoutMs: 1_000,
      environment: { PATH: "/usr/bin" },
    });

    await expect(
      runner.complete({
        requestId: "post-result-tool-stop",
        harness: "eliza",
        canonical: requiredCanaryCompletion(),
      }),
    ).resolves.toMatchObject({
      resultSubtype: "error_max_turns",
      terminalReason: "max_turns",
      toolCalls: [{ name: "CANARY", arguments: { value: "OK" } }],
    });
  });

  it.each([
    {
      label: "no captured tool",
      capture: false,
      subtype: "error_max_turns",
      isError: true,
      terminalReason: "max_turns",
    },
    {
      label: "different result subtype",
      capture: true,
      subtype: "error_during_execution",
      isError: true,
      terminalReason: "model_error",
    },
    {
      label: "non-error result",
      capture: true,
      subtype: "error_max_turns",
      isError: false,
      terminalReason: "max_turns",
    },
    {
      label: "different terminal reason",
      capture: true,
      subtype: "error_max_turns",
      isError: true,
      terminalReason: "model_error",
    },
    {
      label: "missing terminal reason",
      capture: true,
      subtype: "error_max_turns",
      isError: true,
      terminalReason: undefined,
    },
  ])("rejects a post-result SDK failure with $label", async (testCase) => {
    const runner = new ClaudeSdkCompletionRunner({
      sdkModule: createPostResultFailureSdk(testCase),
      timeoutMs: 1_000,
      environment: { PATH: "/usr/bin" },
    });

    await expect(
      runner.complete({
        requestId: "invalid-post-result-stop",
        harness: "eliza",
        canonical: requiredCanaryCompletion(),
      }),
    ).rejects.toMatchObject({ code: "claude_sdk_stream_failed" });
  });

  it("classifies SDK process failures without exposing upstream text", async () => {
    const upstreamText = "sensitive upstream authentication detail";
    const canonical = canonicalizeChatCompletion({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "Return PONG" }],
    });
    const accountBase = createFakeSdk("text").sdk;
    const accountRunner = new ClaudeSdkCompletionRunner({
      sdkModule: {
        ...accountBase,
        query(call) {
          const query = accountBase.query(call);
          return {
            [Symbol.asyncIterator]: () => query[Symbol.asyncIterator](),
            accountInfo: async () => {
              throw new Error(upstreamText);
            },
            close: () => query.close?.(),
          };
        },
      },
      environment: { PATH: "/usr/bin" },
    });
    await expectRedactedFailure(
      accountRunner.complete({
        requestId: "account-failure",
        harness: "eliza",
        canonical,
      }),
      "claude_sdk_account_info_failed",
      upstreamText,
    );

    const streamBase = createFakeSdk("text").sdk;
    const streamRunner = new ClaudeSdkCompletionRunner({
      sdkModule: {
        ...streamBase,
        query() {
          const stream = (async function* () {
            yield {
              type: "system",
              subtype: "init",
              model: "claude-sonnet-4-6",
              claude_code_version: "test-cli",
              apiKeySource: "oauth",
            };
            throw new Error(upstreamText);
          })();
          return {
            [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
            accountInfo: async () => ({
              apiProvider: "firstParty",
              subscriptionType: "Claude Max",
            }),
            close: () => undefined,
          };
        },
      },
      environment: { PATH: "/usr/bin" },
    });
    await expectRedactedFailure(
      streamRunner.complete({
        requestId: "stream-failure",
        harness: "openclaw",
        canonical,
      }),
      "claude_sdk_stream_failed",
      upstreamText,
    );

    const queryBase = createFakeSdk("text").sdk;
    const queryRunner = new ClaudeSdkCompletionRunner({
      sdkModule: {
        ...queryBase,
        query() {
          throw new Error(upstreamText);
        },
      },
      environment: { PATH: "/usr/bin" },
    });
    await expectRedactedFailure(
      queryRunner.complete({
        requestId: "query-failure",
        harness: "hermes",
        canonical,
      }),
      "claude_sdk_query_start_failed",
      upstreamText,
    );
  });

  it("scrubs ambient raw credentials and rejects non-OAuth SDK provenance", async () => {
    const rawKey = "raw-anthropic-key-must-not-cross-boundary";
    const oauthFake = createFakeSdk("text");
    const oauthRunner = new ClaudeSdkCompletionRunner({
      sdkModule: oauthFake.sdk,
      timeoutMs: 1_000,
      environment: {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: rawKey,
        OPENAI_API_KEY: "unrelated-raw-key",
        CLAUDE_CODE_OAUTH_TOKEN: "allowed-oauth-token",
      },
    });
    const canonical = canonicalizeChatCompletion({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "Return PONG" }],
    });

    const result = await oauthRunner.complete({
      requestId: "oauth",
      harness: "eliza",
      canonical,
    });
    const environment = oauthFake.queryCalls[0].options.env as Record<
      string,
      string
    >;

    expect(result.sdkApiKeySource).toBe("none");
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBe("allowed-oauth-token");
    expect(JSON.stringify(environment)).not.toContain(rawKey);

    const keychainFake = createFakeSdk("text", "none");
    const keychainRunner = new ClaudeSdkCompletionRunner({
      sdkModule: keychainFake.sdk,
      timeoutMs: 1_000,
      environment: { PATH: "/usr/bin" },
    });
    await expect(
      keychainRunner.complete({
        requestId: "keychain-oauth",
        harness: "eliza",
        canonical,
      }),
    ).resolves.toMatchObject({ sdkApiKeySource: "none" });

    const rawFake = createFakeSdk("text", "temporary");
    const rawRunner = new ClaudeSdkCompletionRunner({
      sdkModule: rawFake.sdk,
      timeoutMs: 1_000,
      environment: { PATH: "/usr/bin" },
    });
    await expect(
      rawRunner.complete({
        requestId: "raw",
        harness: "hermes",
        canonical,
      }),
    ).rejects.toMatchObject({ code: "claude_sdk_non_subscription_auth" });

    const apiAccountFake = createFakeSdk("text", "none", {
      apiProvider: "firstParty",
      apiKeySource: "user",
    });
    const apiAccountRunner = new ClaudeSdkCompletionRunner({
      sdkModule: apiAccountFake.sdk,
      timeoutMs: 1_000,
      environment: { PATH: "/usr/bin" },
    });
    await expect(
      apiAccountRunner.complete({
        requestId: "api-account",
        harness: "hermes",
        canonical,
      }),
    ).rejects.toMatchObject({
      code: "claude_sdk_non_subscription_account",
    });

    expect(() =>
      assertNoApiBillingEnvironment({ ANTHROPIC_API_KEY: rawKey }),
    ).toThrowError(
      "API-billing environment variables must be removed before starting",
    );
    expect(() =>
      assertNoApiBillingEnvironment({
        CLAUDE_CODE_OAUTH_TOKEN: "allowed-oauth-token",
      }),
    ).not.toThrow();
  });

  it("keeps the published API-billing denylist unique and fail-closed", () => {
    expect(new Set(FORBIDDEN_API_BILLING_ENV_NAMES).size).toBe(
      FORBIDDEN_API_BILLING_ENV_NAMES.length,
    );
    for (const name of FORBIDDEN_API_BILLING_ENV_NAMES) {
      expect(() =>
        assertNoApiBillingEnvironment({ [name]: "present" }),
      ).toThrowError(
        "API-billing environment variables must be removed before starting",
      );
      expect(
        buildClaudeCodeManagedEnvironment({ [name]: "present" })[name],
      ).toBeUndefined();
    }
    expect(() =>
      assertNoApiBillingEnvironment({ anthropic_api_key: "present" }),
    ).toThrow();
  });

  it("uses structured rejected rate-limit resets without clipping long windows", async () => {
    const resetsAtSeconds = 2_000_000_000;
    const base = createFakeSdk("text").sdk;
    const runner = new ClaudeSdkCompletionRunner({
      sdkModule: {
        ...base,
        query() {
          const stream = (async function* () {
            yield {
              type: "rate_limit_event",
              rate_limit_info: {
                status: "rejected" as const,
                resetsAt: resetsAtSeconds,
                rateLimitType: "seven_day",
              },
            };
          })();
          return {
            [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
            accountInfo: async () => ({
              apiProvider: "firstParty",
              subscriptionType: "Claude Max",
            }),
          };
        },
      },
      environment: { PATH: "/usr/bin" },
    });

    await expect(
      runner.complete({
        requestId: "structured-rate-limit",
        harness: "eliza",
        canonical: canonicalizeChatCompletion({
          model: "claude-opus-4-8",
          messages: [{ role: "user", content: "PONG" }],
        }),
      }),
    ).rejects.toMatchObject({
      code: "subscription_rate_limited",
      retryAtMs: resetsAtSeconds * 1_000,
      rateLimitType: "seven_day",
    } satisfies Partial<ClaudeRateLimitError>);
  });

  it("classifies assistant rate-limit errors as unknown reset", async () => {
    const base = createFakeSdk("text").sdk;
    const runner = new ClaudeSdkCompletionRunner({
      sdkModule: {
        ...base,
        query() {
          const stream = (async function* () {
            yield {
              type: "assistant",
              error: "rate_limit" as const,
              message: { content: [] },
            };
          })();
          return {
            [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
            accountInfo: async () => ({
              apiProvider: "firstParty",
              subscriptionType: "Claude Max",
            }),
          };
        },
      },
      environment: { PATH: "/usr/bin" },
    });

    await expect(
      runner.complete({
        requestId: "assistant-rate-limit",
        harness: "hermes",
        canonical: canonicalizeChatCompletion({
          model: "claude-opus-4-8",
          messages: [{ role: "user", content: "PONG" }],
        }),
      }),
    ).rejects.toMatchObject({
      code: "subscription_rate_limited",
      retryAtMs: null,
    });
  });

  it("classifies the SDK's textual API 429 fallback as an unknown reset", async () => {
    const base = createFakeSdk("text").sdk;
    const runner = new ClaudeSdkCompletionRunner({
      sdkModule: {
        ...base,
        query() {
          const stream = (async function* () {
            yield {
              type: "system",
              subtype: "init",
              model: "claude-opus-4-8-actual",
              claude_code_version: "test-cli",
              apiKeySource: "oauth",
            };
            yield {
              type: "assistant",
              message: {
                content: [{ type: "text", text: "API Error: 429 (redacted)" }],
              },
            };
            yield {
              type: "result",
              subtype: "success",
              terminal_reason: "completed",
              usage: fakeUsage(),
            };
          })();
          return {
            [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
            accountInfo: async () => ({
              apiProvider: "firstParty",
              subscriptionType: "Claude Max",
            }),
          };
        },
      },
      environment: { PATH: "/usr/bin" },
    });

    await expect(
      runner.complete({
        requestId: "text-rate-limit",
        harness: "openclaw",
        canonical: canonicalizeChatCompletion({
          model: "claude-opus-4-8",
          messages: [{ role: "user", content: "PONG" }],
        }),
      }),
    ).rejects.toMatchObject({
      code: "subscription_rate_limited",
      retryAtMs: null,
    });
  });

  it("checks subscription tier before consuming the provider stream", async () => {
    let streamStarted = false;
    const base = createFakeSdk("text").sdk;
    const runner = new ClaudeSdkCompletionRunner({
      sdkModule: {
        ...base,
        query() {
          const stream = (async function* () {
            streamStarted = true;
            yield { type: "assistant", message: { content: [] } };
          })();
          return {
            [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
            accountInfo: async () => ({
              apiProvider: "firstParty",
              subscriptionType: "Claude Pro",
            }),
          };
        },
      },
      environment: { PATH: "/usr/bin" },
    });

    await expect(
      runner.complete({
        requestId: "tier-preflight",
        harness: "openclaw",
        canonical: canonicalizeChatCompletion({
          model: "claude-opus-4-8",
          messages: [{ role: "user", content: "PONG" }],
        }),
        credentialTierValidator: () => {
          throw new Error("tier mismatch");
        },
      }),
    ).rejects.toThrow("tier mismatch");
    expect(streamStarted).toBe(false);
  });
});
