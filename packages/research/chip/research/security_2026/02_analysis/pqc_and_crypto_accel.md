# Post-Quantum and Classical Crypto Accelerators, TRNG, PUF

Date: 2026-05-19

This note covers the cryptographic primitives required by the E1
boot, OTA, KeyMint, and attestation paths: classical hashes,
symmetric AEAD, asymmetric signing and KEM, post-quantum candidates,
hardware RNG, and PUFs. The reference contracts are
`docs/security/boot-image-format.md` §1 (algorithm choices),
`docs/security/key-ceremony.md` (key custody), and
`docs/security/threat-model.md` (assets A1-A13 and mitigation M14).

## 1. Required primitives, by surface

| Surface | Primitive | Spec doc anchor |
|---|---|---|
| Image hash (BL1, BL2, recovery, vbmeta) | SHA-256 | boot-image-format.md §1 |
| Image signature | Ed25519 (RFC 8032) | boot-image-format.md §1 |
| Optional intermediate KDF | HKDF-SHA-256 | boot-image-format.md §1 |
| dm-verity Merkle hash | SHA-256 | avb-a-b-ota.md §1 (implicit via AVB defaults) |
| fs-verity per-file Merkle | SHA-256 | source.android.com fsverity |
| Disk encryption (userdata FBE) | AES-256-XTS or AES-256-HCTR2 | AOSP FBE defaults |
| Keystore-bound AEAD | AES-256-GCM | KeyMint default |
| TLS for OTA fetch + attestation | AES-128-GCM, ChaCha20-Poly1305, ECDHE-X25519 | TLS 1.3 |
| KeyMint key wrapping | AES-256-GCM | KeyMint |
| Device identity (per-device) | Ed25519 attestation key | key-ceremony.md §5 |
| Random for nonces (debug-auth, RMA challenge) | NIST SP 800-90A CTR_DRBG seeded by SP 800-90B source | debug-policy.md §4, key-ceremony.md §5 |
| Future migration: PQC firmware sign | ML-DSA-65 (Dilithium-3) | FIPS 204 |
| Future migration: PQC key wrap | ML-KEM-768 (Kyber-768) | FIPS 203 |
| Hash-based root option | SLH-DSA-128s (SPHINCS+ small) | FIPS 205 |

## 2. Classical accelerators

### 2.1 SHA-256

Three implementation options, in order of complexity:

- **Software on a small RV hart with Zknh** (RISC-V Scalar Crypto Zk
  hash extension). Zknh adds `sha256sig0/sig1/sum0/sum1` instructions.
  Single-thread throughput on an Ibex-class core jumps from ~30 cycles/
  byte (pure C) to ~10 cycles/byte. Adequate for boot-time image
  hashing where the budget is one-shot per partition; not adequate for
  bulk dm-verity (block-level) under load.
- **Vector software with Zvknh** (Vector Crypto). If RVV is in the
  main AP cluster (per `research/cpu_subsystem_2026/02_analysis/vector_extension_landscape.md`),
  Zvknh accelerates SHA-256 within the vector pipeline. Useful for
  dm-verity and bulk hashing.
- **Dedicated SHA-256/SHA-3 block.** OpenTitan `hmac` (SHA-2-256/384/512)
  and `kmac` (SHA-3 family). Best throughput; needed if the security
  core does both AVB verification and continuous SPDM measurement.

Recommendation: hardware `hmac` block on the security core (OpenTitan
import). RVV-Zvknh on the AP cluster for runtime dm-verity. No
software-only path in production.

### 2.2 AES-256

Three options:

- **RV scalar Zkne/Zknd** (encrypt/decrypt round instructions). Single-
  hart software AES-256 reaches ~5 cycles/byte. OK for control-plane
  AEAD, not for FBE.
- **RVV vector AES** (Zvkns/Zvkne). Bulk AES at memory-bandwidth-limited
  rate. Strong for FBE on the AP cluster.
- **Dedicated AES core** with first-order masking (OpenTitan `aes`).
  Needed for any side-channel-protected use, which includes KeyMint
  AEAD on the secure core (`docs/security/threat-model.md` §5 notes
  that DPA/EM SCA is an explicit non-goal in v0, but moving it from
  non-goal to in-scope in v1 requires the masked block now, since
  retrofitting masking later is impractical).

Recommendation: OpenTitan `aes` masked core on the security core; RVV
Zvkns/Zvkne in the AP cluster. The AES IP cost is ~10 kGE for the
core + ~5 kGE for mask refresh from CSRNG.

### 2.3 ChaCha20-Poly1305

No hardware needed. With Zbkb/Zbkc/Zbkx bit-manipulation and Zbb base,
ChaCha20-Poly1305 reaches ~3-4 cycles/byte on a small in-order RV hart.
Useful for TLS where the peer chooses ChaCha20 (typically mobile
clients where AES-NI is absent).

