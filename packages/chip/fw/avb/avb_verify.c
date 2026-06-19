/*
 * AVB vbmeta verifier — E1 Ed25519 profile. See avb_verify.h and
 * docs/security/avb-a-b-ota.md.
 *
 * libavb stores all multi-byte integers big-endian; this file decodes them.
 * The verifier copies nothing: the auth hash is computed over the header bytes
 * (with the auth/aux-block-internal layout untouched) followed by the
 * auxiliary block bytes, exactly as libavb's avb_vbmeta_image_verify does for
 * the RSA profile, except the signature primitive is Ed25519.
 */

#include "avb_verify.h"
#include "ed25519_ct.h"

static const uint8_t AVB_MAGIC_BYTES[AVB_MAGIC_LEN] = {'A', 'V', 'B', '0'};

static uint32_t rd_be32(const uint8_t *p)
{
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] << 8) | (uint32_t)p[3];
}

static uint64_t rd_be64(const uint8_t *p)
{
    return ((uint64_t)rd_be32(p) << 32) | (uint64_t)rd_be32(p + 4);
}

/* Constant-time N-byte equality: 1 if equal, 0 otherwise. */
static int ct_eq(const uint8_t *a, const uint8_t *b, size_t n)
{
    unsigned int diff = 0;
    for (size_t i = 0; i < n; i++) {
        diff |= (unsigned int)(a[i] ^ b[i]);
    }
    return (int)(1u & ((diff - 1u) >> 8));
}

/*
 * True iff [off, off+size) lies within [0, limit). Computed without overflow:
 * off and size are u64, limit is the trusted image/block length. A zero-size
 * region at any in-range offset is allowed (some optional fields are empty).
 */
static int region_ok(uint64_t off, uint64_t size, uint64_t limit)
{
    if (off > limit) {
        return 0;
    }
    return size <= (limit - off);
}

enum avb_result avb_parse_header(const uint8_t *image, size_t image_len,
                                 struct avb_vbmeta_header *out)
{
    if (image_len < AVB_HEADER_LEN) {
        return AVB_ERR_TRUNCATED;
    }
    for (unsigned i = 0; i < AVB_MAGIC_LEN; i++) {
        out->magic[i] = image[i];
        if (out->magic[i] != AVB_MAGIC_BYTES[i]) {
            return AVB_ERR_MAGIC;
        }
    }
    out->required_libavb_version_major = rd_be32(image + 0x04);
    out->required_libavb_version_minor = rd_be32(image + 0x08);
    out->authentication_data_block_size = rd_be64(image + 0x0C);
    out->auxiliary_data_block_size = rd_be64(image + 0x14);
    out->algorithm_type = rd_be32(image + 0x1C);
    out->hash_offset = rd_be64(image + 0x20);
    out->hash_size = rd_be64(image + 0x28);
    out->signature_offset = rd_be64(image + 0x30);
    out->signature_size = rd_be64(image + 0x38);
    out->public_key_offset = rd_be64(image + 0x40);
    out->public_key_size = rd_be64(image + 0x48);
    out->public_key_metadata_offset = rd_be64(image + 0x50);
    out->public_key_metadata_size = rd_be64(image + 0x58);
    out->descriptors_offset = rd_be64(image + 0x60);
    out->descriptors_size = rd_be64(image + 0x68);
    out->rollback_index = rd_be64(image + 0x70);
    out->flags = rd_be32(image + 0x78);
    out->rollback_index_location = rd_be32(image + 0x7C);
    for (unsigned i = 0; i < AVB_RELEASE_STRING_LEN; i++) {
        out->release_string[i] = image[0x80 + i];
    }
    return AVB_OK;
}

/*
 * Walk the descriptor stream within the auxiliary block. base points at the
 * auxiliary block start; the descriptor stream is [desc_off, desc_off+desc_sz)
 * inside it. Each descriptor is an 16-byte AvbDescriptor (u64 tag, u64
 * num_bytes_following) followed by num_bytes_following bytes of body, 8-byte
 * aligned. The known descriptor bodies are decoded and validated; chain
 * descriptors are recorded as pins; hash descriptors are matched against
 * targets and (if present) verified.
 */
