/**
 * Seals operator output (for example freshly minted grant codes) to a local
 * operator's RSA public key so the plaintext never reaches CI logs or
 * artifacts. AES-256-GCM encrypts the payload; RSA-OAEP (SHA-256) wraps the
 * one-time AES key.
 *
 *   keygen --private-out key.pem --public-out key.pub.b64   (local; key mode 600)
 *   seal   < plaintext > envelope.json   (CI; ELIZA_ENVELOPE_RECIPIENT_PUBLIC_KEY = base64 SPKI DER)
 *   open   --private-key key.pem < envelope.json > plaintext   (local)
 */
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

export interface RecipientEnvelope {
  version: 1;
  algorithm: "RSA-OAEP-256+A256GCM";
  wrappedKey: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

function recipientKey(publicKeyBase64: string) {
  const key = createPublicKey({
    key: Buffer.from(publicKeyBase64.trim(), "base64"),
    format: "der",
    type: "spki",
  });
  if (
    key.asymmetricKeyType !== "rsa" ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072
  ) {
    throw new Error("recipient key must be RSA with at least 3072 bits");
  }
  return key;
}

export function sealToRecipient(
  plaintext: Buffer,
  publicKeyBase64: string,
): RecipientEnvelope {
  const contentKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", contentKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const wrappedKey = publicEncrypt(
    {
      key: recipientKey(publicKeyBase64),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    contentKey,
  );
  return {
    version: 1,
    algorithm: "RSA-OAEP-256+A256GCM",
    wrappedKey: wrappedKey.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function openEnvelope(
  envelope: RecipientEnvelope,
  privateKeyPem: string,
): Buffer {
  if (envelope.version !== 1 || envelope.algorithm !== "RSA-OAEP-256+A256GCM") {
    throw new Error("unsupported envelope");
  }
  const contentKey = privateDecrypt(
    {
      key: createPrivateKey(privateKeyPem),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(envelope.wrappedKey, "base64"),
  );
  const decipher = createDecipheriv(
    "aes-256-gcm",
    contentKey,
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
}

export function generateRecipientKeyPair(): {
  privateKeyPem: string;
  publicKeyBase64: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 4096,
  });
  return {
    privateKeyPem: privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
    publicKeyBase64: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
  };
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      "private-out": { type: "string" },
      "public-out": { type: "string" },
      "private-key": { type: "string" },
    },
    strict: true,
  });
  if (command === "keygen") {
    if (!values["private-out"] || !values["public-out"]) {
      throw new Error("keygen needs --private-out and --public-out");
    }
    const pair = generateRecipientKeyPair();
    writeFileSync(values["private-out"], pair.privateKeyPem, { mode: 0o600 });
    writeFileSync(values["public-out"], `${pair.publicKeyBase64}\n`);
  } else if (command === "seal") {
    const publicKey = process.env.ELIZA_ENVELOPE_RECIPIENT_PUBLIC_KEY;
    if (!publicKey) {
      throw new Error("ELIZA_ENVELOPE_RECIPIENT_PUBLIC_KEY is required");
    }
    const plaintext = readFileSync(0);
    process.stdout.write(
      `${JSON.stringify(sealToRecipient(plaintext, publicKey))}\n`,
    );
  } else if (command === "open") {
    if (!values["private-key"]) throw new Error("open needs --private-key");
    const envelope = JSON.parse(readFileSync(0, "utf8")) as RecipientEnvelope;
    process.stdout.write(
      openEnvelope(envelope, readFileSync(values["private-key"], "utf8")),
    );
  } else {
    throw new Error("usage: recipient-envelope.ts keygen|seal|open");
  }
}
