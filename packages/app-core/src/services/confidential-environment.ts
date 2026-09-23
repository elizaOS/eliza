/**
 * Encrypts complete launch environments only after authenticating the KMS's
 * timestamped application-specific X25519 key. The independently provisioned
 * secp256k1 signer pin is distinct from dstack's KMS CA pin; neither is learned
 * from the response being verified. Plaintext never goes to the KMS endpoint.
 */
import {
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { keccak256, SigningKey } from "ethers";
import { z } from "zod";
import { verifyConfidentialRelease } from "./confidential-release.ts";

const schema = z
  .object({
    release: z.unknown(),
    envelope: z.object({ payload: z.string(), signature: z.string() }).strict(),
    endpoint: z.url(),
    kmsSigningPublicKey: z.string().regex(/^(02|03)[a-f0-9]{64}$/),
    environment: z.array(
      z
        .object({
          key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
          value: z.string().refine((value) => !value.includes("\0")),
        })
        .strict(),
    ),
  })
  .strict();

/** Retrieves public material only, authenticates it, then encrypts locally. */
export async function encryptConfidentialEnvironment(
  input: unknown,
  authorityPem: string,
  signal?: AbortSignal,
): Promise<{ appId: string; encryptedEnv: string }> {
  try {
    const request = schema.parse(input);
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
      throw new Error("TLS verification is required");
    const endpoint = new URL(request.endpoint);
    const local =
      endpoint.protocol === "http:" &&
      ["127.0.0.1", "[::1]"].includes(endpoint.hostname);
    if (
      (endpoint.protocol !== "https:" && !local) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.pathname !== "/"
    )
      throw new Error("Use an HTTPS KMS origin or loopback SSH tunnel");
    if (
      new Set(request.environment.map(({ key }) => key)).size !==
      request.environment.length
    )
      throw new Error("Duplicate environment names are ambiguous");
    const identity = verifyConfidentialRelease(
      request.release,
      request.envelope,
      authorityPem,
    );
    const release = z.object({ compose: z.string() }).parse(request.release);
    const measured = z
      .object({ allowed_envs: z.array(z.string()) })
      .parse(JSON.parse(release.compose));
    const requiredNames = [
      ...request.environment.map(({ key }) => key),
      "ELIZA_DSTACK_RELEASE_POLICY_JSON",
    ];
    if (requiredNames.some((key) => !measured.allowed_envs.includes(key)))
      throw new Error(
        "Measured compose does not authorize every launch variable",
      );
    if (
      request.environment.some(({ key }) =>
        /^(ELIZA_TEE_|ELIZA_DSTACK_|NODE_OPTIONS$|NODE_TLS_REJECT_UNAUTHORIZED$|LD_|DYLD_|PATH$)/.test(
          key,
        ),
      )
    )
      throw new Error(
        "Admission and process-loader controls must remain measured",
      );
    // The measured public authority remains in compose. Its signed envelope is
    // delivered here, outside the compose bytes it authenticates.
    if (
      request.environment.some(
        ({ key }) => key === "ELIZA_DSTACK_RELEASE_POLICY_JSON",
      )
    )
      throw new Error("Release policy is supplied by the verified envelope");
    const response = await fetch(
      new URL("/prpc/GetAppEnvEncryptPubKey?json", endpoint),
      {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: identity.appId }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      },
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing KMS response");
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      if (!response.ok) throw new Error("KMS rejected public-key request");
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > 16_384)
          throw new Error("KMS response exceeds protocol limit");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    const key = z
      .object({
        public_key: z.string().regex(/^[a-f0-9]{64}$/i),
        signature_v1: z.string().regex(/^[a-f0-9]{128}0[01]$/i),
        timestamp: z.union([
          z.number().int().safe().nonnegative(),
          z.string().regex(/^\d{1,20}$/),
        ]),
      })
      .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const timestamp = BigInt(key.timestamp);
    const age = BigInt(Math.floor(Date.now() / 1000)) - timestamp;
    if (age < -60n || age > 300n || timestamp > 0xffffffffffffffffn)
      throw new Error(
        "KMS public-key response is outside its validity interval",
      );
    const timeBytes = Buffer.alloc(8);
    timeBytes.writeBigUInt64BE(timestamp);
    const digest = keccak256(
      Buffer.concat([
        Buffer.from("dstack-env-encrypt-pubkey:"),
        Buffer.from(identity.appId, "hex"),
        timeBytes,
        Buffer.from(key.public_key, "hex"),
      ]),
    );
    const recovered = SigningKey.computePublicKey(
      SigningKey.recoverPublicKey(digest, `0x${key.signature_v1}`),
      true,
    );
    if (recovered !== `0x${request.kmsSigningPublicKey}`)
      throw new Error("KMS signing identity differs from the operator pin");
    // Match dstack's existing wire format: ephemeral raw X25519 public key,
    // 12-byte nonce, AES-256-GCM ciphertext and 16-byte tag, with no AAD/KDF.
    const recipient = createPublicKey({
      key: {
        kty: "OKP",
        crv: "X25519",
        x: Buffer.from(key.public_key, "hex").toString("base64url"),
      },
      format: "jwk",
    });
    const ephemeral = generateKeyPairSync("x25519");
    const shared = diffieHellman({
      privateKey: ephemeral.privateKey,
      publicKey: recipient,
    });
    try {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", shared, nonce);
      const plaintext = Buffer.from(
        JSON.stringify({
          env: [
            ...request.environment,
            {
              key: "ELIZA_DSTACK_RELEASE_POLICY_JSON",
              value: JSON.stringify(request.envelope),
            },
          ],
        }),
      );
      try {
        const ciphertext = Buffer.concat([
          cipher.update(plaintext),
          cipher.final(),
        ]);
        const raw = ephemeral.publicKey.export({ format: "jwk" }).x;
        if (!raw) throw new Error("Missing ephemeral public key");
        // Reject a release that expired while the KMS request was in flight.
        verifyConfidentialRelease(
          request.release,
          request.envelope,
          authorityPem,
        );
        signal?.throwIfAborted();
        return {
          appId: identity.appId,
          encryptedEnv: Buffer.concat([
            Buffer.from(raw, "base64url"),
            nonce,
            ciphertext,
            cipher.getAuthTag(),
          ]).toString("hex"),
        };
      } finally {
        plaintext.fill(0);
      }
    } finally {
      shared.fill(0);
    }
  } catch {
    // error-policy:J1 Suppress parser/crypto diagnostics that may contain launch secrets.
    throw new ElizaError(
      "Launch environment encryption failed; check release, trusted KMS signer and fresh signed key",
      {
        code: "CONFIDENTIAL_ENVIRONMENT_REJECTED",
      },
    );
  }
}
