/**
 * Same-named unit coverage for custom-actions.ts. Drives the real module:
 * SSRF/scheme/DNS reject-vs-pin, guarded GET/POST (body cap, headers,
 * User-Agent), live registration + defToAction parameter/role/error
 * semantics, and http/shell/code handler branches. Pinned-fetch and DNS
 * are stubbed only at the exported test seams — no real network.
 */
import type { Action, IAgentRuntime, Memory } from "@elizaos/core";
import type { CustomActionDef, CustomActionHandler } from "@elizaos/shared";
import { resolveServerOnlyPort } from "@elizaos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __setDnsLookupImplForTests,
  __setPinnedFetchImplForTests,
  buildTestHandler,
  CustomActionTimeoutError,
  performGuardedHttpGet,
  performGuardedHttpPost,
  registerCustomActionLive,
  setCustomActionsRuntime,
} from "./custom-actions.ts";

const PUBLIC_IP = "93.184.216.34";
const PUBLIC_URL = `https://${PUBLIC_IP}/api`;
const PUBLIC_HOSTNAME = "example.test";

function makeDef(
  overrides: {
    id?: string;
    name?: string;
    description?: string;
    similes?: string[];
    parameters?: CustomActionDef["parameters"];
    handler?: CustomActionHandler;
    enabled?: boolean;
    requiredRole?: CustomActionDef["requiredRole"];
    createdAt?: string;
    updatedAt?: string;
  } = {},
): CustomActionDef {
  return {
    id: overrides.id ?? "act-1",
    name: overrides.name ?? "TEST_ACTION",
    description: overrides.description ?? "a test action that fetches data",
    similes: overrides.similes,
    parameters: overrides.parameters ?? [
      { name: "q", description: "query", required: true },
    ],
    handler: overrides.handler ?? {
      type: "http",
      url: `${PUBLIC_URL}?q={{q}}`,
      method: "GET",
    },
    enabled: overrides.enabled ?? true,
    requiredRole: overrides.requiredRole,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00Z",
  };
}

function defToActionForTest(def: CustomActionDef): Action {
  const registerAction = vi.fn();
  setCustomActionsRuntime({ registerAction } as unknown as IAgentRuntime);
  const action = registerCustomActionLive(def);
  setCustomActionsRuntime(null as unknown as IAgentRuntime);
  if (!action) throw new Error("registerCustomActionLive returned null");
  return action;
}

function apiPort(): string {
  return String(resolveServerOnlyPort(process.env));
}

afterEach(() => {
  __setPinnedFetchImplForTests(null);
  __setDnsLookupImplForTests(null);
  setCustomActionsRuntime(null as unknown as IAgentRuntime);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CustomActionTimeoutError", () => {
  it("is an Error subclass with a stable name", () => {
    const err = new CustomActionTimeoutError("hung after 15000ms");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CustomActionTimeoutError);
    expect(err.name).toBe("CustomActionTimeoutError");
    expect(err.message).toBe("hung after 15000ms");
  });
});

