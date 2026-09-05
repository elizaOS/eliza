import { describe, expect, it, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import type { LookupFunction } from "node:net";
import { withRuntimeEnvironment } from "../../../shared/src/runtime-env.ts";

import {
  assertPublicJwksDestination,
  clearOidcJwksCacheForTests,
  createPublicJwksTransport,
  getPublicRemoteJWKSet,
  type PublicJwksTransportDependencies,
} from "../oidc";

class JwksTransportHarness {
  readonly request = new EventEmitter() as ClientRequest;
  readonly deadlines = new Set<ReturnType<typeof setTimeout>>();
  requestCalls = 0;
  requestDestroyed = false;
  requestEnded = false;
  responseResumed = false;
  responseDestroyed = false;
  destroyError: Error | undefined;
  timeoutMs: number | undefined;
  lookupCalls = 0;
  requestLookup: LookupFunction | undefined;
  readonly lookup = (() => {}) as LookupFunction;
  private responseHandler: ((response: IncomingMessage) => void) | undefined;
  private deadlineCallbacks = new Map<
    ReturnType<typeof setTimeout>,
    () => void
  >();

  constructor() {
    this.request.destroy = (() => {
      this.requestDestroyed = true;
      if (this.destroyError) throw this.destroyError;
      return this.request;
    }) as ClientRequest["destroy"];
    this.request.end = (() => {
      this.requestEnded = true;
      return this.request;
    }) as ClientRequest["end"];
  }

  readonly dependencies: Readonly<PublicJwksTransportDependencies> =
    Object.freeze({
      request: ((
        _url: URL,
        options: RequestOptions | HttpsRequestOptions,
        handler: (response: IncomingMessage) => void,
      ) => {
        this.requestCalls += 1;
        this.timeoutMs = options.timeout as number | undefined;
        this.requestLookup = options.lookup;
        this.responseHandler = handler;
        return this.request;
      }) as PublicJwksTransportDependencies["request"],
      createLookup: ((_resource: string) => {
        this.lookupCalls += 1;
        return this.lookup;
      }) as PublicJwksTransportDependencies["createLookup"],
      setDeadline: (callback, _timeoutMs) => {
        const deadline = Object.create(null) as ReturnType<typeof setTimeout>;
        this.deadlines.add(deadline);
        this.deadlineCallbacks.set(deadline, callback);
        return deadline;
      },
      clearDeadline: (deadline) => {
        this.deadlines.delete(deadline);
        this.deadlineCallbacks.delete(deadline);
      },
    });

  respond(
    statusCode: number,
    headers: IncomingMessage["headers"] = {},
  ): EventEmitter {
    if (!this.responseHandler) throw new Error("request was not created");
    const response = new EventEmitter() as EventEmitter & IncomingMessage;
    response.statusCode = statusCode;
    response.headers = headers;
    response.resume = (() => {
      this.responseResumed = true;
      return response;
    }) as IncomingMessage["resume"];
    response.destroy = (() => {
      this.responseDestroyed = true;
      if (this.destroyError) throw this.destroyError;
      return response;
    }) as IncomingMessage["destroy"];
    this.responseHandler(response);
    return response;
  }

  fireDeadline(): void {
    const callback = this.deadlineCallbacks.values().next().value;
    if (!callback) throw new Error("deadline was not scheduled");
    callback();
  }
}

describe("assertPublicJwksDestination SSRF guard", () => {
  it("preserves upstream status, headers, and body and cleans up request resources", async () => {
    const harness = new JwksTransportHarness();
    const transport = createPublicJwksTransport(harness.dependencies, {
      timeoutMs: 1234,
      maxBytes: 32,
    });
    const controller = new AbortController();
    const pending = transport("https://idp.example.com/jwks", {
      signal: controller.signal,
    });
    const response = harness.respond(401, {
      "content-type": "application/json",
    });
    response.emit("data", Buffer.from('{"error":"unauthorized"}'));
    response.emit("end");

    const result = await pending;
    expect(result.status).toBe(401);
    expect(result.headers.get("content-type")).toBe("application/json");
    expect(await result.text()).toBe('{"error":"unauthorized"}');
    expect(harness.timeoutMs).toBe(1234);
    expect(harness.lookupCalls).toBe(1);
    expect(harness.requestLookup).toBe(harness.lookup);
    expect(harness.requestEnded).toBe(true);
    expect(harness.deadlines.size).toBe(0);
    controller.abort();
    expect(harness.requestDestroyed).toBe(false);
  });

  it("drops non-conforming upstream bytes for bodyless success statuses", async () => {
    for (const status of [204, 205]) {
      const harness = new JwksTransportHarness();
      const pending = createPublicJwksTransport(harness.dependencies)(
        "https://idp.example.com/jwks",
      );
      const response = harness.respond(status);
      response.emit("data", Buffer.from("hostile-body"));
      response.emit("end");

      const result = await pending;
      expect(result.status).toBe(status);
      expect(await result.text()).toBe("");
      expect(harness.deadlines.size).toBe(0);
    }
  });

  it("rejects redirects and oversized declared or streamed bodies", async () => {
    const cases = [
      {
        status: 302,
        headers: {},
        body: Buffer.alloc(0),
        error: "redirects are not allowed",
      },
      {
        status: 200,
        headers: { "content-length": "9" },
        body: Buffer.alloc(0),
        error: "response is too large",
      },
      {
        status: 200,
        headers: {},
        body: Buffer.alloc(9),
        error: "response is too large",
      },
    ] as const;

    for (const testCase of cases) {
      const harness = new JwksTransportHarness();
      const transport = createPublicJwksTransport(harness.dependencies, {
        timeoutMs: 5000,
        maxBytes: 8,
      });
      const pending = transport("https://idp.example.com/jwks");
      const response = harness.respond(testCase.status, testCase.headers);
      if (testCase.body.byteLength > 0) response.emit("data", testCase.body);
      await expect(pending).rejects.toThrow(testCase.error);
      response.emit("data", Buffer.alloc(1024));
      response.emit("end");
      expect(harness.deadlines.size).toBe(0);
      expect(harness.requestDestroyed).toBe(true);
      if (testCase.status === 302 || "content-length" in testCase.headers) {
        expect(harness.responseDestroyed).toBe(true);
        expect(harness.responseResumed).toBe(false);
      }
    }
  });

  it("preserves fixed terminal errors when best-effort socket destruction throws", async () => {
    const harness = new JwksTransportHarness();
    harness.destroyError = new Error("injected destroy detail");
    const pending = createPublicJwksTransport(harness.dependencies)(
      "https://idp.example.com/jwks",
    );
    expect(() => harness.respond(302)).not.toThrow();
    await expect(pending).rejects.toThrow(
      "OIDC jwksUri redirects are not allowed",
    );
    expect(harness.responseDestroyed).toBe(true);
    expect(harness.requestDestroyed).toBe(true);
  });

  it("rejects deadline, request timeout, and request failure", async () => {
    for (const event of ["deadline", "timeout", "error"] as const) {
      const harness = new JwksTransportHarness();
      const transport = createPublicJwksTransport(harness.dependencies);
      const pending = transport("https://idp.example.com/jwks");
      if (event === "deadline") harness.fireDeadline();
      else
        harness.request.emit(
          event,
          event === "error" ? new Error("socket detail") : undefined,
        );
      await expect(pending).rejects.toThrow(
        event === "error"
          ? "OIDC JWKS request failed"
          : "OIDC JWKS request timed out",
      );
      expect(harness.deadlines.size).toBe(0);
      if (event !== "error") expect(harness.requestDestroyed).toBe(true);
    }
  });

  it("cleans up when pinned request construction fails synchronously", async () => {
    const harness = new JwksTransportHarness();
    const controller = new AbortController();
    const dependencies: Readonly<PublicJwksTransportDependencies> =
      Object.freeze({
        ...harness.dependencies,
        request: (() => {
          throw new Error("request-construction-secret");
        }) as PublicJwksTransportDependencies["request"],
      });

    await expect(
      createPublicJwksTransport(dependencies)("https://idp.example.com/jwks", {
        signal: controller.signal,
      }),
    ).rejects.toThrow("OIDC JWKS request failed");
    expect(harness.deadlines.size).toBe(0);
    controller.abort();
    expect(harness.requestDestroyed).toBe(false);
  });

  it("rejects preflight and mid-flight aborts without retaining listeners", async () => {
    const preflightHarness = new JwksTransportHarness();
    const preflightController = new AbortController();
    preflightController.abort();
    await expect(
      createPublicJwksTransport(preflightHarness.dependencies)(
        "https://idp.example.com/jwks",
        {
          signal: preflightController.signal,
        },
      ),
    ).rejects.toThrow("OIDC JWKS request was aborted");
    expect(preflightHarness.requestCalls).toBe(0);
    expect(preflightHarness.deadlines.size).toBe(0);

    const activeHarness = new JwksTransportHarness();
    const activeController = new AbortController();
    const pending = createPublicJwksTransport(activeHarness.dependencies)(
      "https://idp.example.com/jwks",
      { signal: activeController.signal },
    );
    activeController.abort();
    await expect(pending).rejects.toThrow("OIDC JWKS request was aborted");
    expect(activeHarness.requestDestroyed).toBe(true);
    expect(activeHarness.deadlines.size).toBe(0);
  });

  it("rejects interrupted and failed response streams", async () => {
    for (const event of ["aborted", "error"] as const) {
      const harness = new JwksTransportHarness();
      const pending = createPublicJwksTransport(harness.dependencies)(
        "https://idp.example.com/jwks",
      );
      const response = harness.respond(200);
      response.emit(
        event,
        event === "error" ? new Error("upstream detail") : undefined,
      );
      await expect(pending).rejects.toThrow(
        event === "aborted"
          ? "OIDC JWKS response was interrupted"
          : "OIDC JWKS response failed",
      );
      expect(harness.deadlines.size).toBe(0);
    }
  });
  it("rejects IPv4-mapped IPv6 literals that embed private IPv4 targets", async () => {
    await expect(
      assertPublicJwksDestination("https://[::ffff:10.0.0.1]/jwks"),
    ).rejects.toThrow();
    await expect(
      assertPublicJwksDestination("https://[::ffff:a00:1]/jwks"),
    ).rejects.toThrow();
  });

  it("rejects IPv4-compatible and translated IPv6 literals", async () => {
    await expect(
      assertPublicJwksDestination("https://[::127.0.0.1]/jwks"),
    ).rejects.toThrow();
    await expect(
      assertPublicJwksDestination("https://[::7f00:1]/jwks"),
    ).rejects.toThrow();
    await expect(
      assertPublicJwksDestination("https://[::ffff:0:127.0.0.1]/jwks"),
    ).rejects.toThrow();
  });

  it("rejects special-purpose IPv4 and IPv6 literals", async () => {
    for (const uri of [
      "https://192.0.2.1/jwks",
      "https://198.51.100.1/jwks",
      "https://203.0.113.1/jwks",
      "https://[100::1]/jwks",
      "https://[3fff::1]/jwks",
    ]) {
      await expect(assertPublicJwksDestination(uri), uri).rejects.toThrow();
    }
  });

  it("rejects NAT64 literals that embed private IPv4 targets", async () => {
    // 64:ff9b::/96 well-known prefix — 10.0.0.1 and 169.254.169.254 embedded.
    await expect(
      assertPublicJwksDestination("https://[64:ff9b::a00:1]/jwks"),
    ).rejects.toThrow();
    await expect(
      assertPublicJwksDestination("https://[64:ff9b::10.0.0.1]/jwks"),
    ).rejects.toThrow();
    await expect(
      assertPublicJwksDestination("https://[64:ff9b::a9fe:a9fe]/jwks"),
    ).rejects.toThrow();
    // 64:ff9b:1::/48 is local-use and non-globally-reachable.
    await expect(
      assertPublicJwksDestination("https://[64:ff9b:1:c0a8:1:100::]/jwks"),
    ).rejects.toThrow();
    // RFC 8215 does not define an embedded IPv4 position for this local-use
    // prefix, so it must be rejected even when the low 32 bits look public.
    await expect(
      assertPublicJwksDestination("https://[64:ff9b:1:beef::808:808]/jwks"),
    ).rejects.toThrow();
  });

  it("rejects 6to4 literals that embed private IPv4 targets", async () => {
    // 2002::/16 — 10.0.0.1 and 127.0.0.1 embedded.
    await expect(
      assertPublicJwksDestination("https://[2002:a00:1::]/jwks"),
    ).rejects.toThrow();
    await expect(
      assertPublicJwksDestination("https://[2002:7f00:1::]/jwks"),
    ).rejects.toThrow();
  });

  it("rejects Teredo literals outright", async () => {
    await expect(
      assertPublicJwksDestination(
        "https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/jwks",
      ),
    ).rejects.toThrow();
  });

  it("still allows transition literals that embed public IPv4 targets", async () => {
    // Well-known NAT64/6to4 embeddings of 8.8.8.8 are public.
    await expect(
      assertPublicJwksDestination("https://[64:ff9b::808:808]/jwks"),
    ).resolves.toBeUndefined();
    await expect(
      assertPublicJwksDestination("https://[2002:808:808::]/jwks"),
    ).resolves.toBeUndefined();
  });

  it("bounds the tenant-controlled remote JWKS cache", async () => {
    clearOidcJwksCacheForTests();
    const first = await getPublicRemoteJWKSet(
      "https://idp.example.com/jwks",
      "tenant:first",
    );
    for (let index = 0; index < 256; index += 1) {
      await getPublicRemoteJWKSet(
        `https://idp.example.com/jwks/${index}`,
        `tenant:${index}`,
      );
    }
    const reloaded = await getPublicRemoteJWKSet(
      "https://idp.example.com/jwks",
      "tenant:first",
    );
    expect(reloaded).not.toBe(first);
    clearOidcJwksCacheForTests();
  });

  it("applies the request-local JWKS maximum age to each cache decision", async () => {
    clearOidcJwksCacheForTests();
    let now = 1_000_000;
    const nowSpy = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const first = await withRuntimeEnvironment(
        { STEWARD_OIDC_JWKS_MAX_AGE_MS: "60000" },
        () =>
          getPublicRemoteJWKSet(
            "https://idp.example.com/jwks",
            "tenant:runtime-age",
          ),
      );
      now += 60_001;
      const retained = await withRuntimeEnvironment(
        { STEWARD_OIDC_JWKS_MAX_AGE_MS: "120000" },
        () =>
          getPublicRemoteJWKSet(
            "https://idp.example.com/jwks",
            "tenant:runtime-age",
          ),
      );
      expect(retained).toBe(first);

      const rebuilt = await withRuntimeEnvironment(
        { STEWARD_OIDC_JWKS_MAX_AGE_MS: "60000" },
        () =>
          getPublicRemoteJWKSet(
            "https://idp.example.com/jwks",
            "tenant:runtime-age",
          ),
      );
      expect(rebuilt).not.toBe(first);
    } finally {
      nowSpy.mockRestore();
      clearOidcJwksCacheForTests();
    }
  });
});
