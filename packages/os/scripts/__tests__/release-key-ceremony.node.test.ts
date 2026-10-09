import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decrypt } from "../android/decrypt-release-keys.ts";
import {
  defaultKeyManifest,
  encodeAvbPublicKey,
  generate,
  loadKeyManifest,
  parseArgs,
} from "../android/generate-release-keys.ts";
import { loadReleaseKeyPolicy } from "../release-key-policy.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const avbFixture = JSON.parse(
  fs.readFileSync(
    path.join(
      packageRoot,
      "scripts/__tests__/fixtures/avb-known-answer-vectors.json",
    ),
    "utf8",
  ),
) as {
  vectors: { bits: number; avbtoolSha256: string; publicKeyPem: string }[];
};
const manifest = loadKeyManifest(defaultKeyManifest);
const sha256 = (data: Buffer) =>
  crypto.createHash("sha256").update(data).digest("hex");

// Expected digests were produced by AOSP avbtool.py (external/avb main)
// `extract_public_key` for the fixture keys and matched byte-for-byte by
// encodeAvbPublicKey on 2026-10-02.
const AVB_VECTORS = {
  2048: "8a1378f7a6ac785140d220a907e2d3549e04b7103f9ca473b267c581d95ea3cb",
  4096: "3672bd6c6d0ae06da40afc5ecf6ed1b834c0b6a6a3080fc03564fed4d819f0de",
};

function tempDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "os-release-keys-"));
  const pass = path.join(tmp, "pass");
  fs.writeFileSync(pass, "correct horse battery staple 2026\n", {
    mode: 0o600,
  });
  return { tmp, pass };
}

test("AVB public key encoding matches avbtool known-answer vectors", () => {
  assert.equal(avbFixture.vectors.length, 2);
  for (const [bits, digest] of Object.entries(AVB_VECTORS)) {
    const vector = avbFixture.vectors.find((v) => String(v.bits) === bits);
    assert.equal(vector?.avbtoolSha256, digest);
    const key = crypto.createPublicKey(vector?.publicKeyPem ?? "");
    const encoded = encodeAvbPublicKey(key);
    assert.equal(encoded.length, 8 + 2 * (Number(bits) / 8));
    assert.equal(sha256(encoded), digest, `${bits}-bit vector`);
  }
});

test("generic key manifest covers the AOSP image and release-trust keys", () => {
  const names = manifest.keys.map((k) => k.name);
  for (const required of [
    "releasekey",
    "platform",
    "shared",
    "media",
    "networkstack",
    "sdk_sandbox",
    "bluetooth",
    "nfc",
    "apex",
    "apex_payload",
    "avb",
    "release_manifest",
    "contract_release",
    "contract_qualification",
  ])
    assert.ok(names.includes(required), required);
  for (const key of manifest.keys)
    if (key.kind !== "ed25519")
      assert.ok((key.bits ?? 0) >= 4096, `${key.name} must be RSA-4096+`);
  assert.doesNotMatch(
    fs.readFileSync(defaultKeyManifest, "utf8"),
    /senior|elizaresearch/i,
  );
});

