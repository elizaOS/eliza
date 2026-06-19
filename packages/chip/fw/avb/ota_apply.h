/*
 * E1 OTA payload apply to the inactive A/B slot.
 *
 * Implements the apply half of docs/security/avb-a-b-ota.md §5: an OTA payload
 * (a new slot's vbmeta + boot image) is verified BEFORE any write, then written
 * to the INACTIVE slot, then the slot is marked active-pending with a finite
 * try budget (AB_OTA_TRIES) so a bad OTA auto-rolls-back to the known-good slot
 * via the ab_slot try-exhaustion path. A post-apply re-verify confirms the
 * bytes that landed in the slot still verify.
 *
 * Pre-write verification is the same avb_verify gate the bootloader uses:
 *   - vbmeta authenticity (E1 Ed25519, AVB key A pinned),
 *   - boot partition digest (hash descriptor) against the payload boot image,
 *   - anti-rollback: rollback_index >= the OTP floor for the vbmeta slot.
 * A payload that fails ANY check is rejected and NOTHING is written to the
 * inactive slot (avb-a-b-ota.md §4 TC-OTA-001..004). A rollback-index downgrade
 * is rejected here exactly as the bootloader would reject it, so a downgrade
 * payload can never even be staged into a slot.
 *
 * PARTITION STORE: the inactive slot's partitions are modeled as caller-owned
 * software buffers (struct ota_slot_store). On real hardware the write target
 * is flash/UFS reached through a block driver, and the "bootloader-message
 * updated last, atomically" step (§5) is a driver/fastboot concern. That
 * physical write path is a documented follow-on; this module proves the
 * verify-then-stage-then-arm-with-rollback logic with a software store.
 *
 * Freestanding: no malloc, no libc beyond the shared crypto memcpy/memset.
 */

#ifndef E1_FW_AVB_OTA_APPLY_H
#define E1_FW_AVB_OTA_APPLY_H

#include <stddef.h>
#include <stdint.h>

#include "ab_slot.h"
#include "avb_verify.h"

/*
 * An OTA payload as handed to the apply step after download + staging. vbmeta
 * is the new slot's signed top-level descriptor; boot is the new whole-partition
 * boot image its hash descriptor covers. (The real payload protobuf carries
 * many partitions; the E1 model covers the AVB-gating vbmeta + boot pair, which
 * is what the bootloader verifies pre-kexec.)
 */
struct ota_payload {
    const uint8_t *vbmeta;
    size_t         vbmeta_len;
    const uint8_t *boot;
    size_t         boot_len;
};

/*
 * Caller-owned destination buffers for the inactive slot. apply copies the
 * payload into these (modeling the flash/UFS write) and points the controller's
 * slot image at them. Capacities bound the copy; an oversized payload is
 * rejected with OTA_ERR_NO_SPACE (the §4 TC-OTA-007 "insufficient space" path,
 * modeled as a fixed-capacity store).
 */
struct ota_slot_store {
    uint8_t *vbmeta;
    size_t   vbmeta_cap;
    size_t   vbmeta_len;   /* written by apply */
    uint8_t *boot;
    size_t   boot_cap;
    size_t   boot_len;     /* written by apply */
};

enum ota_result {
    OTA_OK = 0,
    OTA_ERR_INVALID_SLOT = 1,    /* target is not A or B (recovery is not OTA'd) */
    OTA_ERR_EMPTY_PAYLOAD = 2,   /* missing vbmeta or boot bytes */
    OTA_ERR_NO_SPACE = 3,        /* payload exceeds the slot store capacity */
    OTA_ERR_VERIFY_PRE = 4,      /* pre-write avb_verify rejected the payload */
    OTA_ERR_VERIFY_POST = 5      /* post-write re-verify failed (write corruption) */
};

/*
 * Apply an OTA payload to the INACTIVE slot.
 *
 *   1. target must be AB_SLOT_A or AB_SLOT_B and must NOT be the currently
 *      active slot (the caller passes active so apply refuses to overwrite the
 *      running slot). Recovery is never an OTA target.
 *   2. PRE-WRITE verify: avb_verify the payload vbmeta with the boot image as a
 *      hash target, against the live OTP rollback floor. Reject (no write) on
 *      any failure. *pre_avb_rc (if non-NULL) receives the avb_result so the
 *      caller can log the precise reason (downgrade, tamper, wrong key, ...).
 *   3. Stage: copy vbmeta + boot into the caller's slot store (capacity-checked),
 *      and point ctl->image[target] at the store.
 *   4. Arm: priority = AB_PRIORITY_MAX, tries_remaining = AB_OTA_TRIES,
 *      successful_boot = 0, unbootable = 0, rollback_index cached from the
 *      verified header. A bad new image now auto-rolls-back after the tries are
 *      spent without an ab_mark_successful().
 *   5. POST-WRITE verify: re-run avb_verify on the bytes now in the store; a
 *      mismatch (a corrupted write) leaves the slot unbootable and returns
 *      OTA_ERR_VERIFY_POST.
 *
 * Returns OTA_OK only when the slot is staged and armed and re-verifies.
 */
enum ota_result ota_apply(struct ab_controller *ctl,
                          enum ab_slot_id active,
                          enum ab_slot_id target,
                          const struct ota_payload *payload,
                          struct ota_slot_store *store,
                          enum avb_result *pre_avb_rc);

#endif /* E1_FW_AVB_OTA_APPLY_H */
