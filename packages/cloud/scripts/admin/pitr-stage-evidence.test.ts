import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareStageEvidence } from "./pitr-stage-evidence";
import { generateRecipientKeyPair, openEnvelope } from "./recipient-envelope";

const recipient = generateRecipientKeyPair();
test("private intent survives only as recipient ciphertext with operation binding", () => {
  const directory = mkdtempSync(join(tmpdir(), "pitr-seal-test-"));
  try {
    const store = prepareStageEvidence({
      directory,
      recipientPublicKey: recipient.publicKeyBase64,
      operationReceipt: "a".repeat(64),
    });
    const receipt = store("stage-intent.json", {
      baseline: { credential: "private-sentinel" },
    });
    const file = join(directory, "stage-intent.sealed.json"),
      raw = readFileSync(file, "utf8");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(raw).not.toContain("private-sentinel");
    expect(JSON.stringify(receipt)).not.toContain("private-sentinel");
    const plaintext = openEnvelope(JSON.parse(raw), recipient.privateKeyPem);
    try {
      expect(JSON.parse(plaintext.toString())).toMatchObject({
        operationReceipt: "a".repeat(64),
        evidence: { baseline: { credential: "private-sentinel" } },
      });
    } finally {
      plaintext.fill(0);
    }
    expect(() => store("stage-intent.json", {})).toThrow(
      "stage_evidence_unavailable",
    );
    expect(() => store("../escape.json", {})).toThrow(
      "stage_evidence_unavailable",
    );
    expect(() =>
      store("stage-observation.json", { data: "x".repeat(4 * 1024 * 1024) }),
    ).toThrow("stage_evidence_unavailable");
    expect(readdirSync(directory)).toEqual(["stage-intent.sealed.json"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("invalid recipient and nonprivate directory refuse before evidence persistence", () => {
  const directory = mkdtempSync(join(tmpdir(), "pitr-seal-test-"));
  try {
    expect(() =>
      prepareStageEvidence({
        directory,
        recipientPublicKey: "bad",
        operationReceipt: "a".repeat(64),
      }),
    ).toThrow("stage_evidence_recipient_refused");
    chmodSync(directory, 0o755);
    expect(() =>
      prepareStageEvidence({
        directory,
        recipientPublicKey: recipient.publicKeyBase64,
        operationReceipt: "a".repeat(64),
      }),
    ).toThrow("stage_evidence_recipient_refused");
    expect(readdirSync(directory)).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