static enum avb_result walk_descriptors(const uint8_t *aux, uint64_t aux_size,
                                        uint64_t desc_off, uint64_t desc_sz,
                                        const struct avb_hash_target *targets,
                                        size_t n_targets,
                                        struct avb_verify_outcome *out)
{
    if (!region_ok(desc_off, desc_sz, aux_size)) {
        return AVB_ERR_FIELD_BOUNDS;
    }
    const uint8_t *stream = aux + desc_off;
    uint64_t pos = 0;

    while (pos < desc_sz) {
        if (desc_sz - pos < 16u) {
            return AVB_ERR_DESCRIPTOR;
        }
        uint64_t tag = rd_be64(stream + pos);
        uint64_t nbf = rd_be64(stream + pos + 8);
        /* The 16-byte AvbDescriptor header plus its body must fit, and the
           next descriptor starts 8-byte aligned (libavb invariant). */
        if (nbf > desc_sz - pos - 16u) {
            return AVB_ERR_DESCRIPTOR;
        }
        if ((nbf & 7u) != 0u) {
            return AVB_ERR_DESCRIPTOR;
        }
        const uint8_t *body = stream + pos + 16u;
        uint64_t body_len = nbf;

        switch (tag) {
        case AVB_DESCRIPTOR_TAG_HASH: {
            /* AvbHashDescriptor body: image_size(u64), hash_algorithm[32],
               partition_name_len(u32), salt_len(u32), digest_len(u32),
               flags(u32), reserved[60], then partition_name|salt|digest.
               Fixed prefix = 8 + 32 + 16 + 60 = 0x74. */
            if (body_len < 0x74u) {
                return AVB_ERR_HASH_DESCRIPTOR;
            }
            uint64_t img_size = rd_be64(body + 0x00);
            uint32_t name_len = rd_be32(body + 0x28);
            uint32_t salt_len = rd_be32(body + 0x2C);
            uint32_t digest_len = rd_be32(body + 0x30);
            if (name_len > AVB_MAX_PARTITION_NAME ||
                salt_len > AVB_MAX_SALT_LEN ||
                digest_len == 0u || digest_len > AVB_MAX_DESCRIPTOR_DIGEST) {
                return AVB_ERR_HASH_DESCRIPTOR;
            }
            uint64_t var = (uint64_t)name_len + salt_len + digest_len;
            if (var > body_len - 0x74u) {
                return AVB_ERR_HASH_DESCRIPTOR;
            }
            const uint8_t *name = body + 0x74u;
            const uint8_t *salt = name + name_len;
            const uint8_t *digest = salt + salt_len;

            /* If the caller supplied the partition image, verify the digest:
               SHA-256(salt || image). Only SHA-256 digests are validated by
               this freestanding verifier (digest_len must be 32). */
            for (size_t t = 0; t < n_targets; t++) {
                const char *tn = targets[t].partition_name;
                size_t tnl = 0;
                while (tn[tnl] != '\0') tnl++;
                if (tnl != name_len) continue;
                int same = 1;
                for (uint32_t k = 0; k < name_len; k++) {
                    if ((uint8_t)tn[k] != name[k]) { same = 0; break; }
                }
                if (!same) continue;

                if (digest_len != SHA256_DIGEST_LEN) {
                    return AVB_ERR_HASH_DESCRIPTOR;
                }
                if (targets[t].image_len != img_size) {
                    return AVB_ERR_HASH_DESCRIPTOR;
                }
                struct sha256_ctx c;
                uint8_t got[SHA256_DIGEST_LEN];
                sha256_init(&c);
                sha256_update(&c, salt, salt_len);
                sha256_update(&c, targets[t].image, targets[t].image_len);
                sha256_final(&c, got);
                if (!ct_eq(got, digest, SHA256_DIGEST_LEN)) {
                    return AVB_ERR_HASH_DESCRIPTOR;
                }
                break;
            }
            out->hash_descriptor_count++;
            break;
        }
        case AVB_DESCRIPTOR_TAG_HASHTREE: {
            /* AvbHashtreeDescriptor body: dm_verity_version(u32),
               image_size(u64), tree_offset(u64), tree_size(u64),
               data_block_size(u32), hash_block_size(u32), fec_num_roots(u32),
               fec_offset(u64), fec_size(u64), hash_algorithm[32],
               partition_name_len(u32), salt_len(u32), root_digest_len(u32),
               flags(u32), reserved[60], then partition_name|salt|root_digest.
               Fixed prefix = 0xA4; root-digest length offset = 0x60. */
            if (body_len < 0xA4u) {
                return AVB_ERR_HASHTREE_DESCRIPTOR;
            }
            uint32_t name_len = rd_be32(body + 0x58);
            uint32_t salt_len = rd_be32(body + 0x5C);
            uint32_t root_len = rd_be32(body + 0x60);
            if (name_len > AVB_MAX_PARTITION_NAME ||
                salt_len > AVB_MAX_SALT_LEN ||
                root_len == 0u || root_len > AVB_MAX_DESCRIPTOR_DIGEST) {
                return AVB_ERR_HASHTREE_DESCRIPTOR;
            }
            uint64_t var = (uint64_t)name_len + salt_len + root_len;
            if (var > body_len - 0xA4u) {
                return AVB_ERR_HASHTREE_DESCRIPTOR;
            }
            out->hashtree_descriptor_count++;
            break;
        }
        case AVB_DESCRIPTOR_TAG_CHAIN_PARTITION: {
            /* AvbChainPartitionDescriptor: rollback_index_location(u32),
               partition_name_len(u32), public_key_len(u32), flags(u32),
               reserved[60], then partition_name|public_key. */
            if (body_len < 0x4Cu) {
                return AVB_ERR_CHAIN_DESCRIPTOR;
            }
            uint32_t ril = rd_be32(body + 0x00);
            uint32_t name_len = rd_be32(body + 0x04);
            uint32_t pk_len = rd_be32(body + 0x08);
            if (name_len == 0u || name_len >= AVB_MAX_PARTITION_NAME) {
                return AVB_ERR_CHAIN_DESCRIPTOR;
            }
            uint64_t var = (uint64_t)name_len + pk_len;
            if (var > body_len - 0x4Cu) {
                return AVB_ERR_CHAIN_DESCRIPTOR;
            }
            if (pk_len == 0u) {
                return AVB_ERR_CHAIN_DESCRIPTOR;
            }
            if (out->chain_pin_count >= AVB_MAX_CHAIN_PINS) {
                return AVB_ERR_CHAIN_DESCRIPTOR;
            }
            const uint8_t *name = body + 0x4Cu;
            const uint8_t *pk = name + name_len;
            struct avb_chain_pin *pin = &out->chain_pins[out->chain_pin_count];
            for (uint32_t k = 0; k < name_len; k++) {
                pin->partition_name[k] = (char)name[k];
            }
            pin->partition_name[name_len] = '\0';
            pin->rollback_index_location = ril;
            pin->public_key = pk;
            pin->public_key_len = pk_len;
            out->chain_pin_count++;
            break;
        }
        case AVB_DESCRIPTOR_TAG_PROPERTY: {
            /* AvbPropertyDescriptor: key_num_bytes(u64), value_num_bytes(u64),
               then key|0x00|value|0x00. Bounds only. */
            if (body_len < 16u) {
                return AVB_ERR_DESCRIPTOR;
            }
            uint64_t key_len = rd_be64(body + 0x00);
            uint64_t val_len = rd_be64(body + 0x08);
            /* key NUL + value NUL = 2 trailing bytes. */
            if (key_len > body_len - 16u || val_len > body_len - 16u - key_len ||
                (key_len + val_len + 2u) > body_len - 16u) {
                return AVB_ERR_DESCRIPTOR;
            }
            out->property_descriptor_count++;
            break;
        }
        case AVB_DESCRIPTOR_TAG_KERNEL_CMDLINE:
            /* Recognized; structural bounds already enforced above. */
            break;
        default:
            return AVB_ERR_DESCRIPTOR;
        }
        pos += 16u + nbf;
    }
    return AVB_OK;
}

