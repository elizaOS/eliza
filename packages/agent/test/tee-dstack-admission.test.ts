/**
 * dstack Intel TDX admission end to end without hardware. The real admission
 * code (createConfidentialLocalAdmission -> pinned dstack provider -> boot
 * gate) runs against a fake dstack guest agent socket and a SHA-256-pinned stub
 * verifier executable; nothing inside the agent is replaced. Covers the
 * positive path, a negative matrix across verifier, raw-quote, simulator and
 * release-authority failures, the raw TDX quote/attestation decoders, and a
 * KMS client that must appraise its own evidence before trusting a KMS answer.
 */

import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConfidentialLocalAdmission } from "../src/security/confidential-local-admission.ts";
import { decodeDstackAttestation } from "../src/services/tee-dstack-attestation.ts";
import { createDstackEvidenceProvider } from "../src/services/tee-dstack-evidence.ts";
import { verifyDstackKeySignatureChain } from "../src/services/tee-dstack-key-release.ts";
import { mergeDstackCpuProductionProfile } from "../src/services/tee-dstack-production-profile.ts";
import { resolveDstackEvidenceConfiguration } from "../src/services/tee-dstack-release.ts";
import {
  HttpTeeKeyReleaseClient,
  wrapTeeReleaseKey,
} from "../src/services/tee-key-release.ts";
import {
  assertTdxQuoteSelfSignature,
  parseTdxQuote,
} from "../src/services/tee-tdx-quote.ts";
import {
  buildTdxQuote,
  causeChain,
  DEPLOYMENT,
  type DstackHarness,
  dstackV1DeriveKey,
  fill,
  packMsgpack,
  QUOTE_REGISTERS,
  startDstackHarness,
} from "./support/dstack-tdx-harness.ts";

let harness: DstackHarness;
beforeAll(async () => {
  harness = await startDstackHarness();
});
afterAll(async () => {
  await harness?.close();
});

function resetMode(): void {
  for (const key of Object.keys(harness.guest.mode))
    delete harness.guest.mode[key as keyof typeof harness.guest.mode];
}

/** Admission result plus the provider-level cause for the same scenario. */
async function appraise(env: Record<string, string>) {
  const admission = await createConfidentialLocalAdmission(env).then(
    () => ({ admitted: true as const }),
    (error: unknown) => ({ admitted: false as const, error }),
  );
  const cause = await (async () => {
    try {
      const provider = createDstackEvidenceProvider(
        resolveDstackEvidenceConfiguration(env),
      );
      return { evidence: await provider.collectEvidence() };
    } catch (error) {
      return { failure: causeChain(error) };
    }
  })();
  return { admission, cause };
}

