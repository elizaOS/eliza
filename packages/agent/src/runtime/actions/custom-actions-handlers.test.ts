/**
 * Behavioral tests for the custom-action handler surface: buildTestHandler's
 * http/shell/code paths, defToAction's parameter/role/error semantics, and the
 * live-registration registry. Deterministic — the pinned fetch and global fetch
 * are stubbed at the existing test seams, so no real network, DNS, or terminal
 * runs.
 */
import type { CustomActionDef } from "@elizaos/shared";
import type { Action, IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __setPinnedFetchImplForTests,
  buildTestHandler,
  CustomActionTimeoutError,
  registerCustomActionLive,
  setCustomActionsRuntime,
} from "../custom-actions.ts";

// A public IP literal skips DNS inside resolveUrlSafety and goes straight to
// the pinned-fetch seam.
const PUBLIC_URL = "https://93.184.216.34/api";

function makeDef(overrides: Partial<CustomActionDef> = {}): CustomActionDef {
  return {
    id: "act-1",
    name: "TEST_ACTION",
    description: "a test action that fetches data",
    parameters: [{ name: "q", description: "query", required: true }],
    handler: { type: "http", url: `${PUBLIC_URL}?q={{q}}`, method: "GET" },
    enabled: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

afterEach(() => {
  __setPinnedFetchImplForTests(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("http handler", () => {
  it("substitutes URL params encoded and returns the response body", async () => {
    let seenUrl = "";
    __setPinnedFetchImplForTests(async ({ url }) => {
      seenUrl = url.toString();
      return new Response("result text", { status: 200 });
    });
    const handler = buildTestHandler(makeDef());

    const result = await handler({ q: "two words" });

    expect(result).toEqual({ ok: true, output: "result text" });
    // URL substitution must be URI-encoded so param values cannot smuggle
    // path/query structure into the request.
    expect(seenUrl).toBe(`${PUBLIC_URL}?q=two%20words`);
  });

  it("substitutes body params raw and defaults Content-Type for a POST body", async () => {
    let seenBody: string | undefined;
    let seenContentType: string | null | undefined;
    __setPinnedFetchImplForTests(async ({ init }) => {
      seenBody = init.body as string;
      // The legacy custom-action path passes a plain header record, not a
      // Headers instance.
      seenContentType = (init.headers as Record<string, string>)[
        "Content-Type"
      ];
      return new Response("ok", { status: 200 });
    });
    const handler = buildTestHandler(
      makeDef({
        handler: {
          type: "http",
          url: PUBLIC_URL,
          method: "POST",
          bodyTemplate: '{"query":"{{q}}"}',
        },
      }),
    );

    await handler({ q: "hello" });

    expect(seenBody).toBe('{"query":"hello"}');
    expect(seenContentType).toBe("application/json");
  });

  it("blocks internal-network URLs before any request is sent", async () => {
    __setPinnedFetchImplForTests(async () => {
      throw new Error("must not fetch");
    });
    const handler = buildTestHandler(
      makeDef({
        handler: { type: "http", url: "https://10.0.0.8/internal", method: "GET" },
        parameters: [],
      }),
    );

    const result = await handler({});

    expect(result.ok).toBe(false);
    expect(result.output).toContain("internal network");
  });

  it("blocks redirects on the legacy http custom-action path", async () => {
    __setPinnedFetchImplForTests(
      async () =>
        new Response("", {
          status: 302,
          headers: { location: `${PUBLIC_URL}/next` },
        }),
    );
    const handler = buildTestHandler(makeDef({ parameters: [] }));

    const result = await handler({});

    expect(result.ok).toBe(false);
    expect(result.output).toContain("redirects are not allowed");
  });

  it("returns ok=false with the body on a non-2xx response", async () => {
    __setPinnedFetchImplForTests(
      async () => new Response("upstream broke", { status: 503 }),
    );
    const handler = buildTestHandler(makeDef({ parameters: [] }));

    const result = await handler({});

    expect(result.ok).toBe(false);
    expect(result.output).toBe("upstream broke");
  });

  it("rejects an unsupported handler type", async () => {
    const handler = buildTestHandler(
      makeDef({
        handler: { type: "carrier-pigeon" } as never,
      }),
    );

    const result = await handler({});

    expect(result.ok).toBe(false);
    expect(result.output).toContain("Unsupported handler type");
  });
});

describe("shell handler", () => {
  it("shell-escapes param values so quotes cannot break out of the argument", async () => {
    let seenBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        seenBody = String(init.body);
        return new Response("{}", { status: 200 });
      }),
    );
    const handler = buildTestHandler(
      makeDef({
        handler: { type: "shell", command: "echo {{msg}}" },
        parameters: [{ name: "msg", description: "message", required: true }],
      }),
    );

    const result = await handler({ msg: "hi'; rm -rf / #" });

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(seenBody) as { command: string };
    // The injected quote is neutralized by POSIX single-quote escaping.
    expect(parsed.command).toBe(`echo 'hi'\\''; rm -rf / #'`);
  });

  it("posts to the local terminal API and surfaces an HTTP failure", async () => {
    let seenUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seenUrl = String(url);
        return new Response("denied", { status: 403 });
      }),
    );
    const handler = buildTestHandler(
      makeDef({
        handler: { type: "shell", command: "uptime" },
        parameters: [],
      }),
    );

    const result = await handler({});

    expect(seenUrl).toContain("/api/terminal/run");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("HTTP 403");
  });

  it("times out a hung terminal request with CustomActionTimeoutError", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    const handler = buildTestHandler(
      makeDef({
        handler: { type: "shell", command: "sleep 999" },
        parameters: [],
      }),
    );

    const pending = handler({});
    const assertion = expect(pending).rejects.toBeInstanceOf(
      CustomActionTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;
  });
});

