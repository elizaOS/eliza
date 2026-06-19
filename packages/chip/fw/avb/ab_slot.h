/*
 * E1 A/B slot bootloader state machine.
 *
 * Implements the Android boot_control HAL slot model on top of the E1 AVB
 * vbmeta verifier (avb_verify.{c,h}). Two complete slots (A, B) and one shared
 * recovery slot, per docs/security/avb-a-b-ota.md §1. The bootloader picks the
 * highest-priority slot that (a) is bootable (tries_remaining > 0 or already
 * marked successful) and (b) whose vbmeta verifies AND whose rollback_index is
 * at or above the stored OTP floor for the vbmeta rollback slot
 * (boot-image-format.md §4 slot 2). When neither A nor B is bootable, recovery
 * is selected (verified the same way). If recovery also fails, selection
 * fails closed — there is no unverified boot path.
 *
 * Anti-rollback is real: slot acceptance gates on avb_verify's rollback check,
 * and ab_mark_successful() advances the OTP rollback floor monotonically to the
 * booted image's rollback_index (the firmware model of programming OTP fuses;
 * the physical fuse program is e1_provision.py / the OTP driver).
 *
 * Automatic rollback: ab_mark_boot_attempt() decrements tries_remaining for the
 * slot the bootloader is about to launch. A slot that reaches zero tries
 * without ab_mark_successful() is marked unbootable; the next ab_select_slot()
 * then returns the other slot, or recovery, fail-closed. This is the
 * power-loss / bad-OTA auto-revert path (avb-a-b-ota.md §4 TC-OTA-009).
 *
 * Freestanding: no malloc, no libc beyond the shared crypto memcpy/memset. The
 * partition store (the vbmeta + boot bytes per slot) is a software model passed
 * in by the caller; the real flash/UFS read is a driver dependency, documented
 * in ota_apply.h and the spec.
 */

#ifndef E1_FW_AVB_AB_SLOT_H
#define E1_FW_AVB_AB_SLOT_H

#include <stddef.h>
#include <stdint.h>

#include "avb_verify.h"

/* Slot identifiers. RECOVERY is the shared fallback, not part of A/B ping-pong. */
enum ab_slot_id {
    AB_SLOT_A = 0,
    AB_SLOT_B = 1,
    AB_SLOT_RECOVERY = 2,
    AB_SLOT_COUNT = 3,
    AB_SLOT_NONE = 0xFF  /* selection failed: no bootable slot */
};

/* AOSP bootloader-message bounds (avb-a-b-ota.md §1). */
#define AB_PRIORITY_MAX     15u
#define AB_TRIES_MAX        7u
/* Tries granted to a freshly-applied OTA slot (avb-a-b-ota.md §5). */
#define AB_OTA_TRIES        2u

/*
 * Per-slot metadata, the firmware model of the AOSP bootloader_control slot
 * record in `misc`. priority/tries_remaining/successful_boot mirror the HAL;
 * rollback_index is the vbmeta rollback_index of the image currently in the
 * slot (cached so selection and the post-boot OTP advance do not re-parse).
 * unbootable is set when a slot is permanently rejected (verity corrupt, tries
 * exhausted, or a failed apply); it is sticky until the slot is re-provisioned.
 */
struct ab_slot_meta {
    uint8_t  priority;          /* 0..AB_PRIORITY_MAX; 0 == never selected */
    uint8_t  tries_remaining;   /* 0..AB_TRIES_MAX */
    uint8_t  successful_boot;   /* 0/1 */
    uint8_t  unbootable;        /* 0/1 sticky reject */
    uint64_t rollback_index;    /* vbmeta rollback_index of the resident image */
};

/*
 * The image bytes resident in a slot's partitions, as the bootloader would read
 * them from flash/UFS. vbmeta is the signed top-level descriptor; boot is the
 * whole-partition image the vbmeta's boot hash descriptor covers. NULL/0 means
 * the slot is empty (treated as unbootable). Pointers alias caller storage.
 */
struct ab_slot_image {
    const uint8_t *vbmeta;
    size_t         vbmeta_len;
    const uint8_t *boot;       /* whole-partition image for the boot hash desc */
    size_t         boot_len;
};

