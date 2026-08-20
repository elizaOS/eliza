/**
 * Exercises the terminal action against its real HTTP response contract while
 * stubbing only the loopback transport. Success and failure must remain
 * distinguishable, missing execution proof must fail rather than become an
 * invented zero exit code, and a hung loopback fetch must fail closed.
 */

import {
  ElizaError,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveTerminalTransportTimeoutMs,
  terminalAction,
} from "./terminal.ts";

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: () => "7f72b2d2-741f-48d9-8571-4ac9918d6a6e",
}));

function runtime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    createMemory: vi.fn(async () => "00000000-0000-0000-0000-000000000004"),
    redactSecrets: vi.fn((text: string) => text),
  } as unknown as IAgentRuntime;
}

function message(): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000002",
    agentId: "00000000-0000-0000-0000-000000000001",
    entityId: "00000000-0000-0000-0000-000000000003",
    roomId: "00000000-0000-0000-0000-000000000004",
    content: { text: "run echo hello" },
  } as Memory;
}

function options(command = "echo hello"): HandlerOptions {
  return { parameters: { command } };
}

function terminalResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      runId: "run-7f72b2d2-741f-48d9-8571-4ac9918d6a6e",
      command: "echo hello",
      exitCode: 0,
      stdout: "hello\n",
      stderr: "",
      timedOut: false,
      truncated: false,
      maxDurationMs: 30_000,
      ...overrides,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("terminal action effect proof", () => {
  beforeEach(() => {
    vi.stubEnv("ELIZA_BUILD_VARIANT", "direct");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns an applied receipt bound to exact clean stdout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => terminalResponse()),
    );

    const result = await terminalAction.handler(
      runtime(),
      message(),
      undefined,
      options(),
    );

    expect(result).toMatchObject({
      success: true,
      userFacingText: "hello",
      verifiedUserFacing: false,
      userFacingEffectReceiptIds: [
        "terminal-run:run-7f72b2d2-741f-48d9-8571-4ac9918d6a6e",
      ],
      effectReceipts: [
        {
          receiptId: "terminal-run:run-7f72b2d2-741f-48d9-8571-4ac9918d6a6e",
          operation: "system.shell.execute",
          outcome: "applied",
          commit: {
            kind: "provider_accepted",
            id: "run-7f72b2d2-741f-48d9-8571-4ac9918d6a6e",
          },
        },
      ],
    });
  });

  it("returns a failed non-retryable receipt for a nonzero exit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        terminalResponse({
          exitCode: 7,
          stdout: "",
          stderr: "permission denied",
        }),
      ),
    );

    const result = await terminalAction.handler(
      runtime(),
      message(),
      undefined,
      options("false"),
    );

    expect(result).toMatchObject({
      success: false,
      error: "TERMINAL_EXECUTION_FAILED",
      userFacingText: "The command failed with exit code 7.",
      verifiedUserFacing: true,
      effectReceipts: [
        {
          outcome: "failed",
          failure: {
            code: "TERMINAL_EXECUTION_FAILED",
            retryable: false,
            acceptance: "rejected",
          },
        },
      ],
    });
  });

  it("does not stamp raw stdout as verified user-facing text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        terminalResponse({
          command:
            "git ls-remote --heads https://github.com/elizaOS/eliza develop",
          stdout:
            "ebcf7fff00000000000000000000000000000000\trefs/heads/develop\n",
        }),
      ),
    );

    const result = await terminalAction.handler(
      runtime(),
      message(),
      undefined,
      options("git ls-remote --heads https://github.com/elizaOS/eliza develop"),
    );

    // Kept as the deterministic fallback relay…
    expect(result).toMatchObject({
      success: true,
      userFacingText:
        "ebcf7fff00000000000000000000000000000000\trefs/heads/develop",
    });
    // …but never verbatim-verified: that stamp is what let the relay ship the
    // raw SHA line as a standalone leading paragraph before the natural reply.
    expect(
      (result as { verifiedUserFacing?: boolean }).verifiedUserFacing,
    ).toBe(false);
  });

  it("keeps the deterministic empty-stdout success sentence verified", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => terminalResponse({ stdout: "" })),
    );

    const result = await terminalAction.handler(
      runtime(),
      message(),
      undefined,
      options("true"),
    );

    expect(result).toMatchObject({
      success: true,
      userFacingText: "The command finished successfully with exit code 0.",
      verifiedUserFacing: true,
    });
  });
  it("summarizes multiline stdout without marking it canonical", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => terminalResponse({ stdout: "first\nsecond\n" })),
    );

    const result = await terminalAction.handler(
      runtime(),
      message(),
      undefined,
      options("printf 'first\\nsecond\\n'"),
    );

    expect(result).toMatchObject({
      success: true,
      userFacingText:
        "The command finished (exit 0) with 2 lines of output; ask me about specifics instead of dumping it into chat.",
      verifiedUserFacing: false,
    });
    expect(result?.text).toContain("first\nsecond");
  });

  it("summarizes carriage-return-delimited stdout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => terminalResponse({ stdout: "first\rsecond" })),
    );

    const result = await terminalAction.handler(
      runtime(),
      message(),
      undefined,
      options("printf 'first\\rsecond'"),
    );

    expect(result).toMatchObject({
      success: true,
      userFacingText:
        "The command finished (exit 0) with 2 lines of output; ask me about specifics instead of dumping it into chat.",
      verifiedUserFacing: false,
    });
  });
  it("summarizes single-line stdout over the relay limit", async () => {
    const stdout = "x".repeat(201);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => terminalResponse({ stdout })),
    );

    const result = await terminalAction.handler(
      runtime(),
      message(),
      undefined,
      options("generate-long-output"),
    );

    expect(result).toMatchObject({
      userFacingText:
        "The command finished (exit 0) with 1 line of output; ask me about specifics instead of dumping it into chat.",
      verifiedUserFacing: false,
    });
    expect(result?.text).toContain(stdout);
  });

  it("relays a single line at the exact size limit without marking it canonical", async () => {
    const stdout = "x".repeat(200);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => terminalResponse({ stdout })),
    );

    const result = await terminalAction.handler(
      runtime(),
      message(),
      undefined,
      options("generate-bounded-output"),
    );

    expect(result).toMatchObject({
      userFacingText: stdout,
      verifiedUserFacing: false,
    });
  });

  it("keeps action-owned empty, stderr, truncated, and timeout statuses canonical", async () => {
    const cases = [
      {
        override: { stdout: "" },
        text: "The command finished successfully with exit code 0.",
      },
      {
        override: { stdout: "partial", stderr: "warning" },
        text: "The command finished successfully with exit code 0.",
      },
      {
        override: { stdout: "partial", truncated: true },
        text: "The command finished successfully with exit code 0.",
      },
      {
        override: { stdout: "partial", timedOut: true, maxDurationMs: 30_000 },
        text: "The command timed out after 30000 ms; I can't verify that it completed.",
      },
    ];

    for (const testCase of cases) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => terminalResponse(testCase.override)),
      );
      const result = await terminalAction.handler(
        runtime(),
        message(),
        undefined,
        options(),
      );
      expect(result).toMatchObject({
        userFacingText: testCase.text,
        verifiedUserFacing: true,
      });
    }
  });

  it("rejects a response that omits its exit code instead of fabricating zero", async () => {
    const response = terminalResponse();
    const payload = (await response.json()) as Record<string, unknown>;
    delete payload.exitCode;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    await expect(
      terminalAction.handler(runtime(), message(), undefined, options()),
    ).rejects.toMatchObject({
      code: "TERMINAL_RESPONSE_INVALID",
    });
  });

  it("rejects execution proof for a different run identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        terminalResponse({
          runId: "run-00000000-0000-4000-8000-000000000001",
        }),
      ),
    );

    await expect(
      terminalAction.handler(runtime(), message(), undefined, options()),
    ).rejects.toMatchObject({
      code: "TERMINAL_RESPONSE_INVALID",
      context: {
        expectedRunId: "run-7f72b2d2-741f-48d9-8571-4ac9918d6a6e",
        receivedRunId: "run-00000000-0000-4000-8000-000000000001",
      },
    });
  });

  it("surfaces an HTTP rejection as a typed action failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );

    await expect(
      terminalAction.handler(runtime(), message(), undefined, options()),
    ).rejects.toMatchObject({
      code: "TERMINAL_REQUEST_FAILED",
      context: { status: 503 },
    });
  });

  it("derives its transport deadline from the configured server run limit", () => {
    vi.stubEnv("ELIZA_TERMINAL_MAX_DURATION_MS", "125000");
    expect(resolveTerminalTransportTimeoutMs()).toBe(135_000);

    vi.stubEnv("ELIZA_TERMINAL_MAX_DURATION_MS", "9999999999");
    expect(resolveTerminalTransportTimeoutMs()).toBe(3_610_000);
  });

  it("cancels a stalled response body with the caller's abort reason", async () => {
    const caller = new AbortController();
    let bodyCancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel: () => {
                bodyCancelled = true;
              },
            }),
            { status: 200 },
          ),
      ),
    );
    const abortReason = new Error("turn cancelled");
    const pending = terminalAction.handler(runtime(), message(), undefined, {
      ...options(),
      abortSignal: caller.signal,
    } as HandlerOptions & { abortSignal: AbortSignal });

    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledOnce();
    });
    caller.abort(abortReason);

    await expect(pending).rejects.toBe(abortReason);
    expect(bodyCancelled).toBe(true);
  });

  it("rejects and cancels a response whose declared body exceeds the cap", async () => {
    let bodyCancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel: () => {
                bodyCancelled = true;
              },
            }),
            {
              status: 200,
              headers: { "Content-Length": String(2 * 1024 * 1024 + 1) },
            },
          ),
      ),
    );

    await expect(
      terminalAction.handler(runtime(), message(), undefined, options()),
    ).rejects.toMatchObject({ code: "TERMINAL_RESPONSE_INVALID" });
    expect(bodyCancelled).toBe(true);
  });

  it("binds an acceptance-unknown transport failure to the dispatched run id", async () => {
    let dispatchedRunId = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        dispatchedRunId =
          new Headers(init?.headers).get("X-Eliza-Terminal-Run-Id") ?? "";
        throw new TypeError("connection reset");
      }),
    );

    let caught: unknown;
    try {
      await terminalAction.handler(runtime(), message(), undefined, options());
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "TERMINAL_REQUEST_OUTCOME_UNKNOWN",
      context: {
        acceptance: "unknown",
        runId: expect.stringMatching(/^run-[0-9a-f-]{36}$/u),
        transportTimeoutMs: 310_000,
      },
    });
    expect((caught as { context: { runId: string } }).context.runId).toBe(
      dispatchedRunId,
    );
  });
});