describe("performGuardedHttpGet — scheme, parse, and host blocklist", () => {
  it("blocks a malformed URL before any request is sent", async () => {
    __setPinnedFetchImplForTests(async () => {
      throw new Error("must not fetch");
    });
    await expect(performGuardedHttpGet("not a url")).resolves.toEqual({
      ok: false,
      status: 0,
      text: "",
      blocked: true,
    });
  });

  it("blocks non-https schemes even for a public IP", async () => {
    __setPinnedFetchImplForTests(async () => {
      throw new Error("must not fetch");
    });
    await expect(
      performGuardedHttpGet(`http://${PUBLIC_IP}/`),
    ).resolves.toEqual({
      ok: false,
      status: 0,
      text: "",
      blocked: true,
    });
    await expect(performGuardedHttpGet(`ftp://${PUBLIC_IP}/`)).resolves.toEqual(
      {
        ok: false,
        status: 0,
        text: "",
        blocked: true,
      },
    );
  });

  it("blocks loopback, link-local, metadata, and .local hosts", async () => {
    __setPinnedFetchImplForTests(async () => {
      throw new Error("must not fetch");
    });
    const blocked = [
      "https://localhost/",
      "https://127.0.0.1/",
      "https://[::1]/",
      "https://0.0.0.0/",
      "https://printer.local/",
      "https://metadata.google.internal/",
      "https://169.254.169.254/",
      "https://10.0.0.8/internal",
      "https://192.168.1.1/",
      "https://172.16.0.1/",
    ];
    for (const url of blocked) {
      const result = await performGuardedHttpGet(url);
      expect(result, url).toEqual({
        ok: false,
        status: 0,
        text: "",
        blocked: true,
      });
    }
  });

  it("allows a public IP literal and pins the request to that address", async () => {
    let pinned = "";
    __setPinnedFetchImplForTests(async ({ target, url }) => {
      pinned = target.pinnedAddress;
      expect(url.toString()).toBe(`${PUBLIC_URL}?x=1`);
      return new Response("pong", { status: 200 });
    });

    const result = await performGuardedHttpGet(`${PUBLIC_URL}?x=1`);

    expect(pinned).toBe(PUBLIC_IP);
    expect(result).toEqual({
      ok: true,
      status: 200,
      text: "pong",
      blocked: false,
    });
  });

  it("returns ok=false with the body on a non-2xx that is not a redirect", async () => {
    __setPinnedFetchImplForTests(
      async () => new Response("nope", { status: 404 }),
    );
    const result = await performGuardedHttpGet(PUBLIC_URL);
    expect(result).toEqual({
      ok: false,
      status: 404,
      text: "nope",
      blocked: false,
    });
  });

  it("returns an empty text body when the response has no content", async () => {
    __setPinnedFetchImplForTests(
      async () => new Response(null, { status: 204 }),
    );
    const result = await performGuardedHttpGet(PUBLIC_URL);
    expect(result).toEqual({
      ok: true,
      status: 204,
      text: "",
      blocked: false,
    });
  });
});

describe("performGuardedHttpGet — DNS pin / reject", () => {
  it("blocks when DNS returns no usable addresses (empty queue)", async () => {
    __setDnsLookupImplForTests(async () => []);
    __setPinnedFetchImplForTests(async () => {
      throw new Error("must not fetch");
    });
    await expect(
      performGuardedHttpGet(`https://${PUBLIC_HOSTNAME}/`),
    ).resolves.toMatchObject({ blocked: true, status: 0 });
  });

  it("blocks whitespace-only and non-string DNS records as an empty queue", async () => {
    __setDnsLookupImplForTests(async () => [
      "   ",
      { address: "" },
      { address: 123 },
      {},
    ]);
    __setPinnedFetchImplForTests(async () => {
      throw new Error("must not fetch");
    });
    await expect(
      performGuardedHttpGet(`https://${PUBLIC_HOSTNAME}/`),
    ).resolves.toMatchObject({ blocked: true });
  });

  it("blocks a hostname whose single DNS record is a private IP", async () => {
    __setDnsLookupImplForTests(async () => "10.0.0.1");
    __setPinnedFetchImplForTests(async () => {
      throw new Error("must not fetch");
    });
    await expect(
      performGuardedHttpGet(`https://${PUBLIC_HOSTNAME}/`),
    ).resolves.toMatchObject({ blocked: true, status: 0 });
  });

  it("blocks when any address in a multi-record set is private", async () => {
    __setDnsLookupImplForTests(async () => [
      { address: PUBLIC_IP },
      { address: "192.168.0.9" },
    ]);
    __setPinnedFetchImplForTests(async () => {
      throw new Error("must not fetch");
    });
    await expect(
      performGuardedHttpGet(`https://${PUBLIC_HOSTNAME}/`),
    ).resolves.toMatchObject({ blocked: true });
  });

  it("pins the first public address of a multi-record set", async () => {
    let pinned = "";
    __setDnsLookupImplForTests(async () => [
      { address: `  ${PUBLIC_IP}  ` },
      { address: "1.1.1.1" },
    ]);
    __setPinnedFetchImplForTests(async ({ target }) => {
      pinned = target.pinnedAddress;
      return new Response("ok", { status: 200 });
    });

    const result = await performGuardedHttpGet(`https://${PUBLIC_HOSTNAME}/x`);

    expect(pinned).toBe(PUBLIC_IP);
    expect(result.ok).toBe(true);
    expect(result.blocked).toBe(false);
  });

  it("blocks when DNS lookup throws", async () => {
    __setDnsLookupImplForTests(async () => {
      throw new Error("ENOTFOUND");
    });
    __setPinnedFetchImplForTests(async () => {
      throw new Error("must not fetch");
    });
    await expect(
      performGuardedHttpGet(`https://${PUBLIC_HOSTNAME}/`),
    ).resolves.toMatchObject({ blocked: true, status: 0 });
  });

  it("throws when DNS yields a non-IP pin that is not a private address", async () => {
    __setDnsLookupImplForTests(async () => ["not-an-ip"]);
    await expect(
      performGuardedHttpGet(`https://${PUBLIC_HOSTNAME}/`),
    ).rejects.toThrow(/internal network addresses/);
  });
});

