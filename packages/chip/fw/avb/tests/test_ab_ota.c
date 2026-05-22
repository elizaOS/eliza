/*
 * Host harness for the E1 A/B slot + OTA apply + recovery logic
 * (ab_slot.{c,h}, ota_apply.{c,h}). Built and run by run_tests.sh with host gcc.
 *
 * Cases (docs/security/avb-a-b-ota.md §§4-6):
 *   (a) Normal A/B select picks the bootable, verifying slot A.
 *   (b) An OTA to slot B that verifies becomes active-pending, then on a
 *       successful boot is pinned and the OTP rollback floor advances.
 *   (c) A bad OTA (slot B armed, boot attempts exhaust the try budget without a
 *       success) AUTO-ROLLS-BACK: selection returns to the known-good slot A.
 *   (d) A rollback-index-downgrade OTA is REJECTED pre-write (AVB_ERR_ROLLBACK),
 *       nothing is staged, and slot B stays as it was.
 *   (e) A tampered OTA vbmeta is REJECTED pre-write (AVB_ERR_HASH); a wrong-key
 *       OTA is REJECTED (AVB_ERR_PUBKEY_HASH).
 *   (f) Both A and B unbootable -> recovery is selected (verified).
 *       Recovery also bad -> AB_ERR_NO_BOOTABLE_SLOT (fail-closed halt).
 *
 * Exits non-zero on any wrong decision; prints "AB/OTA test PASS" on success.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ab_slot.h"
#include "ota_apply.h"
#include "avb_verify.h"
#include "ab_expected.h"

static int g_failures = 0;

static void check(const char *name, int ok)
{
    printf("%s %s\n", ok ? "PASS" : "FAIL", name);
    if (!ok) {
        g_failures++;
    }
}

/* A loaded file: bytes + length. The harness keeps every vector resident. */
struct blob {
    uint8_t bytes[8192];
    size_t  len;
};

static int load(const char *dir, const char *name, struct blob *b)
{
    char path[512];
    snprintf(path, sizeof(path), "%s/%s", dir, name);
    FILE *f = fopen(path, "rb");
    if (!f) {
        fprintf(stderr, "  cannot open %s\n", path);
        return 0;
    }
    b->len = fread(b->bytes, 1, sizeof(b->bytes), f);
    int trailing = fgetc(f) != EOF; /* detect overflow of the fixed buffer */
    fclose(f);
    if (trailing) {
        fprintf(stderr, "  %s exceeds blob buffer\n", path);
        return 0;
    }
    return 1;
}

/* Seed a controller with slot A resident-good and slots B/recovery empty. */
static void seed_controller(struct ab_controller *ctl,
                            const struct blob *a_vbmeta,
                            const struct blob *a_boot)
{
    memset(ctl, 0, sizeof(*ctl));
    memcpy(ctl->expected_pubkey_hash, AB_PINNED_KEY_HASH, 32);
    ctl->rollback_floor = AB_VBMETA_ROLLBACK_FLOOR;
    ctl->recovery_rollback_floor = AB_RECOVERY_ROLLBACK_FLOOR;
    ctl->parity_ok = 1;

    ctl->image[AB_SLOT_A].vbmeta = a_vbmeta->bytes;
    ctl->image[AB_SLOT_A].vbmeta_len = a_vbmeta->len;
    ctl->image[AB_SLOT_A].boot = a_boot->bytes;
    ctl->image[AB_SLOT_A].boot_len = a_boot->len;
    ctl->meta[AB_SLOT_A].priority = AB_PRIORITY_MAX;
    ctl->meta[AB_SLOT_A].tries_remaining = 0;
    ctl->meta[AB_SLOT_A].successful_boot = 1; /* A is the running known-good slot */
}

