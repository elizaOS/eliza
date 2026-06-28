/*
 * Constant-time Ed25519 signature verification (RFC 8032 Ed25519), with the
 * required SHA-512 included.
 *
 * Reference: derived from TweetNaCl v20140427 (Bernstein, van Gent, Lange,
 * Schwabe, Schwabe — https://tweetnacl.cr.yp.to/), which is public domain.
 * Only the verify path (crypto_sign_open) and its dependencies are retained
 * and renamed; scalar arithmetic on secret data is not present in a verify-
 * only build, and the field/group arithmetic that is present is the constant-
 * time fixed-window ladder of the original. The SHA-512 here is the TweetNaCl
 * crypto_hash (FIPS 180-4 SHA-512).
 *
 * Freestanding: no malloc, no libc beyond the memcpy/memset provided locally.
 */

#ifndef E1_BOOTROM_SECURE_ED25519_CT_H
#define E1_BOOTROM_SECURE_ED25519_CT_H

#include <stddef.h>
#include <stdint.h>

#define ED25519_PUBKEY_LEN 32u
#define ED25519_SIG_LEN    64u
#define SHA512_DIGEST_LEN  64u

/*
 * Verify an Ed25519 signature over msg[0..msg_len).
 * Returns 1 if the signature is valid, 0 otherwise. Never aborts; the result
 * is a clean accept/reject for fail-closed callers.
 */
int ed25519_verify(const uint8_t signature[ED25519_SIG_LEN],
                   const uint8_t public_key[ED25519_PUBKEY_LEN],
                   const uint8_t *msg, size_t msg_len);

/* SHA-512 (FIPS 180-4), exposed for the verifier and KAT harness. */
void sha512(const uint8_t *in, size_t len, uint8_t out[SHA512_DIGEST_LEN]);

#endif /* E1_BOOTROM_SECURE_ED25519_CT_H */