describe("performGuardedHttpGet — self-API loopback exemption", () => {
  it("allows https loopback only on the agent's own API port, via unpinned fetch", async () => {
    const port = apiPort();
    let fetchedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        fetchedUrl = String(input);
        return new Response("self-api", { status: 200 });
      }),
    );
    __setPinnedFetchImplForTests(async () => {
      throw new Error("loopback exemption must not pin");
    });

    const allowed = `https://127.0.0.1:${port}/health`;
    const result = await performGuardedHttpGet(allowed);

    expect(fetchedUrl).toBe(allowed);
    expect(result).toEqual({
      ok: true,
      status: 200,
      text: "self-api",
      blocked: false,
    });

    const blocked = await performGuardedHttpGet(
      `https://127.0.0.1:${Number(port) + 1}/health`,
    );
    expect(blocked.blocked).toBe(true);
  });
});

describe("performGuardedHttpGet — body cap and headers", () => {
  it("returns a body that fits the caller maxChars, including the exact limit", async () => {
    const body = "z".repeat(16);
    __setPinnedFetchImplForTests(
      async () => new Response(body, { status: 200 }),
    );
    const result = await performGuardedHttpGet(PUBLIC_URL, { maxChars: 16 });
    expect(result.ok).toBe(true);
    expect(result.text).toBe(body);
  });

  it("throws when the response exceeds the configured character cap", async () => {
    __setPinnedFetchImplForTests(
      async () => new Response("z".repeat(17), { status: 200 }),
    );
    await expect(
      performGuardedHttpGet(PUBLIC_URL, { maxChars: 16 }),
    ).rejects.toThrow(/16-character safety limit/);
  });

  it("sends the browser-like default User-Agent and lets caller headers win", async () => {
    const seen: string[] = [];
    __setPinnedFetchImplForTests(async ({ init }) => {
      seen.push(new Headers(init.headers).get("user-agent") ?? "");
      return new Response("ok", { status: 200 });
    });

    await performGuardedHttpGet(PUBLIC_URL);
    await performGuardedHttpGet(PUBLIC_URL, {
      headers: { "User-Agent": "CallerUA/9", Accept: "text/plain" },
    });

    expect(seen[0]).toContain("Mozilla/5.0");
    expect(seen[1]).toBe("CallerUA/9");
  });
});

describe("performGuardedHttpPost", () => {
  it("POSTs the body as application/json unless Content-Type is overridden", async () => {
    const hops: Array<{
      method?: string;
      contentType: string | null;
      body: unknown;
    }> = [];
    __setPinnedFetchImplForTests(async ({ init }) => {
      hops.push({
        method: init.method,
        contentType: new Headers(init.headers).get("content-type"),
        body: init.body,
      });
      return new Response('{"ok":true}', { status: 200 });
    });

    const defaulted = await performGuardedHttpPost(PUBLIC_URL, {
      body: '{"a":1}',
    });
    expect(defaulted.ok).toBe(true);
    expect(defaulted.text).toBe('{"ok":true}');
    expect(hops[0]).toEqual({
      method: "POST",
      contentType: "application/json",
      body: '{"a":1}',
    });

    await performGuardedHttpPost(PUBLIC_URL, {
      body: "raw",
      headers: { "Content-Type": "text/plain" },
    });
    expect(hops[1]?.contentType).toBe("text/plain");
    expect(hops[1]?.body).toBe("raw");
  });

  it("blocks a POST to a private host without sending the body", async () => {
    __setPinnedFetchImplForTests(async () => {
      throw new Error("must not fetch");
    });
    await expect(
      performGuardedHttpPost("https://10.1.2.3/hook", { body: "secret" }),
    ).resolves.toEqual({
      ok: false,
      status: 0,
      text: "",
      blocked: true,
    });
  });
});

