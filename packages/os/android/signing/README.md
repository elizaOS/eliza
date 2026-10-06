# Release signing keys

Tooling for an offline key ceremony and a signing environment. No release keys
exist for this repository; [`../release-trust.json`](../release-trust.json) is
deliberately unenrolled.

| Item | Path |
| --- | --- |
| Generic key list | [`key-manifest.json`](key-manifest.json) |
| Generator (offline ceremony) | [`scripts/android/generate-release-keys.ts`](../../scripts/android/generate-release-keys.ts) |
| Signing-environment decryptor | [`scripts/android/decrypt-release-keys.ts`](../../scripts/android/decrypt-release-keys.ts) |
| Tests | `node --test scripts/__tests__/release-key-ceremony.node.test.ts` (from `packages/os`) |

The tests prove that AVB public-key encoding is byte-identical to AOSP
`avbtool extract_public_key` for 2048- and 4096-bit vectors, that every private
key is encrypted at rest (scrypt, AES-256), that decryption yields the
unencrypted PKCS#8 DER `signapk` reads, that each key matches its certificate or
public key, and that Ed25519 fingerprints satisfy
[`release-key-policy.ts`](../../scripts/release-key-policy.ts). They do not prove
signing a real `target_files.zip` (that needs an [AOSP builder](../builder/README.md)),
booting a device with these keys, or HSM operation.

## Keys

- **APK and module keys:** `releasekey`, `platform`, `shared`, `media`,
  `networkstack`, `sdk_sandbox`, `bluetooth`, `nfc`; x509 + pk8, RSA-4096.
- **APEX:** one container pair (`apex`) and one RSA-4096 payload key
  (`apex_payload`) for `sign_target_files_apks`.
- **`avb`:** RSA-4096. The generator also writes `avb_pkmd.bin` for
  `fastboot flash avb_custom_key` or factory fusing. `avbPublicKeySha256` in
  `fingerprints.json` is the SHA-256 of that file.
- **Ed25519:** `release_manifest` signs image release manifests
  (`ELIZAOS_RELEASE_ED25519_*` in `release-key-policy.ts`); `contract_release` and
  `contract_qualification` are the two independent `release-trust.json` roles that
  the Android release contract requires.

Products keep their own manifest (for example with an application signing key)
and pass `--manifest FILE`; names must match `^[a-z][a-z0-9_]*$`, RSA keys must
be 4096 or 8192 bits. The platform, shared, media, APEX and AVB keys can never be
rotated on devices in the field without a data wipe, and an application key only
through an APK v3 rotation lineage. Losing them blocks all future updates, so
backups are part of the deliverable.

## 1. Offline key ceremony

Two people (custodian and witness), an air-gapped laptop booted from a verified
live image with networking disabled, two new encrypted USB drives and
tamper-evident bags.

1. Copy this repository at a reviewed commit with Node 24 and OpenSSL 3, then run
   the ceremony tests to check the toolchain.
2. Each person types half of a passphrase (at least 20 characters in total) into
   a tmpfs file:
   ```sh
   umask 077; mkdir -p /dev/shm/ceremony
   cat > /dev/shm/ceremony/pass   # both halves on one line, then Ctrl-D
   ```
3. Generate. The output must be a new directory outside any Git working tree:
   ```sh
   node packages/os/scripts/android/generate-release-keys.ts \
     --output /media/USB1/release-keys-2026 \
     --passphrase-file /dev/shm/ceremony/pass --organization "<Legal entity>" \
     [--manifest /path/to/product-key-manifest.json]
   ```
4. Check that every private file ends in `.enc` and no plaintext `.pk8`/`.pem`
   private key exists. Print `fingerprints.json`; both people sign the printout.
5. Copy the directory to the second drive. Seal each drive and each passphrase half
   separately and store them in different locations.
6. `shred` `/dev/shm/ceremony` and power off.

## 2. Hardware-backed online keys

AVB, OTA payload, application and Ed25519 keys can be used from an HSM (for
example Cloud KMS/HSM): `avbtool --signing_helper_with_files`,
`ota_from_target_files --payload_signer`, and `apksigner` through a PKCS#11
provider. Import the offline-generated keys (keeping the offline backup
authoritative), allow only a dedicated release-signer identity to use them, and
enable audit logging. Confirm Ed25519 import support for your provider before
relying on it. The remaining x509/pk8 keys stay in the encrypted bundle, because
`signapk` reads key files.

## 3. Signing job

Run on an ephemeral machine with no external IP, gated by required reviewers.

1. Download the unsigned `target_files.zip` and `otatools.zip`; check their
   SHA-256 against the build record.
2. Decrypt into tmpfs (also refused inside any Git working tree):
   ```sh
   node packages/os/scripts/android/decrypt-release-keys.ts --input bundle \
     --output /dev/shm/keys --passphrase-file /dev/shm/pass
   ```
3. Sign and build the OTA:
   ```sh
   sign_target_files_apks -o -d /dev/shm/keys \
     --avb_vbmeta_key /dev/shm/keys/avb.pem --avb_vbmeta_algorithm SHA256_RSA4096 \
     unsigned-target_files.zip signed-target_files.zip
   ota_from_target_files -k /dev/shm/keys/releasekey signed-target_files.zip ota.zip
   ```
   Map APEX keys with `--extra_apex_payload_key` / `--extra_apks` for each APEX
   in the build, or keep AVB in the HSM with
   `--avb_vbmeta_extra_args "--signing_helper_with_files <helper>"`.
4. Sign release metadata. `scripts/android/sign-contract.ts` takes the
   `contract_release.pem` or `contract_qualification.pem` file;
   `sign-image-release.ts` reads `ELIZAOS_RELEASE_ED25519_PRIVATE_KEY_PKCS8_BASE64`,
   the canonical base64 PKCS#8 DER of `release_manifest`
   (`openssl pkey -in release_manifest.pem -outform DER | base64 | tr -d '\n'`).
5. `shred` `/dev/shm/keys` and delete the machine.

## 4. Enrollment (reviewed pull request)

- `release-trust.json`: add `contract_release` and `contract_qualification` as
  separate entries using their `publicKeyPem`, with `id`, `roles`, `channels`,
  `operations` and `expiresAt`.
- Image releases: publish `spkiBase64` and `spkiSha256` of `release_manifest` as
  the independently pinned `ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_*` values.
- Release contracts: set `avb.publicKeySha256` to the `avb` key's
  `avbPublicKeySha256` and `productionKeys: true` only for real release keys.
- Downstream launcher descriptors pin `certificateSha256` from the product's own
  application key.

## 5. Devices

Relockable devices with `avb_custom_key` (Pixel class): `fastboot flash
avb_custom_key avb_pkmd.bin`, then `fastboot flashing lock`. Devices without it
need the ODM to fuse the verified-boot key hash at the factory; otherwise they
stay unlocked (orange state), which release notes must state as a weaker trust
state.
