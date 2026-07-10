/**
 * Edge matrix for the guarded fetch's bounded redirect follower
 * (performGuardedHttpRequest). Deterministic — the pinned-fetch seam returns
 * scripted 3xx/2xx responses so no real network or DNS runs. Covers: the happy
 * rename 301, relative Location, every-hop SSRF re-check, scheme downgrade,
 * malformed/absent Location, the self-API null-target exemption as a redirect
 * destination, max-hop exhaustion, 301/302/303/307/308 method+body semantics,
 * and cross-origin credential-header stripping.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  __setDnsLookupImplForTests,
  __setPinnedFetchImplForTests,
  buildTestHandler,
  performGuardedHttpGet,
  performGuardedHttpPost,
  registerCustomActionLive,
  setCustomActionsRuntime,
} from "../custom-actions.ts";

// Distinct public IP literals ⇒ resolveUrlSafety skips DNS and pins directly,
// and distinct IPs are distinct origins (origin = scheme://host:port).
const ORIGIN_A = "https://93.184.216.34";
const ORIGIN_B = "https://93.184.216.35";

type Hop = {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: BodyInit | null;
};

// Scripts the pinned-fetch seam from a URL→Response route table while recording
// every hop (url + method + headers) so a test can assert what actually crossed
// the wire on each redirect.
function scriptFetch(routes: Record<string, () => Response>): {
  hops: Hop[];
} {
  const hops: Hop[] = [];
  __setPinnedFetchImplForTests(async ({ url, init }) => {
    const headers: Record<string, string> = {};
    (init.headers as Headers).forEach((v, k) => {
      headers[k] = v;
    });
    hops.push({
      url: url.toString(),
      method: init.method,
      headers,
      body: init.body,
    });
    const make = routes[url.toString()];
    if (!make) throw new Error(`no scripted response for ${url.toString()}`);
    return make();
  });
  return { hops };
}

function redirect(status: number, location: string): () => Response {
  return () => new Response("", { status, headers: { location } });
}

afterEach(() => {
  __setPinnedFetchImplForTests(null);
  __setDnsLookupImplForTests(null);
});

describe("guarded fetch — bounded redirect follower", () => {
  it("follows a single 301 to the renamed target and returns its body", async () => {
    const { hops } = scriptFetch({
      [`${ORIGIN_A}/old`]: redirect(301, `${ORIGIN_A}/new`),
      [`${ORIGIN_A}/new`]: () => new Response("renamed body", { status: 200 }),
    });

    const result = await performGuardedHttpGet(`${ORIGIN_A}/old`);

    expect(result.blocked).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.text).toBe("renamed body");
    expect(hops.map((h) => h.url)).toEqual([
      `${ORIGIN_A}/old`,
      `${ORIGIN_A}/new`,
    ]);
  });

  it("resolves a relative Location against the current URL", async () => {
    const { hops } = scriptFetch({
      [`${ORIGIN_A}/a/old`]: redirect(302, "../b/new"),
      [`${ORIGIN_A}/b/new`]: () => new Response("moved", { status: 200 }),
    });

    const result = await performGuardedHttpGet(`${ORIGIN_A}/a/old`);

    expect(result.text).toBe("moved");
    expect(hops[1]?.url).toBe(`${ORIGIN_A}/b/new`);
  });

  it("blocks a redirect that downgrades the scheme to http", async () => {
    const { hops } = scriptFetch({
      [`${ORIGIN_A}/old`]: redirect(301, "http://93.184.216.34/new"),
    });

    const result = await performGuardedHttpGet(`${ORIGIN_A}/old`);

    expect(result.blocked).toBe(true);
    expect(result.status).toBe(301);
    // Never fetched the insecure destination.
    expect(hops).toHaveLength(1);
  });

  it("blocks a malformed Location header", async () => {
    // An absolute Location with an unterminated IPv6 host fails URL parsing even
    // against a valid base (a relative-looking value would just resolve
    // same-origin and be followed safely — the throwing path needs a genuinely
    // unparseable absolute URL).
    const { hops } = scriptFetch({
      [`${ORIGIN_A}/old`]: redirect(302, "https://[oops"),
    });

    const result = await performGuardedHttpGet(`${ORIGIN_A}/old`);

    expect(result.blocked).toBe(true);
    expect(hops).toHaveLength(1);
  });

  it("blocks a 3xx with no Location header", async () => {
    const { hops } = scriptFetch({
      [`${ORIGIN_A}/old`]: () => new Response("", { status: 302 }),
    });

    const result = await performGuardedHttpGet(`${ORIGIN_A}/old`);

    expect(result.blocked).toBe(true);
    expect(hops).toHaveLength(1);
  });

  it("re-runs the SSRF guard on every hop — blocks a redirect to a private host", async () => {
    const { hops } = scriptFetch({
      [`${ORIGIN_A}/old`]: redirect(301, "https://10.0.0.1/internal"),
    });

    const result = await performGuardedHttpGet(`${ORIGIN_A}/old`);

    expect(result.blocked).toBe(true);
    // The internal host is never actually fetched.
    expect(hops.map((h) => h.url)).toEqual([`${ORIGIN_A}/old`]);
  });

  it("blocks a redirect into the self-API loopback exemption (null target)", async () => {
    // resolveUrlSafety exempts the agent's own API port with a null target; that
    // exemption is for a caller-typed URL, not a destination an external host can
    // 301 the agent into.
    const { hops } = scriptFetch({
      [`${ORIGIN_A}/old`]: redirect(301, "https://localhost/internal"),
    });

    const result = await performGuardedHttpGet(`${ORIGIN_A}/old`);

    expect(result.blocked).toBe(true);
    expect(hops).toHaveLength(1);
  });

  it("stops after the redirect cap is exhausted", async () => {
    const { hops } = scriptFetch({
      [`${ORIGIN_A}/0`]: redirect(301, `${ORIGIN_A}/1`),
      [`${ORIGIN_A}/1`]: redirect(301, `${ORIGIN_A}/2`),
      [`${ORIGIN_A}/2`]: redirect(301, `${ORIGIN_A}/3`),
      [`${ORIGIN_A}/3`]: redirect(301, `${ORIGIN_A}/4`),
      [`${ORIGIN_A}/4`]: () => new Response("too deep", { status: 200 }),
    });

    const result = await performGuardedHttpGet(`${ORIGIN_A}/0`);

    expect(result.blocked).toBe(true);
    // 4 fetches (hops 0..3): the 4th 3xx lands on the cap and is not followed.
    expect(hops.map((h) => h.url)).toEqual([
      `${ORIGIN_A}/0`,
      `${ORIGIN_A}/1`,
      `${ORIGIN_A}/2`,
      `${ORIGIN_A}/3`,
    ]);
  });

  it("303 demotes a POST to a bodyless GET and drops Content-Type", async () => {
    const { hops } = scriptFetch({
      [`${ORIGIN_A}/submit`]: redirect(303, `${ORIGIN_A}/result`),
      [`${ORIGIN_A}/result`]: () => new Response("ok", { status: 200 }),
    });

    const result = await performGuardedHttpPost(`${ORIGIN_A}/submit`, {
      body: JSON.stringify({ a: 1 }),
    });

    expect(result.text).toBe("ok");
    expect(hops[0]?.method).toBe("POST");
    expect(hops[1]?.method).toBe("GET");
    expect(hops[1]?.headers["content-type"]).toBeUndefined();
  });

  it("307 preserves method and body across the redirect", async () => {
    const { hops } = scriptFetch({
      [`${ORIGIN_A}/submit`]: redirect(307, `${ORIGIN_A}/mirror`),
      [`${ORIGIN_A}/mirror`]: () => new Response("mirrored", { status: 200 }),
    });

    const result = await performGuardedHttpPost(`${ORIGIN_A}/submit`, {
      body: JSON.stringify({ a: 1 }),
    });

    expect(result.text).toBe("mirrored");
    expect(hops[0]?.method).toBe("POST");
    expect(hops[1]?.method).toBe("POST");
    expect(hops[1]?.headers["content-type"]).toBe("application/json");
  });

  it("strips credential headers on a cross-origin hop but keeps them same-origin", async () => {
    const sameThenCross = scriptFetch({
      [`${ORIGIN_A}/start`]: redirect(302, `${ORIGIN_A}/same`),
      [`${ORIGIN_A}/same`]: redirect(302, `${ORIGIN_B}/cross`),
      [`${ORIGIN_B}/cross`]: () => new Response("landed", { status: 200 }),
    });

    const result = await performGuardedHttpGet(`${ORIGIN_A}/start`, {
      headers: { Authorization: "Bearer secret", Cookie: "sid=abc" },
    });

    expect(result.text).toBe("landed");
    const [start, same, cross] = sameThenCross.hops;
    // Same-origin hop keeps the credentials.
    expect(start?.headers.authorization).toBe("Bearer secret");
    expect(same?.headers.authorization).toBe("Bearer secret");
    expect(same?.headers.cookie).toBe("sid=abc");
    // Cross-origin hop drops them.
    expect(cross?.headers.authorization).toBeUndefined();
    expect(cross?.headers.cookie).toBeUndefined();
  });
});

describe("guarded fetch — public guard surface", () => {
  it("blocks invalid URLs and non-HTTPS schemes before fetching", async () => {
    const { hops } = scriptFetch({});

    await expect(performGuardedHttpGet("not a url")).resolves.toEqual({
      ok: false,
      status: 0,
      text: "",
      blocked: true,
    });
    await expect(
      performGuardedHttpGet("http://93.184.216.34"),
    ).resolves.toEqual({
      ok: false,
      status: 0,
      text: "",
      blocked: true,
    });
    expect(hops).toHaveLength(0);
  });

  it("blocks hostnames that resolve to private addresses before fetching", async () => {
    __setDnsLookupImplForTests(async () => [{ address: "10.0.0.1" }]);
    const { hops } = scriptFetch({});

    const result = await performGuardedHttpGet("https://example.test/data");

    expect(result.blocked).toBe(true);
    expect(hops).toHaveLength(0);
  });

  it("pins hostname fetches to the first public DNS answer", async () => {
    __setDnsLookupImplForTests(async () => [
      { address: "93.184.216.34" },
      { address: "93.184.216.35" },
    ]);
    const { hops } = scriptFetch({
      "https://example.test/data": () =>
        new Response("public", { status: 200 }),
    });

    const result = await performGuardedHttpGet("https://example.test/data");

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      text: "public",
      blocked: false,
    });
    expect(hops).toHaveLength(1);
  });

  it("caps response bodies for callers that request a smaller read window", async () => {
    scriptFetch({
      [`${ORIGIN_A}/long`]: () => new Response("0123456789", { status: 200 }),
    });

    const result = await performGuardedHttpGet(`${ORIGIN_A}/long`, {
      maxChars: 5,
    });

    expect(result.text).toBe("01234");
  });
});

describe("custom action HTTP handler", () => {
  it("templates URL parameters and JSON bodies before sending", async () => {
    const { hops } = scriptFetch({
      [`${ORIGIN_A}/echo/a%20b`]: () =>
        new Response("accepted", { status: 201 }),
    });
    const handler = buildTestHandler({
      id: "http-echo",
      name: "HTTP Echo",
      description: "Posts a templated body",
      enabled: true,
      parameters: [
        { name: "id", description: "Identifier", required: true },
        { name: "name", description: "Display name", required: true },
      ],
      handler: {
        type: "http",
        method: "POST",
        url: `${ORIGIN_A}/echo/{{id}}`,
        headers: {},
        bodyTemplate: '{"name":"{{name}}"}',
      },
    } as Parameters<typeof buildTestHandler>[0]);

    const result = await handler({ id: "a b", name: "Ada" });

    expect(result).toEqual({ ok: true, output: "accepted" });
    expect(hops[0]).toMatchObject({
      url: `${ORIGIN_A}/echo/a%20b`,
      method: "POST",
    });
    expect(hops[0]?.headers["content-type"]).toBe("application/json");
    expect(hops[0]?.body).toBe('{"name":"Ada"}');
  });

  it("does not attach a body to GET and HEAD handlers", async () => {
    const { hops } = scriptFetch({
      [`${ORIGIN_A}/lookup/Ada`]: () => new Response("found", { status: 200 }),
    });
    const handler = buildTestHandler({
      id: "http-get",
      name: "HTTP Get",
      description: "Fetches without a body",
      enabled: true,
      parameters: [{ name: "name", description: "Name", required: true }],
      handler: {
        type: "http",
        method: "GET",
        url: `${ORIGIN_A}/lookup/{{name}}`,
        headers: {},
        bodyTemplate: "ignored",
      },
    } as Parameters<typeof buildTestHandler>[0]);

    const result = await handler({ name: "Ada" });

    expect(result).toEqual({ ok: true, output: "found" });
    expect(hops[0]?.body).toBeUndefined();
  });

  it("rejects redirects for legacy HTTP custom actions", async () => {
    scriptFetch({
      [`${ORIGIN_A}/old`]: redirect(302, `${ORIGIN_A}/new`),
    });
    const handler = buildTestHandler({
      id: "http-redirect",
      name: "HTTP Redirect",
      description: "Redirects",
      enabled: true,
      parameters: [],
      handler: {
        type: "http",
        method: "GET",
        url: `${ORIGIN_A}/old`,
        headers: {},
      },
    } as Parameters<typeof buildTestHandler>[0]);

    const result = await handler({});

    expect(result).toEqual({
      ok: false,
      output: "Blocked: redirects are not allowed for HTTP custom actions",
    });
  });

  it("rejects blocked HTTP custom action targets", async () => {
    const { hops } = scriptFetch({});
    const handler = buildTestHandler({
      id: "http-blocked",
      name: "HTTP Blocked",
      description: "Blocked",
      enabled: true,
      parameters: [],
      handler: {
        type: "http",
        method: "GET",
        url: "https://169.254.169.254/latest/meta-data",
        headers: {},
      },
    } as Parameters<typeof buildTestHandler>[0]);

    const result = await handler({});

    expect(result).toEqual({
      ok: false,
      output: "Blocked: cannot make requests to internal network addresses",
    });
    expect(hops).toHaveLength(0);
  });

  it("reports unsupported handler types explicitly", async () => {
    const handler = buildTestHandler({
      id: "unsupported",
      name: "Unsupported",
      description: "Unsupported",
      enabled: true,
      parameters: [],
      handler: { type: "bogus" },
    } as Parameters<typeof buildTestHandler>[0]);

    await expect(handler({})).resolves.toEqual({
      ok: false,
      output: "Unsupported handler type: bogus",
    });
  });
});

describe("custom action registration", () => {
  it("returns null when no runtime has been installed", () => {
    expect(
      registerCustomActionLive({
        id: "no-runtime",
        name: "No Runtime",
        description: "No runtime",
        enabled: true,
        parameters: [],
        handler: {
          type: "http",
          method: "GET",
          url: `${ORIGIN_A}/noop`,
          headers: {},
        },
      } as Parameters<typeof registerCustomActionLive>[0]),
    ).toBeNull();
  });

  it("registers converted actions on the installed runtime", () => {
    const actions: unknown[] = [];
    setCustomActionsRuntime({
      registerAction(action: unknown) {
        actions.push(action);
      },
    } as Parameters<typeof setCustomActionsRuntime>[0]);

    const action = registerCustomActionLive({
      id: "live",
      name: "Live Action",
      description: "Registers live action",
      enabled: true,
      parameters: [{ name: "id", description: "Identifier", required: true }],
      handler: {
        type: "http",
        method: "GET",
        url: `${ORIGIN_A}/{{id}}`,
        headers: {},
      },
    } as Parameters<typeof registerCustomActionLive>[0]);

    expect(action?.name).toBe("Live Action");
    expect(actions).toEqual([action]);
  });
});