describe("dstack TDX admission (fake guest agent + pinned stub verifier)", () => {
  it("admits a pinned deployment and exposes quote-bound measurements", async () => {
    resetMode();
    const env = await harness.environment();
    const { admission, cause } = await appraise(env);
    expect(admission).toEqual({ admitted: true });
    expect(cause.evidence).toMatchObject({
      kind: "tdx",
      provider: "dstack",
      claims: { debugDisabled: true },
      measurements: {
        app: DEPLOYMENT.appId,
        compose: DEPLOYMENT.composeHash,
        os: DEPLOYMENT.osImageHash,
        boot: DEPLOYMENT.mrAggregated,
        mrtd: QUOTE_REGISTERS.mrTd.toString("hex"),
        rtmr0: QUOTE_REGISTERS.rtmrs[0].toString("hex"),
        rtmr3: QUOTE_REGISTERS.rtmrs[3].toString("hex"),
      },
    });
    expect(cause.evidence?.freshness?.verifier).toMatch(
      /^dstack-verifier:sha256:[0-9a-f]{64}$/,
    );
    expect(harness.guest.requests).toContain("/v1/Attest");
    // The returned re-appraisal closure re-attests on every call.
    const before = harness.guest.requests.length;
    const admit = await createConfidentialLocalAdmission(env);
    await expect(admit()).resolves.toBe(true);
    expect(harness.guest.requests.length).toBeGreaterThanOrEqual(before + 2);
  }, 60_000);

  it.each([
    ["quote v5 with a TD 1.0 body", { quoteVersion: 5, quoteBody: "td10" }],
    ["quote v5 with a TD 1.5 body", { quoteVersion: 5, quoteBody: "td15" }],
    ["MessagePack bin-encoded bytes", { binBytes: true }],
  ] as const)(
    "admits %s",
    async (_name, mode) => {
      resetMode();
      Object.assign(harness.guest.mode, mode);
      const { admission } = await appraise(await harness.environment());
      expect(admission).toEqual({ admitted: true });
    },
    60_000,
  );

  const matrix: Array<{
    name: string;
    mode?: Partial<typeof harness.guest.mode>;
    env?: Parameters<DstackHarness["environment"]>[0];
    cause: RegExp;
  }> = [
    {
      name: "TCB status OutOfDate",
      env: { verifier: { details: { tcb_status: "OutOfDate" } } },
      cause: /does not meet production appraisal policy/,
    },
    {
      name: "verifier JSON report_data mismatch",
      env: { verifier: { details: { report_data: "ab".repeat(64) } } },
      cause: /report-data challenge mismatch/,
    },
    {
      name: "raw quote report_data mismatch (verifier accepts)",
      mode: { wrongQuoteReportData: true },
      cause: /Raw TDX quote report data does not match the challenge/,
    },
    {
      name: "stack report_data mismatch",
      mode: { wrongStackReportData: true },
      cause: /stack report data does not match the challenge/,
    },
    {
      name: "debug TD attribute set (verifier accepts)",
      mode: { debug: true },
      cause: /debuggable trust domain/,
    },
    {
      name: "os_image_is_dev",
      env: { verifier: { details: { os_image_is_dev: true } } },
      cause: /does not meet production appraisal policy/,
    },
    {
      name: "advisory_ids non-empty",
      env: {
        verifier: { details: { advisory_ids: ["INTEL-SA-00837"] } },
      },
      cause: /advisory_ids/,
    },
    {
      name: "compose_hash mismatch",
      env: {
        verifier: { appInfoOverrides: { compose_hash: "f".repeat(64) } },
      },
      cause: /deployment identity does not match/,
    },
    {
      name: "verifier registers disagree with the raw quote",
      env: { verifier: { appInfoOverrides: { mrtd: "00".repeat(48) } } },
      cause: /registers do not match the raw TDX quote/,
    },
    {
      name: "verifier binary hash mismatch",
      env: { pin: { verifierSha256: "0".repeat(64) } },
      cause: /digest mismatch/,
    },
    {
      name: "expired release envelope",
      env: {
        release: {
          notBefore: new Date(Date.now() - 7_200_000).toISOString(),
          expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
        },
      },
      cause: /outside its validity interval/,
    },
    {
      name: "dstack simulator: report data patched into a captured quote",
      mode: { simulatorPatchedQuote: true },
      cause: /signature does not cover its header and report/,
    },
    {
      name: "seeded simulator: quote signed by an untrusted attestation key",
      mode: { untrustedAttestationKey: true },
      cause: /Pinned verifier rejected the attestation/,
    },
    {
      name: "legacy SCALE attestation (default simulator fixture)",
      mode: { legacyScale: true },
      cause: /Legacy SCALE attestations are not accepted/,
    },
  ];

  it.each(matrix)(
    "rejects: $name",
    async (scenario) => {
      resetMode();
      Object.assign(harness.guest.mode, scenario.mode ?? {});
      const { admission, cause } = await appraise(
        await harness.environment(scenario.env),
      );
      expect(admission.admitted).toBe(false);
      expect(
        admission.admitted ? undefined : (admission.error as { code?: string }),
      ).toMatchObject({ code: "CONFIDENTIAL_LOCAL_ADMISSION_REJECTED" });
      expect(cause.failure).toMatch(scenario.cause);
    },
    60_000,
  );
});

