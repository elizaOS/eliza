/** Host, principal and request-lifetime contracts for the existing local API dispatcher. */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveInboxRequestAuthorization } from "../src/api/inbox-request-authorization.ts";

afterEach(() => vi.unstubAllEnvs());

import {
  dispatchApiRoute,
  registerInProcessApi,
} from "../src/api/in-process-api.ts";
import {
  getAuthenticatedInProcessAuthorization,
  isAuthenticatedInProcessRequest,
} from "../src/api/in-process-request.ts";
import type { RouteKernel } from "../src/api/route-kernel.ts";
import {
  runWithViewClient,
  type ViewClientScope,
} from "../src/runtime/view-client-context.ts";

function fixture() {
  const runtime = {} as IAgentRuntime,
    host = {},
    controller = new AbortController();
  const scope: ViewClientScope = {
    hostKey: host,
    request: {
      runtime,
      signal: controller.signal,
      authorization: { ok: true, role: "OWNER", identityId: "paired-identity" },
    },
  };
  const calls: string[] = [];
  const kernel = (name: string): RouteKernel => ({
    handle: async (req, res) => {
      calls.push(name);
      expect(isAuthenticatedInProcessRequest(req)).toBe(true);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          name,
          authority: resolveInboxRequestAuthorization(
            req,
            "POST",
            "/api/views/notes/navigate",
            getAuthenticatedInProcessAuthorization(req) ?? {
              ok: false,
              role: "NONE",
            },
          ),
        }),
      );
    },
  });
  const args = {
    runtime,
    hostKey: host,
    inProcess: true,
    isAuthorized: () => true,
    method: "POST",
    path: "/api/views/notes/navigate",
    headers: { "Content-Type": "application/json" },
    body: { clientId: "owned-renderer" },
  };
  return { runtime, host, controller, scope, calls, kernel, args };
}

describe("scoped in-process host dispatch", () => {
  it("selects the original host rather than another host or legacy runtime fallback", async () => {
    const f = fixture(),
      other = {};
    const cleanup = [
      registerInProcessApi(f.runtime, f.kernel("legacy")),
      registerInProcessApi(f.runtime, f.kernel("original"), f.host),
      registerInProcessApi(f.runtime, f.kernel("other"), other),
    ];
    try {
      const result = await runWithViewClient(f.scope, () =>
        dispatchApiRoute(f.args),
      );
      expect(result).toEqual({
        status: 200,
        headers: { "content-type": "application/json" },
        body: { name: "original", authority: f.scope.request?.authorization },
      });
      expect(f.calls).toEqual(["original"]);
    } finally {
      for (const fn of cleanup) fn();
    }
  });
  it.each(["host", "runtime", "authorization", "retired"])(
    "rejects a mismatched or expired original request: %s",
    async (kind) => {
      const f = fixture(),
        close = registerInProcessApi(f.runtime, f.kernel("owned"), f.host);
      try {
        if (!f.scope.request) throw new Error("Fixture scope missing");
        if (kind === "host") f.scope.hostKey = {};
        if (kind === "runtime")
          f.scope.request = {
            ...f.scope.request,
            runtime: {} as IAgentRuntime,
          };
        if (kind === "authorization")
          f.scope.request = {
            ...f.scope.request,
            authorization: { ok: false, role: "NONE" },
          };
        if (kind === "retired") f.controller.abort();
        expect(
          (await runWithViewClient(f.scope, () => dispatchApiRoute(f.args)))
            .status,
        ).toBe(403);
        expect(f.calls).toEqual([]);
      } finally {
        close();
      }
    },
  );
  it("does not fall back when the exact host kernel is missing", async () => {
    const f = fixture(),
      close = registerInProcessApi(f.runtime, f.kernel("legacy"));
    try {
      expect(
        (await runWithViewClient(f.scope, () => dispatchApiRoute(f.args)))
          .status,
      ).toBe(503);
      expect(f.calls).toEqual([]);
    } finally {
      close();
    }
  });
  it("old unregister callbacks cannot remove newer registrations for either scope", async () => {
    const f = fixture(),
      old = registerInProcessApi(f.runtime, f.kernel("old"), f.host),
      newer = registerInProcessApi(f.runtime, f.kernel("new"), f.host);
    const oldDefault = registerInProcessApi(f.runtime, f.kernel("old-default")),
      newDefault = registerInProcessApi(f.runtime, f.kernel("new-default"));
    try {
      old();
      oldDefault();
      expect(
        (await runWithViewClient(f.scope, () => dispatchApiRoute(f.args))).body,
      ).toMatchObject({ name: "new" });
      const { hostKey: _host, ...legacy } = f.args;
      expect((await dispatchApiRoute(legacy)).body).toMatchObject({
        name: "new-default",
      });
      newer();
      expect(
        (await runWithViewClient(f.scope, () => dispatchApiRoute(f.args)))
          .status,
      ).toBe(503);
    } finally {
      old();
      newer();
      oldDefault();
      newDefault();
    }
  });
  it("aborts an in-flight nested dispatch when its originating request closes", async () => {
    const f = fixture();
    let ready: () => void = () => {};
    const started = new Promise<void>((resolve) => (ready = resolve));
    const close = registerInProcessApi(
      f.runtime,
      {
        handle: async (req) => {
          ready();
          await new Promise<void>((resolve) =>
            req.once("aborted", () => resolve()),
          );
        },
      },
      f.host,
    );
    try {
      const pending = runWithViewClient(f.scope, () =>
        dispatchApiRoute(f.args),
      );
      await started;
      f.controller.abort(
        new DOMException("Original request closed", "AbortError"),
      );
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      close();
    }
  });
  it("an async child retains no usable authority after request retirement", async () => {
    const f = fixture(),
      close = registerInProcessApi(f.runtime, f.kernel("owned"), f.host);
    let release: () => void = () => {};
    const waiting = new Promise<void>((resolve) => (release = resolve));
    try {
      const background = runWithViewClient(f.scope, async () => {
        await waiting;
        return dispatchApiRoute(f.args);
      });
      f.controller.abort();
      release();
      expect((await background).status).toBe(403);
      expect(f.calls).toEqual([]);
    } finally {
      close();
    }
  });
  it("preserves a verified USER role without promoting it to root OWNER", async () => {
    const f = fixture(),
      close = registerInProcessApi(f.runtime, f.kernel("owned"), f.host);
    if (!f.scope.request) throw Error("Missing scope");
    f.scope.request.authorization = {
      ok: true,
      role: "USER",
      identityId: "scoped-user",
    };
    vi.stubEnv("ELIZA_API_TOKEN", "synthetic-scoped-root");
    try {
      expect(
        (
          await runWithViewClient(f.scope, () =>
            dispatchApiRoute({
              ...f.args,
              headers: {
                ...f.args.headers,
                Authorization: "Bearer synthetic-scoped-root",
              },
            }),
          )
        ).body,
      ).toMatchObject({
        authority: { ok: true, role: "USER", identityId: "scoped-user" },
      });
    } finally {
      close();
    }
  });
  it("HTTP-like fields cannot create authenticated in-process provenance", () => {
    const forged = {
      headers: {
        "x-eliza-in-process": "true",
        "x-eliza-owner-id": "paired-identity",
      },
      inProcess: true,
      authorization: { ok: true, role: "OWNER" },
    };
    expect(isAuthenticatedInProcessRequest(forged)).toBe(false);
    expect(getAuthenticatedInProcessAuthorization(forged)).toBeUndefined();
  });
});