test("manifest validation rejects path-like names, duplicates and weak keys", () => {
  const { tmp } = tempDir();
  try {
    const write = (keys: unknown[]) => {
      const file = path.join(tmp, `m-${Math.random()}.json`);
      fs.writeFileSync(
        file,
        JSON.stringify({ schemaVersion: 1, reviewedAt: "x", keys }),
      );
      return file;
    };
    const ok = { kind: "ed25519", storage: "hsm", consumer: "", rotatable: 1 };
    assert.throws(
      () => loadKeyManifest(write([{ ...ok, name: "../escape" }])),
      /invalid key name/,
    );
    assert.throws(
      () =>
        loadKeyManifest(
          write([
            { ...ok, name: "a" },
            { ...ok, name: "a" },
          ]),
        ),
      /duplicate/,
    );
    assert.throws(
      () =>
        loadKeyManifest(
          write([{ ...ok, name: "app", kind: "x509-pk8", bits: 2048 }]),
        ),
      /RSA-4096/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("test-key ceremony produces encrypted keys that decrypt to matching public keys", () => {
  const { tmp, pass } = tempDir();
  const out = path.join(tmp, "keys");
  try {
    const { fingerprints } = generate(
      parseArgs(["--output", out, "--passphrase-file", pass, "--test-keys"]),
    );
    assert.equal(fingerprints.testKeys, true);
    assert.ok(fs.existsSync(path.join(out, "TEST-KEYS-DO-NOT-SHIP")));
    assert.equal(fingerprints.keys.length, manifest.keys.length);
    for (const entry of fingerprints.keys as Record<string, string>[]) {
      const base = path.join(out, entry.name);
      if (entry.kind === "x509-pk8") {
        const encrypted = fs.readFileSync(`${base}.pk8.enc`);
        assert.throws(
          () =>
            crypto.createPrivateKey({
              key: encrypted,
              format: "der",
              type: "pkcs8",
            }),
          entry.name,
        );
        const cert = new crypto.X509Certificate(
          fs.readFileSync(`${base}.x509.pem`),
        );
        assert.match(cert.subject, /TEST-ONLY/);
        assert.equal(
          entry.certificateSha256,
          cert.fingerprint256.replaceAll(":", "").toLowerCase(),
        );
      } else {
        const derivedPublic = crypto.createPublicKey(
          fs.readFileSync(`${base}.pub.pem`),
        );
        if (entry.kind === "avb-rsa")
          assert.equal(
            sha256(encodeAvbPublicKey(derivedPublic)),
            entry.avbPublicKeySha256,
            entry.name,
          );
        if (entry.kind === "ed25519") {
          // The fingerprint is exactly what release-key-policy pins.
          const policy = loadReleaseKeyPolicy({
            ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64: entry.spkiBase64,
            ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_SHA256: entry.spkiSha256,
          });
          assert.equal(policy.publicKeyFingerprint, entry.spkiSha256);
          assert.ok(
            crypto.createPublicKey(entry.publicKeyPem).equals(derivedPublic),
          );
        }
      }
      for (const file of fs
        .readdirSync(out)
        .filter((f) => f.startsWith(`${entry.name}.`) && f.endsWith(".enc")))
        assert.equal(
          fs.statSync(path.join(out, file)).mode & 0o077,
          0,
          `${file} permissions`,
        );
    }
    assert.ok(
      fs
        .readFileSync(path.join(out, "avb_pkmd.bin"))
        .equals(fs.readFileSync(path.join(out, "avb.avbpubkey"))),
    );
    const plaintext = fs
      .readdirSync(out)
      .filter(
        (f) =>
          /\.(pk8|pem)$/.test(f) &&
          !f.endsWith(".x509.pem") &&
          !f.endsWith(".pub.pem"),
      );
    assert.deepEqual(plaintext, [], "no unencrypted private keys on disk");

    // Signing environment: decrypt to the AOSP plaintext layout and check it
    // with openssl's unencrypted PKCS#8 reader, the format signapk consumes.
    const plainDir = path.join(tmp, "plain");
    const { written } = decrypt({
      input: out,
      output: plainDir,
      passphraseFile: pass,
    });
    assert.equal(written.length, manifest.keys.length);
    for (const entry of fingerprints.keys as Record<string, string>[]) {
      if (entry.kind === "x509-pk8") {
        const parsed = execFileSync(
          "openssl",
          [
            "pkcs8",
            "-inform",
            "DER",
            "-nocrypt",
            "-in",
            path.join(plainDir, `${entry.name}.pk8`),
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        const cert = new crypto.X509Certificate(
          fs.readFileSync(path.join(plainDir, `${entry.name}.x509.pem`)),
        );
        assert.ok(
          cert.checkPrivateKey(crypto.createPrivateKey(parsed)),
          entry.name,
        );
      } else {
        const key = crypto.createPrivateKey(
          fs.readFileSync(path.join(plainDir, `${entry.name}.pem`)),
        );
        assert.ok(
          crypto
            .createPublicKey(key)
            .equals(
              crypto.createPublicKey(
                fs.readFileSync(path.join(out, `${entry.name}.pub.pem`)),
              ),
            ),
          entry.name,
        );
        if (entry.kind === "avb-rsa")
          assert.equal(
            sha256(encodeAvbPublicKey(crypto.createPublicKey(key))),
            entry.avbPublicKeySha256,
            entry.name,
          );
      }
    }
    assert.throws(
      () => decrypt({ input: out, output: plainDir, passphraseFile: pass }),
      /already exists/,
    );
    // --only selects exact key names; a typo or empty name decrypts nothing
    // and must fail instead of reporting "Decrypted 0 keys".
    for (const only of ["releasekey,platfrom", "", "releasekey,"]) {
      const rejected = path.join(tmp, `plain-only-${only.length}`);
      assert.throws(
        () =>
          decrypt({ input: out, output: rejected, passphraseFile: pass, only }),
        /--only names a key/,
      );
      assert.equal(fs.existsSync(rejected), false, `${only}: nothing written`);
    }
    const subset = decrypt({
      input: out,
      output: path.join(tmp, "plain-subset"),
      passphraseFile: pass,
      only: "releasekey,platform",
    });
    assert.deepEqual([...subset.written].sort(), ["platform", "releasekey"]);
    const wrongPass = path.join(tmp, "wrong");
    fs.writeFileSync(wrongPass, "definitely not the right passphrase", {
      mode: 0o600,
    });
    assert.throws(() =>
      decrypt({
        input: out,
        output: path.join(tmp, "plain2"),
        passphraseFile: wrongPass,
      }),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a product manifest adds its own application key with --manifest", () => {
  const { tmp, pass } = tempDir();
  try {
    const productManifest = path.join(tmp, "product-keys.json");
    fs.writeFileSync(
      productManifest,
      JSON.stringify({
        schemaVersion: 1,
        reviewedAt: "2026-10-02",
        keys: [
          {
            name: "example_app",
            kind: "x509-pk8",
            bits: 4096,
            consumer: "Example launcher APK",
            storage: "hsm",
            rotatable: "apk-signature-scheme-v3-lineage-only",
          },
        ],
      }),
    );
    const { fingerprints } = generate(
      parseArgs([
        "--output",
        path.join(tmp, "keys"),
        "--passphrase-file",
        pass,
        "--manifest",
        productManifest,
        "--test-keys",
      ]),
    );
    assert.deepEqual(
      fingerprints.keys.map((k) => k.name),
      ["example_app"],
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("generator refuses unsafe outputs and weak passphrase files", () => {
  const { tmp, pass } = tempDir();
  try {
    const args = (output: string, passFile = pass) =>
      parseArgs([
        "--output",
        output,
        "--passphrase-file",
        passFile,
        "--test-keys",
      ]);
    assert.throws(
      () => generate(args(path.join(packageRoot, "android/signing/nope"))),
      /inside the eliza repository/,
    );
    const otherRepo = path.join(tmp, "product");
    fs.mkdirSync(path.join(otherRepo, ".git"), { recursive: true });
    assert.throws(
      () => generate(args(path.join(otherRepo, "keys", "new"))),
      /inside the Git working tree/,
    );
    assert.throws(() => generate(args(tmp)), /already exists/);
    fs.chmodSync(pass, 0o644);
    assert.throws(() => generate(args(path.join(tmp, "k"))), /chmod 600/);
    const short = path.join(tmp, "short");
    fs.writeFileSync(short, "short", { mode: 0o600 });
    assert.throws(
      () => generate(args(path.join(tmp, "k2"), short)),
      /at least 20/,
    );
    assert.throws(
      () => parseArgs(["--output", path.join(tmp, "k3")]),
      /passphrase-file/,
    );
    assert.throws(
      () =>
        parseArgs([
          "--output",
          path.join(tmp, "k4"),
          "--passphrase-file",
          pass,
        ]),
      /--organization/,
    );
    assert.deepEqual(
      fs.readdirSync(path.join(packageRoot, "android/signing")).sort(),
      ["README.md", "key-manifest.json"],
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
