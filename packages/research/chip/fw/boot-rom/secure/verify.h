/*
 * OPNPHN01 signed-image parser and verifier (mask-ROM secure boot).
 *
 * Implements docs/security/boot-image-format.md exactly:
 *   §2 container + 256-byte header layout
 *   §3 key ladder (SHA-256(pubkey) pinned to OTP root / next-stage hash)
 *   §4 anti-rollback
 *   §5 lifecycle gating
 *   §6 fail-closed halt behavior + 32-byte UART halt record
 *
 * Every failure path returns a distinct error code; the caller emits the halt
 * record and stops. There is no unsigned fallback and no bypass.
 */

#ifndef E1_BOOTROM_SECURE_VERIFY_H
#define E1_BOOTROM_SECURE_VERIFY_H

#include <stddef.h>
#include <stdint.h>

#include "sha256.h"

#define OPNPHN01_MAGIC0 'O'
#define OPNPHN01_HEADER_LEN  256u
#define OPNPHN01_SIG_LEN     96u
#define OPNPHN01_HEADER_VERSION 1u

/* image_type values (boot-image-format.md §2.1). */
enum opnphn01_image_type {
    OPNPHN01_TYPE_BOOTLOADER = 0,
    OPNPHN01_TYPE_RECOVERY = 1,
    OPNPHN01_TYPE_VBMETA = 2,
    OPNPHN01_TYPE_VENDOR_BOOT = 3
};

/* flags bits (boot-image-format.md §2.1). */
#define OPNPHN01_FLAG_ALLOW_DEV 0x1u
#define OPNPHN01_FLAG_ALLOW_MFG 0x2u

/* lifecycle one-hot codes (boot-image-format.md §5). */
enum opnphn01_lifecycle {
    OPNPHN01_LC_BLANK = 0x01u,
    OPNPHN01_LC_DEV = 0x02u,
    OPNPHN01_LC_MFG = 0x04u,
    OPNPHN01_LC_LOCKED = 0x08u,
    OPNPHN01_LC_RMA = 0x10u,
    OPNPHN01_LC_SCRAP = 0x20u
};

/*
 * Parsed header. Multi-byte fields are little-endian on the wire and are
 * decoded into host order here. Layout matches boot-image-format.md §2.1
 * byte-for-byte; opnphn01_parse_header() validates the wire image against this.
 */
struct opnphn01_header {
    uint8_t  magic[8];               /* 0x00: ASCII "OPNPHN01" */
    uint32_t header_version;         /* 0x08: =1 */
    uint32_t image_type;             /* 0x0C */
    uint64_t image_size;             /* 0x10: payload byte count */
    uint32_t rollback_index;         /* 0x18 */
    uint32_t rollback_slot;          /* 0x1C */
    uint32_t key_id;                 /* 0x20 */
    uint32_t flags;                  /* 0x24 */
    uint8_t  payload_sha256[32];     /* 0x28 */
    uint8_t  next_stage_pubkey_hash[32]; /* 0x48 */
    uint32_t min_lifecycle_state;    /* 0x68 */
    /* 0x6C: 148 reserved bytes, zero-filled, covered by the signature. */
};

/* Signature blob (boot-image-format.md §2.2). */
struct opnphn01_sig {
    uint8_t pubkey[32];    /* 0x00: Ed25519 public key */
    uint8_t signature[64]; /* 0x20: Ed25519 sig over (header || payload) */
};

/*
 * Security inputs the ROM reads from OTP (otp-fuse-map.md). The caller is
 * responsible for the 2-of-3 majority read and parity check before populating
 * this; a parity failure is reported as VERIFY_ERR_OTP_PARITY and never
 * reaches the verifier with stale data.
 */