describe("raw TDX quote and dstack attestation decoding", () => {
  const attestationKey = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  }).privateKey;
  const reportData = randomBytes(64);

  it("parses v4 and v5 TD reports field by field", () => {
    for (const [version, body] of [
      [4, "td10"],
      [5, "td10"],
      [5, "td15"],
    ] as const) {
      const quote = parseTdxQuote(
        buildTdxQuote({ reportData, attestationKey, version, body }),
      );
      assertTdxQuoteSelfSignature(quote);
      expect(quote).toMatchObject({ version, body, teeType: 0x81 });
      expect(quote.report).toMatchObject({
        reportData: reportData.toString("hex"),
        mrTd: QUOTE_REGISTERS.mrTd.toString("hex"),
        rtmr2: QUOTE_REGISTERS.rtmrs[2].toString("hex"),
        mrSeam: fill(0x02).toString("hex"),
        tdAttributes: "0000001000000000",
        debug: false,
      });
      expect(quote.report.mrServiceTd !== undefined).toBe(body === "td15");
    }
    expect(
      parseTdxQuote(buildTdxQuote({ reportData, attestationKey, debug: true }))
        .report.debug,
    ).toBe(true);
  });

  it.each([
    ["version 3", { version: 3 }, /Unsupported TDX quote version 3/],
    ["SGX TEE type", { teeType: 0 }, /not an Intel TDX quote/],
    ["ECDSA-384 key type", { attestationKeyType: 3 }, /attestation key type/],
  ])("rejects %s", (_name, override, message) => {
    const quote = buildTdxQuote({ reportData, attestationKey });
    const header = quote.subarray(0, 8);
    if ("version" in override) header.writeUInt16LE(override.version, 0);
    if ("teeType" in override) header.writeUInt32LE(override.teeType, 4);
    if ("attestationKeyType" in override)
      header.writeUInt16LE(override.attestationKeyType, 2);
    expect(() => parseTdxQuote(quote)).toThrow(message);
  });

  it("rejects truncated quotes, bad v5 body sizes and altered reports", () => {
    const quote = buildTdxQuote({ reportData, attestationKey });
    expect(() => parseTdxQuote(quote.subarray(0, 600))).toThrow(/truncated/);
    expect(() => parseTdxQuote(quote.subarray(0, 700))).toThrow(/truncated/);
    const v5 = buildTdxQuote({ reportData, attestationKey, version: 5 });
    v5.writeUInt32LE(648, 50);
    expect(() => parseTdxQuote(v5)).toThrow(/body size/);
    const altered = Buffer.from(quote);
    altered[48 + 136] ^= 0xff; // one MRTD byte
    expect(() => assertTdxQuoteSelfSignature(parseTdxQuote(altered))).toThrow(
      /signature does not cover/,
    );
  });

  it("decodes guest-v1 MessagePack and rejects malformed attestations", () => {
    const quote = buildTdxQuote({ reportData, attestationKey });
    const document = {
      version: 1,
      platform: { kind: "tdx", data: { quote, event_log: [] } },
      stack: {
        kind: "dstack",
        data: { report_data: reportData, runtime_events: [], config: "{}" },
      },
    };
    const encoded = packMsgpack(document);
    const decoded = decodeDstackAttestation(encoded.toString("hex"));
    expect(decoded.platform).toBe("tdx");
    expect(decoded.tdxQuote?.equals(quote)).toBe(true);
    expect(decoded.stackReportData.equals(reportData)).toBe(true);
    const reject = (hex: string, message: RegExp) =>
      expect(() => decodeDstackAttestation(hex)).toThrow(message);
    reject(`${encoded.toString("hex")}00`, /trailing bytes/);
    reject(encoded.subarray(0, 40).toString("hex"), /truncated/);
    reject(`00${quote.toString("hex")}`, /Legacy SCALE/);
    reject("c0", /not a MessagePack V1 map/);
    reject(
      packMsgpack({ ...document, version: 2 }).toString("hex"),
      /Unsupported attestation version/,
    );
    reject(
      packMsgpack({
        ...document,
        stack: { kind: "dstack", data: { report_data: fill(1, 32) } },
      }).toString("hex"),
      /must be 64 bytes/,
    );
    // Duplicate key: a second "version" entry in a 4-entry map.
    const duplicate = Buffer.concat([
      Buffer.from([0x84]),
      packMsgpack("version"),
      packMsgpack(1),
      encoded.subarray(1),
    ]);
    reject(duplicate.toString("hex"), /repeats a map key/);
  });
});