describe("setCustomActionsRuntime / registerCustomActionLive", () => {
  it("returns null when no runtime has been registered", () => {
    expect(registerCustomActionLive(makeDef())).toBeNull();
  });

  it("hot-registers the converted Action and copies contexts, similes, and role", () => {
    const registerAction = vi.fn();
    setCustomActionsRuntime({
      registerAction,
    } as unknown as IAgentRuntime);

    const action = registerCustomActionLive(
      makeDef({
        similes: ["FETCH_IT"],
        requiredRole: "ADMIN",
      }),
    );

    expect(action?.name).toBe("TEST_ACTION");
    expect(action?.similes).toEqual(["FETCH_IT"]);
    expect(action?.contexts).toEqual([
      "general",
      "automation",
      "connectors",
      "agent_internal",
    ]);
    expect(action?.roleGate).toEqual({ minRole: "ADMIN" });
    expect(registerAction).toHaveBeenCalledTimes(1);
    expect(registerAction).toHaveBeenCalledWith(action);
  });

  it("defaults missing similes to [] and floors GUEST at USER", () => {
    const guest = defToActionForTest(makeDef({ requiredRole: "GUEST" }));
    expect(guest.similes).toEqual([]);
    expect(guest.roleGate).toEqual({ minRole: "USER" });

    const owner = defToActionForTest(makeDef({ requiredRole: "OWNER" }));
    expect(owner.roleGate).toEqual({ minRole: "OWNER" });

    const unset = defToActionForTest(makeDef());
    expect(unset.roleGate).toEqual({ minRole: "USER" });
  });
});

describe("defToAction handler — parameters and errors", () => {
  it("fails a missing required parameter without invoking the transport", async () => {
    __setPinnedFetchImplForTests(async () => {
      throw new Error("must not fetch");
    });
    const action = defToActionForTest(makeDef());
    const result = await action.handler(
      {} as IAgentRuntime,
      {} as Memory,
      undefined,
      { parameters: {} },
    );
    expect(result).toMatchObject({
      success: false,
      text: "Missing required parameter: q",
    });
  });

  it("omits an optional missing/null parameter and stringifies non-strings", async () => {
    let seenUrl = "";
    __setPinnedFetchImplForTests(async ({ url }) => {
      seenUrl = url.toString();
      return new Response("ok", { status: 200 });
    });
    const action = defToActionForTest(
      makeDef({
        parameters: [
          { name: "q", description: "query", required: true },
          { name: "extra", description: "optional", required: false },
        ],
        handler: {
          type: "http",
          url: `${PUBLIC_URL}?q={{q}}&extra={{extra}}`,
          method: "GET",
        },
      }),
    );

    const result = await action.handler(
      {} as IAgentRuntime,
      {} as Memory,
      undefined,
      { parameters: { q: 7, extra: null } },
    );

    expect(seenUrl).toBe(`${PUBLIC_URL}?q=7&extra=`);
    expect(result).toMatchObject({
      success: true,
      text: "ok",
      data: { actionId: "act-1", params: { q: "7" } },
    });
  });

  it("translates a thrown transport error into a failed ActionResult", async () => {
    __setPinnedFetchImplForTests(async () => {
      throw new Error("socket exploded");
    });
    const action = defToActionForTest(makeDef());
    const result = await action.handler(
      {} as IAgentRuntime,
      {} as Memory,
      undefined,
      { parameters: { q: "x" } },
    );
    expect(result).toMatchObject({ success: false });
    expect((result as { text: string }).text).toContain("socket exploded");
  });

  it("maps parameters onto string schemas", () => {
    const action = defToActionForTest(makeDef());
    expect(action.parameters).toEqual([
      {
        name: "q",
        description: "query",
        required: true,
        schema: { type: "string" },
      },
    ]);
  });
});

