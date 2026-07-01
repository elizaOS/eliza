/*
 * Freestanding Ed25519 deterministic key generation and signing (RFC 8032).
 *
 * The E1 DICE ladder needs to *produce* the DeviceID and per-boot Alias
 * keypairs from a CDI-derived seed and to sign the X.509 TBS bytes of the
 * Alias certificate. The mask-ROM verifier (fw/boot-rom/secure/ed25519_ct.h)
 * is verify-only, so the signing side lives here.
 *
 * Reference: derived from TweetNaCl v20140427 (Bernstein, van Gent, Lange,
 * Schwabe, Schwabe — https://tweetnacl.cr.yp.to/), which is public domain.
 * Only the key-generation, signing, and the SHA-512 it depends on are retained
 * and renamed. Ed25519 signing is deterministic by construction (the per-
 * signature nonce r = SHA-512(prefix || message)), so a fixed seed yields a
 * fixed keypair and fixed signatures — exactly the determinism the DICE chain
 * tests require.
 *
 * Freestanding: no malloc, no libc beyond memcpy/memset.
 */

#ifndef E1_DICE_ED25519_SIGN_H
#define E1_DICE_ED25519_SIGN_H

#include <stddef.h>
#include <stdint.h>

#define ED25519_SEED_LEN   32u
#define ED25519_PUBKEY_LEN 32u
#define ED25519_PRIVKEY_LEN 64u /* expanded secret: seed(32) || pubkey(32) */
#define ED25519_SIG_LEN    64u
#define ED25519_SHA512_LEN 64u

/*
 * Deterministically derive an Ed25519 keypair from a 32-byte seed.
 * pubkey[32] receives the public key; privkey[64] receives the expanded
 * secret key (seed || pubkey) used by ed25519_sign. Same seed => same keys.
 */
void ed25519_keypair_from_seed(uint8_t pubkey[ED25519_PUBKEY_LEN],
                               uint8_t privkey[ED25519_PRIVKEY_LEN],
                               const uint8_t seed[ED25519_SEED_LEN]);

/*
 * Produce a detached Ed25519 signature over msg[0..msg_len) under the expanded
 * secret key privkey[64]. Deterministic per RFC 8032.
 */
void ed25519_sign(uint8_t sig[ED25519_SIG_LEN],
                  const uint8_t *msg, size_t msg_len,
                  const uint8_t privkey[ED25519_PRIVKEY_LEN]);

/* SHA-512 (FIPS 180-4), exposed for the KAT harness. */
void ed25519_sha512(const uint8_t *in, size_t len,
                    uint8_t out[ED25519_SHA512_LEN]);

#endif /* E1_DICE_ED25519_SIGN_H */