describe("terminal secret hygiene", () => {
  beforeEach(() => {
    vi.stubEnv("ELIZA_BUILD_VARIANT", "direct");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("removes configured, argument, output, and URI secrets from every returned and persisted surface", async () => {
    const configuredSecret = "same-same-same-same";
    const bearerSecret = "sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const flagSecret = "flag-secret-value-123456789";
    const urlPassword = "url-password-value-123456789";
    const leakyCommand =
      `curl --token=${flagSecret} -H "Authorization: Bearer ${bearerSecret}" ` +
      `https://operator:${urlPassword}@api.example.com/${configuredSecret}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        terminalResponse({
          command: leakyCommand,
          stdout: `result ${configuredSecret} ${bearerSecret}\n`,
          stderr: `postgres://service:${urlPassword}@db.example.com/app`,
        }),
      ),
    );

    const createMemory = vi.fn(
      async () => "00000000-0000-0000-0000-000000000004",
    );
    const rt = {
      agentId: "00000000-0000-0000-0000-000000000001",
      createMemory,
      redactSecrets: vi.fn((text: string) =>
        text.replaceAll(configuredSecret, "[REDACTED:CONFIGURED_SECRET]"),
      ),
    } as unknown as IAgentRuntime;

    const result = await terminalAction.handler(
      rt,
      message(),
      undefined,
      options(leakyCommand),
    );
    const surfaces = JSON.stringify({
      result,
      memory: createMemory.mock.calls,
    });

    for (const secret of [
      configuredSecret,
      bearerSecret,
      flagSecret,
      urlPassword,
    ]) {
      expect(surfaces).not.toContain(secret);
    }
    expect(surfaces).toContain("api.example.com");
    expect(surfaces).toContain("db.example.com");
    expect(surfaces).toContain("[REDACTED:CONFIGURED_SECRET]");
  });

  it("fails closed on a hung loopback terminal run instead of waiting forever", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort(
          Object.assign(new Error("The operation was aborted due to timeout"), {
            name: "TimeoutError",
          }),
        );
      }, 50);
      return controller.signal;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) return;
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            signal.addEventListener("abort", () => reject(signal.reason));
          }),
      ),
    );
    const started = Date.now();
    await expect(
      terminalAction.handler(runtime(), message(), undefined, options()),
    ).rejects.toMatchObject({
      name: ElizaError.name,
      code: "TERMINAL_REQUEST_FAILED",
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
