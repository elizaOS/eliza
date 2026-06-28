/*
 * E1 DICE measurement chain — Compound Device Identifier (CDI) ladder.
 *
 * Implements the TCG DICE / Open DICE key-derivation ladder for the Eliza E1
 * Root of Trust, per docs/security/tee-plan/02-root-of-trust.md §3 and §5:
 *
 *     UDS ----HKDF(UDS, H(BL1))----> CDI_layer0 (== CDI_BL1)
 *     CDI_BL1 --HKDF(CDI_BL1, H(BL2))--> CDI_BL2
 *     CDI_BL2 --HKDF(CDI_BL2, H(monitor))--> CDI_monitor
 *
 * Each transition is HKDF-SHA256 (RFC 5869): the previous CDI is the input
 * keying material (IKM), the stage measurement is the salt, and a fixed,
 * stage-specific info string domain-separates the layers. A tampered or
 * downgraded image changes its measurement, which forks the entire downstream
 * ladder — the cryptographic binding the static-key placeholder cannot give.
 *
 * From CDI_monitor two Ed25519 keypairs are derived deterministically:
 *   - DeviceID: stable per device (creator-signed cert, key-ceremony.md §5).
 *   - Alias:    per-boot identity (Alias cert, signed by DeviceID each boot).
 *
 * UDS provenance is the RoT itself: the SRAM-PUF / OTP device secret fed
 * through the OpenTitan-class key manager, never software-visible (see
 * docs/sw/security/dice-rot-binding.md). This module is the math; the silicon
 * entropy is a physical dependency.
 *
 * Freestanding: no malloc, no libc beyond the local memcpy/memset. Builds for
 * the riscv64-unknown-elf RoT target and for host KAT.
 */

#ifndef E1_DICE_CDI_H
#define E1_DICE_CDI_H

#include <stddef.h>
#include <stdint.h>

#include "ed25519_sign.h"

#define DICE_CDI_LEN          32u /* CDI width = SHA-256 output */
#define DICE_MEASUREMENT_LEN  32u /* stage measurement = SHA-256 digest */
#define DICE_UDS_LEN          32u /* UDS as presented by the key manager */
#define HMAC_SHA256_LEN       32u

/* ---- HMAC-SHA256 (FIPS 198-1) and HKDF-SHA256 (RFC 5869) ---- */

void hmac_sha256(const uint8_t *key, size_t key_len,
                 const uint8_t *msg, size_t msg_len,
                 uint8_t out[HMAC_SHA256_LEN]);

/* HKDF-Extract: PRK = HMAC(salt, IKM). */
void hkdf_sha256_extract(const uint8_t *salt, size_t salt_len,
                         const uint8_t *ikm, size_t ikm_len,
                         uint8_t prk[HMAC_SHA256_LEN]);

/*
 * HKDF-Expand: OKM = T(1) || T(2) || ...  truncated to okm_len bytes.
 * okm_len must be <= 255*32. Returns 0 on success, -1 on invalid length.
 */
int hkdf_sha256_expand(const uint8_t prk[HMAC_SHA256_LEN],
                       const uint8_t *info, size_t info_len,
                       uint8_t *okm, size_t okm_len);

/* One-shot HKDF (Extract then Expand). Returns 0 on success, -1 on bad length. */
int hkdf_sha256(const uint8_t *salt, size_t salt_len,
                const uint8_t *ikm, size_t ikm_len,
                const uint8_t *info, size_t info_len,
                uint8_t *okm, size_t okm_len);

/* ---- CDI ladder ---- */

/* DICE layer identifiers; select the HKDF info domain-separation string. */
enum dice_layer {
    DICE_LAYER0 = 0, /* UDS    -> CDI_BL1     (info "E1-DICE-CDI-L0/BL1") */
    DICE_LAYER_BL2,  /* CDI_BL1 -> CDI_BL2    (info "E1-DICE-CDI-BL2")    */
    DICE_LAYER_MONITOR /* CDI_BL2 -> CDI_monitor (info "E1-DICE-CDI-MONITOR") */
};

/*
 * Derive the next CDI: CDI_next = HKDF-SHA256(ikm=prev, salt=measurement,
 * info=layer-domain-string). `prev` is the UDS for DICE_LAYER0, otherwise the
 * upstream CDI. Returns 0 on success; -1 on NULL argument. On failure `next`
 * is zeroed (fail-closed: never emit an undefined CDI).
 */
int dice_derive_cdi(const uint8_t prev[DICE_CDI_LEN],
                    const uint8_t measurement[DICE_MEASUREMENT_LEN],
                    enum dice_layer layer,
                    uint8_t next[DICE_CDI_LEN]);

/* Holds the full chain produced by dice_walk_boot_chain. */
struct dice_chain {
    uint8_t cdi_bl1[DICE_CDI_LEN];
    uint8_t cdi_bl2[DICE_CDI_LEN];
    uint8_t cdi_monitor[DICE_CDI_LEN];
};

/*
 * Walk UDS -> CDI_BL1 -> CDI_BL2 -> CDI_monitor using the three stage
 * measurements. Returns 0 on success; -1 on NULL argument (chain zeroed).
 */
int dice_walk_boot_chain(const uint8_t uds[DICE_UDS_LEN],
                         const uint8_t h_bl1[DICE_MEASUREMENT_LEN],
                         const uint8_t h_bl2[DICE_MEASUREMENT_LEN],
                         const uint8_t h_monitor[DICE_MEASUREMENT_LEN],
                         struct dice_chain *out);

/* ---- Identity keys derived from CDI_monitor ---- */

/*
 * Derive a deterministic Ed25519 seed from a CDI for a labelled identity.
 * seed = HKDF-Expand(PRK=HKDF-Extract(salt="", IKM=cdi), info=label).
 */
int dice_derive_key_seed(const uint8_t cdi[DICE_CDI_LEN],
                         const char *label,
                         uint8_t seed[ED25519_SEED_LEN]);

/*
 * Derive the DeviceID keypair (stable device identity) from CDI_monitor.
 * Returns 0 on success, -1 on NULL argument.
 */
int dice_derive_device_id(const uint8_t cdi_monitor[DICE_CDI_LEN],
                          uint8_t pubkey[ED25519_PUBKEY_LEN],
                          uint8_t privkey[ED25519_PRIVKEY_LEN]);

/*
 * Derive the per-boot Alias keypair from CDI_monitor. The Alias is bound to the
 * monitor measurement (already folded into CDI_monitor) so a different monitor
 * yields a different Alias key, which is what makes the per-boot Alias cert
 * attest the running monitor.
 */
int dice_derive_alias(const uint8_t cdi_monitor[DICE_CDI_LEN],
                      uint8_t pubkey[ED25519_PUBKEY_LEN],
                      uint8_t privkey[ED25519_PRIVKEY_LEN]);

#endif /* E1_DICE_CDI_H */
