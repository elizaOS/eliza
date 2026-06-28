/*
 * OPNPHN01 verifier. See verify.h and docs/security/boot-image-format.md.
 *
 * Byte offsets are taken directly from §2.1 / §2.2 of that spec. The verifier
 * is fail-closed: it returns at the first failing check with a distinct code,
 * and only returns VERIFY_OK when every check passes.
 */

#include "verify.h"
#include "ed25519_ct.h"

static const uint8_t OPNPHN01_MAGIC[8] = {'O', 'P', 'N', 'P', 'H', 'N', '0', '1'};

static uint32_t rd_le32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
           ((uint32_t)p[3] << 24);
}

static uint64_t rd_le64(const uint8_t *p)
{
    return (uint64_t)rd_le32(p) | ((uint64_t)rd_le32(p + 4) << 32);
}

static void wr_le32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}

/* Constant-time 32-byte equality: 1 if equal, 0 otherwise. */
static int ct_eq32(const uint8_t *a, const uint8_t *b)
{
    unsigned int diff = 0;
    for (unsigned i = 0; i < 32; i++) {
        diff |= (unsigned int)(a[i] ^ b[i]);
    }
    return (int)(1u & ((diff - 1u) >> 8));
}

enum verify_result opnphn01_parse_header(const uint8_t *image, size_t image_len,
                                         struct opnphn01_header *out)
{
    if (image_len < OPNPHN01_HEADER_LEN) {
        return VERIFY_ERR_TRUNCATED;
    }

    for (unsigned i = 0; i < 8; i++) {
        out->magic[i] = image[i];
        if (out->magic[i] != OPNPHN01_MAGIC[i]) {
            return VERIFY_ERR_MAGIC;
        }
    }

    out->header_version = rd_le32(image + 0x08);
    if (out->header_version != OPNPHN01_HEADER_VERSION) {
        return VERIFY_ERR_HEADER_VERSION;
    }

    out->image_type = rd_le32(image + 0x0C);
    out->image_size = rd_le64(image + 0x10);
    out->rollback_index = rd_le32(image + 0x18);
    out->rollback_slot = rd_le32(image + 0x1C);
    out->key_id = rd_le32(image + 0x20);
    out->flags = rd_le32(image + 0x24);
    for (unsigned i = 0; i < 32; i++) {
        out->payload_sha256[i] = image[0x28 + i];
        out->next_stage_pubkey_hash[i] = image[0x48 + i];
    }
    out->min_lifecycle_state = rd_le32(image + 0x68);
    return VERIFY_OK;
}

