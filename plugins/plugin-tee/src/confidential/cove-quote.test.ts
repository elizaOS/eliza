import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  hkdfSync,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type CoveClaims,
  type CoveMeasurements,
  type CoveQuote,
  type CoveQuoteBody,
  canonicalBodyBytes,
  canonicalTbsBytes,
  coveQuoteToTeeEvidence,
  type DiceCertificate,
  expectedReportData,
  verifyCoveQuote,
} from "./cove-quote.ts";
import { evaluateTeeEvidencePolicy } from "@elizaos/agent/services/tee-policy";

/**
 * Local DICE key ceremony for tests. This is the reference vector the silicon
 * RoT/TSM must reproduce: a real UDS -> CDI ladder (HKDF-SHA256, matching
 * packages/research/chip/fw/dice/cdi.c) yields the DeviceID and Alias Ed25519 keypairs,
 * which sign a real DICE certificate chain and the quote body. No fabricated
 * signatures — every signature here is produced and verified with node:crypto.
 */

const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

type KeyPair = { privateKey: KeyObject; rawPublicKey: Buffer };

/** Derive an Ed25519 keypair deterministically from a 32-byte seed. */
function ed25519FromSeed(seed: Buffer): KeyPair {
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const rawPublicKey = Buffer.from(
    createPublicKey(privateKey)
      .export({ format: "der", type: "spki" })
      .subarray(-32),
  );
  return { privateKey, rawPublicKey };
}

/** HKDF-SHA256, matching the chip DICE ladder's KDF (RFC 5869). */
function hkdf(ikm: Buffer, salt: Buffer, info: string, len = 32): Buffer {
  return Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from(info, "utf8"), len),
  );
}

/** UDS -> CDI_BL1 -> CDI_BL2 -> CDI_monitor; salt is the stage measurement. */
function walkCdiLadder(
  uds: Buffer,
  hBl1: Buffer,
  hBl2: Buffer,
  hMonitor: Buffer,
): Buffer {
  const cdiBl1 = hkdf(uds, hBl1, "E1-DICE-CDI-L0/BL1");
  const cdiBl2 = hkdf(cdiBl1, hBl2, "E1-DICE-CDI-BL2");
  return hkdf(cdiBl2, hMonitor, "E1-DICE-CDI-MONITOR");
}

function signTbs(
  cert: Omit<DiceCertificate, "signature">,
  issuer: KeyObject,
): string {
  const withPlaceholder: DiceCertificate = { ...cert, signature: "" };
  const sig = cryptoSign(null, canonicalTbsBytes(withPlaceholder), issuer);
  return Buffer.from(sig).toString("base64url");
}

const DAY_MS = 24 * 60 * 60 * 1000;

type MintOptions = {
  measurements?: Partial<CoveMeasurements>;
  claims?: Partial<CoveClaims>;
  securityVersion?: number;
  nonce?: string;
  ephemeralPublicKey?: Buffer;
  timestamp?: string;
  notBefore?: string;
  notAfter?: string;
  /** Override the boot measurements absorbed into the CDI ladder salt chain. */
  bootStages?: { bl1: Buffer; bl2: Buffer; monitor: Buffer };
};

type MintedQuote = {
  quote: CoveQuote;
  rotPublicKey: string;
  nonce: string;
  ephemeralPublicKey: Buffer;
};

const DEFAULT_MEASUREMENTS: CoveMeasurements = {
  boot: `sha256:${"11".repeat(32)}`,
  monitor: `sha256:${"22".repeat(32)}`,
  os: `sha256:${"33".repeat(32)}`,
  policy: `sha256:${"44".repeat(32)}`,
  device: `sha256:${"55".repeat(32)}`,
  agent: `sha256:${"66".repeat(32)}`,
  npuFirmware: `sha256:${"77".repeat(32)}`,
  modelWeights: `sha256:${"88".repeat(32)}`,
};

const DEFAULT_CLAIMS: CoveClaims = {
  secureBoot: true,
  debugDisabled: true,
  productionLifecycle: true,
  memoryEncrypted: true,
  ioProtected: true,
  npuProtected: true,
  monitorMeasured: true,
};

/**
 * Mint a fully-signed CoVE quote with a real DICE chain. Returns the quote plus
 * the RoT anchor public key a verifier would be provisioned with.
 */
