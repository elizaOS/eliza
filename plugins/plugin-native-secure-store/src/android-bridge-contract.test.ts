/** Verifies the static security contract of the Android Keystore bridge. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(
    new URL(".", import.meta.url).pathname,
    "../android/src/main/java/ai/eliza/plugins/securestore/SecureStorePlugin.kt",
  ),
  "utf8",
).replace(/\s+/g, " ");

describe("Android secure-store bridge contract", () => {
  it("uses a non-exportable randomized AES-GCM Android Keystore key", () => {
    expect(source).toContain('KeyStore.getInstance("AndroidKeyStore")');
    expect(source).toContain(
      'KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore"',
    );
    expect(source).toContain('Cipher.getInstance("AES/GCM/NoPadding")');
    expect(source).toContain("setRandomizedEncryptionRequired(true)");
    expect(source).toContain("GCMParameterSpec(128, iv)");
  });

  it("binds every ciphertext to its fixed logical key", () => {
    expect(source.match(/cipher\.updateAAD\(key\.toByteArray/g)).toHaveLength(
      2,
    );
    expect(source).toContain("allowedKeys.contains(key)");
    expect(source).not.toContain('call.getString("service")');
  });

  it("uses atomic device-only, no-backup ciphertext files", () => {
    expect(source).toContain(
      'File(context.noBackupFilesDir, "eliza-secure-store")',
    );
    expect(source).toContain("AtomicFile(valueFile(key))");
    expect(source).toContain("atomicFile.finishWrite(stream)");
    expect(source).toContain("atomicFile.failWrite(stream)");
    expect(source).not.toContain("SharedPreferences");
  });

  it("does not include secret values in errors or filenames", () => {
    expect(source).not.toContain("error.message");
    expect(source).not.toContain("plaintext.toString");
    expect(source).not.toContain("value.hashCode");
    expect(source).toContain("value.isNullOrEmpty()");
  });

  it("verifies deletion and reports whether ciphertext existed", () => {
    expect(source).toContain("AtomicFile(file).delete()");
    expect(source).toContain("if (file.exists())");
    expect(source).toContain('put("deleted", deleted)');
  });
});
