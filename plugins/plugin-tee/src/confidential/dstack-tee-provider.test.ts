import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  type CoveQuote,
  type CoveQuoteBody,
  canonicalBodyBytes,
  canonicalTbsBytes,
  type DiceCertificate,
  expectedReportData,
} from "./cove-quote.ts";
import { collectDstackTeeEvidence } from "./dstack-tee-provider.ts";

const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

function ed25519FromSeed(seed: Buffer): {
  privateKey: KeyObject;
  rawPublicKey: string;
} {
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const rawPublicKey = Buffer.from(
    createPublicKey(privateKey)
      .export({ format: "der", type: "spki" })
      .subarray(-32),
  ).toString("base64url");
  return { privateKey, rawPublicKey };
}

function signTbs(
  cert: Omit<DiceCertificate, "signature">,
  issuer: KeyObject,
): string {
  return Buffer.from(
    cryptoSign(null, canonicalTbsBytes({ ...cert, signature: "" }), issuer),
  ).toString("base64url");
}

/**
 * Mint a real 2-cert CoVE quote ([DeviceID self-issued anchor, Alias]) signed
 * with node:crypto Ed25519, to exercise the provider's CoVE branch end to end.
 */
const COVE_NONCE = "cove-nonce";
const COVE_EPK = Buffer.alloc(32, 0xab);

function mintCoveQuote(
  overrides: { securityVersion?: number; nonce?: string; epk?: Buffer } = {},
): { quoteJson: string; rotPublicKey: string } {
  const now = Date.now();
  const day = 86_400_000;
  const securityVersion = overrides.securityVersion ?? 7;
  const nonce = overrides.nonce ?? COVE_NONCE;
  const epk = overrides.epk ?? COVE_EPK;
  const deviceId = ed25519FromSeed(Buffer.alloc(32, 0x0d));
  const alias = ed25519FromSeed(Buffer.alloc(32, 0x0a));
  const notBefore = new Date(now - day).toISOString();
  const notAfter = new Date(now + day).toISOString();

  const deviceCert: DiceCertificate = {
    subject: "E1-DICE-DeviceID",
    issuer: "E1-DICE-DeviceID",
    subjectPublicKey: deviceId.rawPublicKey,
    securityVersion,
    notBefore,
    notAfter,
    signature: "",
  };
  deviceCert.signature = signTbs(deviceCert, deviceId.privateKey);

  const aliasCert: DiceCertificate = {
    subject: "E1-DICE-Alias",
    issuer: "E1-DICE-DeviceID",
    subjectPublicKey: alias.rawPublicKey,
    securityVersion,
    notBefore,
    notAfter,
    signature: "",
  };
  aliasCert.signature = signTbs(aliasCert, deviceId.privateKey);

  const body: CoveQuoteBody = {
    measurements: {
      boot: `sha256:${"11".repeat(32)}`,
      monitor: `sha256:${"22".repeat(32)}`,
      os: `sha256:${"33".repeat(32)}`,
      policy: `sha256:${"44".repeat(32)}`,
      device: `sha256:${"55".repeat(32)}`,
      agent: `sha256:${"66".repeat(32)}`,
    },
    claims: {
      secureBoot: true,
      debugDisabled: true,
      productionLifecycle: true,
      memoryEncrypted: true,
      ioProtected: true,
      npuProtected: true,
      monitorMeasured: true,
    },
    securityVersion,
    reportData: expectedReportData(nonce, epk),
    nonce,
    timestamp: new Date(now).toISOString(),
    hardwareVendor: "eliza",
    platformVersion: "e1-model-v0",
  };
  const signature = Buffer.from(
    cryptoSign(null, canonicalBodyBytes(body), alias.privateKey),
  ).toString("base64url");

  const quote: CoveQuote = { body, chain: [deviceCert, aliasCert], signature };
  return {
    quoteJson: JSON.stringify(quote),
    rotPublicKey: deviceId.rawPublicKey,
  };
}