enum avb_result avb_verify(const uint8_t *image, size_t image_len,
                           const struct avb_trust_inputs *trust,
                           const struct avb_hash_target *hash_targets,
                           size_t n_targets,
                           struct avb_verify_outcome *out)
{
    struct avb_verify_outcome local;
    struct avb_verify_outcome *res = out ? out : &local;
    for (unsigned i = 0; i < sizeof(*res); i++) {
        ((uint8_t *)res)[i] = 0;
    }

    /* §1 OTP parity gate: a parity fault must never reach the verifier. */
    if (!trust->parity_ok) {
        return AVB_ERR_PARITY;
    }
    if (image_len > AVB_MAX_VBMETA_SIZE) {
        return AVB_ERR_TRUNCATED;
    }

    enum avb_result rc = avb_parse_header(image, image_len, &res->header);
    if (rc != AVB_OK) {
        return rc;
    }
    struct avb_vbmeta_header *h = &res->header;

    /* §2 version: this verifier implements libavb major version 1. */
    if (h->required_libavb_version_major != 1u) {
        return AVB_ERR_VERSION;
    }

    /* Block bounds: header + auth block + aux block must fit the image. */
    {
        uint64_t need = (uint64_t)AVB_HEADER_LEN +
                        h->authentication_data_block_size +
                        h->auxiliary_data_block_size;
        if (need > image_len) {
            return AVB_ERR_BLOCK_BOUNDS;
        }
    }
    const uint8_t *auth = image + AVB_HEADER_LEN;
    uint64_t auth_size = h->authentication_data_block_size;
    const uint8_t *aux = auth + auth_size;
    uint64_t aux_size = h->auxiliary_data_block_size;

