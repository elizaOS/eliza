/**
 * In-repo Intel TDX DCAP quote parser (quote v4, and v5 with a TD 1.0 or TD 1.5
 * body). It exposes the TD report fields the agent binds to (MRTD, RTMR0-3,
 * TDATTRIBUTES, REPORTDATA) and checks the quote's ECDSA-P256 self-signature
 * with the attestation key the quote carries, which detects any byte of the
 * header or TD report being altered after signing (for example report data
 * patched into a captured quote, as the dstack simulator does).
 *
 * Authenticity is NOT established here: the attestation key's QE report, PCK
 * certificate chain to Intel's root, TCB level, QE identity and revocation are
 * appraised by the pinned external dstack-verifier. This parser is defense in
 * depth that binds the raw quote bytes independently of the verifier's JSON.
 */
import { createPublicKey, verify } from "node:crypto";
import { ElizaError } from "@elizaos/core";

export const TDX_TEE_TYPE = 0x81;
/** ECDSA-256-with-P-256 attestation key; the only type Intel QEs issue for TDX. */
export const TDX_ATTESTATION_KEY_TYPE_ECDSA_P256 = 2;
const HEADER_BYTES = 48;
const TD10_BODY_BYTES = 584;
const TD15_BODY_BYTES = 648;
const V5_BODY_DESCRIPTOR_BYTES = 6;
const SIGNATURE_BYTES = 64;
const ATTESTATION_KEY_BYTES = 64;
/** TDATTRIBUTES bit 0: the TD is debuggable and its memory is host-readable. */
const TD_ATTRIBUTES_DEBUG_BIT = 0x01;
const MAX_QUOTE_BYTES = 1024 * 1024;

export type TdxTdReport = {
  teeTcbSvn: string;
  mrSeam: string;
  mrSignerSeam: string;
  seamAttributes: string;
  tdAttributes: string;
  xfam: string;
  mrTd: string;
  mrConfigId: string;
  mrOwner: string;
  mrOwnerConfig: string;
  rtmr0: string;
  rtmr1: string;
  rtmr2: string;
  rtmr3: string;
  reportData: string;
  /** TDATTRIBUTES.DEBUG; a debuggable TD provides no confidentiality. */
  debug: boolean;
  /** TD 1.5 bodies only. */
  teeTcbSvn2?: string;
  mrServiceTd?: string;
};

export type ParsedTdxQuote = {
  version: 4 | 5;
  attestationKeyType: number;
  teeType: number;
  body: "td10" | "td15";
  report: TdxTdReport;
  /** Header and body bytes covered by the attestation-key signature. */
  signedBytes: Buffer;
  signature: Buffer;
  /** Raw uncompressed P-256 point (x || y) carried in the signature data. */
  attestationKey: Buffer;
};

function rejected(message: string): ElizaError {
  return new ElizaError(message, { code: "TEE_TDX_QUOTE_REJECTED" });
}

function field(body: Buffer, offset: number, length: number): string {
  return body.subarray(offset, offset + length).toString("hex");
}

function parseTdReport(body: Buffer, kind: "td10" | "td15"): TdxTdReport {
  const tdAttributes = body.subarray(120, 128);
  // Byte 0 of the little-endian TDATTRIBUTES word holds TUD bits 0..7.
  const debug = ((tdAttributes[0] ?? 0) & TD_ATTRIBUTES_DEBUG_BIT) !== 0;
  return {
    teeTcbSvn: field(body, 0, 16),
    mrSeam: field(body, 16, 48),
    mrSignerSeam: field(body, 64, 48),
    seamAttributes: field(body, 112, 8),
    tdAttributes: tdAttributes.toString("hex"),
    xfam: field(body, 128, 8),
    mrTd: field(body, 136, 48),
    mrConfigId: field(body, 184, 48),
    mrOwner: field(body, 232, 48),
    mrOwnerConfig: field(body, 280, 48),
    rtmr0: field(body, 328, 48),
    rtmr1: field(body, 376, 48),
    rtmr2: field(body, 424, 48),
    rtmr3: field(body, 472, 48),
    reportData: field(body, 520, 64),
    debug,
    ...(kind === "td15"
      ? { teeTcbSvn2: field(body, 584, 16), mrServiceTd: field(body, 600, 48) }
      : {}),
  };
}

