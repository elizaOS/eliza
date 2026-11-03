import { describe, expect, it } from "bun:test";
import { encodeBase58 } from "./base58.ts";
import { handleRequest, type MemoryStore } from "./worker.ts";

function empty(): MemoryStore {
  return { keys: new Map(), usage: new Map() };
}

describe("Pro trades and sign-in verify", () => {
  it("counts a trade once and verifies a login message", async () => {
    const store = empty();
    const identity = "device-12345678";
    const consume = () =>
      handleRequest(
        new Request("https://brain.local/v1/pro-trades/consume", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ identity, tradeId: "trade12345678" }),
        }),
        store,
        {}
      );
    const first = await (await consume()).json();
    expect(first.remaining).toBe(99);
    const second = await (await consume()).json();
    expect(second.remaining).toBe(99);
    expect(second.signature).toBeUndefined();

    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const pubkey = encodeBase58(raw);
    const expires = new Date(Date.now() + 60_000).toISOString();
    const message = `valhalla-app.xyz wants you to sign in with your Solana account:\n${pubkey}\n\nSign in to Valhalla. Read-only. This is not a transaction.\n\nNonce: abcdefgh\nIssued At: ${new Date().toISOString()}\nExpiration Time: ${expires}`;
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(message)));
    let rawSig = "";
    for (const byte of sig) rawSig += String.fromCharCode(byte);
    const ok = await handleRequest(
      new Request("https://brain.local/v1/siws/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pubkey, message, signature: btoa(rawSig) }),
      }),
      store,
      {}
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()).address).toBe(pubkey);
    const bad = await handleRequest(
      new Request("https://brain.local/v1/siws/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pubkey, message, signature: btoa("nope") }),
      }),
      store,
      {}
    );
    expect(bad.status).toBe(401);
  });
});
