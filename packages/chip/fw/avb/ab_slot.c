/*
 * E1 A/B slot bootloader state machine. See ab_slot.h and
 * docs/security/avb-a-b-ota.md (§1 slot layout, §3 rollback, §4 failure modes).
 *
 * The selection path is the only place a slot's vbmeta is trusted: a slot is
 * never selected without avb_verify returning AVB_OK against the live OTP
 * rollback floor and the pinned AVB key. Fail-closed: a slot whose vbmeta does
 * not verify is permanently marked unbootable, and if A, B, and recovery all
 * fail, selection returns AB_ERR_NO_BOOTABLE_SLOT with AB_SLOT_NONE.
 */

#include "ab_slot.h"

static int slot_in_range(enum ab_slot_id slot)
{
    return slot == AB_SLOT_A || slot == AB_SLOT_B || slot == AB_SLOT_RECOVERY;
}

/*
 * Verify the vbmeta resident in `slot` against the controller trust inputs.
 * The slot's boot image is fed as a hash target so the boot partition digest
 * is confirmed as part of the same pass. Returns the avb_result; on AVB_OK the
 * caller may read the verified rollback_index from out->header.
 */
static enum avb_result verify_slot(const struct ab_controller *ctl,
                                   enum ab_slot_id slot,
                                   struct avb_verify_outcome *out)
{
    const struct ab_slot_image *img = &ctl->image[slot];
    if (img->vbmeta == 0 || img->vbmeta_len == 0u) {
        return AVB_ERR_TRUNCATED;
    }

    struct avb_trust_inputs trust;
    for (unsigned i = 0; i < SHA256_DIGEST_LEN; i++) {
        trust.expected_pubkey_hash[i] = ctl->expected_pubkey_hash[i];
    }
    trust.rollback_min = (slot == AB_SLOT_RECOVERY) ? ctl->recovery_rollback_floor
                                                    : ctl->rollback_floor;
    trust.parity_ok = ctl->parity_ok;

    /* Confirm the boot partition digest in the same pass when present. */
    struct avb_hash_target boot_target;
    const struct avb_hash_target *targets = 0;
    size_t n_targets = 0;
    if (img->boot != 0 && img->boot_len != 0u) {
        boot_target.partition_name = "boot";
        boot_target.image = img->boot;
        boot_target.image_len = img->boot_len;
        targets = &boot_target;
        n_targets = 1;
    }

    return avb_verify(img->vbmeta, img->vbmeta_len, &trust, targets, n_targets, out);
}

/* A/B candidate is eligible for selection (before the cryptographic check). */
static int ab_candidate_eligible(const struct ab_slot_meta *m,
                                 const struct ab_slot_image *img)
{
    if (m->unbootable) {
        return 0;
    }
    if (m->priority == 0u) {
        return 0;
    }
    if (m->tries_remaining == 0u && m->successful_boot == 0u) {
        return 0;
    }
    if (img->vbmeta == 0 || img->vbmeta_len == 0u) {
        return 0;
    }
    return 1;
}

enum ab_result ab_select_slot(struct ab_controller *ctl,
                              enum ab_slot_id *out_slot,
                              struct avb_verify_outcome *out_avb)
{
    struct avb_verify_outcome scratch;
    struct avb_verify_outcome *res = out_avb ? out_avb : &scratch;

    if (out_slot) {
        *out_slot = AB_SLOT_NONE;
    }

    /*
     * Order the two A/B slots by priority (high first), ties to lower slot id.
     * Only A and B participate; recovery is the explicit fallback below.
     */
    const enum ab_slot_id ab[2] = {AB_SLOT_A, AB_SLOT_B};
    enum ab_slot_id order[2];
    {
        const struct ab_slot_meta *ma = &ctl->meta[AB_SLOT_A];
        const struct ab_slot_meta *mb = &ctl->meta[AB_SLOT_B];
        if (mb->priority > ma->priority) {
            order[0] = AB_SLOT_B;
            order[1] = AB_SLOT_A;
        } else {
            order[0] = AB_SLOT_A;
            order[1] = AB_SLOT_B;
        }
    }
    (void)ab;

