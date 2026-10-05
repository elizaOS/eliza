/**
 * Key release through the dstack guest agent's v1 `GetKey`. dstack derives an
 * application key from the app root key that dstack-KMS releases only to an
 * attested CVM whose app/compose identity it authorizes. Before a key is used,
 * this client (1) appraises its own freshly collected, request-bound evidence
 * through the pinned dstack provider against the request policy, and (2)
 * verifies the returned signature chain: link 0 binds the derived public key
 * to the app root key, link 1 binds the app root key and the pinned app id to
 * the pinned KMS root key. A development key provider or a different KMS
 * cannot produce a chain under the pinned KMS root.
 *
 * Wire contract (dstack docs/guest-api-v1.md, agent_rpc_v1.proto):
 * `POST /v1/GetKey` `{ domain, algorithm }` over the internal Unix socket
 * returns `{ key, public_key, signature_chain }` with bytes hex encoded.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { lstat } from "node:fs/promises";
import { request } from "node:http";
import { ElizaError } from "@elizaos/core";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { z } from "zod";
import {
  appraiseOwnEvidence,
  assertEvidenceReportDataMatches,
  type TeeKeyReleaseClient,
  type TeeKeyReleaseRequest,
  type TeeKeyReleaseResult,
  type TeeReportDataBoundEvidenceProvider,
} from "./tee-key-release.ts";

const KEY_CLAIM_TAG = "dstack-guest-v1-key-claim";
const KMS_ISSUED_TAG = "dstack-kms-issued";
const DOMAIN_PREFIX = "elizaos/tee-key-release/v1";
const REPORT_DATA_TAG = "elizaos-dstack-getkey-v1\0";
const RELEASE_HKDF_INFO = "elizaos-dstack-key-release/v1";
const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);
const MAX_RESPONSE_BYTES = 64 * 1024;
const hex = z.string().regex(/^(?:[0-9a-f]{2})*$/i);
const getKeyResponse = z.object({
  key: hex,
  public_key: hex,
  signature_chain: z.array(hex).length(2),
});

function rejected(message: string, cause?: unknown): ElizaError {
  return new ElizaError(message, {
    code: "TEE_DSTACK_KEY_RELEASE_REJECTED",
    ...(cause === undefined ? {} : { cause }),
  });
}

function lengthPrefixed(...fields: Uint8Array[]): Buffer {
  return Buffer.concat(
    fields.flatMap((field) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(field.length);
      return [length, Buffer.from(field)];
    }),
  );
}

/** The v1 key-claim bytes that signature-chain link 0 signs. */
export function dstackKeyClaim(
  algorithm: "ed25519" | "secp256k1",
  domain: string,
  publicKey: Uint8Array,
): Buffer {
  return lengthPrefixed(
    Buffer.from(KEY_CLAIM_TAG),
    Buffer.from(algorithm),
    Buffer.from(domain, "utf8"),
    publicKey,
  );
}

/** The message KMS root signature-chain link 1 signs. */
export function dstackKmsIssuedMessage(
  appId: Uint8Array,
  appRootPublicKey: Uint8Array,
): Buffer {
  return Buffer.concat([
    Buffer.from(`${KMS_ISSUED_TAG}:`),
    appId,
    appRootPublicKey,
  ]);
}

function recoverableSignature(link: Buffer) {
  if (link.length !== 65)
    throw rejected("Signature chain link must be 65 bytes");
  const recovery = link[64] ?? 255;
  if (recovery > 3) throw rejected("Signature chain recovery id is invalid");
  const signature = secp256k1.Signature.fromBytes(
    link.subarray(0, 64),
    "compact",
  );
  if (signature.hasHighS())
    throw rejected("Signature chain link is not low-S normalized");
  return signature.addRecoveryBit(recovery);
}

/**
 * Verify a guest-v1 `GetKey` signature chain and return the app root key
 * (SEC1 compressed). Throws unless the chain ends at the pinned KMS root key
 * and names the pinned app id.
 */
export function verifyDstackKeySignatureChain(input: {
  algorithm: "ed25519" | "secp256k1";
  domain: string;
  publicKey: Uint8Array;
  signatureChain: readonly Uint8Array[];
  appId: Uint8Array;
  kmsRootPublicKey: Uint8Array;
}): Buffer {
  const [link0, link1] = input.signatureChain;
  if (!link0 || !link1 || input.signatureChain.length !== 2)
    throw rejected("Signature chain must have exactly two links");
  try {
    const claimDigest = keccak_256(
      dstackKeyClaim(input.algorithm, input.domain, input.publicKey),
    );
    const appRoot = recoverableSignature(Buffer.from(link0))
      .recoverPublicKey(claimDigest)
      .toBytes(true);
    const kmsDigest = keccak_256(dstackKmsIssuedMessage(input.appId, appRoot));
    const kmsSignature = recoverableSignature(Buffer.from(link1));
    const valid = secp256k1.verify(
      kmsSignature.toBytes("compact"),
      kmsDigest,
      input.kmsRootPublicKey,
      { prehash: false, lowS: true },
    );
    if (!valid)
      throw rejected("Signature chain is not rooted in the pinned KMS");
    return Buffer.from(appRoot);
  } catch (error) {
    // error-policy:J2 Any chain defect withholds the derived key.
    if (error instanceof ElizaError) throw error;
    throw rejected("Signature chain verification failed", error);
  }
}

