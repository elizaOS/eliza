import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareProviderErrorEnvelope } from "./pitr-provider-error-envelope";
import { generateRecipientKeyPair, openEnvelope } from "./recipient-envelope";

const keys = generateRecipientKeyPair();
function fixture(
  work: (
    input: Parameters<typeof prepareProviderErrorEnvelope>[0],
    dir: string,
  ) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), "sealed-provider-test-"));
  try {
    work(
      {
        recipientPublicKey: keys.publicKeyBase64,
        file: join(dir, "error.json"),
        operationReceipt: "a".repeat(64),
        knownPrivateValues: [
          "private-token-sentinel",
          "private-name-sentinel",
          "00112233-4455-6677-8899-aabbccddeeff",
        ],
      },
      dir,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test("only scrubbed messages and finite codes reach authenticated ciphertext, never public receipt", () => {
  fixture((input, dir) => {
    const sink = prepareProviderErrorEnvelope(input);
    sink.capture([
      {
        message:
          "Name private-name-sentinel is invalid; private-token-sentinel 00112233-4455-6677-8899-aabbccddeeff",
        extensions: { code: "BAD_USER_INPUT", private: "ignored-secret" },
        data: { private: "ignored-data" },
      },
      {
        message: "public constraint",
        extensions: { code: "private-unknown-code" },
      },
    ]);
    const encrypted = readFileSync(input.file, "utf8");
    const plain = openEnvelope(
      JSON.parse(encrypted),
      keys.privateKeyPem,
    ).toString();
    const publicReceipt = JSON.stringify(sink.receipt());
    expect(sink.receipt().state).toBe("sealed");
    expect(statSync(input.file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["error.json"]);
    expect(plain).toContain("public constraint");
    expect(plain).toContain("BAD_USER_INPUT");
    expect(plain).toContain('"code":"UNKNOWN"');
    for (const secret of [
      ...input.knownPrivateValues,
      "ignored-secret",
      "ignored-data",
      "private-unknown-code",
    ]) {
      expect(plain).not.toContain(secret);
      expect(encrypted).not.toContain(secret);
      expect(publicReceipt).not.toContain(secret);
    }
    expect(publicReceipt).not.toContain("public constraint");
    sink.capture([{ message: "second", extensions: { code: "FORBIDDEN" } }]);
    expect(readFileSync(input.file, "utf8")).toBe(encrypted);
  });
});
test("invalid recipient fails before capture and malformed or oversized detail never leaves plaintext", () => {
  fixture((input, dir) => {
    expect(() =>
      prepareProviderErrorEnvelope({
        ...input,
        recipientPublicKey: "private-invalid-key",
      }),
    ).toThrow("provider_evidence_recipient_invalid");
    for (const errors of [
      null,
      [],
      Array.from({ length: 17 }, () => ({ message: "x" })),
      [{ message: "private-token-sentinel".repeat(1000) }],
      [{ message: 42 }],
    ]) {
      const sink = prepareProviderErrorEnvelope(input);
      sink.capture(errors);
      expect(sink.receipt()).toEqual({
        state: "unavailable",
        ciphertextSha256: null,
      });
      expect(readdirSync(dir)).toEqual([]);
    }
  });
});
test("exclusive-write failure never overwrites evidence or exposes fallback plaintext", () => {
  fixture((input) => {
    writeFileSync(input.file, "existing");
    const sink = prepareProviderErrorEnvelope(input);
    sink.capture([{ message: "private-token-sentinel" }]);
    expect(sink.receipt()).toEqual({
      state: "unavailable",
      ciphertextSha256: null,
    });
    expect(readFileSync(input.file, "utf8")).toBe("existing");
  });
});
