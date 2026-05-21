import {
  AuditDispatcher,
  InMemorySink,
  MemoryKmsAdapter,
} from "@elizaos/security";
import type { Check, CheckResult } from "../types.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

export const kmsRoundtrip: Check = {
  id: "C1.1-kms-roundtrip",
  title: "Memory KMS adapter AEAD round-trips plaintext with AAD",
  tsc: ["C1.1"],
  severity: "critical",
  async run(): Promise<CheckResult> {
    const kms = new MemoryKmsAdapter();
    const keyId = "verify.kms.roundtrip";
    await kms.getOrCreateKey(keyId);
    const plaintext = enc.encode("soc2-verify-plaintext");
    const aad = enc.encode("verify-aad");
    const encResult = await kms.encrypt(keyId, plaintext, aad);
    const decResult = await kms.decrypt(
      keyId,
      encResult.ciphertext,
      encResult.nonce,
      encResult.authTag,
      aad,
      encResult.keyVersion,
    );
    if (dec.decode(decResult) !== "soc2-verify-plaintext") {
      return {
        status: "fail",
        evidence: `Round-trip decryption produced unexpected plaintext.`,
      };
    }
    // AAD mismatch must fail.
    let aadMismatchRejected = false;
    try {
      await kms.decrypt(
        keyId,
        encResult.ciphertext,
        encResult.nonce,
        encResult.authTag,
        enc.encode("wrong-aad"),
        encResult.keyVersion,
      );
    } catch {
      aadMismatchRejected = true;
    }
    if (!aadMismatchRejected) {
      return {
        status: "fail",
        evidence: `AAD mismatch was not rejected — AEAD integrity broken.`,
      };
    }
    return {
      status: "pass",
      evidence: `KMS AEAD round-trip succeeded; AAD mismatch rejected.`,
    };
  },
};

export const kmsHmacRoundtrip: Check = {
  id: "C1.1-kms-hmac-roundtrip",
  title: "Memory KMS adapter HMAC verifies and detects tampering",
  tsc: ["C1.1", "CC6.7"],
  severity: "high",
  async run(): Promise<CheckResult> {
    const kms = new MemoryKmsAdapter();
    const keyId = "verify.kms.hmac";
    await kms.getOrCreateKey(keyId);
    const data = enc.encode("hmac-payload");
    const tag = await kms.hmac(keyId, data);
    const ok = await kms.hmacVerify(keyId, data, tag);
    if (!ok) {
      return { status: "fail", evidence: `HMAC verify returned false for valid tag.` };
    }
    const tampered = new Uint8Array(tag);
    if (tampered.length === 0) {
      return { status: "fail", evidence: `HMAC tag empty.` };
    }
    tampered[0] = (tampered[0]! ^ 0xff) & 0xff;
    const ok2 = await kms.hmacVerify(keyId, data, tampered);
    return ok2
      ? {
          status: "fail",
          evidence: `Tampered HMAC tag was accepted.`,
        }
      : {
          status: "pass",
          evidence: `HMAC verify accepts valid + rejects tampered tag.`,
        };
  },
};

export const kmsSignatureRoundtrip: Check = {
  id: "C1.1-kms-signature-roundtrip",
  title: "Memory KMS adapter Ed25519 sign+verify works; bad sig rejected",
  tsc: ["C1.1", "PI1.5"],
  severity: "high",
  async run(): Promise<CheckResult> {
    const kms = new MemoryKmsAdapter();
    const keyId = "verify.kms.signing";
    await kms.getOrCreateKey(keyId);
    const data = enc.encode("artifact-bytes");
    const sig = await kms.sign(keyId, data, "ed25519");
    const ok = await kms.verify(keyId, data, sig.signature, "ed25519");
    if (!ok) {
      return { status: "fail", evidence: `Valid Ed25519 signature rejected.` };
    }
    const bad = new Uint8Array(sig.signature);
    bad[0] = (bad[0]! ^ 0x01) & 0xff;
    const ok2 = await kms.verify(keyId, data, bad, "ed25519");
    return ok2
      ? {
          status: "fail",
          evidence: `Tampered signature was accepted.`,
        }
      : {
          status: "pass",
          evidence: `Sign+verify works; tampered signature rejected.`,
        };
  },
};

export const auditDispatcherEmits: Check = {
  id: "CC4.1-audit-dispatcher-emits",
  title: "Audit dispatcher fans events out to registered sinks",
  tsc: ["CC4.1"],
  severity: "critical",
  async run(): Promise<CheckResult> {
    const sink = new InMemorySink();
    const dispatcher = new AuditDispatcher({ sinks: [sink] });
    const event = await dispatcher.emit({
      actor: { type: "user", id: "soc2-verify" },
      action: "auth.login",
      result: "success",
    });
    const snap = sink.snapshot();
    if (snap.length !== 1) {
      return {
        status: "fail",
        evidence: `Expected 1 event in sink, found ${snap.length}.`,
      };
    }
    const got = snap[0]!;
    if (got.event_id !== event.event_id) {
      return {
        status: "fail",
        evidence: `Sink received different event_id than dispatcher returned.`,
      };
    }
    return {
      status: "pass",
      evidence: `Dispatcher emitted event ${event.event_id} into in-memory sink.`,
    };
  },
};

export const auditRedaction: Check = {
  id: "CC4.1-audit-redaction",
  title: "Audit dispatcher drops disallowed metadata fields (PII redaction)",
  tsc: ["CC4.1", "C1.1", "P4.1"],
  severity: "critical",
  async run(): Promise<CheckResult> {
    const sink = new InMemorySink();
    const dispatcher = new AuditDispatcher({ sinks: [sink] });
    await dispatcher.emit({
      actor: { type: "user", id: "soc2-verify" },
      action: "auth.login",
      result: "success",
      metadata: {
        email: "user@example.com", // disallowed
        email_hash: "abcd1234", // allowed
        ip: "203.0.113.1", // allowed
      },
    });
    const got = sink.snapshot()[0]!;
    const md = got.metadata ?? {};
    if ("email" in md) {
      return {
        status: "fail",
        evidence: `Email leaked into audit event metadata: ${JSON.stringify(md)}`,
      };
    }
    if (!("email_hash" in md) || !("ip" in md)) {
      return {
        status: "fail",
        evidence: `Allowed fields were unexpectedly stripped: ${JSON.stringify(md)}`,
      };
    }
    return {
      status: "pass",
      evidence: `Redaction kept email_hash + ip; dropped raw email.`,
    };
  },
};
