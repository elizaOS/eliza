/** Exercises the browser SDK and real WebAuthn ceremonies against the embedded API with a virtual authenticator and a seeded verified-email grant. */
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "@playwright/test";
import type { LoginAuth } from "../src/sdk/auth";
import type { startEmbeddedLogin } from "../src/server/embedded";

declare global {
  interface Window {
    loginAuth: LoginAuth;
  }
}

test("registers and signs in with a browser passkey and rejects consumed challenges", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-login-browser-"));
  const assets = new Map<string, Blob>();
  let login: Awaited<ReturnType<typeof startEmbeddedLogin>> | undefined;
  let browser: Browser | undefined;
  const frontend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/auth/")) {
        if (!login) return new Response("Login is starting", { status: 503 });
        return fetch(
          new Request(
            `http://127.0.0.1:${login.port}${url.pathname}${url.search}`,
            request,
          ),
        );
      }
      if (url.pathname === "/") {
        return new Response(
          '<!doctype html><html><head><title>Login browser integration</title></head><body><script type="module">import { LoginAuth } from "/sdk/auth.js"; window.loginAuth = new LoginAuth({ baseUrl: location.origin });</script></body></html>',
          {
            headers: { "Content-Type": "text/html" },
          },
        );
      }
      const asset = assets.get(url.pathname);
      return asset
        ? new Response(asset, { headers: { "Content-Type": asset.type } })
        : new Response("Not found", { status: 404 });
    },
  });
  const origin = `http://localhost:${frontend.port}`;
  const environment = {
    NODE_ENV: "test",
    STEWARD_ACK_LOCAL_CUSTODY: "true",
    STEWARD_PGLITE_PATH: join(directory, "database"),
    STEWARD_PGLITE_MEMORY: "false",
    STEWARD_MASTER_PASSWORD: randomBytes(32).toString("hex"),
    STEWARD_JWT_SECRET: randomBytes(32).toString("hex"),
    STEWARD_KDF_SALT: randomBytes(32).toString("hex"),
    STEWARD_AUDIT_HMAC_KEY: randomBytes(32).toString("hex"),
    PASSKEY_RP_ID: "localhost",
    PASSKEY_ORIGIN: origin,
    APP_URL: origin,
  };
  const previous = new Map(
    [...Object.keys(environment), "STEWARD_EMBEDDED", "STEWARD_DB_MODE"].map(
      (key) => [key, process.env[key]],
    ),
  );
  Object.assign(process.env, environment);
  try {
    const entry = join(import.meta.dir, "../src/sdk/auth.ts");
    const outdir = join(directory, "bundle");
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        entry,
        "--target=browser",
        "--conditions=eliza-source",
        "--format=esm",
        "--splitting",
        `--outdir=${outdir}`,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const [exitCode, diagnostics] = await Promise.all([
      build.exited,
      new Response(build.stderr).text(),
    ]);
    if (exitCode !== 0)
      throw new Error(`Browser SDK build failed: ${diagnostics}`);
    for (const filename of await readdir(outdir))
      assets.set(`/sdk/${filename}`, Bun.file(join(outdir, filename)));

    const { startEmbeddedLogin } = await import("../src/server/embedded");
    login = await startEmbeddedLogin({ port: 0 });
    const { _seedEmailGrantForTests } = await import(
      "../src/server/api/src/routes/auth"
    );
    const { defaultAuthTenantId } = await import(
      "../src/server/api/src/services/default-auth-tenant"
    );
    const grant = randomBytes(32).toString("base64url");
    const email = "passkey-browser@example.test";
    // Email delivery is outside this test: seed its verified result, then exercise
    // the actual grant consumption, browser authenticator and server verifier.
    await _seedEmailGrantForTests(
      grant,
      email,
      defaultAuthTenantId(),
      "personal",
    );
    const scopedGrant = randomBytes(32).toString("base64url");
    await _seedEmailGrantForTests(
      scopedGrant,
      email,
      defaultAuthTenantId(),
      "tenant",
    );
    for (const body of [
      { email, emailGrant: grant, tenantId: defaultAuthTenantId() },
      { email, emailGrant: scopedGrant },
    ]) {
      const wrongScope = await fetch(
        `${origin}/auth/passkey/register/options`,
        {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      expect(wrongScope.status).toBe(401);
    }
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    await page.goto(origin);
    await page.waitForFunction(() => Boolean(window.loginAuth));
    const enrolled = await page.evaluate(
      async ({ email, grant }) => {
        const result = await window.loginAuth.addPasskey(email, {
          emailGrant: grant,
        });
        if (!("user" in result))
          throw new Error("Unexpected MFA challenge during enrollment");
        return { id: result.user.id, email: result.user.email };
      },
      { email, grant },
    );
    expect(enrolled.email).toBe(email);
    await page.evaluate(() => window.loginAuth.signOut());

    let verificationBody: string | null = null;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/auth/passkey/login/verify")
        verificationBody = request.postData();
    });
    const signedIn = await page.evaluate(async (email) => {
      const result = await window.loginAuth.signInWithPasskey(email);
      if (!("user" in result))
        throw new Error("Unexpected MFA challenge during sign-in");
      return { id: result.user.id, email: result.user.email };
    }, email);
    expect(signedIn).toEqual(enrolled);
    expect(errors).toEqual([]);
    if (!verificationBody)
      throw new Error("Browser did not submit its authenticator assertion");
    const replay = await fetch(`${origin}/auth/passkey/login/verify`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: verificationBody,
    });
    expect(replay.ok).toBe(false);
    const reusedGrant = await fetch(`${origin}/auth/passkey/register/options`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ email, emailGrant: grant }),
    });
    expect(reusedGrant.status).toBe(401);
  } finally {
    await browser?.close();
    await frontend.stop(true);
    await login?.stop();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
