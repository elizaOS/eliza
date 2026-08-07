import assert from "node:assert/strict";
import test from "node:test";
import { onRequest, onRequestPost } from "../functions/api/waitlist.js";

class MemoryKV {
  values = new Map();
  async get(key) { return this.values.get(key) ?? null; }
  async put(key, value) { this.values.set(key, value); }
}

function request(body, headers = {}) {
  return new Request("https://eliza.app/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://eliza.app", "cf-connecting-ip": "192.0.2.1", ...headers },
    body: JSON.stringify(body),
  });
}

test("stores a normalized valid signup without exposing the address in the key", async () => {
  const WAITLIST = new MemoryKV();
  const response = await onRequestPost({ request: request({ email: " Hello@Example.COM ", source: "eliza.app" }), env: { WAITLIST } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  const emailEntry = [...WAITLIST.values.entries()].find(([key]) => key.startsWith("email:"));
  assert.ok(emailEntry);
  assert.equal(JSON.parse(emailEntry[1]).email, "hello@example.com");
  assert.equal(emailEntry[0].includes("example.com"), false);
});

test("rejects invalid email, cross-origin requests, and unsupported methods", async () => {
  const env = { WAITLIST: new MemoryKV() };
  assert.equal((await onRequestPost({ request: request({ email: "bad" }), env })).status, 400);
  assert.equal((await onRequestPost({ request: request({ email: "a@example.com" }, { origin: "https://evil.example" }), env })).status, 403);
  assert.equal(onRequest().status, 405);
});

test("returns success for honeypot submissions without storing an email", async () => {
  const WAITLIST = new MemoryKV();
  const response = await onRequestPost({ request: request({ email: "bot@example.com", companyWebsite: "https://spam.example" }), env: { WAITLIST } });
  assert.equal(response.status, 200);
  assert.equal([...WAITLIST.values.keys()].some((key) => key.startsWith("email:")), false);
});

test("deduplicates a signup after the short rate-limit window", async () => {
  const WAITLIST = new MemoryKV();
  const first = await onRequestPost({ request: request({ email: "person@example.com" }), env: { WAITLIST } });
  assert.equal(first.status, 200);
  for (const key of [...WAITLIST.values.keys()]) if (key.startsWith("rate:")) WAITLIST.values.delete(key);
  const second = await onRequestPost({ request: request({ email: "person@example.com" }), env: { WAITLIST } });
  assert.deepEqual(await second.json(), { ok: true, alreadyJoined: true });
});
