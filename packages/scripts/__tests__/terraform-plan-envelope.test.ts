/**
 * Exercises the real Terraform plan envelope CLI with temporary files and
 * verifies authenticated round trips, tamper rejection, and key separation.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = new URL("../terraform-plan-envelope.mjs", import.meta.url)
  .pathname;

function generateRsaKeys() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
  return {
    privateKey: pair.privateKey.export({ format: "pem", type: "pkcs8" }),
    publicKey: pair.publicKey.export({ format: "pem", type: "spki" }),
  };
}

const RSA_KEYS = generateRsaKeys();
const OTHER_RSA_KEYS = generateRsaKeys();

function run(
  operation: "encrypt" | "decrypt",
  inputPath: string,
  outputPath: string,
  metadataPath: string,
  keys: { privateKey?: string; publicKey?: string },
) {
  return spawnSync(
    "node",
    [scriptPath, operation, inputPath, outputPath, metadataPath],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TERRAFORM_PLAN_ARTIFACT_PRIVATE_KEY: keys.privateKey,
        TERRAFORM_PLAN_ARTIFACT_PUBLIC_KEY: keys.publicKey,
      },
    },
  );
}

function withFixture(
  callback: (fixture: {
    directory: string;
    encryptedPath: string;
    metadataPath: string;
    planPath: string;
    privateKey: string;
    publicKey: string;
  }) => void,
) {
  const directory = mkdtempSync(join(tmpdir(), "terraform-plan-envelope-"));
  const planPath = join(directory, "selected.tfplan");
  const metadataPath = join(directory, "plan-metadata.json");
  const encryptedPath = join(directory, "selected.tfplan.enc");
  const { privateKey, publicKey } = RSA_KEYS;
  writeFileSync(planPath, randomBytes(4096));
  writeFileSync(
    metadataPath,
    JSON.stringify({
      component: "pages-domains",
      environment: "staging",
      planSha256: "a".repeat(64),
      runAttempt: "1",
      runId: "123",
    }),
  );
  try {
    callback({
      directory,
      encryptedPath,
      metadataPath,
      planPath,
      privateKey,
      publicKey,
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

describe("Terraform plan envelope", () => {
  test("round trips without giving the plan lane the private key", () => {
    withFixture(
      ({
        directory,
        encryptedPath,
        metadataPath,
        planPath,
        privateKey,
        publicKey,
      }) => {
        const original = readFileSync(planPath);
        const encrypted = run(
          "encrypt",
          planPath,
          encryptedPath,
          metadataPath,
          { publicKey },
        );
        expect(encrypted.status).toBe(0);
        expect(readFileSync(encryptedPath).includes(original)).toBe(false);

        const decryptedPath = join(directory, "decrypted.tfplan");
        const decrypted = run(
          "decrypt",
          encryptedPath,
          decryptedPath,
          metadataPath,
          { privateKey },
        );
        expect(decrypted.status).toBe(0);
        expect(readFileSync(decryptedPath)).toEqual(original);
      },
    );
  });

  test("rejects ciphertext tampering without writing plaintext", () => {
    withFixture(
      ({
        directory,
        encryptedPath,
        metadataPath,
        planPath,
        privateKey,
        publicKey,
      }) => {
        expect(
          run("encrypt", planPath, encryptedPath, metadataPath, { publicKey })
            .status,
        ).toBe(0);
        const contents = readFileSync(encryptedPath);
        contents[contents.length - 1] ^= 1;
        writeFileSync(encryptedPath, contents);

        const decryptedPath = join(directory, "decrypted.tfplan");
        const decrypted = run(
          "decrypt",
          encryptedPath,
          decryptedPath,
          metadataPath,
          { privateKey },
        );
        expect(decrypted.status).not.toBe(0);
        expect(existsSync(decryptedPath)).toBe(false);
      },
    );
  });

  test("rejects metadata substitution and the wrong private key", () => {
    withFixture(
      ({
        directory,
        encryptedPath,
        metadataPath,
        planPath,
        privateKey,
        publicKey,
      }) => {
        expect(
          run("encrypt", planPath, encryptedPath, metadataPath, { publicKey })
            .status,
        ).toBe(0);
        const originalMetadata = readFileSync(metadataPath);
        writeFileSync(metadataPath, '{"environment":"production"}');
        const metadataOutput = join(directory, "metadata-substitution.tfplan");
        expect(
          run("decrypt", encryptedPath, metadataOutput, metadataPath, {
            privateKey,
          }).status,
        ).not.toBe(0);
        expect(existsSync(metadataOutput)).toBe(false);

        writeFileSync(metadataPath, originalMetadata);
        const wrongKeyOutput = join(directory, "wrong-key.tfplan");
        const wrongPrivateKey = OTHER_RSA_KEYS.privateKey;
        expect(
          run("decrypt", encryptedPath, wrongKeyOutput, metadataPath, {
            privateKey: wrongPrivateKey,
          }).status,
        ).not.toBe(0);
        expect(existsSync(wrongKeyOutput)).toBe(false);
      },
    );
  });

  test("requires an RSA public key for encryption", () => {
    withFixture(({ encryptedPath, metadataPath, planPath }) => {
      const nonRsaPublicKey = generateKeyPairSync("ed25519").publicKey.export({
        format: "pem",
        type: "spki",
      });
      const result = run("encrypt", planPath, encryptedPath, metadataPath, {
        publicKey: nonRsaPublicKey,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "must contain an RSA key of at least 3072 bits",
      );
      expect(existsSync(encryptedPath)).toBe(false);
    });
  });

  test("rejects private key material in the public-key lane", () => {
    withFixture(({ encryptedPath, metadataPath, planPath, privateKey }) => {
      const result = run("encrypt", planPath, encryptedPath, metadataPath, {
        publicKey: privateKey,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("never private key material");
      expect(existsSync(encryptedPath)).toBe(false);
    });
  });
});