describe("code handler", () => {
  it("runs the code with frozen params and returns the result", async () => {
    const handler = buildTestHandler(
      makeDef({
        handler: { type: "code", code: "return `${params.a}-${params.b}`;" },
        parameters: [
          { name: "a", description: "a", required: true },
          { name: "b", description: "b", required: true },
        ],
      }),
    );

    const result = await handler({ a: "x", b: "y" });

    expect(result).toEqual({ ok: true, output: "x-y" });
  });

  it("caps oversized code output at 4000 chars", async () => {
    const handler = buildTestHandler(
      makeDef({
        handler: { type: "code", code: 'return "z".repeat(50000);' },
        parameters: [],
      }),
    );

    const result = await handler({});

    expect(result.ok).toBe(true);
    expect(result.output.length).toBe(4000);
  });

  it("returns 'Done' when the code produces no value", async () => {
    const handler = buildTestHandler(
      makeDef({
        handler: { type: "code", code: "const unused = 1;" },
        parameters: [],
      }),
    );

    const result = await handler({});

    expect(result).toEqual({ ok: true, output: "Done" });
  });
});

describe("registerCustomActionLive / defToAction", () => {
  it("returns null when no runtime has been registered", () => {
    setCustomActionsRuntime(null as unknown as IAgentRuntime);
    expect(registerCustomActionLive(makeDef())).toBeNull();
  });

  it("registers the converted action with the runtime", () => {
    const registerAction = vi.fn();
    setCustomActionsRuntime({
      registerAction,
    } as unknown as IAgentRuntime);

    const action = registerCustomActionLive(makeDef());

    expect(action?.name).toBe("TEST_ACTION");
    expect(registerAction).toHaveBeenCalledWith(action);
    setCustomActionsRuntime(null as unknown as IAgentRuntime);
  });

  it("maps parameters to string schemas and floors the role gate at USER", () => {
    const action = defToActionForTest(makeDef());
    expect(action.parameters).toEqual([
      {
        name: "q",
        description: "query",
        required: true,
        schema: { type: "string" },
      },
    ]);
    expect(action.roleGate).toEqual({ minRole: "USER" });

    const admin = defToActionForTest(makeDef({ requiredRole: "ADMIN" }));
    expect(admin.roleGate).toEqual({ minRole: "ADMIN" });
    // GUEST must not lower the floor below USER.
    const guest = defToActionForTest(makeDef({ requiredRole: "GUEST" }));
    expect(guest.roleGate).toEqual({ minRole: "USER" });
  });

  it("fails a missing required parameter without invoking the handler", async () => {
    __setPinnedFetchImplForTests(async () => {
      throw new Error("must not fetch");
    });
    const action = defToActionForTest(makeDef());

    const result = await action.handler(
      {} as IAgentRuntime,
      {} as never,
      undefined,
      { parameters: {} },
    );

    expect(result).toMatchObject({
      success: false,
      text: "Missing required parameter: q",
    });
  });

  it("stringifies non-string parameter values and returns the handler payload", async () => {
    let seenUrl = "";
    __setPinnedFetchImplForTests(async ({ url }) => {
      seenUrl = url.toString();
      return new Response("num ok", { status: 200 });
    });
    const action = defToActionForTest(makeDef());

    const result = await action.handler(
      {} as IAgentRuntime,
      {} as never,
      undefined,
      { parameters: { q: 42 } },
    );

    expect(seenUrl).toContain("q=42");
    expect(result).toMatchObject({
      success: true,
      text: "num ok",
      data: { actionId: "act-1", params: { q: "42" } },
    });
  });

  it("translates a thrown handler error into a failed ActionResult", async () => {
    __setPinnedFetchImplForTests(async () => {
      throw new Error("socket exploded");
    });
    const action = defToActionForTest(makeDef());

    const result = await action.handler(
      {} as IAgentRuntime,
      {} as never,
      undefined,
      { parameters: { q: "x" } },
    );

    expect(result).toMatchObject({ success: false });
    expect((result as { text: string }).text).toContain("socket exploded");
  });
});

// defToAction is intentionally private; the registry path is its public seam.
function defToActionForTest(def: CustomActionDef): Action {
  const registerAction = vi.fn();
  setCustomActionsRuntime({ registerAction } as unknown as IAgentRuntime);
  const action = registerCustomActionLive(def);
  setCustomActionsRuntime(null as unknown as IAgentRuntime);
  if (!action) throw new Error("registerCustomActionLive returned null");
  return action;
}
