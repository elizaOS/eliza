/**
 * Standard-format CoVE / AP-TEE evidence verifier: X.509 DER certificate chains
 * carrying a TCG DICE `DiceTcbInfo` extension (OID 2.23.133.5.4), as emitted by
 * real RISC-V CoVE TSMs (e.g. Salus via its `rice` DICE crate) through the
 * COVG `get_evidence(DiceTcbInfo)` call.
 *
 * This is an ADDITIONAL accepted format alongside the bespoke canonical-JSON
 * DICE path in `cove-quote.ts`; neither replaces the other. The canonical-JSON
 * path is the reference the E1 silicon may reproduce without an ASN.1 encoder;
 * this path is what interoperates with TSMs that already emit standard X.509.
 *
 * Real cryptography only. Each certificate's signature is verified with
 * node:crypto (`X509Certificate.verify`/`createPublicKey`) — Ed25519 per the
 * rice format (algorithm OID 1.3.101.112). The chain is anchored in a trusted
 * RoT public key supplied out-of-band (the DeviceID / layer-0 key), exactly as
 * a relying party must obtain a CoVE root anchor: it is not carried in the leaf.
 *
 * `DiceTcbInfo` FwId measurements are extracted with a minimal ASN.1 DER reader
 * (node's `X509Certificate` does not surface custom extensions), keeping the
 * SHA-384 (or other) digests and the optional SVN, then mapped into the
 * normalized `TeeEvidence` shape so the same policy evaluator consumes them.
 */

import {
  createHash,
  createPublicKey,
  type KeyObject,
  timingSafeEqual,
  X509Certificate,
} from "node:crypto";
import {
  normalizeTeeEvidence,
  type TeeEvidence,
  type TeeMeasurements,
} from "./tee-evidence.ts";

/** TCG DICE `DiceTcbInfo` extension OID: tcg(2.23.133) platformClass(5) 4. */
export const TCG_DICE_TCB_INFO_OID = "2.23.133.5.4";
/** Ed25519 signature/key algorithm OID (RFC 8410). */
export const ED25519_OID = "1.3.101.112";
/** SHA-384 hash algorithm OID (the digest rice's FwIds use). */
export const SHA384_OID = "2.16.840.1.101.3.4.2.2";

/** A single FWID entry from a `DiceTcbInfo` extension. */
export type DiceFwId = {
  /** Hash algorithm OID (e.g. SHA-384 `2.16.840.1.101.3.4.2.2`). */
  hashAlgOid: string;
  /** Lowercase-hex digest bytes. */
  digestHex: string;
};

/** Decoded `DiceTcbInfo` extension contents (only the fields rice emits). */
export type DiceTcbInfo = {
  /** FWID measurement list, in encoded order (TCG PCR-register order). */
  fwids: DiceFwId[];
  /** Security version number, when the `svn` field [3] is present. */
  svn?: number;
  vendor?: string;
  model?: string;
  version?: string;
  /** Raw operational-flags byte, when the `flags` field [7] is present. */
  flags?: number;
  /**
   * `vendorInfo` field [8] OCTET STRING, lowercase-hex, when present. A CoVE TSM
   * MAY place the live-channel `report_data` (SHA256(nonce || epk)) here so the
   * X.509 evidence is bound to the verifier's challenge. When the binding
   * options are supplied, this field is what the verifier checks against.
   */
  reportDataHex?: string;
};

/** One verified link in the chain, with its decoded `DiceTcbInfo` (if any). */
export type CoveX509Cert = {
  subject: string;
  issuer: string;
  /** SHA-256 hex of the subject SPKI DER (DeviceID-style identity digest). */
  spkiSha256: string;
  notBefore: string;
  notAfter: string;
  /** Decoded `DiceTcbInfo` extension, present on the leaf for rice certs. */
  tcbInfo?: DiceTcbInfo;
};

export type CoveX509VerifyOptions = {
  /**
   * The trusted RoT anchor: the issuer (DeviceID / layer-0) Ed25519 public key
   * that signed `chain[0]`. Accepts SPKI DER (Buffer/Uint8Array), SPKI/PEM
   * (string), or a raw 32-byte Ed25519 key (Buffer). Obtained out-of-band; a
   * CoVE leaf is signed by but does not contain its issuer key.
   */
  trustedRotPublicKey: Buffer | Uint8Array | string;
  /** Wall-clock for validity-window checks. Defaults to `Date.now()`. */
  nowMs?: number;
  /**
   * Nonce this verifier issued for the live channel. When supplied together
   * with `ephemeralPublicKey`, the leaf's `DiceTcbInfo` vendorInfo field MUST
   * carry `report_data = SHA256(nonce || epk)` and equal it, or verification
   * fails with `report-data-mismatch`. This is the anti-replay binding,
   * consistent with the canonical-JSON CoVE path (`verifyCoveQuote`). A leaf
   * that omits vendorInfo when a binding is required fails closed: the standard
   * rice `DiceTcbInfo` does not emit report_data, so a TSM that interoperates
   * with this binding MUST place it in vendorInfo [8]; otherwise the relying
   * party cannot prove freshness and must reject.
   */
  expectedNonce?: string;
  /** Ephemeral public key the verifier offered; bound with `expectedNonce`. */
  ephemeralPublicKey?: Buffer;
};

