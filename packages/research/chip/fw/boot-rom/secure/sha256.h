/*
 * Freestanding SHA-256, FIPS 180-4.
 *
 * No libc dependency. Suitable for the E1 mask ROM and for host-side KAT
 * builds. All inputs are treated as opaque bytes; the implementation makes no
 * secret-dependent branches or memory accesses.
 */

#ifndef E1_BOOTROM_SECURE_SHA256_H
#define E1_BOOTROM_SECURE_SHA256_H

#include <stddef.h>
#include <stdint.h>

#define SHA256_DIGEST_LEN 32u
#define SHA256_BLOCK_LEN  64u

struct sha256_ctx {
    uint32_t state[8];
    uint64_t bitlen;
    uint8_t  buf[SHA256_BLOCK_LEN];
    size_t   buflen;
};

void sha256_init(struct sha256_ctx *ctx);
void sha256_update(struct sha256_ctx *ctx, const void *data, size_t len);
void sha256_final(struct sha256_ctx *ctx, uint8_t out[SHA256_DIGEST_LEN]);

/* One-shot convenience wrapper over init/update/final. */
void sha256(const void *data, size_t len, uint8_t out[SHA256_DIGEST_LEN]);

#endif /* E1_BOOTROM_SECURE_SHA256_H */