describe("dstack TEE provider", () => {
  it("collects normalized evidence from inline JSON", async () => {
    await expect(
      collectDstackTeeEvidence({
        env: {
          ELIZA_TEE_EVIDENCE_JSON: JSON.stringify({
            kind: "dstack",
            measurements: { agent: "sha256:abc" },
            freshness: { nonce: "n" },
            claims: { debugDisabled: true },
          }),
        },
      }),
    ).resolves.toMatchObject({
      kind: "dstack",
      provider: "dstack",
      measurements: { agent: "sha256:abc" },
      freshness: { nonce: "n" },
      claims: { debugDisabled: true },
    });
  });

  it("collects normalized evidence from an HTTP endpoint", async () => {
    const request = vi.fn(async () =>
      Response.json({
        kind: "tdx",
        provider: "dstack",
        securityVersion: 3,
        measurements: { os: "abc" },
      }),
    );

    await expect(
      collectDstackTeeEvidence({
        endpointUrl: "https://tee.example.test/evidence",
        fetch: request as unknown as typeof fetch,
        env: {},
      }),
    ).resolves.toMatchObject({
      kind: "tdx",
      provider: "dstack",
      securityVersion: 3,
      measurements: { os: "abc" },
    });
    expect(request).toHaveBeenCalledWith("https://tee.example.test/evidence", {
      method: "GET",
      headers: { accept: "application/json" },
    });
  });

  it("fails when no evidence source is configured", async () => {
    await expect(
      collectDstackTeeEvidence({ env: {}, evidencePath: "" }),
    ).rejects.toThrow(/No dstack TEE evidence source configured/);
  });

  it("rejects an oversized evidence payload (decompression-bomb guard)", async () => {
    await expect(
      collectDstackTeeEvidence({
        maxPayloadBytes: 16,
        env: {
          ELIZA_TEE_EVIDENCE_JSON: JSON.stringify({
            kind: "dstack",
            measurements: { agent: `sha256:${"a".repeat(64)}` },
          }),
        },
      }),
    ).rejects.toThrow(/payload exceeds 16 bytes/);
  });

  it("refuses a plain-http evidence endpoint under the production profile", async () => {
    await expect(
      collectDstackTeeEvidence({
        endpointUrl: "http://tee.example.test/evidence",
        requireSecureTransport: true,
        fetch: (async () =>
          Response.json({ kind: "dstack" })) as unknown as typeof fetch,
        env: {},
      }),
    ).rejects.toThrow(/must be https:/);
  });

  it("refuses NODE_TLS_REJECT_UNAUTHORIZED=0 under the production profile", async () => {
    await expect(
      collectDstackTeeEvidence({
        requireSecureTransport: true,
        env: {
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
          ELIZA_TEE_EVIDENCE_JSON: JSON.stringify({ kind: "dstack" }),
        },
      }),
    ).rejects.toThrow(/NODE_TLS_REJECT_UNAUTHORIZED=0/);
  });

  it("enforces a pinned KMS identity", async () => {
    await expect(
      collectDstackTeeEvidence({
        expectedKmsPublicKey: "pinned-key",
        env: {
          ELIZA_TEE_EVIDENCE_JSON: JSON.stringify({
            kind: "dstack",
            kmsPublicKey: "rogue-key",
          }),
        },
      }),
    ).rejects.toThrow(/KMS identity does not match the pinned public key/);

    await expect(
      collectDstackTeeEvidence({
        expectedKmsPublicKey: "pinned-key",
        env: {
          ELIZA_TEE_EVIDENCE_JSON: JSON.stringify({
            kind: "dstack",
            kmsPublicKey: "pinned-key",
          }),
        },
      }),
    ).resolves.toMatchObject({ kind: "dstack", provider: "dstack" });
  });

  it("verifies + maps an on-device CoVE quote from env (real DICE crypto)", async () => {
    const { quoteJson, rotPublicKey } = mintCoveQuote();
    await expect(
      collectDstackTeeEvidence({
        env: {
          ELIZA_COVE_QUOTE_JSON: quoteJson,
          ELIZA_COVE_ROT_PUBLIC_KEY: rotPublicKey,
        },
      }),
    ).resolves.toMatchObject({
      kind: "cove",
      provider: "eliza-riscv",
      claims: { npuProtected: true, monitorMeasured: true },
      measurements: { boot: `sha256:${"11".repeat(32)}` },
    });
  });

  it("rejects a CoVE quote with no RoT anchor configured (fail-closed)", async () => {
    const { quoteJson } = mintCoveQuote();
    await expect(
      collectDstackTeeEvidence({ env: { ELIZA_COVE_QUOTE_JSON: quoteJson } }),
    ).rejects.toThrow(/requires coveRotPublicKey/);
  });

  it("enforces the report_data binding from env (nonce/epk) and accepts a match", async () => {
    const { quoteJson, rotPublicKey } = mintCoveQuote();
    await expect(
      collectDstackTeeEvidence({
        env: {
          ELIZA_COVE_QUOTE_JSON: quoteJson,
          ELIZA_COVE_ROT_PUBLIC_KEY: rotPublicKey,
          ELIZA_COVE_NONCE: COVE_NONCE,
          ELIZA_COVE_EPHEMERAL_PUBLIC_KEY: COVE_EPK.toString("base64"),
        },
      }),
    ).resolves.toMatchObject({ kind: "cove", provider: "eliza-riscv" });
  });

  it("rejects a replayed CoVE quote whose report_data binds a different nonce", async () => {
    // Quote captured from an earlier challenge (old nonce); the verifier's
    // fresh nonce must reject it as a replay.
    const { quoteJson, rotPublicKey } = mintCoveQuote({
      nonce: "captured-old-nonce",
    });
    await expect(
      collectDstackTeeEvidence({
        env: {
          ELIZA_COVE_QUOTE_JSON: quoteJson,
          ELIZA_COVE_ROT_PUBLIC_KEY: rotPublicKey,
          ELIZA_COVE_NONCE: "fresh-verifier-nonce",
          ELIZA_COVE_EPHEMERAL_PUBLIC_KEY: COVE_EPK.toString("base64"),
        },
      }),
    ).rejects.toThrow(/report-data-mismatch/);
  });

  it("fails closed on a half-configured binding (nonce without epk)", async () => {
    const { quoteJson, rotPublicKey } = mintCoveQuote();
    await expect(
      collectDstackTeeEvidence({
        env: {
          ELIZA_COVE_QUOTE_JSON: quoteJson,
          ELIZA_COVE_ROT_PUBLIC_KEY: rotPublicKey,
          ELIZA_COVE_NONCE: COVE_NONCE,
        },
      }),
    ).rejects.toThrow(
      /requires both ELIZA_COVE_NONCE and ELIZA_COVE_EPHEMERAL_PUBLIC_KEY/,
    );
  });

  it("enforces the CoVE rollback floor via ELIZA_COVE_MIN_SECURITY_VERSION", async () => {
    const { quoteJson, rotPublicKey } = mintCoveQuote({ securityVersion: 2 });
    await expect(
      collectDstackTeeEvidence({
        env: {
          ELIZA_COVE_QUOTE_JSON: quoteJson,
          ELIZA_COVE_ROT_PUBLIC_KEY: rotPublicKey,
          ELIZA_COVE_MIN_SECURITY_VERSION: "5",
        },
      }),
    ).rejects.toThrow(/security-version-too-low/);
  });

  it("accepts a CoVE quote at or above the rollback floor", async () => {
    const { quoteJson, rotPublicKey } = mintCoveQuote({ securityVersion: 7 });
    await expect(
      collectDstackTeeEvidence({
        env: {
          ELIZA_COVE_QUOTE_JSON: quoteJson,
          ELIZA_COVE_ROT_PUBLIC_KEY: rotPublicKey,
          ELIZA_COVE_MIN_SECURITY_VERSION: "5",
        },
      }),
    ).resolves.toMatchObject({ kind: "cove", provider: "eliza-riscv" });
  });

  it("rejects a CoVE quote that does not verify against the anchor", async () => {
    const { quoteJson } = mintCoveQuote();
    // A different RoT key than the one that signed the quote's DeviceID cert.
    const foreignAnchor = ed25519FromSeed(Buffer.alloc(32, 0x99)).rawPublicKey;
    await expect(
      collectDstackTeeEvidence({
        env: {
          ELIZA_COVE_QUOTE_JSON: quoteJson,
          ELIZA_COVE_ROT_PUBLIC_KEY: foreignAnchor,
        },
      }),
    ).rejects.toThrow(/CoVE quote verification failed/);
  });
});