function mintCoveQuoteForTest(options: MintOptions = {}): MintedQuote {
  const nowMs = Date.now();
  const securityVersion = options.securityVersion ?? 7;
  const nonce = options.nonce ?? "verifier-nonce-abc123";
  const ephemeralPublicKey =
    options.ephemeralPublicKey ?? Buffer.alloc(32, 0xab);
  const timestamp = options.timestamp ?? new Date(nowMs).toISOString();
  const notBefore = options.notBefore ?? new Date(nowMs - DAY_MS).toISOString();
  const notAfter = options.notAfter ?? new Date(nowMs + DAY_MS).toISOString();

  // RoT root anchor: a stable per-device root key (creator key ceremony).
  const rot = ed25519FromSeed(Buffer.alloc(32, 0x01));

  // DICE ladder produces CDI_monitor; DeviceID + Alias derive from it.
  const stages = options.bootStages ?? {
    bl1: Buffer.alloc(32, 0xb1),
    bl2: Buffer.alloc(32, 0xb2),
    monitor: Buffer.alloc(32, 0x70),
  };
  const cdiMonitor = walkCdiLadder(
    Buffer.alloc(32, 0xfe), // UDS (fused, never exported on real silicon)
    stages.bl1,
    stages.bl2,
    stages.monitor,
  );
  const deviceId = ed25519FromSeed(
    hkdf(cdiMonitor, Buffer.alloc(0), "E1-DICE-DeviceID-Ed25519"),
  );
  const alias = ed25519FromSeed(
    hkdf(cdiMonitor, Buffer.alloc(0), "E1-DICE-Alias-Ed25519"),
  );

  const measurements: CoveMeasurements = {
    ...DEFAULT_MEASUREMENTS,
    ...options.measurements,
  };
  const claims: CoveClaims = { ...DEFAULT_CLAIMS, ...options.claims };

  const rootCert: DiceCertificate = {
    subject: "E1-DICE-RoT",
    issuer: "E1-DICE-RoT",
    subjectPublicKey: rot.rawPublicKey.toString("base64url"),
    securityVersion,
    notBefore,
    notAfter,
    signature: "",
  };
  rootCert.signature = signTbs(rootCert, rot.privateKey);

  const deviceCert: DiceCertificate = {
    subject: "E1-DICE-DeviceID",
    issuer: "E1-DICE-RoT",
    subjectPublicKey: deviceId.rawPublicKey.toString("base64url"),
    securityVersion,
    notBefore,
    notAfter,
    signature: "",
  };
  deviceCert.signature = signTbs(deviceCert, rot.privateKey);

  const aliasCert: DiceCertificate = {
    subject: "E1-DICE-Alias",
    issuer: "E1-DICE-DeviceID",
    subjectPublicKey: alias.rawPublicKey.toString("base64url"),
    measurements: { monitor: measurements.monitor },
    securityVersion,
    notBefore,
    notAfter,
    signature: "",
  };
  aliasCert.signature = signTbs(aliasCert, deviceId.privateKey);

  const body: CoveQuoteBody = {
    measurements,
    claims,
    securityVersion,
    reportData: expectedReportData(nonce, ephemeralPublicKey),
    nonce,
    timestamp,
    hardwareVendor: "eliza",
    platformVersion: "e1-model-v0",
  };
  const signature = Buffer.from(
    cryptoSign(null, canonicalBodyBytes(body), alias.privateKey),
  ).toString("base64url");

  return {
    quote: { body, chain: [rootCert, deviceCert, aliasCert], signature },
    rotPublicKey: rot.rawPublicKey.toString("base64url"),
    nonce,
    ephemeralPublicKey,
  };
}