/*
 * Full A/B controller state. The caller owns the image store; the controller
 * owns the metadata and the OTP rollback floor model. rollback_floor is the
 * stored OTP minimum for the vbmeta rollback slot (boot-image-format §4 slot 2)
 * and only ever increases. recovery_rollback_floor is the floor for the
 * recovery rollback slot (slot 3). expected_pubkey_hash / parity_ok are the AVB
 * trust inputs (the pinned AVB key A hash and the OTP parity gate).
 */
struct ab_controller {
    struct ab_slot_meta  meta[AB_SLOT_COUNT];
    struct ab_slot_image image[AB_SLOT_COUNT];
    uint8_t  expected_pubkey_hash[SHA256_DIGEST_LEN];
    uint64_t rollback_floor;            /* OTP floor, vbmeta slot (slot 2) */
    uint64_t recovery_rollback_floor;   /* OTP floor, recovery slot (slot 3) */
    uint8_t  parity_ok;                 /* OTP parity gate */
};

/* Result of a slot selection: the chosen slot plus the verifier outcome. */
enum ab_result {
    AB_OK = 0,
    AB_ERR_NO_BOOTABLE_SLOT = 1,  /* A, B, and recovery all failed: halt */
    AB_ERR_INVALID_SLOT = 2,      /* slot id out of range */
    AB_ERR_NOT_VERIFIED = 3       /* a slot was named but its vbmeta did not verify */
};

/*
 * Pick the active slot, fail-closed.
 *
 *   1. Among AB_SLOT_A and AB_SLOT_B, consider only slots that are bootable
 *      (priority > 0, not unbootable, and tries_remaining > 0 or
 *      successful_boot == 1) AND whose image is present.
 *   2. Order candidates by priority (high first); break ties by lower slot id
 *      (A before B).
 *   3. For each candidate in order, verify its vbmeta with avb_verify against
 *      the controller trust inputs and rollback_floor. The first that returns
 *      AVB_OK is selected; its rollback_index is cached into meta.
 *   4. A candidate whose vbmeta fails verification is marked unbootable (it can
 *      never be trusted) and selection continues to the next candidate.
 *   5. If no A/B slot is selectable, fall through to AB_SLOT_RECOVERY, verified
 *      the same way against recovery_rollback_floor.
 *   6. If recovery also fails, return AB_ERR_NO_BOOTABLE_SLOT.
 *
 * On AB_OK *out_slot holds the chosen slot id; *out_avb (if non-NULL) holds the
 * verifier outcome for that slot. The boot hash target (the slot's boot image)
 * is fed to avb_verify so the boot partition digest is confirmed too.
 */
enum ab_result ab_select_slot(struct ab_controller *ctl,
                              enum ab_slot_id *out_slot,
                              struct avb_verify_outcome *out_avb);

/*
 * Record that the bootloader is about to launch `slot`: decrement its
 * tries_remaining (saturating at 0). When tries reach 0 without a prior
 * successful boot, the slot is marked unbootable so the next ab_select_slot()
 * auto-rolls-back to the other slot. A slot already marked successful is not
 * decremented (it is pinned). Returns AB_ERR_INVALID_SLOT for a bad id.
 */
enum ab_result ab_mark_boot_attempt(struct ab_controller *ctl,
                                    enum ab_slot_id slot);

/*
 * Record that `slot` booted to a user-visible success (update_engine's
 * mark_boot_successful). Pins the slot: successful_boot = 1, tries_remaining
 * reset to 0 (a pinned successful slot needs no further tries), priority set to
 * AB_PRIORITY_MAX. The other A/B slot's priority is lowered so the pinned slot
 * wins selection. The OTP rollback floor is advanced monotonically to the
 * booted image's rollback_index (never lowered). Returns AB_ERR_INVALID_SLOT
 * for a bad id, or AB_ERR_NOT_VERIFIED if the slot has no resident image.
 */
enum ab_result ab_mark_successful(struct ab_controller *ctl,
                                  enum ab_slot_id slot);

#endif /* E1_FW_AVB_AB_SLOT_H */