describe("buildTestHandler — http", () => {
  it("URI-encodes URL params, substitutes missing values as empty, and leaves body raw", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    let seenContentType: string | undefined;
    __setPinnedFetchImplForTests(async ({ url, init }) => {
      seenUrl = url.toString();
      seenBody = init.body;
      seenContentType = (init.headers as Record<string, string>)[
        "Content-Type"
      ];
      return new Response("posted", { status: 200 });
    });
    const handler = buildTestHandler(
      makeDef({
        parameters: [
          { name: "q", description: "query", required: true },
          { name: "note", description: "note", required: false },
        ],
        handler: {
          type: "http",
          url: `${PUBLIC_URL}?q={{q}}`,
          method: "POST",
          bodyTemplate: '{"q":"{{q}}","note":"{{note}}"}',
        },
      }),
    );

    const result = await handler({ q: "a b" });

    expect(result).toEqual({ ok: true, output: "posted" });
    expect(seenUrl).toBe(`${PUBLIC_URL}?q=a%20b`);
    expect(seenBody).toBe('{"q":"a b","note":""}');
    expect(seenContentType).toBe("application/json");
  });

  it("does not send a body on GET or HEAD even when a template is set", async () => {
    const bodies: unknown[] = [];
    __setPinnedFetchImplForTests(async ({ init }) => {
      bodies.push(init.body);
      return new Response("ok", { status: 200 });
    });

    await buildTestHandler(
      makeDef({
        parameters: [],
        handler: {
          type: "http",
          url: PUBLIC_URL,
          method: "GET",
          bodyTemplate: '{"no":"send"}',
        },
      }),
    )({});
    await buildTestHandler(
      makeDef({
        parameters: [],
        handler: {
          type: "http",
          url: PUBLIC_URL,
          method: "HEAD",
          bodyTemplate: '{"no":"send"}',
        },
      }),
    )({});

    expect(bodies).toEqual([undefined, undefined]);
  });

  it("keeps a caller Content-Type and defaults method to GET when empty", async () => {
    let method = "";
    let contentType: string | undefined;
    __setPinnedFetchImplForTests(async ({ init }) => {
      method = String(init.method);
      contentType = (init.headers as Record<string, string>)["Content-Type"];
      return new Response("ok", { status: 200 });
    });
    const handler = buildTestHandler(
      makeDef({
        parameters: [],
        handler: {
          type: "http",
          url: PUBLIC_URL,
          method: "",
          headers: { "Content-Type": "text/plain" },
          bodyTemplate: "ignored-on-get",
        },
      }),
    );

    await handler({});
    expect(method).toBe("GET");
    expect(contentType).toBe("text/plain");
  });

  it("blocks internal URLs and HTTP redirects on the legacy path", async () => {
    __setPinnedFetchImplForTests(async () => {
      throw new Error("must not fetch");
    });
    const blocked = await buildTestHandler(
      makeDef({
        parameters: [],
        handler: {
          type: "http",
          url: "https://127.0.0.1/secret",
          method: "GET",
        },
      }),
    )({});
    expect(blocked.ok).toBe(false);
    expect(blocked.output).toContain("internal network");

    __setPinnedFetchImplForTests(
      async () =>
        new Response("", {
          status: 302,
          headers: { location: `${PUBLIC_URL}/next` },
        }),
    );
    const redirected = await buildTestHandler(makeDef({ parameters: [] }))({});
    expect(redirected.ok).toBe(false);
    expect(redirected.output).toContain("redirects are not allowed");
  });

  it("rejects an oversized HTTP body at the 4000-character safety limit", async () => {
    __setPinnedFetchImplForTests(
      async () => new Response("z".repeat(4001), { status: 200 }),
    );
    await expect(
      buildTestHandler(makeDef({ parameters: [] }))({}),
    ).rejects.toThrow(/4000-character safety limit/);
  });

  it("rejects an unsupported handler type without touching the transport", async () => {
    __setPinnedFetchImplForTests(async () => {
      throw new Error("must not fetch");
    });
    const handler = buildTestHandler(
      makeDef({
        handler: { type: "carrier-pigeon" } as unknown as CustomActionHandler,
      }),
    );
    await expect(handler({})).resolves.toEqual({
      ok: false,
      output: "Unsupported handler type: carrier-pigeon",
    });
  });
});

