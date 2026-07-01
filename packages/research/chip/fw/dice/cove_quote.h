/*
 * E1 M-mode TSM CoVE attestation-quote producer.
 *
 * Builds a real, RoT-rooted, Ed25519-signed CoVE quote whose canonical-JSON
 * serialization byte-matches the agent verifier
 * (packages/agent/src/services/cove-quote.ts, `verifyCoveQuote`). This is the
 * signing firmware the silicon TSM runs; the pure measurement/claim model lives
 * in scripts/tee/teeevidence_quote.py.
 *
 * Trust structure (matches the verifier's self-rooted DICE chain):
 *   chain[0] = DeviceID cert  (subject == issuer == "E1-DICE-DeviceID";
 *              self-signed by the DeviceID private key; the verifier anchors
 *              this against trustedRotPublicKey == DeviceID public key)
 *   chain[1] = Alias cert     (subject "E1-DICE-Alias", issuer "E1-DICE-DeviceID";
 *              signed by the DeviceID private key over the Alias TBS)
 *   quote.signature           = Ed25519 by the Alias private key over the
 *                               canonical CoveQuoteBody bytes.
 *
 * The DeviceID and Alias keypairs are derived from CDI_monitor via cdi.c
 * (dice_walk_boot_chain -> dice_derive_device_id / dice_derive_alias). The
 * provisioning-time creator/HSM layer above DeviceID is physically BLOCKED and
 * out of scope; DeviceID-as-anchor is the correct on-device runtime structure.
 *
 * Freestanding: no malloc, no libc beyond memcpy/memset and the existing crypto
 * (sha256.c, ed25519_sign.c, cdi.c). Fail-closed: any NULL/length error zeroes
 * the output buffer and returns -1.
 */

#ifndef E1_DICE_COVE_QUOTE_H
#define E1_DICE_COVE_QUOTE_H

#include <stddef.h>
#include <stdint.h>

#include "cdi.h"

/* A measured-launch image segment fed into a measurement register. */
struct cove_blob {
    const uint8_t *data;
    size_t len;
};

/*
 * The measured-launch inputs the TSM folds into the quote. Mirrors
 * teeevidence_quote.py LaunchChain. The npu_firmware/npu_queue_policy and
 * model_weights blobs are optional (set .data = NULL, .len = 0 to omit).
 *
 *   boot   = extend over rom, lifecycle, bl1, bl2
 *   monitor= H(tsm)
 *   os     = extend over kernel, initramfs, dtb
 *   policy = H(policy)
 *   device = H(device_policy)
 *   agent  = H(agent)
 *   npuFirmware = H(npu_firmware || npu_queue_policy)  (only if npu_protected)
 *   modelWeights= H(model_weights)                     (only if present)
 */
struct cove_launch_chain {
    struct cove_blob rom;
    struct cove_blob lifecycle;
    struct cove_blob bl1;
    struct cove_blob bl2;
    struct cove_blob tsm;
    struct cove_blob kernel;
    struct cove_blob initramfs;
    struct cove_blob dtb;
    struct cove_blob policy;
    struct cove_blob device_policy;
    struct cove_blob agent;
    struct cove_blob npu_firmware;     /* optional */
    struct cove_blob npu_queue_policy; /* optional */
    struct cove_blob model_weights;    /* optional */
};

/*
 * Silicon conditions that gate the quote claims (teeevidence_quote.py
 * LaunchConditions). A claim is set true only when its owning condition holds.
 */
struct cove_launch_conditions {
    int secure_boot_verified;
    int lifecycle_locked;
    int memory_encryption_active;
    int iopmp_programmed;
    int npu_private_queue_owned;
    int monitor_measured; /* the TSM was measured + folded into the DICE chain */
};

/*
 * The freshness + identity inputs to a single quote.
 *
 *   nonce            : verifier-issued challenge (UTF-8, NUL-terminated)
 *   ephemeral_pubkey : raw bytes of the live-channel ephemeral public key
 *   timestamp        : RFC3339 instant (UTF-8, NUL-terminated)
 *   hardware_vendor  : e.g. "eliza"
 *   platform_version : e.g. "e1-model-v0"
 *   not_before/after : RFC3339 cert validity window (applied to both certs)
 *   security_version : monotonic anti-rollback version
 */
struct cove_quote_request {
    const char *nonce;
    const uint8_t *ephemeral_pubkey;
    size_t ephemeral_pubkey_len;
    const char *timestamp;
    const char *hardware_vendor;
    const char *platform_version;
    const char *not_before;
    const char *not_after;
    uint32_t security_version;
};

/*
 * Build the full CoVE quote and emit its canonical JSON into `out`.
 *
 * The UDS and the three boot-chain stage measurements (h_bl1, h_bl2, h_monitor)
 * drive the DICE ladder; h_monitor must equal SHA-256(tsm) so the Alias key is
 * bound to the measured monitor. On success `out` holds a NUL-terminated UTF-8
 * JSON string and *out_len is its length (excluding the NUL); the JSON parses
 * and verifies under verifyCoveQuote with trustedRotPublicKey set to the
 * DeviceID public key written to `device_id_pubkey`.
 *
 * Returns 0 on success. On any NULL argument, length error, or buffer overflow
 * returns -1 and zeroes `out` (out[0]='\0' if cap>0), *out_len, and
 * device_id_pubkey.
 */
int cove_quote_build(const uint8_t uds[DICE_UDS_LEN],
                     const uint8_t h_bl1[DICE_MEASUREMENT_LEN],
                     const uint8_t h_bl2[DICE_MEASUREMENT_LEN],
                     const uint8_t h_monitor[DICE_MEASUREMENT_LEN],
                     const struct cove_launch_chain *chain,
                     const struct cove_launch_conditions *conditions,
                     const struct cove_quote_request *request,
                     uint8_t device_id_pubkey[ED25519_PUBKEY_LEN],
                     char *out, size_t out_cap, size_t *out_len);

#endif /* E1_DICE_COVE_QUOTE_H */
