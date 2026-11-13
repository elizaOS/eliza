import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import type { LoginAuth, LoginSession } from "../../src/sdk/auth.ts";

declare global {
  interface Window {
    ReviewLoginAuth: typeof LoginAuth;
    reviewAuth: LoginAuth;
    reviewRotation: Promise<LoginSession | null> | undefined;
    reviewTokens: Map<string, string>;
  }
}

interface RecoveryCase {
  scenario: number;
  requests: number;
  valid: boolean;
  credential: boolean;
  loggedOut: boolean;
}

const cases: RecoveryCase[] = process.env.ELIZA_ACCESS_EXPIRY_CASES
  ? JSON.parse(await readFile(process.env.ELIZA_ACCESS_EXPIRY_CASES, "utf8"))
  : Array.from({ length: 9 }, (_, scenario) => ({
      scenario,
      requests: scenario === 0 || scenario === 3 ? 0 : 1,
      valid: [0, 1, 6].includes(scenario),
      credential: [0, 1, 4, 6, 8].includes(scenario),
      loggedOut: scenario === 5,
    }));

function token(expired: boolean): string {
  return `fixture.${Buffer.from(
    JSON.stringify({
      userId: "expiry-fixture",
      tenantId: "expiry-tenant",
      exp: Math.floor(Date.now() / 1000) + (expired ? -900 : 3600),
    }),
  ).toString("base64url")}.fixture`;
}

async function waitFor(check: () => boolean): Promise<void> {
  const end = Date.now() + 10_000;
  while (!check()) {
    assert(
      Date.now() < end,
      "The browser request did not reach the loopback server",
    );
    await Bun.sleep(10);
  }
}

test("model cases match real browser access-expiry recovery", async () => {
  const build = await Bun.build({
    entrypoints: [path.resolve(import.meta.dir, "../../src/sdk/auth.ts")],
    target: "browser",
    format: "esm",
    splitting: false,
  });
  assert(build.success, build.logs.map(String).join("\n"));
  const bundle = await build.outputs[0].text();
  let current = 0;
  let requests = 0;
  let release: (() => void) | undefined;
  let requestHadCredential = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/sdk.js") {
        return new Response(bundle, {
          headers: { "content-type": "text/javascript" },
        });
      }
      if (
        url.pathname === "/auth/refresh" ||
        url.pathname === "/proxy/refresh"
      ) {
        requests += 1;
        const proxy = url.pathname === "/proxy/refresh";
        const body = (await request.json()) as { refreshToken?: string };
        requestHadCredential = proxy
          ? request.headers.get("cookie")?.includes("refresh=fixture") === true
          : body.refreshToken === "fixture";
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        const status = [2, 7].includes(current)
          ? 401
          : [4, 8].includes(current)
            ? 503
            : 200;
        return Response.json(
          status === 200
            ? {
                ok: true,
                token: token(false),
                refreshToken: "rotated",
                expiresIn: 900,
              }
            : {
                ok: false,
                error:
                  status === 401
                    ? "Credential rejected"
                    : "Temporarily unavailable",
              },
          {
            status,
            headers:
              proxy && status === 200
                ? {
                    "set-cookie":
                      "refresh=rotated; HttpOnly; Path=/; SameSite=Strict",
                  }
                : undefined,
          },
        );
      }
      if (url.pathname === "/proxy/session" && request.method === "DELETE") {
        return Response.json(
          { ok: true },
          {
            headers: {
              "set-cookie":
                "refresh=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict",
            },
          },
        );
      }
      return new Response(
        '<!doctype html><title>SDK expiry fixture</title><script type="module">import {LoginAuth} from "/sdk.js"; window.ReviewLoginAuth = LoginAuth;</script>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const browser = await chromium.launch({ headless: true });
  const receipts: Record<string, unknown>[] = [];
  try {
    for (const model of cases) {
      current = model.scenario;
      requests = 0;
      release = undefined;
      requestHadCredential = false;
      const proxy = current >= 6;
      const context = await browser.newContext();
      if (proxy) {
        await context.addCookies([
          {
            name: "refresh",
            value: "fixture",
            url: origin,
            httpOnly: true,
            sameSite: "Strict",
          },
        ]);
      }
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.goto(origin);
        await page.waitForFunction(() => Boolean(window.ReviewLoginAuth));
        const initial = await page.evaluate(
          ({ scenario, access, proxy }) => {
            window.reviewTokens = new Map([["steward_session_token", access]]);
            if (scenario !== 3 && !proxy)
              window.reviewTokens.set("steward_refresh_token", "fixture");
            window.reviewAuth = new window.ReviewLoginAuth({
              baseUrl: location.origin,
              allowInsecureBaseUrl: true,
              ...(proxy ? { authProxyUrl: "/proxy" } : {}),
              storage: {
                getItem: (key) => window.reviewTokens.get(key) ?? null,
                setItem: (key, value) => {
                  window.reviewTokens.set(key, value);
                },
                removeItem: (key) => {
                  window.reviewTokens.delete(key);
                },
              },
            });
            const first = window.reviewAuth.getSession();
            const second = window.reviewAuth.getSession();
            if (scenario !== 0 && scenario !== 3)
              window.reviewRotation = window.reviewAuth.refreshSession();
            return {
              first: first !== null,
              second: second !== null,
              directCredential: window.reviewTokens.has(
                "steward_refresh_token",
              ),
            };
          },
          { scenario: current, access: token(current !== 0), proxy },
        );
        expect(initial.first).toBe(current === 0);
        expect(initial.second).toBe(current === 0);
        if (!proxy) expect(initial.directCredential).toBe(current !== 3);
        if (model.requests) {
          await waitFor(() => release !== undefined);
          expect(requests).toBe(1);
          expect(requestHadCredential).toBe(true);
          if (model.loggedOut)
            await page.evaluate(() => window.reviewAuth.signOut());
          release?.();
          await page.evaluate(() => window.reviewRotation);
        }
        const stored = await page.evaluate(() => {
          const value = window.reviewTokens.get("steward_session_token");
          const payload = value
            ? JSON.parse(
                atob(value.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
              )
            : null;
          return {
            valid: Boolean(payload && payload.exp * 1000 > Date.now()),
            credential: window.reviewTokens.has("steward_refresh_token"),
          };
        });
        if (proxy && !model.credential) {
          await page.waitForFunction(
            () => !document.cookie.includes("refresh="),
          );
          const deadline = Date.now() + 10_000;
          while (
            (await context.cookies()).some(
              (cookie) => cookie.name === "refresh",
            )
          ) {
            assert(
              Date.now() < deadline,
              "Rejected proxy credential was not cleared",
            );
            await Bun.sleep(10);
          }
        }
        const credential = proxy
          ? (await context.cookies()).some(
              (cookie) => cookie.name === "refresh",
            )
          : stored.credential;
        expect(stored.valid).toBe(model.valid);
        expect(credential).toBe(model.credential);
        expect(requests).toBe(model.requests);
        expect(errors).toEqual([]);
        receipts.push({
          ...model,
          observed: { ...stored, credential, requests },
          errors,
        });
      } finally {
        release?.();
        await context.close();
      }
    }
  } finally {
    await browser.close();
    server.stop(true);
  }
  const report =
    process.env.ELIZA_ACCESS_EXPIRY_REPORT ??
    testOutputPath("quint-access-expiry", "direct.json");
  await mkdir(path.dirname(report), { recursive: true });
  await writeFile(
    report,
    JSON.stringify({ passed: receipts.length, receipts }, null, 2),
  );
}, 120_000);