enum verify_result opnphn01_verify(const uint8_t *image, size_t image_len,
                                   const struct opnphn01_otp *otp,
                                   struct opnphn01_header *hdr_out,
                                   const uint8_t **payload_out,
                                   size_t *payload_len_out)
{
    struct opnphn01_header hdr;
    enum verify_result rc;

    /* §5/§6: a SCRAP device halts immediately, before any parse. */
    if (otp->lifecycle_state == OPNPHN01_LC_SCRAP) {
        return VERIFY_ERR_LIFECYCLE_SCRAP;
    }
    /* §6: OTP parity fault halts before any value is trusted. */
    if (!otp->otp_parity_ok) {
        return VERIFY_ERR_OTP_PARITY;
    }

    rc = opnphn01_parse_header(image, image_len, &hdr);
    if (rc != VERIFY_OK) {
        if (hdr_out) {
            *hdr_out = hdr;
        }
        return rc;
    }

    /* Bounds: header + payload + signature must fit the supplied image. */
    {
        uint64_t need = (uint64_t)OPNPHN01_HEADER_LEN + hdr.image_size +
                        (uint64_t)OPNPHN01_SIG_LEN;
        if (hdr.image_size > image_len || need > image_len) {
            if (hdr_out) {
                *hdr_out = hdr;
            }
            return VERIFY_ERR_TRUNCATED;
        }
    }

    const uint8_t *payload = image + OPNPHN01_HEADER_LEN;
    size_t payload_len = (size_t)hdr.image_size;
    const uint8_t *sigblob = payload + payload_len;
    const uint8_t *sig_pubkey = sigblob;            /* §2.2 0x00 */
    const uint8_t *sig_value = sigblob + 32;        /* §2.2 0x20 */

    /* §6: payload integrity. */
    {
        uint8_t digest[SHA256_DIGEST_LEN];
        sha256(payload, payload_len, digest);
        if (!ct_eq32(digest, hdr.payload_sha256)) {
            if (hdr_out) {
                *hdr_out = hdr;
            }
            return VERIFY_ERR_PAYLOAD_HASH;
        }
    }

    /* §3 key ladder: SHA-256(sig.pubkey) must equal the pinned hash. */
    {
        uint8_t pkh[SHA256_DIGEST_LEN];
        sha256(sig_pubkey, 32, pkh);
        if (!ct_eq32(pkh, otp->expected_pubkey_hash)) {
            if (hdr_out) {
                *hdr_out = hdr;
            }
            return VERIFY_ERR_PUBKEY_HASH;
        }
    }

    /* §3 revocation: refuse a revoked key_id even if the signature verifies. */
    if (hdr.key_id >= 8u) {
        if (hdr_out) {
            *hdr_out = hdr;
        }
        return VERIFY_ERR_KEY_ID_RANGE;
    }
    if ((otp->revoked_key_bitmap >> hdr.key_id) & 1u) {
        if (hdr_out) {
            *hdr_out = hdr;
        }
        return VERIFY_ERR_KEY_REVOKED;
    }

    /*
     * §2.2 signature is over (header || payload). The two are contiguous in the
     * wire image starting at image[0], so verify over that span directly — no
     * copy, no malloc.
     */
    {
        size_t signed_len = OPNPHN01_HEADER_LEN + payload_len;
        if (!ed25519_verify(sig_value, sig_pubkey, image, signed_len)) {
            if (hdr_out) {
                *hdr_out = hdr;
            }
            return VERIFY_ERR_SIGNATURE;
        }
    }

    /* §4 anti-rollback: index must be at or above the OTP floor. */
    if (hdr.rollback_index < otp->rollback_min) {
        if (hdr_out) {
            *hdr_out = hdr;
        }
        return VERIFY_ERR_ROLLBACK;
    }

    /* §5 lifecycle: image refuses to run below its declared minimum. */
    if (otp->lifecycle_state < hdr.min_lifecycle_state) {
        if (hdr_out) {
            *hdr_out = hdr;
        }
        return VERIFY_ERR_LIFECYCLE;
    }

    if (hdr_out) {
        *hdr_out = hdr;
    }
    if (payload_out) {
        *payload_out = payload;
    }
    if (payload_len_out) {
        *payload_len_out = payload_len;
    }
    return VERIFY_OK;
}

void halt_record_build(uint8_t out[HALT_RECORD_LEN], enum verify_result reason,
                       const struct opnphn01_header *hdr,
                       const struct opnphn01_otp *otp)
{
    for (unsigned i = 0; i < HALT_RECORD_LEN; i++) {
        out[i] = 0;
    }
    out[0] = HALT_RECORD_MAGIC0;
    out[1] = HALT_RECORD_MAGIC1;
    out[2] = HALT_RECORD_MAGIC2;
    out[3] = HALT_RECORD_MAGIC3;
    wr_le32(out + 0x04, (uint32_t)reason);
    wr_le32(out + 0x08, hdr ? hdr->image_type : 0xffffffffu);
    wr_le32(out + 0x0C, hdr ? hdr->key_id : 0xffffffffu);
    wr_le32(out + 0x10, hdr ? hdr->rollback_index : 0u);
    wr_le32(out + 0x14, otp ? otp->rollback_min : 0u);
    out[0x18] = otp ? otp->lifecycle_state : 0u;
}
