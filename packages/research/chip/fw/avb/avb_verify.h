/*
 * Android Verified Boot (AVB) vbmeta verifier — E1 Ed25519 profile.
 *
 * Implements the real libavb vbmeta image layout (AvbVBMetaImageHeader, a
 * 256-byte big-endian header followed by an authentication block and an
 * auxiliary block) and the libavb descriptor format
 * (AvbDescriptor + hash/hashtree/chain-partition/property descriptors).
 *
 * It chains from the OPNPHN01 mask-ROM key ladder
 * (docs/security/boot-image-format.md): BL2 loads vbmeta_$slot and verifies it
 * with AVB key A, whose SHA-256 hash is pinned by the previous boot stage.
 * vbmeta in turn protects boot/vendor_boot/dtbo (chain descriptors pin their
 * vbmeta pubkey hashes) and system/vendor/product (hashtree descriptors carry
 * the dm-verity root digest).
 *
 * ALGORITHM PROFILE (E1): libavb's standard authentication is RSA
 * (AVB_ALGORITHM_TYPE_SHA256_RSA*). The E1 root-of-trust key ladder is Ed25519
 * (boot-image-format.md §1), so this verifier implements AVB authentication
 * over Ed25519: the hash is SHA-256 over (header || auxiliary block) and the
 * signature is Ed25519 (RFC 8032) over that hash, reusing the constant-time
 * primitives in fw/boot-rom/secure. This is the E1 AVB profile and is
 * documented in docs/security/avb-a-b-ota.md. It is NOT libavb-RSA compatible
 * and makes no such claim. Only the E1 algorithm id is accepted; the standard
 * libavb RSA ids are recognized for diagnostics and rejected.
 *
 * Freestanding: no malloc, no libc beyond the memcpy/memset provided by the
 * shared crypto sources. The verifier is fail-closed — it returns at the first
 * failing check with a distinct error code and only returns AVB_OK when every
 * structural, cryptographic, rollback, and descriptor check passes. There is
 * no unverified fallback.
 */

#ifndef E1_FW_AVB_AVB_VERIFY_H
#define E1_FW_AVB_AVB_VERIFY_H

#include <stddef.h>
#include <stdint.h>

#include "sha256.h"

/* libavb on-wire constants. */
#define AVB_MAGIC          "AVB0"
#define AVB_MAGIC_LEN      4u
#define AVB_HEADER_LEN     256u
#define AVB_RELEASE_STRING_LEN 48u

/*
 * Algorithm ids. The first four match upstream libavb (AvbAlgorithmType) and
 * are recognized only so the verifier can reject them with a precise code. The
 * E1 profile defines its own id in libavb's vendor-reserved space.
 */
enum avb_algorithm_type {
    AVB_ALGORITHM_TYPE_NONE = 0,
    AVB_ALGORITHM_TYPE_SHA256_RSA2048 = 1,
    AVB_ALGORITHM_TYPE_SHA256_RSA4096 = 2,
    AVB_ALGORITHM_TYPE_SHA256_RSA8192 = 3,
    /* E1 Ed25519 profile: SHA-256(header||aux) signed with Ed25519. */
    AVB_ALGORITHM_TYPE_E1_SHA256_ED25519 = 0x4531ED25u
};

/* Auth-block field sizes for the E1 Ed25519 profile. */
#define AVB_E1_HASH_LEN       SHA256_DIGEST_LEN /* 32 */
#define AVB_E1_SIGNATURE_LEN  64u               /* Ed25519 sig */
#define AVB_E1_PUBKEY_LEN     32u               /* Ed25519 raw pubkey */

/* libavb descriptor tags (AvbDescriptorTag). */
enum avb_descriptor_tag {
    AVB_DESCRIPTOR_TAG_PROPERTY = 0,
    AVB_DESCRIPTOR_TAG_HASHTREE = 1,
    AVB_DESCRIPTOR_TAG_HASH = 2,
    AVB_DESCRIPTOR_TAG_KERNEL_CMDLINE = 3,
    AVB_DESCRIPTOR_TAG_CHAIN_PARTITION = 4
};