function ed25519PublicKey(seed: Buffer): Buffer {
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  if (typeof jwk.x !== "string") throw rejected("Ed25519 key export failed");
  return Buffer.from(jwk.x, "base64url");
}

async function postGuestJson(
  socketPath: string,
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  if (!(await lstat(socketPath)).isSocket())
    throw rejected("Dstack endpoint must be a Unix socket");
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        signal,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.destroy();
          reject(rejected(`Guest-v1 ${path} request was rejected`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES)
            req.destroy(
              rejected("Guest key response exceeds protocol size limit"),
            );
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            // error-policy:J3 Invalid guest replies never produce key material.
            reject(rejected("Malformed guest key response", error));
          }
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

export type DstackGuestKeyReleaseClientConfig = {
  /** The pinned dstack evidence provider for this CVM. */
  evidenceProvider: TeeReportDataBoundEvidenceProvider;
  socketPath: string;
  /** Hex app id the KMS link must name. */
  appId: string;
  /** Pinned dstack KMS root secp256k1 public key (SEC1, hex). */
  kmsRootPublicKey: string;
  timeoutMs?: number;
};

/**
 * Releases 32-byte keys derived by the dstack guest agent from the KMS-issued
 * app root key, after local appraisal of this CVM's own fresh evidence.
 */
export class DstackGuestKeyReleaseClient implements TeeKeyReleaseClient {
  private readonly appId: Buffer;
  private readonly kmsRoot: Buffer;

  constructor(private readonly config: DstackGuestKeyReleaseClientConfig) {
    if (!/^(?:[0-9a-f]{2})+$/i.test(config.appId))
      throw rejected("Dstack app id must be hex");
    if (
      !/^(?:0[23][0-9a-f]{64}|04[0-9a-f]{128})$/i.test(config.kmsRootPublicKey)
    )
      throw rejected("Pinned KMS root key must be a SEC1 secp256k1 key");
    if (!config.socketPath.startsWith("/"))
      throw rejected("Dstack socket path must be absolute");
    this.appId = Buffer.from(config.appId, "hex");
    this.kmsRoot = Buffer.from(config.kmsRootPublicKey, "hex");
  }

  get attestationProvider(): TeeReportDataBoundEvidenceProvider {
    return this.config.evidenceProvider;
  }

  get socketPath(): string {
    return this.config.socketPath;
  }

  get kmsRootPublicKey(): string {
    return this.config.kmsRootPublicKey.toLowerCase();
  }

  get pinnedAppId(): string {
    return this.config.appId.toLowerCase();
  }

  async releaseKey(
    releaseRequest: TeeKeyReleaseRequest,
  ): Promise<TeeKeyReleaseResult> {
    const { keyId } = releaseRequest;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(keyId))
      throw rejected("Key id is not a valid dstack key domain component");
    const collect = this.config.evidenceProvider.collectEvidenceWithReportData;
    if (typeof collect !== "function")
      throw rejected("Dstack key release requires report-data-bound evidence");
    const signal = AbortSignal.timeout(this.config.timeoutMs ?? 60_000);
    const contextDigest = createHash("sha256")
      .update(releaseRequest.context ?? "")
      .digest("hex");
    const domain = `${DOMAIN_PREFIX}/${keyId}/${contextDigest}`;
    const nonce = randomBytes(32).toString("hex");
    const reportDataHex = createHash("sha256")
      .update(REPORT_DATA_TAG)
      .update(Buffer.from(nonce, "hex"))
      .update(domain)
      .digest("hex");
    const evidence = await collect.call(this.config.evidenceProvider, {
      nonce,
      reportDataHex,
    });
    assertEvidenceReportDataMatches(evidence, reportDataHex);
    if (evidence.reportData === undefined)
      throw rejected("Dstack key release evidence is not report-data bound");
    const decision = appraiseOwnEvidence(evidence, {
      ...releaseRequest.policy,
      expectedNonce: nonce,
    });
    if (
      evidence.measurements?.app === undefined ||
      evidence.measurements.app.toLowerCase() !== this.pinnedAppId
    )
      throw rejected("Appraised evidence does not name the pinned app id");

    const response = getKeyResponse.parse(
      await postGuestJson(
        this.config.socketPath,
        "/v1/GetKey",
        { domain, algorithm: "ed25519" },
        signal,
      ),
    );
    const seed = Buffer.from(response.key, "hex");
    try {
      const publicKey = Buffer.from(response.public_key, "hex");
      if (seed.length !== 32 || publicKey.length !== 32)
        throw rejected("Guest key response has invalid key lengths");
      if (!ed25519PublicKey(seed).equals(publicKey))
        throw rejected("Guest public key does not match the derived key");
      verifyDstackKeySignatureChain({
        algorithm: "ed25519",
        domain,
        publicKey,
        signatureChain: response.signature_chain.map((link) =>
          Buffer.from(link, "hex"),
        ),
        appId: this.appId,
        kmsRootPublicKey: this.kmsRoot,
      });
      // The derived Ed25519 seed is never used directly as an encryption key.
      const keyMaterial = Buffer.from(
        hkdfSync("sha256", seed, Buffer.alloc(0), RELEASE_HKDF_INFO, 32),
      );
      const keyMaterialHex = keyMaterial.toString("hex");
      keyMaterial.fill(0);
      return { keyId, keyMaterialHex, decision };
    } finally {
      seed.fill(0);
    }
  }
}