### 2.4 Ed25519 (signature verify) and X25519 (key agreement)

Three options:

- **OTBN program.** OpenTitan's OTBN is a wide-register big-number
  coprocessor designed exactly for this. Verified reference programs
  exist for Ed25519, X25519, ECDSA P-256, RSA-3072.
- **RVV Zvk + bignum library.** Slower but no extra IP.
- **Dedicated EdDSA core.** Multiple open and commercial designs;
  fastest but added area.

Recommendation: OTBN-based Ed25519 verify in the ROM and BL1 path
(SCA-protected via OTBN's masked execution mode). This is the
canonical OpenTitan boot-verify path.

### 2.5 ECDSA P-256 / P-384

Required for KeyMint key attestation chains (Android keystore
attestation root is ECDSA P-256 today; some manufacturers use P-384).
OTBN handles both. SCA notes per `02_analysis/side_channel_and_tamper.md`
§3.3.

## 3. Post-quantum cryptography on chip

NIST has finalized three PQC standards as of 2024-08:

- **FIPS 203 ML-KEM** (Module-Lattice-Based KEM, Kyber-derived).
  Parameter sets ML-KEM-512, -768, -1024. Public key 800-1568 bytes;
  ciphertext 768-1568 bytes; small fast operation.
- **FIPS 204 ML-DSA** (Module-Lattice-Based DSA, Dilithium-derived).
  Parameter sets ML-DSA-44, -65, -87. Public key 1312-2592 bytes;
  signature 2420-4595 bytes; fast verify, moderately slow sign.
- **FIPS 205 SLH-DSA** (Stateless Hash-Based DSA, SPHINCS+-derived).
  Parameter sets SLH-DSA-128s/f, -192s/f, -256s/f. Public key 32-64
  bytes; signature 7-49 kB; very slow but hash-only foundation.

### 3.1 Where PQC fits in the E1 chain

| Surface | Current (v0) | Future (v1, PQ-ready) |
|---|---|---|
| Image signature (BL1, BL2, vbmeta) | Ed25519 | Hybrid Ed25519 + ML-DSA-65 |
| OTA payload signature | Ed25519 | Hybrid Ed25519 + ML-DSA-65 |
| Debug-auth challenge | Ed25519 | Ed25519 (low-volume; can stay) |
| RMA unlock | Ed25519 | Ed25519 |
| Attestation root | ECDSA P-256 / Ed25519 | Hybrid with ML-DSA-65 |
| KeyMint attestation chain | ECDSA P-256 (Android-managed) | Pending AOSP support |
| TLS for OTA fetch | X25519 + Ed25519 | X25519 hybrid with ML-KEM-768 |

The migration strategy is hybrid (classical + PQ side-by-side) until
PQ is mature and AOSP has caught up.

### 3.2 PQC hardware footprint

Open hardware reference points (from `01_sources/source_inventory.yaml`):

- Kyber accelerator (Banerjee et al., ASAP 2022): ~30 kGE for a
  compact NTT-based design with sampler. Constant-time NTT, CBD.
- Dilithium signer/verifier (Beckwith et al., HOST 2021): ~80 kGE
  including rejection sampler.
- OTBN-based PQ: slower (~10x vs. dedicated HW) but reuses OTBN gates.
  Caliptra 2.x runs ML-DSA-87 sign on Veer-EL2 firmware + Caliptra's
  bigint accelerator at workable cost.

For E1 v0: no PQC hardware. v0 cryptography is Ed25519 + SHA-2 + AES.
For v1, the simplest path is **OTBN firmware** for ML-DSA verify (sign
is done offline at the signer HSM, not on chip), reusing the OTBN we
already need for Ed25519 verify. This buys PQ-ready firmware sign
verification at ~zero added area.

For v2: dedicated NTT/sampler accelerator for ML-KEM if KeyMint or TLS
demand the throughput.

### 3.3 SLH-DSA for long-life root keys

SLH-DSA has a single security assumption (hash function preimage
resistance) and no parameter-set arithmetic concerns. Signatures are
large (7-50 kB) which would inflate OTP and SPI overhead, so it is
unsuitable for runtime image signing. But for the *root* key (signed
once per ceremony, verified only at root rotation), SLH-DSA is the
best long-life option. The signature only appears in the root-rotation
OTA payload, which already amortizes the size cost.

Recommendation (v2): root key hybrid Ed25519 + SLH-DSA-128s. Online
keys stay ML-DSA-65 + Ed25519 hybrid.

## 4. TRNG and SP 800-90 stack

`docs/security/debug-policy.md` §4 specifies "ROM-generated 128-bit
nonce" for the debug-auth challenge. That nonce must come from a real
TRNG, not from a PRNG seeded only by boot_counter.

**OpenTitan `entropy_src` + `csrng`:**

- `entropy_src` is the physical noise source with SP 800-90B health
  tests (Repetition Count, Adaptive Proportion). It emits 384-bit
  entropy chunks.
- `csrng` is a NIST SP 800-90A CTR_DRBG built on AES-256. It serves
  as the OS-facing RNG.
- `edn` (Entropy Distribution Network) fans the entropy out to other
  blocks (AES masking refresh, OTBN, KMAC).

This stack maps directly onto what we need. Adopting it pulls in the
SP 800-90B health-test logic, which is non-trivial to write correctly
from scratch.

**Threshold for RNG health:** any TRNG failure (continuous health
test fail, startup test fail) must halt boot. ROM should refuse to
release control to BL1 if the TRNG cannot return entropy. This is
implicit in OpenTitan's design; it should be explicit in
`docs/security/boot-image-format.md` §6 (ROM halt behavior) as a new
halt code `TRNG_FAILED`.

## 5. PUF for device UID

`docs/security/otp-fuse-map.md` §1 reserves 96 bits for
`device_uid_parity`, with the comment that "UID itself derived from
SRAM PUF." This is the right call: a die-unique UID without consuming
OTP for the UID bits themselves.

**SRAM PUF essentials:**

- Power-up state of a dedicated SRAM region is deterministic per die
  but random across dies (process-variation-driven).
- A *helper-data* algorithm (Bose-Chaudhuri-Hocquenghem code, or a
  fuzzy extractor) corrects the ~5-10% bit errors that creep in
  across temperature and aging.
- Parity bits go in OTP (`device_uid_parity`); SRAM provides the
  base PUF response on each reset.

**Stability requirement:** the PUF must hit >99.99% extraction success
across -40 C to +85 C over the device lifetime. This is a vendor IP
question; multiple commercial PUF IPs meet this, and OpenTitan
demonstrates an SRAM PUF reference. For a Sky130 prototype, the PUF
will be unstable in simulation; an opaque "synthetic UID" model is
acceptable for sim, with a clear note that production needs a
characterized PUF.

## 6. Key manager / HBK derivations

OpenTitan `keymgr` provides versioned key derivations rooted in a
hardware boot key (HBK) derived from a UDS (Unique Device Secret)
extracted from OTP, mixed with software-supplied salts.

For E1, this gives us:

- Per-app KeyMint encryption keys derived deterministically from HBK
  + app identity.
- Per-device attestation key derived from HBK + key-purpose tag.
- Lifecycle binding: keymgr enters distinct internal states for each
  lifecycle, so a key derived in DEV cannot be reproduced in LOCKED.

This realizes the "device identity / KeyMint key blob" surface (A11
in `docs/security/threat-model.md`) without storing the key directly
in OTP.

## 7. Open implementation recommendations (consolidated)

- **Hash:** OpenTitan `hmac` (SHA-2) + `kmac` (SHA-3) on security
  core; RVV Zvknh on AP cluster.
- **AES:** OpenTitan `aes` (masked) on security core; RVV Zvkne on AP
  cluster.
- **Curve:** OTBN with Ed25519 and X25519 reference programs.
- **RNG:** OpenTitan `entropy_src` + `csrng` + `edn`.
- **PUF:** Vendor SRAM PUF (commercial IP); OpenTitan-style helper-
  data extraction.
- **Key manager:** OpenTitan `keymgr` rooted in PUF-derived UDS.
- **PQC v1:** OTBN firmware for ML-DSA-65 verify (image signing).
- **PQC v2:** Dedicated Kyber NTT accelerator if KeyMint TLS demands.
- **Long-life root v2:** Hybrid Ed25519 + SLH-DSA-128s.

All of these are Apache-2 IP except the PUF (vendor IP) and the dedicated
PQC accelerator (open academic designs require integration work).

## 8. SCA / fault notes (forward reference)

See `02_analysis/side_channel_and_tamper.md` §3 for:

- AES masking against DPA.
- Ed25519 deterministic-vs-randomized signature trade-off vs fault attacks.
- OTBN constant-time discipline.
- Glitch detection on the security core voltage rail.

## 9. Cross-references

- `docs/security/boot-image-format.md` §1 algorithms.
- `docs/security/key-ceremony.md` §3 root key generation, §5 board
  identity provisioning.
- `docs/security/threat-model.md` assets A1-A4, A11, A13; mitigation M14.
- `docs/security/debug-policy.md` §4 challenge construction (RNG dep.).
- `docs/security/otp-fuse-map.md` §1 device_uid_parity field.
- `02_analysis/root_of_trust_landscape.md` for the RoT IP that hosts
  these blocks.
- `02_analysis/side_channel_and_tamper.md` for the SCA/fault story.
- `03_implementation/security_path_for_e1.md` for the ranked path.
