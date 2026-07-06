/**
 * Key-handling tests with real node:crypto Ed25519 keys — no mocked crypto.
 * Locks the fingerprint algorithm against a fixed public-key fixture, and
 * exercises every signing-key ingress path (env PEM, env base64-wrapped PEM,
 * key file) plus the refusal paths (missing, garbage, non-ed25519).
 */

import { createPublicKey, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceError } from "../errors.ts";
import {
  fingerprintPublicKey,
  generateCertificationKeypair,
  resolveSigningKey,
  SIGNING_KEY_ENV_VAR,
} from "./keys.ts";

// Fixed fixture: if the fingerprint algorithm (sha256 over SPKI DER, first 16
// hex) ever drifts, this constant breaks loudly instead of silently rotating
// every recorded fingerprint.
const FIXTURE_PUBLIC_KEY_PEM =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEANxSK67WrvbmHSvBpokWawHcL+44bljRzTp/6UrtmneE=\n-----END PUBLIC KEY-----\n";
const FIXTURE_FINGERPRINT = "3a05ace11bfcf7fa";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-keys-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("generateCertificationKeypair", () => {
  it("produces PEM halves and a 16-hex fingerprint", () => {
    const keypair = generateCertificationKeypair();
    expect(keypair.publicKeyPem).toContain("-----BEGIN PUBLIC KEY-----");
    expect(keypair.privateKeyPem).toContain("-----BEGIN PRIVATE KEY-----");
    expect(keypair.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintPublicKey(keypair.publicKeyPem)).toBe(
      keypair.fingerprint,
    );
  });

  it("produces distinct keypairs per call", () => {
    const a = generateCertificationKeypair();
    const b = generateCertificationKeypair();
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});

describe("fingerprintPublicKey", () => {
  it("is stable for a fixed key (locks the algorithm)", () => {
    expect(fingerprintPublicKey(FIXTURE_PUBLIC_KEY_PEM)).toBe(
      FIXTURE_FINGERPRINT,
    );
  });

  it("rejects non-ed25519 keys", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => fingerprintPublicKey(rsaPem)).toThrow(EvidenceError);
  });

  it("rejects garbage PEM", () => {
    expect(() => fingerprintPublicKey("not a pem")).toThrow(EvidenceError);
  });
});

describe("resolveSigningKey", () => {
  it("reads a raw PEM from the environment variable", () => {
    const keypair = generateCertificationKeypair();
    const key = resolveSigningKey({
      env: { [SIGNING_KEY_ENV_VAR]: keypair.privateKeyPem },
    });
    expect(key.asymmetricKeyType).toBe("ed25519");
  });

  it("detects and unwraps a base64-wrapped PEM from the environment", () => {
    const keypair = generateCertificationKeypair();
    const wrapped = Buffer.from(keypair.privateKeyPem, "utf8").toString(
      "base64",
    );
    const key = resolveSigningKey({ env: { [SIGNING_KEY_ENV_VAR]: wrapped } });
    expect(key.asymmetricKeyType).toBe("ed25519");
  });

  it("reads a key file, taking precedence over the environment", () => {
    const fileKeypair = generateCertificationKeypair();
    const envKeypair = generateCertificationKeypair();
    const keyFile = path.join(tmpDir(), "signing.pem");
    fs.writeFileSync(keyFile, fileKeypair.privateKeyPem);
    const key = resolveSigningKey({
      env: { [SIGNING_KEY_ENV_VAR]: envKeypair.privateKeyPem },
      keyFile,
    });
    // The derived public fingerprint identifies which key was loaded.
    const fingerprint = fingerprintPublicKey(
      createPublicKey(key).export({ type: "spki", format: "pem" }).toString(),
    );
    expect(fingerprint).toBe(fileKeypair.fingerprint);
  });

  it("fails hard when neither source is present", () => {
    expect(() => resolveSigningKey({ env: {} })).toThrow(EvidenceError);
    try {
      resolveSigningKey({ env: {} });
    } catch (error) {
      expect((error as EvidenceError).code).toBe("CERT_KEY_MISSING");
    }
  });

  it("rejects non-PEM, non-base64-PEM material without echoing it", () => {
    try {
      resolveSigningKey({ env: { [SIGNING_KEY_ENV_VAR]: "hunter2-secret" } });
      throw new Error("expected EvidenceError");
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceError);
      expect((error as EvidenceError).message).not.toContain("hunter2");
    }
  });

  it("rejects an unreadable key file instead of falling back to the env", () => {
    const keypair = generateCertificationKeypair();
    try {
      resolveSigningKey({
        env: { [SIGNING_KEY_ENV_VAR]: keypair.privateKeyPem },
        keyFile: path.join(tmpDir(), "missing.pem"),
      });
      throw new Error("expected EvidenceError");
    } catch (error) {
      expect((error as EvidenceError).code).toBe("CERT_KEY_UNREADABLE");
    }
  });
});
