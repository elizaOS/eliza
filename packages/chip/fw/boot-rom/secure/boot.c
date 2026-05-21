/*
 * Mask-ROM secure-boot C entrypoint. See boot.h.
 *
 * This is the decision point reset.S jumps into: it verifies the first-stage
 * image and either returns an authenticated entry address or returns 0 to
 * force a fail-closed trap. There is no path that returns a fixed unverified
 * handoff address.
 */

#include "boot.h"
#include "measure.h"

/*
 * Platform bindings default to fail-closed weak stubs. A real ROM build links
 * strong definitions that read the OTP macro and the SPI/eMMC image window.
 * Absent those, otp_parity_ok stays 0 so the verifier halts with OTP_PARITY
 * and nothing is booted.
 */
__attribute__((weak)) const uint8_t *e1_rom_image_base(void) { return 0; }
__attribute__((weak)) size_t e1_rom_image_len(void) { return 0; }
__attribute__((weak)) uint64_t e1_rom_image_entry(void) { return 0; }

__attribute__((weak)) void e1_rom_read_otp(struct opnphn01_otp *otp)
{
    for (unsigned i = 0; i < 32; i++) {
        otp->expected_pubkey_hash[i] = 0;
    }
    otp->rollback_min = 0;
    otp->revoked_key_bitmap = 0;
    otp->lifecycle_state = 0;
    otp->otp_parity_ok = 0; /* fail closed until a real OTP is bound */
}

__attribute__((weak)) void e1_rom_emit_halt(const uint8_t record[HALT_RECORD_LEN])
{
    (void)record;
}

uint64_t e1_secure_boot_main(void)
{
    struct opnphn01_otp otp;
    struct opnphn01_header hdr;
    const uint8_t *payload = 0;
    size_t payload_len = 0;
    const uint8_t *image;
    size_t image_len;
    enum verify_result rc;

    e1_rom_read_otp(&otp);
    image = e1_rom_image_base();
    image_len = e1_rom_image_len();

    if (image == 0 || image_len == 0) {
        uint8_t record[HALT_RECORD_LEN];
        halt_record_build(record, VERIFY_ERR_TRUNCATED, 0, &otp);
        e1_rom_emit_halt(record);
        return 0;
    }

    rc = opnphn01_verify(image, image_len, &otp, &hdr, &payload, &payload_len);
    if (rc != VERIFY_OK) {
        uint8_t record[HALT_RECORD_LEN];
        halt_record_build(record, rc, &hdr, &otp);
        e1_rom_emit_halt(record);
        return 0;
    }

    /* Verified: extend the boot measurement with H(payload) before handoff. */
    {
        struct boot_measure m;
        uint8_t stage_hash[SHA256_DIGEST_LEN];
        boot_measure_init(&m);
        sha256(payload, payload_len, stage_hash);
        keymgr_advance(&m, KEYMGR_STAGE_CREATOR, stage_hash);
    }

    return e1_rom_image_entry();
}