int main(int argc, char **argv)
{
    const char *dir = (argc > 1) ? argv[1] : ".";

    static struct blob a_vbmeta, a_boot;
    static struct blob ota_b_vbmeta, ota_b_boot;
    static struct blob dg_vbmeta, dg_boot;
    static struct blob tmp_vbmeta, wk_vbmeta;
    static struct blob rec_vbmeta, rec_boot;

    if (!load(dir, "slot_a_vbmeta.bin", &a_vbmeta) ||
        !load(dir, "slot_a_boot.bin", &a_boot) ||
        !load(dir, "ota_b_vbmeta.bin", &ota_b_vbmeta) ||
        !load(dir, "ota_b_boot.bin", &ota_b_boot) ||
        !load(dir, "ota_downgrade_vbmeta.bin", &dg_vbmeta) ||
        !load(dir, "ota_downgrade_boot.bin", &dg_boot) ||
        !load(dir, "ota_tampered_vbmeta.bin", &tmp_vbmeta) ||
        !load(dir, "ota_wrongkey_vbmeta.bin", &wk_vbmeta) ||
        !load(dir, "recovery_vbmeta.bin", &rec_vbmeta) ||
        !load(dir, "recovery_boot.bin", &rec_boot)) {
        return 2;
    }

    struct ab_controller ctl;
    enum ab_slot_id sel;
    struct avb_verify_outcome avb;

    /* Backing store for OTA stages into slot B. */
    static uint8_t store_vbmeta[8192];
    static uint8_t store_boot[8192];
    struct ota_slot_store storeB = {
        .vbmeta = store_vbmeta, .vbmeta_cap = sizeof(store_vbmeta),
        .boot = store_boot, .boot_cap = sizeof(store_boot),
    };

    /* ---- (a) Normal A/B select picks the good slot A. ---- */
    printf("AB/OTA scenarios:\n");
    seed_controller(&ctl, &a_vbmeta, &a_boot);
    check("(a) select picks slot A",
          ab_select_slot(&ctl, &sel, &avb) == AB_OK && sel == AB_SLOT_A);
    check("(a) selected slot A rollback_index cached",
          ctl.meta[AB_SLOT_A].rollback_index == AB_SLOT_A_INDEX);

    /* ---- (b) OTA to B verifies, becomes active-pending, success pins it. ---- */
    seed_controller(&ctl, &a_vbmeta, &a_boot);
    struct ota_payload pb = {
        .vbmeta = ota_b_vbmeta.bytes, .vbmeta_len = ota_b_vbmeta.len,
        .boot = ota_b_boot.bytes, .boot_len = ota_b_boot.len,
    };
    enum avb_result pre_rc = AVB_OK;
    check("(b) OTA to B applies",
          ota_apply(&ctl, AB_SLOT_A, AB_SLOT_B, &pb, &storeB, &pre_rc) == OTA_OK);
    check("(b) B armed active-pending with OTA tries",
          ctl.meta[AB_SLOT_B].priority == AB_PRIORITY_MAX &&
          ctl.meta[AB_SLOT_B].tries_remaining == AB_OTA_TRIES &&
          ctl.meta[AB_SLOT_B].successful_boot == 0);
    /* Bootloader now selects B (higher-or-equal priority, lower-or-equal id loses
       ties to A, so demote A's priority below 15 to make B win — the real flow
       arms B at priority 15 and A is the previous slot at <15). Model that: */
    ctl.meta[AB_SLOT_A].priority = AB_PRIORITY_MAX - 1u;
    check("(b) select picks new slot B",
          ab_select_slot(&ctl, &sel, &avb) == AB_OK && sel == AB_SLOT_B);
    check("(b) B rollback_index is the OTA index",
          ctl.meta[AB_SLOT_B].rollback_index == AB_OTA_B_INDEX);
    ab_mark_boot_attempt(&ctl, AB_SLOT_B);
    check("(b) success pins B",
          ab_mark_successful(&ctl, AB_SLOT_B) == AB_OK &&
          ctl.meta[AB_SLOT_B].successful_boot == 1 &&
          ctl.meta[AB_SLOT_B].tries_remaining == 0);
    check("(b) OTP rollback floor advanced to OTA index",
          ctl.rollback_floor == AB_OTA_B_INDEX);
    check("(b) select still picks pinned B",
          ab_select_slot(&ctl, &sel, &avb) == AB_OK && sel == AB_SLOT_B);

    /* ---- (c) Bad OTA: B armed but never succeeds -> auto-rollback to A. ---- */
    seed_controller(&ctl, &a_vbmeta, &a_boot);
    pre_rc = AVB_OK;
    check("(c) OTA to B applies (verifies fine; the *boot* will fail)",
          ota_apply(&ctl, AB_SLOT_A, AB_SLOT_B, &pb, &storeB, &pre_rc) == OTA_OK);
    ctl.meta[AB_SLOT_A].priority = AB_PRIORITY_MAX - 1u;
    check("(c) first select picks B",
          ab_select_slot(&ctl, &sel, &avb) == AB_OK && sel == AB_SLOT_B);
    /* Two failed boots (no mark_successful) burn B's try budget. */
    ab_mark_boot_attempt(&ctl, AB_SLOT_B);
    check("(c) after 1 try B still bootable",
          ab_select_slot(&ctl, &sel, &avb) == AB_OK && sel == AB_SLOT_B);
    ab_mark_boot_attempt(&ctl, AB_SLOT_B);
    check("(c) B unbootable after tries exhausted",
          ctl.meta[AB_SLOT_B].unbootable == 1);
    check("(c) AUTO-ROLLBACK: select reverts to known-good slot A",
          ab_select_slot(&ctl, &sel, &avb) == AB_OK && sel == AB_SLOT_A);

    /* ---- (d) Downgrade OTA rejected pre-write; B untouched. ---- */
    seed_controller(&ctl, &a_vbmeta, &a_boot);
    struct ota_payload pd = {
        .vbmeta = dg_vbmeta.bytes, .vbmeta_len = dg_vbmeta.len,
        .boot = dg_boot.bytes, .boot_len = dg_boot.len,
    };
    pre_rc = AVB_OK;
    enum ota_result rd = ota_apply(&ctl, AB_SLOT_A, AB_SLOT_B, &pd, &storeB, &pre_rc);
    check("(d) DOWNGRADE rejected pre-write", rd == OTA_ERR_VERIFY_PRE);
    check("(d) downgrade reason is AVB_ERR_ROLLBACK", pre_rc == AVB_ERR_ROLLBACK);
    check("(d) slot B not armed by a rejected OTA",
          ctl.meta[AB_SLOT_B].priority == 0 &&
          ctl.image[AB_SLOT_B].vbmeta == NULL);
    check("(d) select still picks slot A",
          ab_select_slot(&ctl, &sel, &avb) == AB_OK && sel == AB_SLOT_A);

    /* ---- (e) Tampered / wrong-key OTA rejected pre-write. ---- */
    seed_controller(&ctl, &a_vbmeta, &a_boot);
    struct ota_payload pt = {
        .vbmeta = tmp_vbmeta.bytes, .vbmeta_len = tmp_vbmeta.len,
        .boot = ota_b_boot.bytes, .boot_len = ota_b_boot.len,
    };
    pre_rc = AVB_OK;
    check("(e) TAMPERED vbmeta rejected pre-write",
          ota_apply(&ctl, AB_SLOT_A, AB_SLOT_B, &pt, &storeB, &pre_rc) ==
              OTA_ERR_VERIFY_PRE);
    check("(e) tampered reason is AVB_ERR_HASH", pre_rc == AVB_ERR_HASH);

    seed_controller(&ctl, &a_vbmeta, &a_boot);
    struct ota_payload pw = {
        .vbmeta = wk_vbmeta.bytes, .vbmeta_len = wk_vbmeta.len,
        .boot = ota_b_boot.bytes, .boot_len = ota_b_boot.len,
    };
    pre_rc = AVB_OK;
    check("(e) WRONG-KEY vbmeta rejected pre-write",
          ota_apply(&ctl, AB_SLOT_A, AB_SLOT_B, &pw, &storeB, &pre_rc) ==
              OTA_ERR_VERIFY_PRE);
    check("(e) wrong-key reason is AVB_ERR_PUBKEY_HASH",
          pre_rc == AVB_ERR_PUBKEY_HASH);

    /* OTA cannot target the active slot or recovery. */
    seed_controller(&ctl, &a_vbmeta, &a_boot);
    check("(e) OTA refuses the active slot",
          ota_apply(&ctl, AB_SLOT_A, AB_SLOT_A, &pb, &storeB, NULL) ==
              OTA_ERR_INVALID_SLOT);
    check("(e) OTA refuses recovery as a target",
          ota_apply(&ctl, AB_SLOT_A, AB_SLOT_RECOVERY, &pb, &storeB, NULL) ==
              OTA_ERR_INVALID_SLOT);

    /* ---- (f) Both A and B unbootable -> recovery selected, then halt. ---- */
    seed_controller(&ctl, &a_vbmeta, &a_boot);
    /* Make A and B both dead, install a valid recovery image. */
    ctl.meta[AB_SLOT_A].unbootable = 1;
    ctl.meta[AB_SLOT_B].priority = 0;
    ctl.image[AB_SLOT_RECOVERY].vbmeta = rec_vbmeta.bytes;
    ctl.image[AB_SLOT_RECOVERY].vbmeta_len = rec_vbmeta.len;
    ctl.image[AB_SLOT_RECOVERY].boot = rec_boot.bytes;
    ctl.image[AB_SLOT_RECOVERY].boot_len = rec_boot.len;
    check("(f) both slots bad -> RECOVERY selected",
          ab_select_slot(&ctl, &sel, &avb) == AB_OK && sel == AB_SLOT_RECOVERY);
    check("(f) recovery rollback_index cached",
          ctl.meta[AB_SLOT_RECOVERY].rollback_index == AB_RECOVERY_INDEX);

    /* Recovery also unusable -> fail-closed halt, no slot. */
    seed_controller(&ctl, &a_vbmeta, &a_boot);
    ctl.meta[AB_SLOT_A].unbootable = 1;
    ctl.meta[AB_SLOT_B].priority = 0;
    /* recovery image left empty */
    check("(f) no bootable slot at all -> NO_BOOTABLE_SLOT (halt)",
          ab_select_slot(&ctl, &sel, &avb) == AB_ERR_NO_BOOTABLE_SLOT &&
          sel == AB_SLOT_NONE);

    /* A corrupt recovery vbmeta must also fail closed. */
    seed_controller(&ctl, &a_vbmeta, &a_boot);
    ctl.meta[AB_SLOT_A].unbootable = 1;
    ctl.meta[AB_SLOT_B].priority = 0;
    static struct blob rec_bad;
    memcpy(&rec_bad, &rec_vbmeta, sizeof(rec_bad));
    /* Flip a byte in the release_string region (0x80): covered by the auth hash
       but not used for any bounds/algorithm decision, so the failure surfaces
       cleanly as AVB_ERR_HASH and selection falls through to fail-closed halt. */
    rec_bad.bytes[0x80] ^= 0x01;
    ctl.image[AB_SLOT_RECOVERY].vbmeta = rec_bad.bytes;
    ctl.image[AB_SLOT_RECOVERY].vbmeta_len = rec_bad.len;
    ctl.image[AB_SLOT_RECOVERY].boot = rec_boot.bytes;
    ctl.image[AB_SLOT_RECOVERY].boot_len = rec_boot.len;
    check("(f) corrupt recovery -> NO_BOOTABLE_SLOT (fail-closed)",
          ab_select_slot(&ctl, &sel, &avb) == AB_ERR_NO_BOOTABLE_SLOT);

    if (g_failures != 0) {
        printf("\n%d check(s) FAILED\n", g_failures);
        return 1;
    }
    printf("\nAB/OTA test PASS\n");
    return 0;
}