/* vbmeta header flags (AvbVBMetaImageFlags). */
#define AVB_VBMETA_FLAG_HASHTREE_DISABLED   0x1u
#define AVB_VBMETA_FLAG_VERIFICATION_DISABLED 0x2u

/* Upper bounds for a sane vbmeta image (defense against absurd sizes). */
#define AVB_MAX_VBMETA_SIZE        (1u << 20)   /* 1 MiB */
#define AVB_MAX_DESCRIPTOR_DIGEST  64u          /* SHA-512 worst case */
#define AVB_MAX_PARTITION_NAME     128u
#define AVB_MAX_SALT_LEN           64u

/*
 * Parsed vbmeta header (host order). Mirrors AvbVBMetaImageHeader byte-for-byte;
 * all multi-byte integers are big-endian on the wire (libavb convention) and
 * decoded here. The auth/aux offsets and sizes are validated against the
 * supplied image length before any field is dereferenced.
 */
struct avb_vbmeta_header {
    uint8_t  magic[AVB_MAGIC_LEN];                  /* 0x00 "AVB0" */
    uint32_t required_libavb_version_major;         /* 0x04 */
    uint32_t required_libavb_version_minor;         /* 0x08 */
    uint64_t authentication_data_block_size;        /* 0x0C */
    uint64_t auxiliary_data_block_size;             /* 0x14 */
    uint32_t algorithm_type;                        /* 0x1C */
    uint64_t hash_offset;                           /* 0x20 (in auth block) */
    uint64_t hash_size;                             /* 0x28 */
    uint64_t signature_offset;                      /* 0x30 (in auth block) */
    uint64_t signature_size;                        /* 0x38 */
    uint64_t public_key_offset;                     /* 0x40 (in aux block) */
    uint64_t public_key_size;                       /* 0x48 */
    uint64_t public_key_metadata_offset;            /* 0x50 (in aux block) */
    uint64_t public_key_metadata_size;              /* 0x58 */
    uint64_t descriptors_offset;                    /* 0x60 (in aux block) */
    uint64_t descriptors_size;                      /* 0x68 */
    uint64_t rollback_index;                        /* 0x70 */
    uint32_t flags;                                 /* 0x78 */
    uint32_t rollback_index_location;               /* 0x7C */
    uint8_t  release_string[AVB_RELEASE_STRING_LEN];/* 0x80 */
    /* 0xB0..0x100 padding, zero, covered by the auth hash. */
};

/*
 * Trust inputs the bootloader supplies. expected_pubkey_hash is SHA-256 of the
 * AVB key A public key, pinned by the OPNPHN01 stage that loaded this vbmeta
 * (the AVB analogue of next_stage_pubkey_hash). rollback_min is the OTP
 * rollback floor for this vbmeta's rollback_index_location (boot-image-format
 * §4 slot 2). parity_ok mirrors the OTP majority-read parity gate.
 */
struct avb_trust_inputs {
    uint8_t  expected_pubkey_hash[SHA256_DIGEST_LEN];
    uint64_t rollback_min;
    uint8_t  parity_ok;
};

/*
 * A hash descriptor verification target: the bootloader hands the verifier the
 * loaded partition image and the verifier confirms its digest matches the
 * descriptor. One per chained whole-partition image (boot, vendor_boot, dtbo,
 * recovery). The name is matched against the descriptor's partition_name.
 */
struct avb_hash_target {
    const char    *partition_name;  /* NUL-terminated; matched to descriptor */
    const uint8_t *image;           /* loaded partition bytes */
    size_t         image_len;
};

/*
 * Distinct error codes. Values are stable and usable as a halt-record reason.
 * AVB_OK is 0; every reject is a unique nonzero code.
 */