export type CoveX509VerifyResult =
  | {
      verified: true;
      /** Chain in input order: `chain[0]` is anchored, last is the leaf. */
      chain: [CoveX509Cert, ...CoveX509Cert[]];
      /** The leaf certificate (the one whose key attests the workload). */
      leaf: CoveX509Cert;
    }
  | { verified: false; reason: CoveX509VerifyFailure; detail: string };

export type CoveX509VerifyFailure =
  | "malformed-chain"
  | "empty-chain"
  | "root-anchor-mismatch"
  | "chain-link-broken"
  | "cert-signature-invalid"
  | "cert-expired"
  | "tcb-info-malformed"
  | "report-data-mismatch";

/**
 * Verify an X.509 DICE certificate chain with real Ed25519 cryptography:
 *   1. `chain[0]` (the highest cert provided) is verified against
 *      `trustedRotPublicKey` — the out-of-band RoT/DeviceID anchor.
 *   2. Each subsequent cert is verified against the previous cert's public key,
 *      and `issuer === parent.subject`.
 *   3. Every cert is inside its validity window.
 *   4. The leaf's `DiceTcbInfo` extension is decoded (FwIds + SVN).
 *   5. When `expectedNonce`/`ephemeralPublicKey` are supplied, the leaf's
 *      vendorInfo report_data equals SHA256(nonce || epk) — the live-channel
 *      binding that defeats replay. A leaf without vendorInfo fails closed.
 *
 * Never returns `verified:true` without a passing signature check at every link.
 * A single self-signed leaf is a valid one-element chain when it verifies
 * against the anchor (the anchor then IS the issuer key).
 */
export function verifyCoveX509Chain(
  derChain: ReadonlyArray<Buffer | Uint8Array>,
  options: CoveX509VerifyOptions,
): CoveX509VerifyResult {
  if (derChain.length === 0) {
    return fail("empty-chain", "Certificate chain is empty.");
  }

  const anchorKey = importAnchorKey(options.trustedRotPublicKey);
  if (anchorKey === undefined) {
    return fail(
      "root-anchor-mismatch",
      "Trusted RoT public key is not a valid Ed25519 public key.",
    );
  }

  const certs: X509Certificate[] = [];
  for (const der of derChain) {
    const cert = parseCertificate(der);
    if (cert === undefined) {
      return fail("malformed-chain", "A certificate is not parseable DER.");
    }
    certs.push(cert);
  }

  const nowMs = options.nowMs ?? Date.now();

  // The top cert is verified against the trusted RoT anchor.
  if (!certs[0].verify(anchorKey)) {
    return fail(
      "root-anchor-mismatch",
      "Top certificate is not signed by the trusted RoT public key.",
    );
  }

  const decoded: CoveX509Cert[] = [];
  let issuerKey = certs[0].publicKey;
  let issuerSubject = certs[0].subject;

  for (let i = 0; i < certs.length; i++) {
    const cert = certs[i];
    if (i > 0) {
      if (cert.issuer !== issuerSubject) {
        return fail(
          "chain-link-broken",
          `Certificate issuer "${cert.issuer}" does not match parent subject "${issuerSubject}".`,
        );
      }
      if (!cert.verify(issuerKey)) {
        return fail(
          "cert-signature-invalid",
          `Certificate "${cert.subject}" signature does not verify against its issuer.`,
        );
      }
    }

    const window = certWindowFailure(cert, nowMs);
    if (window !== undefined) return window;

    const tcbInfo = extractDiceTcbInfo(cert);
    if (tcbInfo === "malformed") {
      return fail(
        "tcb-info-malformed",
        `Certificate "${cert.subject}" has a malformed DiceTcbInfo extension.`,
      );
    }

    decoded.push({
      subject: cert.subject,
      issuer: cert.issuer,
      spkiSha256: spkiSha256Hex(cert.publicKey),
      notBefore: cert.validFrom,
      notAfter: cert.validTo,
      ...(tcbInfo === undefined ? {} : { tcbInfo }),
    });

    issuerKey = cert.publicKey;
    issuerSubject = cert.subject;
  }

  const chain = decoded as [CoveX509Cert, ...CoveX509Cert[]];
  const leaf = chain[chain.length - 1];

  if (
    options.expectedNonce !== undefined &&
    options.ephemeralPublicKey !== undefined
  ) {
    const presented = leaf.tcbInfo?.reportDataHex;
    if (presented === undefined) {
      return fail(
        "report-data-mismatch",
        "Leaf DiceTcbInfo carries no vendorInfo report_data to bind the live channel.",
      );
    }
    const expected = createHash("sha256")
      .update(Buffer.from(options.expectedNonce, "utf8"))
      .update(options.ephemeralPublicKey)
      .digest("hex");
    if (!constantTimeHexEquals(presented, expected)) {
      return fail(
        "report-data-mismatch",
        "Leaf report_data is not bound to the nonce/ephemeral key this verifier issued.",
      );
    }
  }

  return { verified: true, chain, leaf };
}