    /* §3 algorithm: only the E1 Ed25519 profile is accepted. */
    if (h->algorithm_type != AVB_ALGORITHM_TYPE_E1_SHA256_ED25519) {
        return AVB_ERR_ALGORITHM;
    }

    /* §4 flags: refuse an image that asks verification to be skipped. */
    if (h->flags & AVB_VBMETA_FLAG_VERIFICATION_DISABLED) {
        return AVB_ERR_VERIFICATION_DISABLED;
    }

    /* Sub-field bounds for the E1 profile. */
    if (!region_ok(h->hash_offset, h->hash_size, auth_size) ||
        !region_ok(h->signature_offset, h->signature_size, auth_size)) {
        return AVB_ERR_FIELD_BOUNDS;
    }
    if (!region_ok(h->public_key_offset, h->public_key_size, aux_size) ||
        !region_ok(h->public_key_metadata_offset, h->public_key_metadata_size,
                   aux_size) ||
        !region_ok(h->descriptors_offset, h->descriptors_size, aux_size)) {
        return AVB_ERR_FIELD_BOUNDS;
    }
    if (h->hash_size != AVB_E1_HASH_LEN ||
        h->signature_size != AVB_E1_SIGNATURE_LEN ||
        h->public_key_size != AVB_E1_PUBKEY_LEN) {
        return AVB_ERR_FIELD_BOUNDS;
    }

    const uint8_t *stored_hash = auth + h->hash_offset;
    const uint8_t *stored_sig = auth + h->signature_offset;
    const uint8_t *pubkey = aux + h->public_key_offset;

    /* §5 auth hash: SHA-256 over (header || auxiliary block). The auth block
       holds the hash/signature themselves and is excluded, matching libavb. */
    uint8_t computed_hash[SHA256_DIGEST_LEN];
    {
        struct sha256_ctx c;
        sha256_init(&c);
        sha256_update(&c, image, AVB_HEADER_LEN);
        sha256_update(&c, aux, (size_t)aux_size);
        sha256_final(&c, computed_hash);
    }
    if (!ct_eq(computed_hash, stored_hash, SHA256_DIGEST_LEN)) {
        return AVB_ERR_HASH;
    }

    /* §6 key pin (AVB analogue of the OPNPHN01 key ladder): the aux public key
       must hash to the value pinned by the loading boot stage. */
    {
        uint8_t pkh[SHA256_DIGEST_LEN];
        sha256(pubkey, AVB_E1_PUBKEY_LEN, pkh);
        if (!ct_eq(pkh, trust->expected_pubkey_hash, SHA256_DIGEST_LEN)) {
            return AVB_ERR_PUBKEY_HASH;
        }
    }

    /* §7 signature: Ed25519 over the (already integrity-checked) auth hash. */
    if (!ed25519_verify(stored_sig, pubkey, computed_hash, SHA256_DIGEST_LEN)) {
        return AVB_ERR_SIGNATURE;
    }

    /* §8 anti-rollback: index at or above the OTP floor for this location. */
    if (h->rollback_index < trust->rollback_min) {
        return AVB_ERR_ROLLBACK;
    }

    /* §9 descriptor walk. */
    rc = walk_descriptors(aux, aux_size, h->descriptors_offset,
                          h->descriptors_size, hash_targets, n_targets, res);
    if (rc != AVB_OK) {
        return rc;
    }

    return AVB_OK;
}
