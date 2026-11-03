import { describe, expect, it } from "bun:test";
import { encodeBase58 } from "./base58.ts";
import { PORTAL_HTML, PORTAL_JS } from "./portal-page.ts";
import { handleRequest, type MemoryStore } from "./worker.ts";

const env = { SESSION_SECRET: "test-secret-value", GOOGLE_CLIENT_ID: "google-client" };

describe("Valhalla portal", () => {
  it("serves the portal without a transaction signer", async () => {
    const page = await handleRequest(new Request("https://brain.local/app"), empty(), env);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    const html = await page.text();
    expect(html).toContain("VALHALLA");
    expect(html + PORTAL_JS + PORTAL_HTML).not.toMatch(/signTransaction|sendTransaction/);
  });

  it("signs in with a wallet message and keeps the session cookie", async () => {
    const store = empty();
    const { pubkey, login } = await signIn(store);
    expect(login.status).toBe(200);
    const me = await handleRequest(new Request("https://brain.local/v1/me", { headers: { cookie: cookieHeader(login) } }), store, env);
    const body = await me.json();
    expect(body.wallets[0].tail).toBe(pubkey.slice(-4));
    const denied = await handleRequest(
      new Request("https://brain.local/v1/me/telegram", { method: "POST", headers: { cookie: cookieHeader(login), "content-type": "application/json" }, body: JSON.stringify({ chatId: "123456" }) }),
      store,
      env
    );
    expect(denied.status).toBe(403);
    const link = await handleRequest(
      new Request("https://brain.local/v1/auth/link/google", {
        method: "POST",
        headers: { cookie: cookieHeader(login), "x-csrf": csrf(login), "content-type": "application/json" },
        body: JSON.stringify({ credential: "token" }),
      }),
      store,
      { ...env, fetchImpl: async () => new Response(JSON.stringify({ aud: "google-client", email: "person@example.com", exp: String(Math.floor(Date.now() / 1000) + 60) }), { status: 200 }) }
    );
    expect(link.status).toBe(200);
    expect((await link.json()).email).toBe("person@example.com");
  });

  it("accepts Google, blocks other admins, and locks the free report", async () => {
    const store = empty();
    const login = await handleRequest(
      new Request("https://brain.local/v1/auth/google", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential: "token" }) }),
      store,
      { ...env, ADMIN_EMAILS: "owner@example.com", fetchImpl: async () => new Response(JSON.stringify({ aud: "google-client", email: "person@example.com", exp: String(Math.floor(Date.now() / 1000) + 60) }), { status: 200 }) }
    );
    expect(login.status).toBe(200);
    const headers = { cookie: cookieHeader(login), "x-csrf": csrf(login) };
    const report = await handleRequest(new Request("https://brain.local/v1/me/report", { headers }), store, env);
    expect((await report.json()).locked).toBe(true);
    const admin = await handleRequest(new Request("https://brain.local/v1/admin/overview", { headers }), store, env);
    expect(admin.status).toBe(403);
  });

  it("counts an offer click with no account data", async () => {
    const store = empty();
    const post = () =>
      handleRequest(
        new Request("https://brain.local/v1/offers/click", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://valhalla-app.xyz" },
          body: JSON.stringify({ id: "ledger", placement: "tools", email: "hidden@example.com" }),
        }),
        store,
        env
      );
    const first = await post();
    expect(first.status).toBe(200);
    expect(first.headers.get("access-control-allow-origin")).toBe("*");
    expect((await post()).status).toBe(200);
    expect(store.portal?.offerClicks.get("ledger:tools")).toBe(2);
    const clicks = [...(store.portal?.offerClicks.entries() ?? [])];
    expect(JSON.stringify(clicks)).not.toContain("example.com");
    const bad = await handleRequest(
      new Request("https://brain.local/v1/offers/click", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "Ledger", placement: "tools" }),
      }),
      store,
      env
    );
    expect(bad.status).toBe(400);
  });
});

async function signIn(store: MemoryStore): Promise<{ pubkey: string; login: Response }> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const pubkey = encodeBase58(raw);
  const nonceRes = await handleRequest(
    new Request("https://brain.local/v1/auth/nonce", { method: "POST", body: JSON.stringify({ pubkey }) }),
    store,
    env
  );
  const nonceBody = await nonceRes.json();
  const signatureBytes = new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(nonceBody.message)));
  const signature = btoa(String.fromCharCode(...signatureBytes));
  const login = await handleRequest(
    new Request("https://brain.local/v1/auth/siws", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pubkey, signature, nonce: nonceBody.nonce }),
    }),
    store,
    env
  );
  return { pubkey, login };
}

function empty(): MemoryStore {
  return { keys: new Map(), usage: new Map() };
}

function cookieHeader(response: Response): string {
  return response.headers.getSetCookie().map((row) => row.split(";")[0]).join("; ");
}

function csrf(response: Response): string {
  const row = response.headers.getSetCookie().find((item) => item.startsWith("valhalla_csrf=")) ?? "";
  return decodeURIComponent(row.split(";")[0]?.split("=")[1] ?? "");
}
