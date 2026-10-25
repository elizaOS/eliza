import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  generateRecipientKeyPair,
  openEnvelope,
  sealToRecipient,
} from "./recipient-envelope";

const pair = generateRecipientKeyPair();

test("seals to the recipient and opens only with its private key", () => {
  const plaintext = Buffer.from("ABCD-EFGH-JKMN-PQRS\n");
  const envelope = sealToRecipient(plaintext, pair.publicKeyBase64);
  expect(JSON.stringify(envelope)).not.toContain("ABCD-EFGH");
  expect(openEnvelope(envelope, pair.privateKeyPem).toString()).toBe(
    plaintext.toString(),
  );
  const other = generateRecipientKeyPair();
  expect(() => openEnvelope(envelope, other.privateKeyPem)).toThrow();
});

test("rejects tampered ciphertext and weak or non-RSA recipients", () => {
  const envelope = sealToRecipient(Buffer.from("x"), pair.publicKeyBase64);
  const tampered = {
    ...envelope,
    ciphertext: Buffer.from("y").toString("base64"),
  };
  expect(() => openEnvelope(tampered, pair.privateKeyPem)).toThrow();
  const weak = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .publicKey.export({ format: "der", type: "spki" })
    .toString("base64");
  expect(() => sealToRecipient(Buffer.from("x"), weak)).toThrow();
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" })
    .publicKey.export({ format: "der", type: "spki" })
    .toString("base64");
  expect(() => sealToRecipient(Buffer.from("x"), ec)).toThrow();
});