enum avb_result {
    AVB_OK = 0,
    AVB_ERR_TRUNCATED = 1,        /* image shorter than header / declared blocks */
    AVB_ERR_MAGIC = 2,            /* magic != "AVB0" */
    AVB_ERR_VERSION = 3,          /* required_libavb_version unsupported */
    AVB_ERR_ALGORITHM = 4,        /* not the E1 Ed25519 profile id */
    AVB_ERR_BLOCK_BOUNDS = 5,     /* auth/aux block sizes overflow the image */
    AVB_ERR_FIELD_BOUNDS = 6,     /* a sub-field offset+size leaves its block */
    AVB_ERR_HASH = 7,             /* SHA-256(header||aux) != stored hash */
    AVB_ERR_SIGNATURE = 8,        /* Ed25519 verify failed */
    AVB_ERR_PUBKEY_HASH = 9,      /* SHA-256(pubkey) != pinned expected hash */
    AVB_ERR_ROLLBACK = 10,        /* rollback_index < OTP floor */
    AVB_ERR_PARITY = 11,          /* OTP parity gate not satisfied */
    AVB_ERR_VERIFICATION_DISABLED = 12, /* flags disable verification: fail closed */
    AVB_ERR_DESCRIPTOR = 13,      /* a descriptor is malformed / out of bounds */
    AVB_ERR_HASH_DESCRIPTOR = 14, /* a hash-descriptor partition digest mismatched */
    AVB_ERR_HASHTREE_DESCRIPTOR = 15, /* hashtree root digest field malformed */
    AVB_ERR_CHAIN_DESCRIPTOR = 16,/* chain descriptor malformed */
    AVB_ERR_CHAIN_PIN = 17        /* chain descriptor pubkey != expected pin */
};

/*
 * Result of a verified vbmeta walk: views into the image for the fields a
 * caller needs to continue the chain. Pointers alias the caller's image buffer
 * and are valid only while it is. Populated only on AVB_OK.
 */
struct avb_chain_pin {
    char           partition_name[AVB_MAX_PARTITION_NAME];
    uint32_t       rollback_index_location;
    const uint8_t *public_key;      /* expected vbmeta pubkey of the chained partition */
    size_t         public_key_len;
};

#define AVB_MAX_CHAIN_PINS 8u

struct avb_verify_outcome {
    struct avb_vbmeta_header header;
    /* Chain-partition pins discovered while walking descriptors. The caller
       loads each chained vbmeta and re-runs the verifier with
       expected_pubkey_hash = SHA-256(public_key). */
    struct avb_chain_pin chain_pins[AVB_MAX_CHAIN_PINS];
    size_t   chain_pin_count;
    uint32_t hash_descriptor_count;
    uint32_t hashtree_descriptor_count;
    uint32_t property_descriptor_count;
};

/*
 * Decode and bounds-check the 256-byte vbmeta header from the wire image.
 * image[0..image_len) must hold at least the header. On success fills out and
 * returns AVB_OK; on a malformed header returns the matching error.
 */
enum avb_result avb_parse_header(const uint8_t *image, size_t image_len,
                                 struct avb_vbmeta_header *out);

/*
 * Full vbmeta verification against the supplied trust inputs.
 *
 * Order (fail-closed):
 *   1. OTP parity gate.
 *   2. parse + structural bounds (magic, version, block sizes, sub-fields).
 *   3. algorithm id is the E1 Ed25519 profile.
 *   4. flags do not disable verification.
 *   5. auth hash: SHA-256(header || auxiliary block) == stored hash.
 *   6. key pin: SHA-256(aux public key) == expected_pubkey_hash.
 *   7. signature: Ed25519(stored hash) under the aux public key.
 *   8. rollback: rollback_index >= rollback_min.
 *   9. descriptor walk: hash descriptors verified against hash_targets;
 *      hashtree descriptors validated for well-formedness; chain descriptors
 *      recorded as pins; properties counted.
 *
 * hash_targets/n_targets may be NULL/0; any hash descriptor with no matching
 * target is treated as a structural-only check (its fields are validated and
 * its digest length recorded, but no partition image is hashed). When a target
 * matches a hash descriptor by name, the partition digest MUST match or
 * verification fails AVB_ERR_HASH_DESCRIPTOR.
 *
 * On AVB_OK, *out (if non-NULL) holds the parsed header, the chain pins, and
 * descriptor counts.
 */
enum avb_result avb_verify(const uint8_t *image, size_t image_len,
                           const struct avb_trust_inputs *trust,
                           const struct avb_hash_target *hash_targets,
                           size_t n_targets,
                           struct avb_verify_outcome *out);

#endif /* E1_FW_AVB_AVB_VERIFY_H */
