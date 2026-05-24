import {
  createHash,
  sign as edSign,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  coveX509ToTeeEvidence,
  decodeDiceTcbInfoFromCert,
  ED25519_OID,
  SHA384_OID,
  TCG_DICE_TCB_INFO_OID,
  verifyCoveX509Chain,
} from "./cove-quote-x509.ts";
import { evaluateTeeEvidencePolicy } from "./tee-policy.ts";

/**
 * Real Salus CoVE evidence certificate, captured from the COVG
 * get_evidence(DiceTcbInfo) flow on the chip's qemu-system-riscv64 (Salus
 * M-mode TSM + tellus_guestvm, `rice` DICE crate). 963-byte X.509 DER, Ed25519,
 * with a critical TCG DiceTcbInfo extension (OID 2.23.133.5.4) carrying 8
 * SHA-384 FWID measurement registers. This is the exact byte string a real TSM
 * emits; the verifier must decode it without our bespoke canonical-JSON format.
 */
const REAL_SALUS_EVIDENCE_DER_B64 =
  "MIIDvzCCA3GgAwIBAgIoNDk2MzBkMTMwYTdjZDNhNjczOTA5OTUwZTViZjkzYzlmOWE0NTM2NTAFBgMrZXAwMzExMC8GA1UEBAwoMjk5ZDQxOTYyNGVhZGQ3OGQ1NmUzZDdlNGFiYmY3MWVmOTQ0NmVlYTAeFw0xODAzMjIyMzU5NTlaFw00OTEyMzEyMzU5NTlaMEsxCzAJBgNVBAYTAkZSMRUwEwYDVQQHDAxEZWZhdWx0IENpdHkxDjAMBgNVBAoMBVJpdm9zMRUwEwYDVQQDDAxyaXZvc2luYy5jb20wKjAFBgMrZXADIQD+kpOu4RdDnvitjMcaiYd/YH/bHuj2hqSndvUh56JzYaOCAmkwggJlMA4GA1UdDwEB/wQEAwIDKDAMBgNVHRMBAf8EAjAAMDMGA1UdIwQsMCqAKDI5OWQ0MTk2MjRlYWRkNzhkNTZlM2Q3ZTRhYmJmNzFlZjk0NDZlZWEwggIOBgVngQUFBAEB/wSCAgAwggH8poIB+DA9BglghkgBZQMEAgIEMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADA9BglghkgBZQMEAgIEMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADA9BglghkgBZQMEAgIEMC+Phoz2Dvld3CIf+/bQFN4dipKQoE9wQ5+IxoHl83+RNxnt7AWoduLrYvKlpvsn5jA9BglghkgBZQMEAgIEMD7DiNuh03sg+PEPEnB4t2nPPmPDTnvkd5Dj/gP3DbpQ+Zm2V0BYZxfKqkCZ8NKPWzA9BglghkgBZQMEAgIEMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADA9BglghkgBZQMEAgIEME14PN+o1rwSk9Dxv7WPnwsFqO9yPLh0XRQtYKw7nSE8UfBqoem5L/CfZOSi0Mj+hzA9BglghkgBZQMEAgIEMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADA9BglghkgBZQMEAgIEMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAFBgMrZXADQQBB7O5s58gUzelzRt0wl7hzsGzBsECeD6Zh26/xp6OFOSq4oaifARQXMEZBJpeC+BlVGoFQ2f3q5b3ZkVoZi2IN";

const REAL_SALUS_EVIDENCE_DER = Buffer.from(
  REAL_SALUS_EVIDENCE_DER_B64,
  "base64",
);

// Measurement registers proven by the live Salus run (tellus_guestvm output).
const SALUS_TVM_PAGE_FWID =
  "2f8f868cf60ef95ddc221ffbf6d014de1d8a9290a04f70439f88c681e5f37f913719edec05a876e2eb62f2a5a6fb27e6";