describe("buildTestHandler — shell", () => {
  it("POSIX-escapes interpolated values and posts to the local terminal API", async () => {
    let seenUrl = "";
    let seenBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        seenUrl = String(url);
        seenBody = String(init.body);
        return new Response("{}", { status: 200 });
      }),
    );
    const handler = buildTestHandler(
      makeDef({
        parameters: [{ name: "msg", description: "message", required: true }],
        handler: { type: "shell", command: "echo {{msg}}" },
      }),
    );

    const result = await handler({ msg: "hi'; rm -rf / #" });
    const parsed = JSON.parse(seenBody) as {
      command: string;
      clientId: string;
    };

    expect(result).toEqual({
      ok: true,
      output: `Executed: ${parsed.command}`,
    });
    expect(seenUrl).toBe(`http://localhost:${apiPort()}/api/terminal/run`);
    expect(parsed.clientId).toBe("runtime-shell-action");
    expect(parsed.command).toBe(`echo 'hi'\\''; rm -rf / #'`);
  });

  it("surfaces a non-2xx terminal response and times out a hung one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("denied", { status: 403 })),
    );
    const failed = await buildTestHandler(
      makeDef({
        parameters: [],
        handler: { type: "shell", command: "uptime" },
      }),
    )({});
    expect(failed).toEqual({
      ok: false,
      output: "Terminal request failed: HTTP 403",
    });

    vi.unstubAllGlobals();
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    const pending = buildTestHandler(
      makeDef({
        parameters: [],
        handler: { type: "shell", command: "sleep 999" },
      }),
    )({});
    const assertion = expect(pending).rejects.toBeInstanceOf(
      CustomActionTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });
});

describe("buildTestHandler — code", () => {
  it("runs with frozen params, returns Done for no value, and stringifies a result", async () => {
    const done = await buildTestHandler(
      makeDef({
        parameters: [],
        handler: { type: "code", code: "const unused = 1;" },
      }),
    )({});
    expect(done).toEqual({ ok: true, output: "Done" });

    const echoed = await buildTestHandler(
      makeDef({
        parameters: [
          { name: "a", description: "a", required: true },
          { name: "b", description: "b", required: true },
        ],
        handler: {
          type: "code",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture is JS source evaluated by the code handler.
          code: "return `${params.a}-${params.b}`;",
        },
      }),
    )({ a: "x", b: "y" });
    expect(echoed).toEqual({ ok: true, output: "x-y" });

    const frozen = buildTestHandler(
      makeDef({
        parameters: [],
        handler: {
          type: "code",
          code: "params.injected = 1; return 1;",
        },
      }),
    );
    await expect(frozen({})).rejects.toThrow();
  });

  it("blocks code-handler fetch to an internal host and rejects redirects", async () => {
    __setPinnedFetchImplForTests(async () => {
      throw new Error("must not fetch");
    });
    await expect(
      buildTestHandler(
        makeDef({
          parameters: [],
          handler: {
            type: "code",
            code: "return await fetch('https://127.0.0.1/secret');",
          },
        }),
      )({}),
    ).rejects.toThrow(/internal network addresses/);

    __setPinnedFetchImplForTests(
      async () =>
        new Response("", {
          status: 301,
          headers: { location: `${PUBLIC_URL}/next` },
        }),
    );
    await expect(
      buildTestHandler(
        makeDef({
          parameters: [],
          handler: {
            type: "code",
            code: `return await fetch('${PUBLIC_URL}');`,
          },
        }),
      )({}),
    ).rejects.toThrow(/redirects are not allowed for code custom actions/);
  });

  it("lets code-handler fetch read a public pinned response", async () => {
    __setPinnedFetchImplForTests(
      async () => new Response("from-code", { status: 200 }),
    );
    const result = await buildTestHandler(
      makeDef({
        parameters: [],
        handler: {
          type: "code",
          code: `return await (await fetch('${PUBLIC_URL}')).text();`,
        },
      }),
    )({});
    expect(result).toEqual({ ok: true, output: "from-code" });
  });
});
