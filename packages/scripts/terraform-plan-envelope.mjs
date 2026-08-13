/**
 * Encrypts saved Terraform plans for protected workflow handoff.
 *
 * The authenticated metadata is deliberately kept outside the ciphertext so
 * operators can review its non-sensitive identity fields. AES-GCM binds those
 * exact bytes to the encrypted plan and refuses to write plaintext unless the
 * envelope, metadata, and protected key all authenticate together.
 */
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const MAGIC = Buffer.from("ELIZA-TFPLAN-V2\0", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const DATA_KEY_BYTES = 32;
const WRAPPED_KEY_LENGTH_BYTES = 2;
const PUBLIC_KEY_ENVIRONMENT_NAME = "TERRAFORM_PLAN_ARTIFACT_PUBLIC_KEY";
const PRIVATE_KEY_ENVIRONMENT_NAME = "TERRAFORM_PLAN_ARTIFACT_PRIVATE_KEY";

function readPublicKey() {
  const encoded = process.env[PUBLIC_KEY_ENVIRONMENT_NAME];
  if (!encoded) {
    throw new Error(`${PUBLIC_KEY_ENVIRONMENT_NAME} is required`);
  }
  const normalized = `${encoded.trimEnd()}\n`;
  if (
    !normalized.startsWith("-----BEGIN PUBLIC KEY-----\n") ||
    !normalized.endsWith("-----END PUBLIC KEY-----\n") ||
    normalized.includes("PRIVATE KEY")
  ) {
    throw new Error(
      `${PUBLIC_KEY_ENVIRONMENT_NAME} must contain only an SPKI public key, never private key material`,
    );
  }
  const key = createPublicKey(normalized);
  if (
    key.asymmetricKeyType !== "rsa" ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072
  ) {
    throw new Error(
      `${PUBLIC_KEY_ENVIRONMENT_NAME} must contain an RSA key of at least 3072 bits`,
    );
  }
  const canonical = key.export({ format: "pem", type: "spki" });
  if (canonical !== normalized) {
    throw new Error(
      `${PUBLIC_KEY_ENVIRONMENT_NAME} must contain one canonical SPKI public key`,
    );
  }
  return key;
}

function readPrivateKey() {
  const encoded = process.env[PRIVATE_KEY_ENVIRONMENT_NAME];
  if (!encoded) {
    throw new Error(`${PRIVATE_KEY_ENVIRONMENT_NAME} is required`);
  }
  const key = createPrivateKey(encoded);
  if (
    key.asymmetricKeyType !== "rsa" ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072
  ) {
    throw new Error(
      `${PRIVATE_KEY_ENVIRONMENT_NAME} must contain an RSA key of at least 3072 bits`,
    );
  }
  return key;
}

function writePrivateFileAtomically(path, contents) {
  if (existsSync(path)) {
    throw new Error(`Refusing to overwrite output: ${path}`);
  }
  const temporaryPath = resolve(
    dirname(path),
    `.terraform-plan-envelope-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  try {
    writeFileSync(temporaryPath, contents, { flag: "wx", mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function encrypt(inputPath, outputPath, metadataPath, publicKey) {
  const plaintext = readFileSync(inputPath);
  const metadata = readFileSync(metadataPath);
  const dataKey = randomBytes(DATA_KEY_BYTES);
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", dataKey, iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(metadata);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const wrappedKey = publicEncrypt(
      { key: publicKey, oaepHash: "sha256" },
      dataKey,
    );
    if (wrappedKey.length > 0xffff) {
      throw new Error("Wrapped Terraform plan key exceeds the envelope limit");
    }
    const wrappedKeyLength = Buffer.alloc(WRAPPED_KEY_LENGTH_BYTES);
    wrappedKeyLength.writeUInt16BE(wrappedKey.length);
    writePrivateFileAtomically(
      outputPath,
      Buffer.concat([MAGIC, wrappedKeyLength, iv, tag, wrappedKey, ciphertext]),
    );
  } finally {
    dataKey.fill(0);
  }
}

function decrypt(inputPath, outputPath, metadataPath, privateKey) {
  const envelope = readFileSync(inputPath);
  const minimumBytes =
    MAGIC.length + WRAPPED_KEY_LENGTH_BYTES + IV_BYTES + TAG_BYTES + 1;
  if (envelope.length < minimumBytes) {
    throw new Error("Terraform plan envelope is truncated");
  }
  const magic = envelope.subarray(0, MAGIC.length);
  if (!timingSafeEqual(magic, MAGIC)) {
    throw new Error("Terraform plan envelope has an unsupported format");
  }
  const wrappedKeyLengthOffset = MAGIC.length;
  const ivOffset = wrappedKeyLengthOffset + WRAPPED_KEY_LENGTH_BYTES;
  const tagOffset = ivOffset + IV_BYTES;
  const wrappedKeyOffset = tagOffset + TAG_BYTES;
  const wrappedKeyLength = envelope.readUInt16BE(wrappedKeyLengthOffset);
  const ciphertextOffset = wrappedKeyOffset + wrappedKeyLength;
  if (wrappedKeyLength === 0 || ciphertextOffset > envelope.length) {
    throw new Error("Terraform plan envelope has an invalid wrapped key");
  }
  const iv = envelope.subarray(ivOffset, tagOffset);
  const tag = envelope.subarray(tagOffset, wrappedKeyOffset);
  const wrappedKey = envelope.subarray(wrappedKeyOffset, ciphertextOffset);
  const ciphertext = envelope.subarray(ciphertextOffset);
  const metadata = readFileSync(metadataPath);
  let dataKey;
  try {
    dataKey = privateDecrypt(
      { key: privateKey, oaepHash: "sha256" },
      wrappedKey,
    );
    if (dataKey.length !== DATA_KEY_BYTES) {
      throw new Error("Terraform plan envelope contains an invalid data key");
    }
    const decipher = createDecipheriv("aes-256-gcm", dataKey, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(metadata);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    writePrivateFileAtomically(outputPath, plaintext);
  } finally {
    if (dataKey) dataKey.fill(0);
  }
}

function main() {
  const [operation, inputPath, outputPath, metadataPath, ...extra] =
    process.argv.slice(2);
  if (
    extra.length > 0 ||
    !["encrypt", "decrypt"].includes(operation) ||
    !inputPath ||
    !outputPath ||
    !metadataPath
  ) {
    throw new Error(
      "Usage: terraform-plan-envelope.mjs <encrypt|decrypt> <input> <output> <metadata>",
    );
  }
  if (resolve(inputPath) === resolve(outputPath)) {
    throw new Error("Input and output paths must be different");
  }
  if (operation === "encrypt") {
    encrypt(inputPath, outputPath, metadataPath, readPublicKey());
  } else {
    decrypt(inputPath, outputPath, metadataPath, readPrivateKey());
  }
}

try {
  main();
  // error-policy:J1 The CLI boundary returns validation and authentication failures without exposing plan bytes.
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Terraform plan envelope failed: ${message}\n`);
  process.exitCode = 1;
}