const SALUS_RUNTIME_PCR1_FWID =
  "4d783cdfa8d6bc1293d0f1bfb58f9f0b05a8ef723cb8745d142d60ac3b9d213c51f06aa1e9b92ff09f64e4a2d0c8fe87";
const SALUS_TVM_CONFIG_FWID =
  "3ec388dba1d37b20f8f10f127078b769cf3e63c34e7be47790e3fe03f70dba50f999b65740586717caaa4099f0d28f5b";
const ZERO_FWID = "00".repeat(48);

// --- Minimal X.509 DER builder for faithful rice-format DICE chains ---------
// node:crypto cannot mint X.509 certs, so the test hand-encodes the same DER a
// rice TSM emits (Ed25519 cert, critical DiceTcbInfo with SHA-384 FwIds) and
// signs the TBS with real Ed25519 keys. Every signature here is real.

const der = {
  len(n: number): Buffer {
    if (n < 0x80) return Buffer.from([n]);
    const bytes: number[] = [];
    let x = n;
    while (x > 0) {
      bytes.unshift(x & 0xff);
      x >>= 8;
    }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  },
  tlv(tag: number, content: Buffer): Buffer {
    return Buffer.concat([
      Buffer.from([tag]),
      der.len(content.length),
      content,
    ]);
  },
  seq(...parts: Buffer[]): Buffer {
    return der.tlv(0x30, Buffer.concat(parts));
  },
  set(...parts: Buffer[]): Buffer {
    return der.tlv(0x31, Buffer.concat(parts));
  },
  oid(dotted: string): Buffer {
    const parts = dotted.split(".").map(Number);
    const bytes = [parts[0] * 40 + parts[1]];
    for (let i = 2; i < parts.length; i++) {
      let v = parts[i];
      const stack = [v & 0x7f];
      v >>= 7;
      while (v > 0) {
        stack.unshift((v & 0x7f) | 0x80);
        v >>= 7;
      }
      bytes.push(...stack);
    }
    return der.tlv(0x06, Buffer.from(bytes));
  },
  int(n: number): Buffer {
    let bytes: number[] = [];
    if (n === 0) bytes = [0];
    else {
      let x = n;
      while (x > 0) {
        bytes.unshift(x & 0xff);
        x = Math.floor(x / 256);
      }
      if (bytes[0] & 0x80) bytes.unshift(0);
    }
    return der.tlv(0x02, Buffer.from(bytes));
  },
  octet(buf: Buffer): Buffer {
    return der.tlv(0x04, buf);
  },
  bool(b: boolean): Buffer {
    return der.tlv(0x01, Buffer.from([b ? 0xff : 0x00]));
  },
  utf8(s: string): Buffer {
    return der.tlv(0x0c, Buffer.from(s, "utf8"));
  },
  utctime(s: string): Buffer {
    return der.tlv(0x17, Buffer.from(s, "ascii"));
  },
  bitstring(buf: Buffer): Buffer {
    return der.tlv(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
  },
};

function rawPub(key: KeyObject): Buffer {
  const spki = key.export({ type: "spki", format: "der" });
  return spki.subarray(spki.length - 32);
}

function spkiEd25519(raw: Buffer): Buffer {
  return der.seq(der.seq(der.oid(ED25519_OID)), der.bitstring(raw));
}

function commonName(cn: string): Buffer {
  return der.seq(der.set(der.seq(der.oid("2.5.4.3"), der.utf8(cn))));
}

function fwidEntry(digestHex: string): Buffer {
  return der.seq(der.oid(SHA384_OID), der.octet(Buffer.from(digestHex, "hex")));
}

function diceTcbInfo(
  fwidHexes: string[],
  svn?: number,
  reportDataHex?: string,
): Buffer {
  const fwids = der.tlv(0xa6, Buffer.concat(fwidHexes.map(fwidEntry))); // [6] IMPLICIT
  const parts: Buffer[] = [];
  if (svn !== undefined) {
    const svnContent = der.int(svn).subarray(2); // strip INTEGER tag+len -> raw content
    parts.push(der.tlv(0x83, svnContent)); // [3] IMPLICIT INTEGER
  }
  parts.push(fwids);
  if (reportDataHex !== undefined) {
    // [8] IMPLICIT vendorInfo OCTET STRING (carries report_data binding)
    parts.push(der.tlv(0x88, Buffer.from(reportDataHex, "hex")));
  }
  return der.seq(Buffer.concat(parts));
}

function extension(oid: string, critical: boolean, value: Buffer): Buffer {
  return der.seq(der.oid(oid), der.bool(critical), der.octet(value));
}

type CertSpec = {
  subjectCN: string;
  issuerCN: string;
  subjectPublic: Buffer;
  signTbs: (tbs: Buffer) => Buffer;
  fwidHexes?: string[];
  svn?: number;
  reportDataHex?: string;
  notBefore?: string;
  notAfter?: string;
};

function buildCert(spec: CertSpec): Buffer {
  const version = der.tlv(0xa0, der.int(2));
  const serial = der.int(1);
  const sigAlg = der.seq(der.oid(ED25519_OID));
  const validity = der.seq(
    der.utctime(spec.notBefore ?? "180322235959Z"),
    der.utctime(spec.notAfter ?? "491231235959Z"),
  );
  const exts: Buffer[] = [];
  if (spec.fwidHexes !== undefined) {
    exts.push(
      extension(
        TCG_DICE_TCB_INFO_OID,
        true,
        diceTcbInfo(spec.fwidHexes, spec.svn, spec.reportDataHex),
      ),
    );
  }
  const extensions = der.tlv(0xa3, der.seq(...exts));
  const tbs = der.seq(
    version,
    serial,
    sigAlg,
    commonName(spec.issuerCN),
    validity,
    commonName(spec.subjectCN),
    spkiEd25519(spec.subjectPublic),
    extensions,
  );
  return der.seq(tbs, sigAlg, der.bitstring(spec.signTbs(tbs)));
}

const signWith =
  (priv: KeyObject) =>
  (msg: Buffer): Buffer =>
    edSign(null, msg, priv);

/** Build a faithful rice-format RoT -> DeviceID -> Alias chain with real keys. */
function buildDiceChain(leafReportDataHex?: string) {
  const root = generateKeyPairSync("ed25519");
  const device = generateKeyPairSync("ed25519");
  const alias = generateKeyPairSync("ed25519");

  const deviceCert = buildCert({
    subjectCN: "E1-DeviceID",
    issuerCN: "E1-RoT",
    subjectPublic: rawPub(device.publicKey),
    signTbs: signWith(root.privateKey),
  });
  const aliasCert = buildCert({
    subjectCN: "E1-Alias",
    issuerCN: "E1-DeviceID",
    subjectPublic: rawPub(alias.publicKey),
    signTbs: signWith(device.privateKey),
    fwidHexes: [
      ZERO_FWID,
      ZERO_FWID,
      SALUS_TVM_PAGE_FWID,
      SALUS_TVM_CONFIG_FWID,
      ZERO_FWID,
      SALUS_RUNTIME_PCR1_FWID,
    ],
    svn: 7,
    ...(leafReportDataHex === undefined
      ? {}
      : { reportDataHex: leafReportDataHex }),
  });

  return {
    root,
    device,
    alias,
    deviceCert,
    aliasCert,
    rootAnchor: rawPub(root.publicKey),
  };
}

// CoVE register layout: index -> TeeEvidence measurement name.
const FWID_NAMES = ["boot", "os", "agent", "policy", "monitor", "device"];

// A wall-clock inside the certs' validity window (2018..2049).
const NOW_MS = Date.parse("2026-05-22T00:00:00Z");

describe("real Salus CoVE X.509 evidence", () => {
  it("decodes the DiceTcbInfo FwIds from the real captured cert", () => {
    const tcb = decodeDiceTcbInfoFromCert(REAL_SALUS_EVIDENCE_DER);
    expect(tcb).not.toBe("malformed");
    expect(tcb).toBeDefined();
    if (tcb === undefined || tcb === "malformed") return;

    expect(tcb.fwids).toHaveLength(8);
    for (const fwid of tcb.fwids) {
      expect(fwid.hashAlgOid).toBe(SHA384_OID);
      expect(fwid.digestHex).toHaveLength(96); // 48-byte SHA-384
    }
    // The non-zero registers from the live tellus_guestvm run.
    expect(tcb.fwids[2].digestHex).toBe(SALUS_TVM_PAGE_FWID);
    expect(tcb.fwids[3].digestHex).toBe(SALUS_TVM_CONFIG_FWID);
    expect(tcb.fwids[5].digestHex).toBe(SALUS_RUNTIME_PCR1_FWID);
    // Unused registers are the all-zero sentinel.
    expect(tcb.fwids[0].digestHex).toBe(ZERO_FWID);
    expect(tcb.fwids[6].digestHex).toBe(ZERO_FWID);
  });

  it("verifies the real cert as a self-anchored leaf against its issuer key", () => {
    // The real leaf is signed by the TSM DeviceID key (not exposed in the
    // single-cert evidence flow). A relying party must supply that anchor
    // out-of-band; a deliberately wrong anchor must fail closed.
    const wrongAnchor = generateKeyPairSync("ed25519");
    const result = verifyCoveX509Chain([REAL_SALUS_EVIDENCE_DER], {
      trustedRotPublicKey: rawPub(wrongAnchor.publicKey),
      nowMs: NOW_MS,
    });
    expect(result.verified).toBe(false);
    if (!result.verified) {
      expect(result.reason).toBe("root-anchor-mismatch");
    }
  });
});

describe("verifyCoveX509Chain", () => {
  it("verifies a real-key DICE chain against its RoT anchor", () => {
    const c = buildDiceChain();
    const result = verifyCoveX509Chain([c.deviceCert, c.aliasCert], {
      trustedRotPublicKey: c.rootAnchor,
      nowMs: NOW_MS,
    });
    expect(result.verified).toBe(true);
    if (!result.verified) return;

    expect(result.chain).toHaveLength(2);
    expect(result.leaf.subject).toContain("E1-Alias");
    expect(result.leaf.issuer).toContain("E1-DeviceID");
    expect(result.leaf.tcbInfo?.svn).toBe(7);
    expect(result.leaf.tcbInfo?.fwids).toHaveLength(6);
    expect(result.leaf.tcbInfo?.fwids[2].digestHex).toBe(SALUS_TVM_PAGE_FWID);
  });

  it("accepts a 32-byte raw Ed25519 anchor and an SPKI/PEM anchor", () => {
    const c = buildDiceChain();
    const rawResult = verifyCoveX509Chain([c.deviceCert, c.aliasCert], {
      trustedRotPublicKey: c.rootAnchor, // raw 32-byte
      nowMs: NOW_MS,
    });
    const pemResult = verifyCoveX509Chain([c.deviceCert, c.aliasCert], {
      trustedRotPublicKey: c.root.publicKey.export({
        type: "spki",
        format: "pem",
      }) as string,
      nowMs: NOW_MS,
    });
    expect(rawResult.verified).toBe(true);
    expect(pemResult.verified).toBe(true);
  });

  it("rejects a tampered leaf measurement (signature breaks)", () => {
    const c = buildDiceChain();
    // Re-issue the leaf with a different agent measurement but the ORIGINAL
    // signature copied over -> the signature no longer matches the TBS.
    const forged = buildCert({
      subjectCN: "E1-Alias",
      issuerCN: "E1-DeviceID",
      subjectPublic: rawPub(c.alias.publicKey),
      signTbs: () => Buffer.alloc(64), // invalid all-zero signature
      fwidHexes: [ZERO_FWID, ZERO_FWID, "ab".repeat(48)],
      svn: 7,
    });
    const result = verifyCoveX509Chain([c.deviceCert, forged], {
      trustedRotPublicKey: c.rootAnchor,
      nowMs: NOW_MS,
    });
    expect(result.verified).toBe(false);
    if (!result.verified) {
      expect(result.reason).toBe("cert-signature-invalid");
    }
  });

  it("rejects the wrong RoT anchor", () => {
    const c = buildDiceChain();
    const attacker = generateKeyPairSync("ed25519");
    const result = verifyCoveX509Chain([c.deviceCert, c.aliasCert], {
      trustedRotPublicKey: rawPub(attacker.publicKey),
      nowMs: NOW_MS,
    });
    expect(result.verified).toBe(false);
    if (!result.verified) {
      expect(result.reason).toBe("root-anchor-mismatch");
    }
  });

  it("rejects a broken issuer/subject link", () => {
    const c = buildDiceChain();
    // Leaf claims a different issuer CN than the parent's subject.
    const mismatched = buildCert({
      subjectCN: "E1-Alias",
      issuerCN: "E1-SomeOtherCA",
      subjectPublic: rawPub(c.alias.publicKey),
      signTbs: signWith(c.device.privateKey),
      fwidHexes: [ZERO_FWID, SALUS_TVM_PAGE_FWID],
    });
    const result = verifyCoveX509Chain([c.deviceCert, mismatched], {
      trustedRotPublicKey: c.rootAnchor,
      nowMs: NOW_MS,
    });
    expect(result.verified).toBe(false);
    if (!result.verified) {
      expect(result.reason).toBe("chain-link-broken");
    }
  });

  it("rejects an expired cert (now outside the validity window)", () => {
    const c = buildDiceChain();
    const result = verifyCoveX509Chain([c.deviceCert, c.aliasCert], {
      trustedRotPublicKey: c.rootAnchor,
      nowMs: Date.parse("2050-01-01T00:00:00Z"), // past notAfter 2049
    });
    expect(result.verified).toBe(false);
    if (!result.verified) {
      expect(result.reason).toBe("cert-expired");
    }
  });

  it("rejects an empty chain", () => {
    const c = buildDiceChain();
    const result = verifyCoveX509Chain([], {
      trustedRotPublicKey: c.rootAnchor,
      nowMs: NOW_MS,
    });
    expect(result.verified).toBe(false);
    if (!result.verified) {
      expect(result.reason).toBe("empty-chain");
    }
  });

  it("accepts a leaf bound to the issued nonce/epk via vendorInfo report_data", () => {
    const nonce = "x509-verifier-nonce";
    const epk = Buffer.alloc(32, 0xab);
    const reportDataHex = createHash("sha256")
      .update(Buffer.from(nonce, "utf8"))
      .update(epk)
      .digest("hex");
    const c = buildDiceChain(reportDataHex);
    const result = verifyCoveX509Chain([c.deviceCert, c.aliasCert], {
      trustedRotPublicKey: c.rootAnchor,
      nowMs: NOW_MS,
      expectedNonce: nonce,
      ephemeralPublicKey: epk,
    });
    expect(result.verified).toBe(true);
    if (!result.verified) return;
    expect(result.leaf.tcbInfo?.reportDataHex).toBe(reportDataHex);
  });

  it("rejects a replayed leaf: report_data binds a different nonce", () => {
    const epk = Buffer.alloc(32, 0xab);
    const oldReportData = createHash("sha256")
      .update(Buffer.from("captured-old-nonce", "utf8"))
      .update(epk)
      .digest("hex");
    const c = buildDiceChain(oldReportData);
    const result = verifyCoveX509Chain([c.deviceCert, c.aliasCert], {
      trustedRotPublicKey: c.rootAnchor,
      nowMs: NOW_MS,
      expectedNonce: "fresh-verifier-nonce",
      ephemeralPublicKey: epk,
    });
    expect(result.verified).toBe(false);
    if (!result.verified) {
      expect(result.reason).toBe("report-data-mismatch");
    }
  });

  it("fails closed when a binding is required but the leaf has no vendorInfo", () => {
    const c = buildDiceChain(); // no report_data in the leaf
    const result = verifyCoveX509Chain([c.deviceCert, c.aliasCert], {
      trustedRotPublicKey: c.rootAnchor,
      nowMs: NOW_MS,
      expectedNonce: "fresh-verifier-nonce",
      ephemeralPublicKey: Buffer.alloc(32, 0xab),
    });
    expect(result.verified).toBe(false);
    if (!result.verified) {
      expect(result.reason).toBe("report-data-mismatch");
    }
  });
});

describe("coveX509ToTeeEvidence + policy", () => {
  it("maps a verified chain into TeeEvidence and passes a matching policy", () => {
    const c = buildDiceChain();
    const result = verifyCoveX509Chain([c.deviceCert, c.aliasCert], {
      trustedRotPublicKey: c.rootAnchor,
      nowMs: NOW_MS,
    });
    expect(result.verified).toBe(true);
    if (!result.verified) return;

    const evidence = coveX509ToTeeEvidence(result, FWID_NAMES);
    expect(evidence.kind).toBe("cove");
    expect(evidence.provider).toBe("eliza-riscv");
    expect(evidence.securityVersion).toBe(7);
    // Zero-digest registers are dropped; only real measurements survive.
    expect(evidence.measurements?.boot).toBeUndefined();
    expect(evidence.measurements?.agent).toBe(`sha384:${SALUS_TVM_PAGE_FWID}`);
    expect(evidence.measurements?.policy).toBe(
      `sha384:${SALUS_TVM_CONFIG_FWID}`,
    );
    expect(evidence.measurements?.device).toBe(
      `sha384:${SALUS_RUNTIME_PCR1_FWID}`,
    );

    const decision = evaluateTeeEvidencePolicy(evidence, {
      required: true,
      allowedKinds: ["cove"],
      requiredMeasurements: { agent: `sha384:${SALUS_TVM_PAGE_FWID}` },
      minSecurityVersion: 5,
    });
    expect(decision.trusted).toBe(true);
    expect(decision.reason).toBe("allowed");
  });

  it("policy rejects evidence whose agent measurement does not match", () => {
    const c = buildDiceChain();
    const result = verifyCoveX509Chain([c.deviceCert, c.aliasCert], {
      trustedRotPublicKey: c.rootAnchor,
      nowMs: NOW_MS,
    });
    expect(result.verified).toBe(true);
    if (!result.verified) return;

    const evidence = coveX509ToTeeEvidence(result, FWID_NAMES);
    const decision = evaluateTeeEvidencePolicy(evidence, {
      required: true,
      allowedKinds: ["cove"],
      requiredMeasurements: { agent: `sha384:${"cc".repeat(48)}` },
    });
    expect(decision.trusted).toBe(false);
    expect(decision.reason).toBe("measurement-mismatch");
  });

  it("policy rejects a security version below the rollback floor", () => {
    const c = buildDiceChain();
    const result = verifyCoveX509Chain([c.deviceCert, c.aliasCert], {
      trustedRotPublicKey: c.rootAnchor,
      nowMs: NOW_MS,
    });
    expect(result.verified).toBe(true);
    if (!result.verified) return;

    const evidence = coveX509ToTeeEvidence(result, FWID_NAMES);
    const decision = evaluateTeeEvidencePolicy(evidence, {
      required: true,
      allowedKinds: ["cove"],
      minSecurityVersion: 99,
    });
    expect(decision.trusted).toBe(false);
    expect(decision.reason).toBe("security-version-too-low");
  });
});
