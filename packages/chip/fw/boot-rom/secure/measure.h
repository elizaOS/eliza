/*
 * Boot measurement register + keymgr-advance software contract (W3).
 *
 * The measurement register is a 32-byte SHA-256 chain extended once per stage:
 *
 *     reg <- SHA256(reg || stage_hash)
 *
 * starting from an all-zero register, matching the TPM/DICE PCR-extend shape
 * and the boot chain in docs/security/tee-plan/02-root-of-trust.md §3. The
 * accumulated value is exported to populate TeeEvidence.measurements.boot (§6).
 *
 * keymgr_advance() is the software side of the key-ladder advance. The keymgr
 * hardware lives in the RoT RTL (W1); this defines the SW contract the ROM
 * uses to bind each verified stage measurement into the ladder. The hardware
 * binding itself is performed by the RTL when the contract fields are written;
 * the stub here records the requested advance and updates the measurement.
 */

#ifndef E1_BOOTROM_SECURE_MEASURE_H
#define E1_BOOTROM_SECURE_MEASURE_H

#include <stddef.h>
#include <stdint.h>

#include "sha256.h"

/* keymgr stages along the boot chain (02-root-of-trust.md §3, §5). */
enum keymgr_stage {
    KEYMGR_STAGE_RESET = 0,
    KEYMGR_STAGE_CREATOR = 1,        /* bound to H(BL1) */
    KEYMGR_STAGE_OWNER_INTERMEDIATE = 2, /* bound to H(BL2) */
    KEYMGR_STAGE_OWNER = 3           /* bound to H(monitor) */
};

struct boot_measure {
    uint8_t reg[SHA256_DIGEST_LEN]; /* accumulated chain, starts zero */
    enum keymgr_stage stage;        /* last stage advanced into */
    uint32_t extend_count;          /* number of extends applied */
};

/* Initialize an all-zero measurement chain at the reset stage. */
void boot_measure_init(struct boot_measure *m);

/* Extend the chain with one stage hash: reg <- SHA256(reg || stage_hash). */
void boot_measure_extend(struct boot_measure *m,
                         const uint8_t stage_hash[SHA256_DIGEST_LEN]);

/*
 * Advance the keymgr ladder for a verified stage and extend the boot
 * measurement with that stage's hash in one step. Returns the new stage.
 * The next_stage must be exactly one beyond the current stage; an out-of-order
 * advance is rejected (returns the unchanged current stage) so the ladder
 * cannot be skipped.
 */
enum keymgr_stage keymgr_advance(struct boot_measure *m,
                                 enum keymgr_stage next_stage,
                                 const uint8_t stage_hash[SHA256_DIGEST_LEN]);

/* Copy the accumulated measurement out for export over the mailbox. */
void boot_measure_export(const struct boot_measure *m,
                         uint8_t out[SHA256_DIGEST_LEN]);

#endif /* E1_BOOTROM_SECURE_MEASURE_H */
