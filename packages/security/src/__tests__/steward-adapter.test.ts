/**
 * Tests the Steward KMS client wire contract with an injected fetch implementation.
 */

import { describe, expect, it } from "vitest";
import { StewardKmsAdapter } from "../kms/steward-adapter.js";
import { KmsError } from "../kms/types.js";

const keyId = "system:model-artifact/v1";

function b64(text: string): string {
  return Buffer.from(text).toString("base64");
}

function fromB64(value: unknown): string {
  expect(typeof value).toBe("string");
  return Buffer.from(value as string, "base64").toString("utf8");
}

function response(body: unknown, init?: ResponseInit): Response {
  const responseInit: ResponseInit = {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json" },
    ...(init?.statusText ? { statusText: init.statusText } : {}),
  };
  return new Response(JSON.stringify(body), responseInit);
}

describe("StewardKmsAdapter", () => {
  it("calls Steward KMS endpoints with bearer auth and typed base64 bodies", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const adapter = new StewardKmsAdapter({
      baseUrl: "https://steward.example.test/",
      tokenProvider: async () => "token-1",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        const path = new URL(String(url)).pathname;
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : {};

        if (path === "/v1/kms/keys") {
          expect(body).toEqual({ keyId, rotationDays: 30 });
          return response({ keyId, version: 3 });
        }
        if (path.endsWith("/rotate")) {
          return response({ keyId, newVersion: 4 });
        }
        if (path.endsWith("/versions")) {
          return response({ versions: [1, 2, 3, 4] });
        }
        if (path.endsWith("/encrypt")) {
          expect(fromB64(body.plaintext_b64)).toBe("plain");
          expect(fromB64(body.aad_b64)).toBe("aad");
          return response({
            ciphertext_b64: b64("cipher"),
            nonce_b64: b64("nonce"),
            auth_tag_b64: b64("tag"),
            version: 4,
          });
        }
        if (path.endsWith("/decrypt")) {
          expect(fromB64(body.ciphertext_b64)).toBe("cipher");
          expect(fromB64(body.nonce_b64)).toBe("nonce");
          expect(fromB64(body.auth_tag_b64)).toBe("tag");
          expect(fromB64(body.aad_b64)).toBe("aad");
          expect(body.version).toBe(4);
          return response({ plaintext_b64: b64("plain") });
        }
        if (path.endsWith("/hmac/verify")) {
          expect(fromB64(body.data_b64)).toBe("data");
          expect(fromB64(body.tag_b64)).toBe("mac");
          return response({ valid: true });
        }
        if (path.endsWith("/hmac")) {
          expect(fromB64(body.data_b64)).toBe("data");
          return response({ tag_b64: b64("mac") });
        }
        if (path.endsWith("/sign")) {
          expect(fromB64(body.data_b64)).toBe("payload");
          expect(body.algorithm).toBe("rsa-pss-sha256");
          return response({
            signature_b64: b64("sig"),
            algorithm: "rsa-pss-sha256",
            version: 4,
          });
        }
        if (path.endsWith("/verify")) {
          expect(fromB64(body.data_b64)).toBe("payload");
          expect(fromB64(body.signature_b64)).toBe("sig");
          expect(body.algorithm).toBe("rsa-pss-sha256");
          return response({ valid: true });
        }
        if (path.endsWith("/public")) {
          return response({ public_key_b64: b64("pub") });
        }
        return response({ error: "unexpected path" }, { status: 404 });
      },
    });

    await expect(
      adapter.getOrCreateKey(keyId, { rotationDays: 30 }),
    ).resolves.toEqual({
      keyId,
      version: 3,
    });
    await expect(adapter.rotateKey(keyId)).resolves.toEqual({
      keyId,
      newVersion: 4,
    });
    await expect(adapter.listKeyVersions(keyId)).resolves.toEqual([1, 2, 3, 4]);

    const encrypted = await adapter.encrypt(
      keyId,
      new TextEncoder().encode("plain"),
      new TextEncoder().encode("aad"),
    );
    expect(Buffer.from(encrypted.ciphertext).toString()).toBe("cipher");
    expect(Buffer.from(encrypted.nonce).toString()).toBe("nonce");
    expect(Buffer.from(encrypted.authTag).toString()).toBe("tag");
    expect(encrypted.keyVersion).toBe(4);

    const plaintext = await adapter.decrypt(
      keyId,
      new TextEncoder().encode("cipher"),
      new TextEncoder().encode("nonce"),
      new TextEncoder().encode("tag"),
      new TextEncoder().encode("aad"),
      4,
    );
    expect(Buffer.from(plaintext).toString()).toBe("plain");

    const mac = await adapter.hmac(keyId, new TextEncoder().encode("data"));
    expect(Buffer.from(mac).toString()).toBe("mac");
    await expect(
      adapter.hmacVerify(
        keyId,
        new TextEncoder().encode("data"),
        new TextEncoder().encode("mac"),
      ),
    ).resolves.toBe(true);

    const signature = await adapter.sign(
      keyId,
      new TextEncoder().encode("payload"),
      "rsa-pss-sha256",
    );
    expect(Buffer.from(signature.signature).toString()).toBe("sig");
    expect(signature.algorithm).toBe("rsa-pss-sha256");
    await expect(
      adapter.verify(
        keyId,
        new TextEncoder().encode("payload"),
        new TextEncoder().encode("sig"),
        "rsa-pss-sha256",
      ),
    ).resolves.toBe(true);

    const publicKey = await adapter.getPublicKey(keyId);
    expect(Buffer.from(publicKey).toString()).toBe("pub");

    expect(calls.length).toBe(10);
    for (const call of calls) {
      expect(call.init.headers).toMatchObject({
        accept: "application/json",
        authorization: "Bearer token-1",
      });
    }
  });

  it("throws KmsError on non-2xx Steward responses", async () => {
    const adapter = new StewardKmsAdapter({
      baseUrl: "https://steward.example.test",
      tokenProvider: async () => "token-1",
      fetch: async () => response({ error: "missing key" }, { status: 404 }),
    });

    await expect(adapter.getPublicKey(keyId)).rejects.toThrow(KmsError);
    await expect(adapter.getPublicKey(keyId)).rejects.toThrow("missing key");
  });

  it("throws KmsError on malformed Steward responses", async () => {
    const adapter = new StewardKmsAdapter({
      baseUrl: "https://steward.example.test",
      tokenProvider: async () => "token-1",
      fetch: async () => response({ ciphertext_b64: b64("cipher") }),
    });

    await expect(
      adapter.encrypt(keyId, new TextEncoder().encode("plain")),
    ).rejects.toThrow("nonce_b64");
  });
});