struct opnphn01_otp {
    uint8_t  expected_pubkey_hash[32]; /* root_key_hash (stage 0) or pinned
                                          next_stage_pubkey_hash (later) */
    uint32_t rollback_min;             /* OTP.rollback[slot] (unary popcount) */
    uint8_t  revoked_key_bitmap;       /* otp-fuse-map.md bit per key_id */
    uint8_t  lifecycle_state;          /* one-hot, highest set bit reported */
    uint8_t  otp_parity_ok;            /* 0 => parity fault, fail closed */
};

/*
 * Distinct error codes. Ordering follows the boot-image-format.md §6 reject
 * list; values are stable and used as the halt-record reason field.
 */
enum verify_result {
    VERIFY_OK = 0,
    VERIFY_ERR_MAGIC = 1,
    VERIFY_ERR_HEADER_VERSION = 2,
    VERIFY_ERR_PAYLOAD_HASH = 3,
    VERIFY_ERR_SIGNATURE = 4,
    VERIFY_ERR_PUBKEY_HASH = 5,
    VERIFY_ERR_ROLLBACK = 6,
    VERIFY_ERR_KEY_REVOKED = 7,
    VERIFY_ERR_LIFECYCLE = 8,
    VERIFY_ERR_OTP_PARITY = 9,
    VERIFY_ERR_LIFECYCLE_SCRAP = 10,
    VERIFY_ERR_TRUNCATED = 11,    /* image shorter than header+payload+sig */
    VERIFY_ERR_KEY_ID_RANGE = 12  /* key_id outside the 8-slot bitmap */
};

/*
 * 32-byte UART halt record (boot-image-format.md §6). Emitted at 115200n8 on
 * any reject. Fixed little-endian layout so external tooling can decode it.
 */
#define HALT_RECORD_LEN 32u
#define HALT_RECORD_MAGIC0 'H'
#define HALT_RECORD_MAGIC1 'A'
#define HALT_RECORD_MAGIC2 'L'
#define HALT_RECORD_MAGIC3 'T'

struct halt_record {
    uint8_t  magic[4];      /* 0x00: "HALT" */
    uint32_t reason;        /* 0x04: enum verify_result */
    uint32_t image_type;    /* 0x08: header.image_type if parsed, else 0xffffffff */
    uint32_t key_id;        /* 0x0C: header.key_id if parsed, else 0xffffffff */
    uint32_t rollback_index;/* 0x10: header.rollback_index if parsed */
    uint32_t rollback_min;  /* 0x14: OTP rollback slot value */
    uint8_t  lifecycle;     /* 0x18: OTP lifecycle one-hot */
    uint8_t  reserved[7];   /* 0x19: zero */
};

/*
 * Decode and bounds-check the 256-byte header from the wire image.
 * image[0..image_len) must contain at least the header. On success fills out
 * and returns VERIFY_OK; on a malformed header returns the matching error.
 */
enum verify_result opnphn01_parse_header(const uint8_t *image, size_t image_len,
                                         struct opnphn01_header *out);

/*
 * Full verification of a complete OPNPHN01 container against OTP state.
 * Performs, in fail-closed order: lifecycle SCRAP halt, OTP parity, magic,
 * header_version, length bounds, payload SHA-256, key-ladder pubkey hash,
 * key revocation, Ed25519 signature over (header||payload), rollback floor,
 * and min_lifecycle_state.
 *
 * On VERIFY_OK, *payload_out points into image at the payload and
 * *payload_len_out is the payload length; *hdr_out holds the parsed header
 * (its next_stage_pubkey_hash pins the next stage's key).
 */
enum verify_result opnphn01_verify(const uint8_t *image, size_t image_len,
                                   const struct opnphn01_otp *otp,
                                   struct opnphn01_header *hdr_out,
                                   const uint8_t **payload_out,
                                   size_t *payload_len_out);

/* Serialize a halt record into a 32-byte buffer (little-endian). */
void halt_record_build(uint8_t out[HALT_RECORD_LEN], enum verify_result reason,
                       const struct opnphn01_header *hdr,
                       const struct opnphn01_otp *otp);

#endif /* E1_BOOTROM_SECURE_VERIFY_H */