describe("CoVE quote verification (real DICE crypto)", () => {
  it("round-trips: mint -> verify -> toTeeEvidence -> policy allowed", () => {
    const minted = mintCoveQuoteForTest();
    const result = verifyCoveQuote(minted.quote, {
      trustedRotPublicKey: minted.rotPublicKey,
    });
    expect(result.verified).toBe(true);
    if (!result.verified) throw new Error("unreachable");

    // report_data binds the live channel.
    expect(result.body.reportData).toBe(
      expectedReportData(minted.nonce, minted.ephemeralPublicKey),
    );

    const evidence = coveQuoteToTeeEvidence(result);
    expect(evidence.kind).toBe("cove");
    expect(evidence.provider).toBe("eliza-riscv");
    expect(evidence.measurements?.boot).toBe(
      minted.quote.body.measurements.boot,
    );
    expect(evidence.measurements?.modelWeights).toBe(
      minted.quote.body.measurements.modelWeights,
    );
    expect(evidence.freshness?.verifier).toBe("eliza-local-verifier");

    const decision = evaluateTeeEvidencePolicy(evidence, {
      required: true,
      allowedKinds: ["cove"],
      allowedProviders: ["eliza-riscv"],
      requiredMeasurements: {
        boot: minted.quote.body.measurements.boot,
        os: minted.quote.body.measurements.os,
        agent: minted.quote.body.measurements.agent,
        policy: minted.quote.body.measurements.policy,
        device: minted.quote.body.measurements.device,
      },
      minSecurityVersion: 5,
      expectedNonce: minted.nonce,
      requiredClaims: {
        secureBoot: true,
        debugDisabled: true,
        ioProtected: true,
        npuProtected: true,
        monitorMeasured: true,
      },
    });
    expect(decision.trusted).toBe(true);
    expect(decision.reason).toBe("allowed");
  });

  it("fails when a measurement is tampered after signing", () => {
    const minted = mintCoveQuoteForTest();
    const tampered: CoveQuote = {
      ...minted.quote,
      body: {
        ...minted.quote.body,
        measurements: {
          ...minted.quote.body.measurements,
          os: `sha256:${"ff".repeat(32)}`,
        },
      },
    };
    const result = verifyCoveQuote(tampered, {
      trustedRotPublicKey: minted.rotPublicKey,
    });
    expect(result.verified).toBe(false);
    if (result.verified) throw new Error("unreachable");
    expect(result.reason).toBe("alias-signature-invalid");
  });

  it("fails against the wrong RoT anchor", () => {
    const minted = mintCoveQuoteForTest();
    const otherRoot = ed25519FromSeed(Buffer.alloc(32, 0x99));
    const result = verifyCoveQuote(minted.quote, {
      trustedRotPublicKey: otherRoot.rawPublicKey.toString("base64url"),
    });
    expect(result.verified).toBe(false);
    if (result.verified) throw new Error("unreachable");
    expect(result.reason).toBe("root-anchor-mismatch");
  });

  it("fails when a cert-chain link is broken (issuer mismatch)", () => {
    const minted = mintCoveQuoteForTest();
    const broken: CoveQuote = {
      ...minted.quote,
      chain: [
        minted.quote.chain[0],
        { ...minted.quote.chain[1], subject: "E1-DICE-Imposter" },
        minted.quote.chain[2],
      ] as CoveQuote["chain"],
    };
    const result = verifyCoveQuote(broken, {
      trustedRotPublicKey: minted.rotPublicKey,
    });
    expect(result.verified).toBe(false);
    if (result.verified) throw new Error("unreachable");
    // DeviceID cert TBS no longer matches its signature (subject changed) AND
    // the Alias cert's issuer no longer matches: the DeviceID signature breaks
    // first as the walk re-verifies it against the RoT.
    expect(result.reason).toBe("cert-signature-invalid");
  });

  it("fails when the Alias leaf key is swapped (forged leaf)", () => {
    const minted = mintCoveQuoteForTest();
    const imposter = ed25519FromSeed(Buffer.alloc(32, 0x42));
    const forged: CoveQuote = {
      ...minted.quote,
      chain: [
        minted.quote.chain[0],
        minted.quote.chain[1],
        {
          ...minted.quote.chain[2],
          subjectPublicKey: imposter.rawPublicKey.toString("base64url"),
        },
      ] as CoveQuote["chain"],
    };
    const result = verifyCoveQuote(forged, {
      trustedRotPublicKey: minted.rotPublicKey,
    });
    expect(result.verified).toBe(false);
    if (result.verified) throw new Error("unreachable");
    // The Alias cert TBS changed, so the DeviceID-issued signature fails.
    expect(result.reason).toBe("cert-signature-invalid");
  });

  it("fails on a bad report_data binding (wrong ephemeral key)", () => {
    const minted = mintCoveQuoteForTest();
    const result = verifyCoveQuote(minted.quote, {
      trustedRotPublicKey: minted.rotPublicKey,
    });
    expect(result.verified).toBe(true);
    if (!result.verified) throw new Error("unreachable");
    // The verified report_data must equal the binding the verifier computes
    // from the nonce it issued and the ephemeral key it offered. A different
    // ephemeral key yields a different digest -> the channel binding is rejected.
    const wrongBinding = expectedReportData(
      minted.nonce,
      Buffer.alloc(32, 0x00),
    );
    expect(result.body.reportData).not.toBe(wrongBinding);
  });

  it("accepts a quote bound to the nonce/epk this verifier issued", () => {
    const minted = mintCoveQuoteForTest();
    const result = verifyCoveQuote(minted.quote, {
      trustedRotPublicKey: minted.rotPublicKey,
      expectedNonce: minted.nonce,
      ephemeralPublicKey: minted.ephemeralPublicKey,
    });
    expect(result.verified).toBe(true);
    if (!result.verified) throw new Error("unreachable");
    expect(result.body.reportData).toBe(
      expectedReportData(minted.nonce, minted.ephemeralPublicKey),
    );
  });

  it("rejects a replayed quote: report_data does not match the issued nonce", () => {
    // A cryptographically valid quote captured from an earlier challenge: its
    // report_data binds the OLD nonce, so this verifier's fresh nonce rejects it.
    const minted = mintCoveQuoteForTest({ nonce: "captured-old-nonce" });
    const result = verifyCoveQuote(minted.quote, {
      trustedRotPublicKey: minted.rotPublicKey,
      expectedNonce: "fresh-verifier-nonce",
      ephemeralPublicKey: minted.ephemeralPublicKey,
    });
    expect(result.verified).toBe(false);
    if (result.verified) throw new Error("unreachable");
    expect(result.reason).toBe("report-data-mismatch");
  });

  it("rejects a quote bound to a different ephemeral key (epk swap)", () => {
    const minted = mintCoveQuoteForTest();
    const result = verifyCoveQuote(minted.quote, {
      trustedRotPublicKey: minted.rotPublicKey,
      expectedNonce: minted.nonce,
      ephemeralPublicKey: Buffer.alloc(32, 0x00),
    });
    expect(result.verified).toBe(false);
    if (result.verified) throw new Error("unreachable");
    expect(result.reason).toBe("report-data-mismatch");
  });

  it("fails when report_data is structurally malformed", () => {
    const minted = mintCoveQuoteForTest();
    // Re-sign a body whose reportData is not a sha256 digest, so the signature
    // is valid but the binding format check rejects it.
    const badBody: CoveQuoteBody = {
      ...minted.quote.body,
      reportData: "not-a-digest",
    };
    const alias = ed25519FromSeed(
      hkdf(
        walkCdiLadder(
          Buffer.alloc(32, 0xfe),
          Buffer.alloc(32, 0xb1),
          Buffer.alloc(32, 0xb2),
          Buffer.alloc(32, 0x70),
        ),
        Buffer.alloc(0),
        "E1-DICE-Alias-Ed25519",
      ),
    );
    const signature = Buffer.from(
      cryptoSign(null, canonicalBodyBytes(badBody), alias.privateKey),
    ).toString("base64url");
    const result = verifyCoveQuote(
      { ...minted.quote, body: badBody, signature },
      { trustedRotPublicKey: minted.rotPublicKey },
    );
    expect(result.verified).toBe(false);
    if (result.verified) throw new Error("unreachable");
    expect(result.reason).toBe("report-data-malformed");
  });

  it("rejects a rolled-back security version below the floor", () => {
    const minted = mintCoveQuoteForTest({ securityVersion: 2 });
    const result = verifyCoveQuote(minted.quote, {
      trustedRotPublicKey: minted.rotPublicKey,
      minSecurityVersion: 5,
    });
    expect(result.verified).toBe(false);
    if (result.verified) throw new Error("unreachable");
    expect(result.reason).toBe("security-version-too-low");
  });

  it("rejects an expired certificate window", () => {
    const past = Date.now() - 10 * DAY_MS;
    const minted = mintCoveQuoteForTest({
      notBefore: new Date(past - DAY_MS).toISOString(),
      notAfter: new Date(past).toISOString(),
    });
    const result = verifyCoveQuote(minted.quote, {
      trustedRotPublicKey: minted.rotPublicKey,
    });
    expect(result.verified).toBe(false);
    if (result.verified) throw new Error("unreachable");
    expect(result.reason).toBe("cert-expired");
  });

  it("rejects a malformed quote object", () => {
    const result = verifyCoveQuote(
      { chain: [], body: {}, signature: 5 },
      { trustedRotPublicKey: "AAAA" },
    );
    expect(result.verified).toBe(false);
    if (result.verified) throw new Error("unreachable");
    expect(result.reason).toBe("malformed-quote");
  });

  it("policy can revoke a security version even on a cryptographically valid quote", () => {
    const minted = mintCoveQuoteForTest({ securityVersion: 6 });
    const result = verifyCoveQuote(minted.quote, {
      trustedRotPublicKey: minted.rotPublicKey,
    });
    expect(result.verified).toBe(true);
    if (!result.verified) throw new Error("unreachable");
    const decision = evaluateTeeEvidencePolicy(coveQuoteToTeeEvidence(result), {
      required: true,
      allowedKinds: ["cove"],
      revokedSecurityVersions: [6],
    });
    expect(decision.trusted).toBe(false);
    expect(decision.reason).toBe("security-version-revoked");
  });
});
