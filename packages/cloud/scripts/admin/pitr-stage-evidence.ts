/** Recipient-only preservation of private stage evidence; never writes plaintext. */
import { createHash } from "node:crypto";
import { lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sealToRecipient } from "./recipient-envelope";

const NAMES = [
  "stage-intent.json",
  "stage-workflow.json",
  "stage-observation.json",
  "stage-reconciliation.json",
  "stage-raw-observation.json",
  "stage-raw-reconciliation.json",
] as const;
export function prepareStageEvidence(input: {
  directory: string;
  recipientPublicKey: string;
  operationReceipt: string;
}) {
  try {
    const directory = lstatSync(input.directory);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (directory.mode & 0o077) !== 0 ||
      directory.uid !== process.getuid?.() ||
      !/^[a-f0-9]{64}$/.test(input.operationReceipt) ||
      input.recipientPublicKey.length > 16384
    )
      throw Error();
    sealToRecipient(Buffer.alloc(0), input.recipientPublicKey);
  } catch {
    throw Error("stage_evidence_recipient_refused");
  }
  return (name: string, value: unknown) => {
    let plaintext: Buffer | undefined;
    try {
      if (!(NAMES as readonly string[]).includes(name)) throw Error();
      const serialized = JSON.stringify({
        purpose: "private_pitr_stage_evidence",
        operationReceipt: input.operationReceipt,
        kind: name,
        evidence: value,
      });
      if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw Error();
      plaintext = Buffer.from(serialized);
      const ciphertext = Buffer.from(
        JSON.stringify(sealToRecipient(plaintext, input.recipientPublicKey)),
      );
      const filename = name.replace(/\.json$/, ".sealed.json");
      writeFileSync(join(input.directory, filename), ciphertext, {
        flag: "wx",
        mode: 0o600,
      });
      return {
        kind: name,
        ciphertextSha256: createHash("sha256").update(ciphertext).digest("hex"),
      };
    } catch {
      throw Error("stage_evidence_unavailable");
    } finally {
      plaintext?.fill(0);
    }
  };
}