/**
 * Map a verified X.509 DICE chain into the normalized `TeeEvidence` shape so
 * `evaluateTeeEvidencePolicy` consumes it identically to the canonical-JSON
 * CoVE path. The leaf's `DiceTcbInfo` FwIds populate `measurements` under the
 * supplied register-name mapping; pass the result of a successful
 * `verifyCoveX509Chain` — never an unverified chain.
 *
 * @param fwidNames Maps FwId list index -> `TeeEvidence` measurement name. CoVE
 *   TSMs emit a fixed register layout (TCG PCR indices); the caller supplies the
 *   platform's register-to-name map so unrelated platforms are not conflated.
 */
export function coveX509ToTeeEvidence(
  result: Extract<CoveX509VerifyResult, { verified: true }>,
  fwidNames: ReadonlyArray<string>,
): TeeEvidence {
  const tcb = result.leaf.tcbInfo;
  const measurements: TeeMeasurements = {};
  if (tcb !== undefined) {
    for (let i = 0; i < tcb.fwids.length && i < fwidNames.length; i++) {
      const fwid = tcb.fwids[i];
      // Skip the all-zero "unmeasured register" sentinel rice emits for unused
      // PCR slots — a zero digest is the absence of a measurement, not a value.
      if (/^0+$/.test(fwid.digestHex)) continue;
      measurements[fwidNames[i]] =
        `${hashPrefix(fwid.hashAlgOid)}:${fwid.digestHex}`;
    }
  }

  return normalizeTeeEvidence({
    kind: "cove",
    provider: "eliza-riscv",
    ...(tcb?.vendor === undefined ? {} : { hardwareVendor: tcb.vendor }),
    ...(tcb?.version === undefined ? {} : { platformVersion: tcb.version }),
    ...(tcb?.svn === undefined ? {} : { securityVersion: tcb.svn }),
    ...(Object.keys(measurements).length === 0 ? {} : { measurements }),
    freshness: { verifier: "eliza-local-verifier" },
    certificatePem: result.leaf.subject,
  });
}

/**
 * Decode the `DiceTcbInfo` extension from a single X.509 DER certificate
 * WITHOUT verifying its signature. Use only for inspecting a cert's measurement
 * claims (e.g. logging, fixture assertions); trust decisions must go through
 * `verifyCoveX509Chain`. Returns `undefined` when the cert is unparseable or has
 * no `DiceTcbInfo` extension, `"malformed"` when the extension cannot decode.
 */
export function decodeDiceTcbInfoFromCert(
  der: Buffer | Uint8Array,
): DiceTcbInfo | "malformed" | undefined {
  const cert = parseCertificate(der);
  if (cert === undefined) return undefined;
  return extractDiceTcbInfo(cert);
}

function importAnchorKey(
  value: Buffer | Uint8Array | string,
): KeyObject | undefined {
  try {
    if (typeof value === "string") {
      return createPublicKey(value);
    }
    const buf = Buffer.from(value);
    // A bare 32-byte Ed25519 key is wrapped in its SPKI DER prefix.
    if (buf.length === 32) {
      const der = Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        buf,
      ]);
      return createPublicKey({ key: der, format: "der", type: "spki" });
    }
    return createPublicKey({ key: buf, format: "der", type: "spki" });
  } catch {
    return undefined;
  }
}

function parseCertificate(
  der: Buffer | Uint8Array,
): X509Certificate | undefined {
  try {
    return new X509Certificate(Buffer.from(der));
  } catch {
    return undefined;
  }
}