/**
 * Parse a TDX quote. Rejects SGX quotes, non-P-256 attestation keys, unknown
 * versions/body types and truncated or inconsistent lengths with a typed error.
 * Bytes after the declared signature data are ignored; they are not signed.
 */
export function parseTdxQuote(input: Uint8Array): ParsedTdxQuote {
  const quote = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (quote.length > MAX_QUOTE_BYTES)
    throw rejected("TDX quote exceeds protocol size limit");
  if (quote.length < HEADER_BYTES) throw rejected("TDX quote is truncated");
  const version = quote.readUInt16LE(0);
  const attestationKeyType = quote.readUInt16LE(2);
  const teeType = quote.readUInt32LE(4);
  if (version !== 4 && version !== 5)
    throw rejected(`Unsupported TDX quote version ${version}`);
  if (teeType !== TDX_TEE_TYPE)
    throw rejected("Quote is not an Intel TDX quote");
  if (attestationKeyType !== TDX_ATTESTATION_KEY_TYPE_ECDSA_P256)
    throw rejected("Unsupported TDX attestation key type");
  let bodyOffset = HEADER_BYTES;
  let bodyLength = TD10_BODY_BYTES;
  let body: "td10" | "td15" = "td10";
  if (version === 5) {
    if (quote.length < HEADER_BYTES + V5_BODY_DESCRIPTOR_BYTES)
      throw rejected("TDX quote is truncated");
    const bodyType = quote.readUInt16LE(HEADER_BYTES);
    const declared = quote.readUInt32LE(HEADER_BYTES + 2);
    if (bodyType === 2) bodyLength = TD10_BODY_BYTES;
    else if (bodyType === 3) {
      bodyLength = TD15_BODY_BYTES;
      body = "td15";
    } else throw rejected(`Unsupported TDX quote v5 body type ${bodyType}`);
    if (declared !== bodyLength)
      throw rejected("TDX quote v5 body size does not match its type");
    bodyOffset = HEADER_BYTES + V5_BODY_DESCRIPTOR_BYTES;
  }
  const signedEnd = bodyOffset + bodyLength;
  if (quote.length < signedEnd + 4) throw rejected("TDX quote is truncated");
  const signatureDataLength = quote.readUInt32LE(signedEnd);
  const signatureData = signedEnd + 4;
  if (
    signatureDataLength < SIGNATURE_BYTES + ATTESTATION_KEY_BYTES ||
    quote.length < signatureData + signatureDataLength
  ) {
    throw rejected("TDX quote signature data is truncated");
  }
  return {
    version: version === 4 ? 4 : 5,
    attestationKeyType,
    teeType,
    body,
    report: parseTdReport(quote.subarray(bodyOffset, signedEnd), body),
    signedBytes: Buffer.from(quote.subarray(0, signedEnd)),
    signature: Buffer.from(
      quote.subarray(signatureData, signatureData + SIGNATURE_BYTES),
    ),
    attestationKey: Buffer.from(
      quote.subarray(
        signatureData + SIGNATURE_BYTES,
        signatureData + SIGNATURE_BYTES + ATTESTATION_KEY_BYTES,
      ),
    ),
  };
}

/** Verify the header+body ECDSA-P256 signature under the embedded attestation key. */
export function assertTdxQuoteSelfSignature(quote: ParsedTdxQuote): void {
  let valid = false;
  try {
    const key = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: quote.attestationKey.subarray(0, 32).toString("base64url"),
        y: quote.attestationKey.subarray(32, 64).toString("base64url"),
      },
      format: "jwk",
    });
    valid = verify(
      "sha256",
      quote.signedBytes,
      { key, dsaEncoding: "ieee-p1363" },
      quote.signature,
    );
  } catch {
    // error-policy:J2 An unusable attestation key never yields a valid quote.
    valid = false;
  }
  if (!valid)
    throw rejected("TDX quote signature does not cover its header and report");
}
