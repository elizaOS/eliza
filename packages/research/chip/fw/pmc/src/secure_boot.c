/*
 * Secure-boot verification on the PMC.
 *
 * The PMC authenticates the OpenSBI / DVFS payload it is handed using the same
 * OPNPHN01 container, key ladder, and Ed25519 + SHA-256 verifier the mask ROM
 * uses (docs/security/boot-image-format.md). There is no HMAC stand-in, no
 * ECDSA shortcut, and no accept-all path: an image that fails any check is
 * rejected with the verifier's error code mapped to a negative return.
 *
 * The verifier sources live under fw/boot-rom/secure and are included here so
 * this PMC translation unit links the real implementation rather than a copy.
 */

#include "pmc.h"

#include "../../boot-rom/secure/sha256.c"
#include "../../boot-rom/secure/ed25519_ct.c"
#include "../../boot-rom/secure/verify.c"

/*
 * OTP-backed expected root key hash and security state. On the PMC these are
 * delivered by the RoT over the mailbox after the RoT has performed the
 * 2-of-3 majority OTP read; the PMC never reads raw fuses. Until the RoT
 * binding lands, this reads parity-not-OK so verification fails closed.
 */
extern void pmc_rot_read_security_state(struct opnphn01_otp *otp);

__attribute__((weak)) void pmc_rot_read_security_state(struct opnphn01_otp *otp)
{
    for (unsigned i = 0; i < 32; i++) {
        otp->expected_pubkey_hash[i] = 0;
    }
    otp->rollback_min = 0;
    otp->revoked_key_bitmap = 0;
    otp->lifecycle_state = 0;
    otp->otp_parity_ok = 0; /* fail closed until the RoT mailbox is bound */
}

/*
 * Returns 0 on a fully verified image, or a negative value carrying the
 * verifier reject code (-(enum verify_result)) on any failure.
 */
int pmc_secure_boot_verify(const uint8_t *image, size_t length)
{
    struct opnphn01_otp otp;
    struct opnphn01_header hdr;
    const uint8_t *payload = 0;
    size_t payload_len = 0;
    enum verify_result rc;

    if (image == 0) {
        return -(int)VERIFY_ERR_TRUNCATED;
    }

    pmc_rot_read_security_state(&otp);

    rc = opnphn01_verify(image, length, &otp, &hdr, &payload, &payload_len);
    if (rc != VERIFY_OK) {
        return -(int)rc;
    }
    return 0;
}