function certWindowFailure(
  cert: X509Certificate,
  nowMs: number,
): Extract<CoveX509VerifyResult, { verified: false }> | undefined {
  const notBefore = Date.parse(cert.validFrom);
  const notAfter = Date.parse(cert.validTo);
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) {
    return fail(
      "cert-expired",
      `Certificate "${cert.subject}" has an unparseable validity window.`,
    );
  }
  if (nowMs < notBefore || nowMs > notAfter) {
    return fail(
      "cert-expired",
      `Certificate "${cert.subject}" is outside its validity window.`,
    );
  }
  return undefined;
}

function spkiSha256Hex(publicKey: KeyObject): string {
  const spki = publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(spki).digest("hex");
}

function hashPrefix(oid: string): string {
  return oid === SHA384_OID ? "sha384" : "sha256";
}

function constantTimeHexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const left = Buffer.from(a.toLowerCase(), "utf8");
  const right = Buffer.from(b.toLowerCase(), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// --- Minimal ASN.1 DER reader (TLV) ----------------------------------------
// Only the subset needed to locate a certificate extension by OID and decode a
// DiceTcbInfo body. No external dependency; node's X509Certificate does not
// surface custom critical extensions, so the raw cert DER is walked here.

type Tlv = {
  /** Tag byte (class + constructed + number). */
  tag: number;
  /** Offset of the value (content) within the source buffer. */
  contentStart: number;
  /** Length of the value in bytes. */
  length: number;
  /** Offset just past this TLV (start of the next sibling). */
  end: number;
};

function readTlv(buf: Buffer, offset: number): Tlv | undefined {
  if (offset + 2 > buf.length) return undefined;
  const tag = buf[offset];
  let pos = offset + 1;
  let length = buf[pos];
  pos += 1;
  if (length & 0x80) {
    const numBytes = length & 0x7f;
    if (numBytes === 0 || numBytes > 4 || pos + numBytes > buf.length) {
      return undefined;
    }
    length = 0;
    for (let i = 0; i < numBytes; i++) {
      length = (length << 8) | buf[pos];
      pos += 1;
    }
  }
  const end = pos + length;
  if (end > buf.length) return undefined;
  return { tag, contentStart: pos, length, end };
}

/** Decode a DER OBJECT IDENTIFIER body (content bytes) into dotted form. */
function decodeOid(content: Buffer): string {
  if (content.length === 0) return "";
  const first = content[0];
  const parts = [Math.floor(first / 40), first % 40];
  let value = 0;
  for (let i = 1; i < content.length; i++) {
    value = (value << 7) | (content[i] & 0x7f);
    if ((content[i] & 0x80) === 0) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join(".");
}

/** Decode a DER INTEGER content into a JS number (small values only). */
function decodeUint(content: Buffer): number | undefined {
  if (content.length === 0 || content.length > 6) return undefined;
  let value = 0;
  for (const byte of content) value = value * 256 + byte;
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Locate the `DiceTcbInfo` extension in a certificate and decode it. Returns
 * `undefined` when no such extension exists, the literal `"malformed"` when one
 * exists but cannot be decoded.
 */
function extractDiceTcbInfo(
  cert: X509Certificate,
): DiceTcbInfo | "malformed" | undefined {
  const der = Buffer.from(cert.raw);
  const extnValue = findExtensionValue(der, TCG_DICE_TCB_INFO_OID);
  if (extnValue === undefined) return undefined;
  return decodeDiceTcbInfo(extnValue);
}

/**
 * Walk the certificate DER to the extensions and return the OCTET STRING value
 * of the extension matching `oid`. Structure walked:
 *   Certificate ::= SEQUENCE { tbsCertificate SEQUENCE, sigAlg, sig }
 *   tbsCertificate contains [3] EXPLICIT Extensions OPTIONAL
 *   Extensions ::= SEQUENCE OF Extension { OID, BOOLEAN OPTIONAL, OCTET STRING }
 */
function findExtensionValue(der: Buffer, oid: string): Buffer | undefined {
  const cert = readTlv(der, 0);
  if (cert === undefined) return undefined;
  const tbs = readTlv(der, cert.contentStart);
  if (tbs === undefined) return undefined;

  // Scan tbsCertificate children for the [3] EXPLICIT extensions wrapper (0xA3).
  let pos = tbs.contentStart;
  let extensions: Tlv | undefined;
  while (pos < tbs.end) {
    const field = readTlv(der, pos);
    if (field === undefined) return undefined;
    if (field.tag === 0xa3) {
      extensions = readTlv(der, field.contentStart); // inner SEQUENCE OF
      break;
    }
    pos = field.end;
  }
  if (extensions === undefined) return undefined;

  // Each Extension is a SEQUENCE { extnID OID, critical BOOLEAN?, extnValue OCTET STRING }.
  let extPos = extensions.contentStart;
  while (extPos < extensions.end) {
    const ext = readTlv(der, extPos);
    if (ext === undefined) return undefined;
    let fieldPos = ext.contentStart;
    const idTlv = readTlv(der, fieldPos);
    if (idTlv === undefined || idTlv.tag !== 0x06) return undefined;
    const id = decodeOid(
      der.subarray(idTlv.contentStart, idTlv.contentStart + idTlv.length),
    );
    fieldPos = idTlv.end;
    let next = readTlv(der, fieldPos);
    if (next === undefined) return undefined;
    if (next.tag === 0x01) {
      // optional critical BOOLEAN
      fieldPos = next.end;
      next = readTlv(der, fieldPos);
      if (next === undefined) return undefined;
    }
    if (next.tag !== 0x04) return undefined; // extnValue OCTET STRING
    if (id === oid) {
      return der.subarray(next.contentStart, next.contentStart + next.length);
    }
    extPos = ext.end;
  }
  return undefined;
}

/**
 * Decode the `DiceTcbInfo` SEQUENCE. Fields are IMPLICIT context-tagged:
 *   [0] vendor UTF8String, [1] model, [2] version, [3] svn INTEGER,
 *   [6] fwids SEQUENCE OF FWID, [7] flags BIT STRING, [8] vendorInfo OCTET
 *   STRING (report_data binding). FWID is SEQUENCE { hashAlg OID, digest OCTET
 *   STRING }.
 */
function decodeDiceTcbInfo(extnValue: Buffer): DiceTcbInfo | "malformed" {
  const seq = readTlv(extnValue, 0);
  if (seq === undefined || seq.tag !== 0x30) return "malformed";

  const info: DiceTcbInfo = { fwids: [] };
  let pos = seq.contentStart;
  while (pos < seq.end) {
    const field = readTlv(extnValue, pos);
    if (field === undefined) return "malformed";
    const content = extnValue.subarray(
      field.contentStart,
      field.contentStart + field.length,
    );
    switch (field.tag) {
      case 0x80: // [0] vendor
        info.vendor = content.toString("utf8");
        break;
      case 0x81: // [1] model
        info.model = content.toString("utf8");
        break;
      case 0x82: // [2] version
        info.version = content.toString("utf8");
        break;
      case 0x83: {
        // [3] svn INTEGER
        const svn = decodeUint(content);
        if (svn === undefined) return "malformed";
        info.svn = svn;
        break;
      }
      case 0xa6: {
        // [6] fwids SEQUENCE OF FWID (IMPLICIT -> content is the list directly)
        const fwids = decodeFwIds(content);
        if (fwids === "malformed") return "malformed";
        info.fwids = fwids;
        break;
      }
      case 0x87: // [7] flags (single-byte operational flags after unused-bits)
        info.flags = content.length >= 2 ? content[1] : (content[0] ?? 0);
        break;
      case 0x88: // [8] vendorInfo OCTET STRING (carries report_data for binding)
        info.reportDataHex = content.toString("hex");
        break;
      default:
        break; // skip layer/index/vendorInfo/type we do not consume
    }
    pos = field.end;
  }
  return info;
}

function decodeFwIds(list: Buffer): DiceFwId[] | "malformed" {
  const fwids: DiceFwId[] = [];
  let pos = 0;
  while (pos < list.length) {
    const fwid = readTlv(list, pos);
    if (fwid === undefined || fwid.tag !== 0x30) return "malformed";
    const algTlv = readTlv(list, fwid.contentStart);
    if (algTlv === undefined || algTlv.tag !== 0x06) return "malformed";
    const hashAlgOid = decodeOid(
      list.subarray(algTlv.contentStart, algTlv.contentStart + algTlv.length),
    );
    const digestTlv = readTlv(list, algTlv.end);
    if (digestTlv === undefined || digestTlv.tag !== 0x04) return "malformed";
    const digestHex = list
      .subarray(
        digestTlv.contentStart,
        digestTlv.contentStart + digestTlv.length,
      )
      .toString("hex");
    fwids.push({ hashAlgOid, digestHex });
    pos = fwid.end;
  }
  if (fwids.length === 0) return "malformed";
  return fwids;
}

function fail(
  reason: CoveX509VerifyFailure,
  detail: string,
): Extract<CoveX509VerifyResult, { verified: false }> {
  return { verified: false, reason, detail };
}
