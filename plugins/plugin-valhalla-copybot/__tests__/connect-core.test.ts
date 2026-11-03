import { beforeAll, describe, expect, it } from "vitest";
import vm from "node:vm";
import { readFileSync } from "node:fs";

type Nacl = {
  sign: {
    keyPair(): { publicKey: Uint8Array; secretKey: Uint8Array };
    detached(message: Uint8Array, secretKey: Uint8Array): Uint8Array;
  };
};

type ConnectApi = {
  isPubkey(value: string): boolean;
  adapterFromInjected(
    provider: unknown,
    name: string
  ): Promise<{ name: string; address: string; signMessage(bytes: Uint8Array): Promise<Uint8Array> } | null>;
  adapterFromStandard(wallet: unknown): Promise<{ name: string; address: string; signMessage(bytes: Uint8Array): Promise<Uint8Array> } | null>;
  pickNamed(list: Array<{ name: string }>, which: string): { name: string } | null;
  signInWithAdapter(
    adapter: { address: string; signMessage(bytes: Uint8Array): Promise<Uint8Array> },
    nacl: Nacl,
    input: { domain: string; nonce: string; issuedAt: string; expiresAt: string }
  ): Promise<{ address: string; session: { address: string } }>;
};

let nacl: Nacl;
let connect: ConnectApi;

function b58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  return "1".repeat(zeros) + digits.reverse().map((digit) => alphabet[digit]).join("");
}

function pair() {
  const keys = nacl.sign.keyPair();
  return { secretKey: keys.secretKey, address: b58(keys.publicKey) };
}

beforeAll(() => {
  const sandbox = vm.createContext({
    self: {},
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Float64Array,
    Uint32Array,
    atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
    btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
  });
  (sandbox as { self: unknown }).self = sandbox;
  vm.runInContext(readFileSync(new URL("../extension/vendor/nacl.min.js", import.meta.url), "utf8"), sandbox);
  vm.runInContext(readFileSync(new URL("../extension/connect-core.js", import.meta.url), "utf8"), sandbox);
  nacl = (sandbox as { nacl: Nacl }).nacl;
  connect = (sandbox as { ValhallaConnect: ConnectApi }).ValhallaConnect;
});

describe("wallet sign-in", () => {
  it("accepts a Phantom-style provider and a Solflare Wallet Standard provider", async () => {
    const phantom = pair();
    const solflare = pair();
    const when = { domain: "valhalla-app.xyz", nonce: "nonce-1", issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const phantomAdapter = await connect.adapterFromInjected(
      {
        isPhantom: true,
        connect: async () => ({ publicKey: { toString: () => phantom.address } }),
        signMessage: async (bytes: Uint8Array) => ({ signature: nacl.sign.detached(bytes, phantom.secretKey) }),
      },
      "Phantom"
    );
    expect(phantomAdapter?.name).toBe("Phantom");
    const phantomSession = await connect.signInWithAdapter(phantomAdapter!, nacl, when);
    expect(phantomSession.address).toBe(phantom.address);
    expect(phantomSession.session.address).toBe(phantom.address);

    const standard = {
      name: "Solflare",
      features: {
        "standard:connect": {
          connect: async () => ({ accounts: [{ address: solflare.address }] }),
        },
        "solana:signMessage": {
          signMessage: async (inputs: Array<{ message: Uint8Array }>) => [
            { signature: nacl.sign.detached(inputs[0].message, solflare.secretKey) },
          ],
        },
      },
    };
    expect(connect.pickNamed([standard], "solflare")?.name).toBe("Solflare");
    const solAdapter = await connect.adapterFromStandard(standard);
    const solSession = await connect.signInWithAdapter(solAdapter!, nacl, { ...when, nonce: "nonce-2" });
    expect(solSession.address).toBe(solflare.address);
    expect(connect.isPubkey("not-an-address")).toBe(false);
  });
});
