/*
 * E1 OTA payload apply. See ota_apply.h and docs/security/avb-a-b-ota.md §5.
 *
 * The order is non-negotiable and fail-closed: verify the payload completely
 * before a single byte is written to the inactive slot, then stage, then arm
 * with a finite try budget so a bad image auto-reverts. The same avb_verify
 * gate the bootloader uses is the only thing that authorizes a stage; there is
 * no path that writes an unverified payload to a slot.
 */

#include "ota_apply.h"

/* Build the AVB trust inputs for the controller's vbmeta rollback slot. */
static void ota_trust(const struct ab_controller *ctl,
                      struct avb_trust_inputs *trust)
{
    for (unsigned i = 0; i < SHA256_DIGEST_LEN; i++) {
        trust->expected_pubkey_hash[i] = ctl->expected_pubkey_hash[i];
    }
    trust->rollback_min = ctl->rollback_floor;
    trust->parity_ok = ctl->parity_ok;
}

/* Verify a vbmeta+boot pair as the bootloader would. */
static enum avb_result ota_verify_pair(const struct ab_controller *ctl,
                                       const uint8_t *vbmeta, size_t vbmeta_len,
                                       const uint8_t *boot, size_t boot_len,
                                       struct avb_verify_outcome *out)
{
    struct avb_trust_inputs trust;
    ota_trust(ctl, &trust);
    struct avb_hash_target boot_target = {
        .partition_name = "boot",
        .image = boot,
        .image_len = boot_len,
    };
    return avb_verify(vbmeta, vbmeta_len, &trust, &boot_target, 1, out);
}

static void copy_bytes(uint8_t *dst, const uint8_t *src, size_t n)
{
    for (size_t i = 0; i < n; i++) {
        dst[i] = src[i];
    }
}

enum ota_result ota_apply(struct ab_controller *ctl,
                          enum ab_slot_id active,
                          enum ab_slot_id target,
                          const struct ota_payload *payload,
                          struct ota_slot_store *store,
                          enum avb_result *pre_avb_rc)
{
    if (pre_avb_rc) {
        *pre_avb_rc = AVB_OK;
    }

    /* OTA targets only A or B, and never the running slot. */
    if (target != AB_SLOT_A && target != AB_SLOT_B) {
        return OTA_ERR_INVALID_SLOT;
    }
    if (target == active) {
        return OTA_ERR_INVALID_SLOT;
    }
    if (payload->vbmeta == 0 || payload->vbmeta_len == 0u ||
        payload->boot == 0 || payload->boot_len == 0u) {
        return OTA_ERR_EMPTY_PAYLOAD;
    }
    if (store->vbmeta == 0 || store->boot == 0) {
        return OTA_ERR_NO_SPACE;
    }
    /* §4 TC-OTA-007: refuse before any write if the slot store is too small. */
    if (payload->vbmeta_len > store->vbmeta_cap ||
        payload->boot_len > store->boot_cap) {
        return OTA_ERR_NO_SPACE;
    }

    /* §4 TC-OTA-001..004: PRE-WRITE verification. Downgrade, tamper, wrong key,
       corrupt vbmeta, bad boot digest all reject here with no write. */
    struct avb_verify_outcome pre;
    enum avb_result rc = ota_verify_pair(ctl, payload->vbmeta, payload->vbmeta_len,
                                         payload->boot, payload->boot_len, &pre);
    if (rc != AVB_OK) {
        if (pre_avb_rc) {
            *pre_avb_rc = rc;
        }
        return OTA_ERR_VERIFY_PRE;
    }

    /* Stage: copy into the slot store (the flash/UFS write model). */
    copy_bytes(store->vbmeta, payload->vbmeta, payload->vbmeta_len);
    store->vbmeta_len = payload->vbmeta_len;
    copy_bytes(store->boot, payload->boot, payload->boot_len);
    store->boot_len = payload->boot_len;

    /* Point the controller's slot image at the staged bytes and arm the slot
       active-pending with a finite try budget (avb-a-b-ota.md §5). */
    ctl->image[target].vbmeta = store->vbmeta;
    ctl->image[target].vbmeta_len = store->vbmeta_len;
    ctl->image[target].boot = store->boot;
    ctl->image[target].boot_len = store->boot_len;

    struct ab_slot_meta *m = &ctl->meta[target];
    m->priority = AB_PRIORITY_MAX;
    m->tries_remaining = AB_OTA_TRIES;
    m->successful_boot = 0;
    m->unbootable = 0;
    m->rollback_index = pre.header.rollback_index;

    /* §5 POST-WRITE verify: the bytes that actually landed must still verify.
       A corrupted write disarms the slot (unbootable) so it cannot be booted. */
    struct avb_verify_outcome post;
    rc = ota_verify_pair(ctl, store->vbmeta, store->vbmeta_len,
                         store->boot, store->boot_len, &post);
    if (rc != AVB_OK) {
        m->unbootable = 1;
        m->priority = 0;
        m->tries_remaining = 0;
        return OTA_ERR_VERIFY_POST;
    }

    return OTA_OK;
}