describe("dstack guest-v1 key signature chain", () => {
  it("matches the published guest-api-v1 KDF and link-0 test vectors", () => {
    // docs/guest-api-v1.md test vectors (Dstack-TEE/dstack).
    const appRoot = Buffer.from(
      "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b",
      "hex",
    );
    expect(
      dstackV1DeriveKey(appRoot, "ed25519", "storage-encryption").toString(
        "hex",
      ),
    ).toBe("3c4c3ece12fa99ccb93fc0090877f80e70545fdd971e2ac93d3398c4684538d3");
    const link0 = Buffer.from(
      "5b6193729ce7976ec67863f21692d4b98c69832698aae8e001a7d33a6f818b6e46ca950725b6e90e8ca9bcf394abd03ce264bf9b7eec1e91693247f9dd53c26901",
      "hex",
    );
    const kmsRoot = secp256k1.utils.randomSecretKey();
    const appId = Buffer.from(DEPLOYMENT.appId, "hex");
    const appRootPublic = secp256k1.getPublicKey(appRoot, true);
    const signed = secp256k1.sign(
      keccak_256(
        Buffer.concat([
          Buffer.from("dstack-kms-issued:"),
          appId,
          appRootPublic,
        ]),
      ),
      kmsRoot,
      { prehash: false, format: "recovered" },
    );
    const link1 = Buffer.concat([signed.subarray(1), signed.subarray(0, 1)]);
    const publicKey = Buffer.from(
      "03d962450a41748021c8b02787ac36ce642ff0ae25f4c55019eb527e1112cfd764",
      "hex",
    );
    const verified = verifyDstackKeySignatureChain({
      algorithm: "secp256k1",
      domain: "storage-encryption",
      publicKey,
      signatureChain: [link0, link1],
      appId,
      kmsRootPublicKey: secp256k1.getPublicKey(kmsRoot, true),
    });
    expect(verified.equals(Buffer.from(appRootPublic))).toBe(true);
    expect(() =>
      verifyDstackKeySignatureChain({
        algorithm: "secp256k1",
        domain: "storage-encryption",
        publicKey,
        signatureChain: [link0, link1],
        appId: Buffer.from("00".repeat(20), "hex"),
        kmsRootPublicKey: secp256k1.getPublicKey(kmsRoot, true),
      }),
    ).toThrow(/not rooted in the pinned KMS/);
  });
});

describe("KMS key release appraises its own evidence", () => {
  it("trusts local dstack appraisal, not the KMS's decision document", async () => {
    resetMode();
    const env = await harness.environment();
    const config = resolveDstackEvidenceConfiguration(env);
    const provider = createDstackEvidenceProvider(config);
    const policy = mergeDstackCpuProductionProfile(undefined, env);
    const kmsRequests: unknown[] = [];
    const kms = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        kmsRequests.push(body);
        // A KMS that claims trust for any evidence and fabricates its own.
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            keyId: body.keyId,
            nonce: body.nonce,
            decision: {
              trusted: true,
              reason: "allowed",
              evidence: { kind: "tdx", provider: "dstack" },
            },
            wrappedKey: wrapTeeReleaseKey({
              keyMaterialHex: "ab".repeat(32),
              agentEphemeralPublicKeyDerBase64: body.ephemeralPublicKey,
              nonceHex: body.nonce,
            }),
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      kms.listen(0, "127.0.0.1", () => resolve()),
    );
    try {
      const { port } = kms.address() as AddressInfo;
      const client = new HttpTeeKeyReleaseClient({
        baseUrl: `http://127.0.0.1:${port}`,
        evidenceProvider: provider,
      });
      const release = await client.releaseKey({
        keyId: "state-volume",
        policy,
      });
      expect(release.keyMaterialHex).toBe("ab".repeat(32));
      expect(release.decision.evidence).toMatchObject({
        provider: "dstack",
        measurements: { app: DEPLOYMENT.appId, mrtd: expect.any(String) },
      });
      expect(release.decision.evidence?.freshness?.verifier).toMatch(
        /^dstack-verifier:sha256:/,
      );
      expect(release.keySourceDecision?.evidence).toEqual({
        kind: "tdx",
        provider: "dstack",
      });
      expect(kmsRequests).toHaveLength(1);

      // Our own evidence now fails appraisal: the KMS is never contacted even
      // though it would answer "trusted".
      harness.guest.mode.debug = true;
      await expect(
        client.releaseKey({ keyId: "state-volume", policy }),
      ).rejects.toThrow(/Dstack evidence collection\/appraisal failed/);
      expect(kmsRequests).toHaveLength(1);
    } finally {
      resetMode();
      await new Promise<void>((resolve) => kms.close(() => resolve()));
    }
  }, 60_000);
});