    for (unsigned i = 0; i < 2u; i++) {
        enum ab_slot_id slot = order[i];
        struct ab_slot_meta *m = &ctl->meta[slot];
        if (!ab_candidate_eligible(m, &ctl->image[slot])) {
            continue;
        }
        enum avb_result rc = verify_slot(ctl, slot, res);
        if (rc == AVB_OK) {
            m->rollback_index = res->header.rollback_index;
            if (out_slot) {
                *out_slot = slot;
            }
            return AB_OK;
        }
        /* A slot whose vbmeta does not verify can never be trusted: burn it so
           the auto-rollback path does not keep retrying a corrupt slot. */
        m->unbootable = 1;
    }

    /* Fail-closed fallback: recovery, verified the same way. */
    {
        struct ab_slot_meta *mr = &ctl->meta[AB_SLOT_RECOVERY];
        const struct ab_slot_image *ir = &ctl->image[AB_SLOT_RECOVERY];
        if (!mr->unbootable && ir->vbmeta != 0 && ir->vbmeta_len != 0u) {
            if (verify_slot(ctl, AB_SLOT_RECOVERY, res) == AVB_OK) {
                mr->rollback_index = res->header.rollback_index;
                if (out_slot) {
                    *out_slot = AB_SLOT_RECOVERY;
                }
                return AB_OK;
            }
            mr->unbootable = 1;
        }
    }

    return AB_ERR_NO_BOOTABLE_SLOT;
}

enum ab_result ab_mark_boot_attempt(struct ab_controller *ctl,
                                    enum ab_slot_id slot)
{
    if (!slot_in_range(slot)) {
        return AB_ERR_INVALID_SLOT;
    }
    struct ab_slot_meta *m = &ctl->meta[slot];

    /* A pinned-successful slot is not retried-counted. */
    if (m->successful_boot) {
        return AB_OK;
    }
    if (m->tries_remaining > 0u) {
        m->tries_remaining--;
    }
    /* Out of tries without a success => auto-rollback: the slot is dead and the
       next ab_select_slot() falls through to the other slot / recovery. */
    if (m->tries_remaining == 0u && m->successful_boot == 0u) {
        m->unbootable = 1;
    }
    return AB_OK;
}

enum ab_result ab_mark_successful(struct ab_controller *ctl,
                                  enum ab_slot_id slot)
{
    if (!slot_in_range(slot)) {
        return AB_ERR_INVALID_SLOT;
    }
    struct ab_slot_meta *m = &ctl->meta[slot];
    const struct ab_slot_image *img = &ctl->image[slot];
    if (img->vbmeta == 0 || img->vbmeta_len == 0u) {
        return AB_ERR_NOT_VERIFIED;
    }

    /* Pin the slot: it is the known-good one now. */
    m->successful_boot = 1;
    m->tries_remaining = 0;
    m->unbootable = 0;
    m->priority = AB_PRIORITY_MAX;

    /* Demote the other A/B slot so the pinned slot always wins selection.
       Recovery priority is not touched (it is the explicit fallback). */
    if (slot == AB_SLOT_A || slot == AB_SLOT_B) {
        enum ab_slot_id other = (slot == AB_SLOT_A) ? AB_SLOT_B : AB_SLOT_A;
        struct ab_slot_meta *mo = &ctl->meta[other];
        if (mo->priority >= AB_PRIORITY_MAX) {
            mo->priority = AB_PRIORITY_MAX - 1u;
        }
    }

    /*
     * Advance the OTP rollback floor monotonically to the booted image's
     * rollback_index (boot-image-format §4: program fuses until the OTP slot
     * equals the image index). The recovery slot owns a separate OTP slot.
     * Never lowered.
     */
    uint64_t *floor = (slot == AB_SLOT_RECOVERY) ? &ctl->recovery_rollback_floor
                                                 : &ctl->rollback_floor;
    if (m->rollback_index > *floor) {
        *floor = m->rollback_index;
    }
    return AB_OK;
}
