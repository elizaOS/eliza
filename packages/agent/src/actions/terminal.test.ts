/**
 * Covers TERMINAL_SHELL input resolution, store-build gating, request
 * identity, and remaining transport-parse branches that the sibling
 * effect/truncation/role suites do not drive. Fetch is stubbed only as
 * the loopback boundary; assertions inspect the action's resolved command,
 * headers, receipts, and typed failures.
 */
import {
  _resetBuildVariantForTests,
  type ActionParameters,
  ElizaError,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeOutputBlock,
  normalizeTerminalOutput,
  resolveTerminalTransportTimeoutMs,
  terminalAction,
} from "./terminal.ts";

function runtime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    redactSecrets: vi.fn((text: string) => text),
    ...overrides,
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

function options(
  parameters: unknown = { command: "echo hello" },
): HandlerOptions {
  return { parameters: parameters as ActionParameters };
}

function terminalResponse(
  init: RequestInit | undefined,
  overrides: Record<string, unknown> = {},
): Response {
  const runId = new Headers(init?.headers).get("X-Eliza-Terminal-Run-Id");
  if (!runId) throw new Error("terminal action omitted its run identity");
  return new Response(
    JSON.stringify({
      ok: true,
      runId,
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

function stubFetch(
  factory: (init?: RequestInit) => Response | Promise<Response> = (init) =>
    terminalResponse(init),
) {
  const fetchSpy = vi.fn(
    async (_input: string | URL | Request, init?: RequestInit) => factory(init),
  );
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

async function dispatchedBody(fetchSpy: ReturnType<typeof stubFetch>) {
  const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
  const raw = init?.body;
  if (typeof raw !== "string") {
    throw new Error("terminal action omitted a JSON request body");
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("terminalAction contract", () => {
  it("is the owner-gated TERMINAL_SHELL action with shell-direct tags", () => {
    expect(terminalAction.name).toBe("TERMINAL_SHELL");
    expect(terminalAction.roleGate).toEqual({ minRole: "OWNER" });
    expect(terminalAction.contexts).toEqual([
      "terminal",
      "code",
      "files",
      "admin",
    ]);
    expect(terminalAction.similes).toEqual([
      "RUN_IN_TERMINAL",
      "EXECUTE_COMMAND",
      "TERMINAL",
      "RUN_SHELL",
    ]);
    expect(terminalAction.tags).toEqual(
      expect.arrayContaining([
        "domain:system",
        "resource:shell",
        "capability:execute",
        "effect:receipt-required",
      ]),
    );
    expect(terminalAction.parameters).toEqual([
      {
        name: "command",
        description: "The shell command to execute in the terminal",
        required: true,
        schema: { type: "string" },
      },
    ]);
  });

  it("keeps complete output blocks and is identity-normalizing", () => {
    expect(completeOutputBlock("")).toBe("(empty)");
    expect(completeOutputBlock("ok\n")).toBe("ok");
    expect(normalizeTerminalOutput("verbatim")).toBe("verbatim");
    expect(resolveTerminalTransportTimeoutMs()).toBe(310_000);
  });
});

describe("terminalAction validate and store-build gate", () => {
  beforeEach(() => {
    vi.stubEnv("ELIZA_BUILD_VARIANT", "direct");
    _resetBuildVariantForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetBuildVariantForTests();
  });

  it("validates true on a direct build and false on a store build", async () => {
    expect(await terminalAction.validate?.(runtime(), message())).toBe(true);

    vi.stubEnv("ELIZA_BUILD_VARIANT", "store");
    _resetBuildVariantForTests();
    expect(await terminalAction.validate?.(runtime(), message())).toBe(false);
  });

  it("blocks the handler on a store build before any loopback fetch", async () => {
    const fetchSpy = stubFetch();
    vi.stubEnv("ELIZA_BUILD_VARIANT", "store");
    _resetBuildVariantForTests();

    const result = await terminalAction.handler(
      runtime(),
      message(),
      undefined,
      options(),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      data: {
        actionName: "TERMINAL_SHELL",
        suppressPostActionContinuation: true,
        terminal: { storeBuildBlocked: true },
      },
    });
    expect(result?.text).toContain("direct download");
    expect(result?.text).toContain("Terminal commands");
  });
});

describe("terminalAction command resolution", () => {
  beforeEach(() => {
    vi.stubEnv("ELIZA_BUILD_VARIANT", "direct");
    _resetBuildVariantForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetBuildVariantForTests();
  });

  it("fails closed when no command can be resolved", async () => {
    const fetchSpy = stubFetch();
    for (const parameters of [
      {},
      { command: "" },
      { command: "   " },
      { command: 12 },
      { shellCommand: "\n" },
      { arguments: "" },
      { arguments: "not-json" },
      { arguments: '["echo", "hello"]' },
      { arguments: '"echo hello"' },
      { arguments: "null" },
      { arguments: '{"command":"   "}' },
      { arguments: "<![CDATA[   ]]>" },
    ]) {
      const result = await terminalAction.handler(
        runtime(),
        message(),
        undefined,
        options(parameters),
      );
      expect(result).toMatchObject({
        success: false,
        error: "TERMINAL_COMMAND_REQUIRED",
        text: "A non-empty shell command is required.",
      });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("prefers parameters.command over shellCommand and JSON arguments", async () => {
    const fetchSpy = stubFetch();
    await terminalAction.handler(
      runtime(),
      message(),
      undefined,
      options({
        command: " echo winner ",
        shellCommand: "echo loser",
        arguments: '{"command":"echo json","shellCommand":"echo json-shell"}',
      }),
    );
    expect(await dispatchedBody(fetchSpy)).toMatchObject({
      command: "echo winner",
      clientId: "runtime-terminal-action",
      captureOutput: true,
    });
  });

  it("uses shellCommand when command is absent", async () => {
    const fetchSpy = stubFetch();
    await terminalAction.handler(
      runtime(),
      message(),
      undefined,
      options({ shellCommand: " echo alias " }),
    );
    expect((await dispatchedBody(fetchSpy)).command).toBe("echo alias");
  });

  it("reads command from MCP-style JSON arguments", async () => {
    const fetchSpy = stubFetch();
    await terminalAction.handler(
      runtime(),
      message(),
      undefined,
      options({ arguments: '{"command":"echo from-json"}' }),
    );
    expect((await dispatchedBody(fetchSpy)).command).toBe("echo from-json");
  });

  it("reads nested shellCommand from JSON arguments as the last fallback", async () => {
    const fetchSpy = stubFetch();
    await terminalAction.handler(
      runtime(),
      message(),
      undefined,
      options({ arguments: '{"shellCommand":"echo nested"}' }),
    );
    expect((await dispatchedBody(fetchSpy)).command).toBe("echo nested");
  });

  it("ignores invalid JSON wrappers so an explicit command still wins", async () => {
    const fetchSpy = stubFetch();
    await terminalAction.handler(
      runtime(),
      message(),
      undefined,
      options({ command: "echo explicit", arguments: "{not json" }),
    );
    expect((await dispatchedBody(fetchSpy)).command).toBe("echo explicit");
  });

  it("unwraps a leaked CDATA wrapper into a bash -lc invocation", async () => {
    const fetchSpy = stubFetch();
    await terminalAction.handler(
      runtime(),
      message(),
      undefined,
      options({ command: "<![CDATA[echo hello]]>" }),
    );
    const encoded = Buffer.from("echo hello", "utf8").toString("base64");
    expect((await dispatchedBody(fetchSpy)).command).toBe(
      `bash -lc "$(printf %s ${encoded} | base64 -d)"`,
    );
  });

  it("treats empty CDATA as a missing command", async () => {
    const result = await terminalAction.handler(
      runtime(),
      message(),
      undefined,
      options({ command: "<![CDATA[   ]]>" }),
    );
    expect(result).toMatchObject({ error: "TERMINAL_COMMAND_REQUIRED" });
  });
});

describe("terminalAction request identity and parse failures", () => {
  beforeEach(() => {
    vi.stubEnv("ELIZA_BUILD_VARIANT", "direct");
    _resetBuildVariantForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetBuildVariantForTests();
  });

  it("forwards the terminal run token on header and body when set", async () => {
    vi.stubEnv("ELIZA_TERMINAL_RUN_TOKEN", "tok-secret");
    const fetchSpy = stubFetch();
    await terminalAction.handler(runtime(), message(), undefined, options());
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("X-Eliza-Terminal-Token")).toBe(
      "tok-secret",
    );
    expect(await dispatchedBody(fetchSpy)).toMatchObject({
      terminalToken: "tok-secret",
      clientId: "runtime-terminal-action",
    });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toMatch(
      /\/api\/terminal\/run$/u,
    );
    expect(init.method).toBe("POST");
  });

  it("omits the token header and body field when unset", async () => {
    const fetchSpy = stubFetch();
    await terminalAction.handler(runtime(), message(), undefined, options());
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).has("X-Eliza-Terminal-Token")).toBe(false);
    expect(await dispatchedBody(fetchSpy)).not.toHaveProperty("terminalToken");
  });

  it("throws the caller abort reason before dispatch when already aborted", async () => {
    const fetchSpy = stubFetch();
    const caller = new AbortController();
    const reason = new Error("turn cancelled");
    caller.abort(reason);
    await expect(
      terminalAction.handler(runtime(), message(), undefined, {
        ...options(),
        abortSignal: caller.signal,
      } as HandlerOptions & { abortSignal: AbortSignal }),
    ).rejects.toBe(reason);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats a non-numeric Content-Length as an acceptance-unknown outcome", async () => {
    let bodyCancelled = false;
    stubFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel: () => {
              bodyCancelled = true;
            },
          }),
          {
            status: 200,
            headers: { "Content-Length": "12.5" },
          },
        ),
    );
    await expect(
      terminalAction.handler(runtime(), message(), undefined, options()),
    ).rejects.toMatchObject({
      code: "TERMINAL_REQUEST_OUTCOME_UNKNOWN",
      context: { acceptance: "unknown" },
    });
    expect(bodyCancelled).toBe(true);
  });

  it("treats a missing response body as an acceptance-unknown outcome", async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    await expect(
      terminalAction.handler(runtime(), message(), undefined, options()),
    ).rejects.toMatchObject({
      code: "TERMINAL_REQUEST_OUTCOME_UNKNOWN",
      context: { acceptance: "unknown" },
    });
  });

  it("treats invalid UTF-8 as an acceptance-unknown outcome", async () => {
    stubFetch(
      () =>
        new Response(new Uint8Array([0xff, 0xfe, 0xfd]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(
      terminalAction.handler(runtime(), message(), undefined, options()),
    ).rejects.toMatchObject({
      name: ElizaError.name,
      code: "TERMINAL_REQUEST_OUTCOME_UNKNOWN",
    });
  });

  it("treats invalid JSON as an acceptance-unknown outcome", async () => {
    stubFetch(
      () =>
        new Response("not-json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(
      terminalAction.handler(runtime(), message(), undefined, options()),
    ).rejects.toMatchObject({
      code: "TERMINAL_REQUEST_OUTCOME_UNKNOWN",
    });
  });

  it("treats a non-object JSON body as an acceptance-unknown outcome", async () => {
    stubFetch(
      () =>
        new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(
      terminalAction.handler(runtime(), message(), undefined, options()),
    ).rejects.toMatchObject({
      code: "TERMINAL_REQUEST_OUTCOME_UNKNOWN",
    });
  });

  it.each([
    ["ok:false", { ok: false }],
    ["stdout number", { stdout: 12 }],
    ["stderr number", { stderr: 1 }],
    ["timedOut string", { timedOut: "false" }],
    ["exitCode float", { exitCode: 1.5 }],
    ["maxDurationMs zero", { maxDurationMs: 0 }],
    ["maxDurationMs negative", { maxDurationMs: -1 }],
    ["maxDurationMs float", { maxDurationMs: 1.5 }],
  ])("rejects incomplete execution proof for %s", async (_name, override) => {
    stubFetch((init) => terminalResponse(init, override));
    await expect(
      terminalAction.handler(runtime(), message(), undefined, options()),
    ).rejects.toMatchObject({
      code: "TERMINAL_REQUEST_OUTCOME_UNKNOWN",
      context: { acceptance: "unknown" },
    });
  });

  it("falls back to an inline report when createMemory is absent", async () => {
    stubFetch();
    const result = await terminalAction.handler(
      runtime(),
      message(),
      undefined,
      options(),
    );
    expect(result?.success).toBe(true);
    expect(result?.text).toContain("No attachment was stored for this output.");
    expect(result?.text).toContain("Shell command completed:");
    expect(
      (result?.promptData as { readView?: unknown } | undefined)?.readView,
    ).toBeUndefined();
    expect(result?.data).toMatchObject({
      actionName: "TERMINAL_SHELL",
      outputAttachment: undefined,
      outputAttachmentMemoryId: undefined,
      suppressVisibleCallback: true,
    });
  });

  it("counts unicode line separators as extra channel-visible lines", async () => {
    stubFetch((init) =>
      terminalResponse(init, { stdout: "first\u2028second\u2029third" }),
    );
    const result = await terminalAction.handler(
      runtime(),
      message(),
      undefined,
      options(),
    );
    expect(result).toMatchObject({
      success: true,
      userFacingText:
        "The command finished (exit 0) with 3 lines of output; ask me about specifics instead of dumping it into chat.",
      verifiedUserFacing: false,
    });
  });
});
