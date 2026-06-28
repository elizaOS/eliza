/*
 * E1 DICE CDI ladder implementation. See cdi.h for the contract.
 *
 * HMAC-SHA256 (FIPS 198-1) and HKDF-SHA256 (RFC 5869) are built on the
 * freestanding SHA-256 shared with the mask ROM (fw/boot-rom/secure/sha256.c).
 * Ed25519 keypair derivation uses the freestanding signer (ed25519_sign.c).
 */

#include "cdi.h"

#include "../boot-rom/secure/sha256.h"

static void dice_memcpy(uint8_t *dst, const uint8_t *src, size_t n)
{
    for (size_t i = 0; i < n; i++) {
        dst[i] = src[i];
    }
}

static void dice_memset(uint8_t *dst, uint8_t v, size_t n)
{
    for (size_t i = 0; i < n; i++) {
        dst[i] = v;
    }
}

static size_t dice_strlen(const char *s)
{
    size_t n = 0;
    while (s[n] != '\0') {
        n++;
    }
    return n;
}

/* ---- HMAC-SHA256 (FIPS 198-1) ---- */

void hmac_sha256(const uint8_t *key, size_t key_len,
                 const uint8_t *msg, size_t msg_len,
                 uint8_t out[HMAC_SHA256_LEN])
{
    uint8_t k0[SHA256_BLOCK_LEN];
    uint8_t ipad[SHA256_BLOCK_LEN];
    uint8_t opad[SHA256_BLOCK_LEN];
    uint8_t inner[SHA256_DIGEST_LEN];
    struct sha256_ctx ctx;

    /* K0: keys longer than the block are hashed; shorter keys are zero-padded. */
    dice_memset(k0, 0, sizeof k0);
    if (key_len > SHA256_BLOCK_LEN) {
        sha256(key, key_len, k0);
    } else {
        dice_memcpy(k0, key, key_len);
    }

    for (unsigned i = 0; i < SHA256_BLOCK_LEN; i++) {
        ipad[i] = k0[i] ^ 0x36u;
        opad[i] = k0[i] ^ 0x5cu;
    }

    sha256_init(&ctx);
    sha256_update(&ctx, ipad, sizeof ipad);
    sha256_update(&ctx, msg, msg_len);
    sha256_final(&ctx, inner);

    sha256_init(&ctx);
    sha256_update(&ctx, opad, sizeof opad);
    sha256_update(&ctx, inner, sizeof inner);
    sha256_final(&ctx, out);

    dice_memset(k0, 0, sizeof k0);
    dice_memset(ipad, 0, sizeof ipad);
    dice_memset(opad, 0, sizeof opad);
    dice_memset(inner, 0, sizeof inner);
}

/* ---- HKDF-SHA256 (RFC 5869) ---- */

void hkdf_sha256_extract(const uint8_t *salt, size_t salt_len,
                         const uint8_t *ikm, size_t ikm_len,
                         uint8_t prk[HMAC_SHA256_LEN])
{
    /* RFC 5869: salt absent -> a string of HashLen zeros. */
    uint8_t zero[HMAC_SHA256_LEN];
    if (salt == NULL || salt_len == 0) {
        dice_memset(zero, 0, sizeof zero);
        salt = zero;
        salt_len = sizeof zero;
    }
    hmac_sha256(salt, salt_len, ikm, ikm_len, prk);
}

int hkdf_sha256_expand(const uint8_t prk[HMAC_SHA256_LEN],
                       const uint8_t *info, size_t info_len,
                       uint8_t *okm, size_t okm_len)
{
    uint8_t t[HMAC_SHA256_LEN];
    size_t t_len = 0;
    size_t done = 0;
    uint8_t counter = 0;

    if (okm_len > 255u * HMAC_SHA256_LEN) {
        return -1;
    }

    while (done < okm_len) {
        struct sha256_ctx ctx; /* HMAC built inline to stream T(i-1)||info||i */
        uint8_t k0[SHA256_BLOCK_LEN];
        uint8_t ipad[SHA256_BLOCK_LEN];
        uint8_t opad[SHA256_BLOCK_LEN];
        uint8_t inner[SHA256_DIGEST_LEN];

        counter++;

        dice_memset(k0, 0, sizeof k0);
        dice_memcpy(k0, prk, HMAC_SHA256_LEN); /* PRK is exactly HashLen */
        for (unsigned i = 0; i < SHA256_BLOCK_LEN; i++) {
            ipad[i] = k0[i] ^ 0x36u;
            opad[i] = k0[i] ^ 0x5cu;
        }

        sha256_init(&ctx);
        sha256_update(&ctx, ipad, sizeof ipad);
        if (t_len != 0) {
            sha256_update(&ctx, t, t_len);
        }
        if (info != NULL && info_len != 0) {
            sha256_update(&ctx, info, info_len);
        }
        sha256_update(&ctx, &counter, 1);
        sha256_final(&ctx, inner);

        sha256_init(&ctx);
        sha256_update(&ctx, opad, sizeof opad);
        sha256_update(&ctx, inner, sizeof inner);
        sha256_final(&ctx, t);
        t_len = HMAC_SHA256_LEN;

        {
            size_t take = okm_len - done;
            if (take > HMAC_SHA256_LEN) {
                take = HMAC_SHA256_LEN;
            }
            dice_memcpy(okm + done, t, take);
            done += take;
        }

        dice_memset(k0, 0, sizeof k0);
        dice_memset(ipad, 0, sizeof ipad);
        dice_memset(opad, 0, sizeof opad);
        dice_memset(inner, 0, sizeof inner);
    }

    dice_memset(t, 0, sizeof t);
    return 0;
}

int hkdf_sha256(const uint8_t *salt, size_t salt_len,
                const uint8_t *ikm, size_t ikm_len,
                const uint8_t *info, size_t info_len,
                uint8_t *okm, size_t okm_len)
{
    uint8_t prk[HMAC_SHA256_LEN];
    int rc;
    hkdf_sha256_extract(salt, salt_len, ikm, ikm_len, prk);
    rc = hkdf_sha256_expand(prk, info, info_len, okm, okm_len);
    dice_memset(prk, 0, sizeof prk);
    return rc;
}

/* ---- CDI ladder ---- */

static const char *dice_layer_info(enum dice_layer layer)
{
    switch (layer) {
    case DICE_LAYER0:
        return "E1-DICE-CDI-L0/BL1";
    case DICE_LAYER_BL2:
        return "E1-DICE-CDI-BL2";
    case DICE_LAYER_MONITOR:
        return "E1-DICE-CDI-MONITOR";
    default:
        return NULL;
    }
}

int dice_derive_cdi(const uint8_t prev[DICE_CDI_LEN],
                    const uint8_t measurement[DICE_MEASUREMENT_LEN],
                    enum dice_layer layer,
                    uint8_t next[DICE_CDI_LEN])
{
    const char *info;

    if (next == NULL) {
        return -1;
    }
    /* Fail closed: any malformed call must not leave a usable CDI behind. */
    dice_memset(next, 0, DICE_CDI_LEN);

    info = dice_layer_info(layer);
    if (prev == NULL || measurement == NULL || info == NULL) {
        return -1;
    }

    /* CDI_next = HKDF(ikm=prev, salt=measurement, info=layer-domain). The
     * measurement-as-salt placement is what forks the ladder on tamper. */
    return hkdf_sha256(measurement, DICE_MEASUREMENT_LEN,
                       prev, DICE_CDI_LEN,
                       (const uint8_t *)info, dice_strlen(info),
                       next, DICE_CDI_LEN);
}

int dice_walk_boot_chain(const uint8_t uds[DICE_UDS_LEN],
                         const uint8_t h_bl1[DICE_MEASUREMENT_LEN],
                         const uint8_t h_bl2[DICE_MEASUREMENT_LEN],
                         const uint8_t h_monitor[DICE_MEASUREMENT_LEN],
                         struct dice_chain *out)
{
    if (out == NULL) {
        return -1;
    }
    dice_memset((uint8_t *)out, 0, sizeof *out);

    if (uds == NULL || h_bl1 == NULL || h_bl2 == NULL || h_monitor == NULL) {
        return -1;
    }

    if (dice_derive_cdi(uds, h_bl1, DICE_LAYER0, out->cdi_bl1) != 0) {
        goto fail;
    }
    if (dice_derive_cdi(out->cdi_bl1, h_bl2, DICE_LAYER_BL2, out->cdi_bl2) != 0) {
        goto fail;
    }
    if (dice_derive_cdi(out->cdi_bl2, h_monitor, DICE_LAYER_MONITOR,
                        out->cdi_monitor) != 0) {
        goto fail;
    }
    return 0;

fail:
    dice_memset((uint8_t *)out, 0, sizeof *out);
    return -1;
}

/* ---- Identity keys ---- */

int dice_derive_key_seed(const uint8_t cdi[DICE_CDI_LEN],
                         const char *label,
                         uint8_t seed[ED25519_SEED_LEN])
{
    if (cdi == NULL || label == NULL || seed == NULL) {
        if (seed != NULL) {
            dice_memset(seed, 0, ED25519_SEED_LEN);
        }
        return -1;
    }
    return hkdf_sha256(NULL, 0,
                       cdi, DICE_CDI_LEN,
                       (const uint8_t *)label, dice_strlen(label),
                       seed, ED25519_SEED_LEN);
}

static int dice_derive_keypair(const uint8_t cdi[DICE_CDI_LEN],
                               const char *label,
                               uint8_t pubkey[ED25519_PUBKEY_LEN],
                               uint8_t privkey[ED25519_PRIVKEY_LEN])
{
    uint8_t seed[ED25519_SEED_LEN];

    if (cdi == NULL || pubkey == NULL || privkey == NULL) {
        if (pubkey != NULL) {
            dice_memset(pubkey, 0, ED25519_PUBKEY_LEN);
        }
        if (privkey != NULL) {
            dice_memset(privkey, 0, ED25519_PRIVKEY_LEN);
        }
        return -1;
    }

    if (dice_derive_key_seed(cdi, label, seed) != 0) {
        dice_memset(pubkey, 0, ED25519_PUBKEY_LEN);
        dice_memset(privkey, 0, ED25519_PRIVKEY_LEN);
        return -1;
    }

    ed25519_keypair_from_seed(pubkey, privkey, seed);
    dice_memset(seed, 0, sizeof seed);
    return 0;
}

int dice_derive_device_id(const uint8_t cdi_monitor[DICE_CDI_LEN],
                          uint8_t pubkey[ED25519_PUBKEY_LEN],
                          uint8_t privkey[ED25519_PRIVKEY_LEN])
{
    return dice_derive_keypair(cdi_monitor, "E1-DICE-DeviceID-Ed25519",
                               pubkey, privkey);
}

int dice_derive_alias(const uint8_t cdi_monitor[DICE_CDI_LEN],
                      uint8_t pubkey[ED25519_PUBKEY_LEN],
                      uint8_t privkey[ED25519_PRIVKEY_LEN])
{
    return dice_derive_keypair(cdi_monitor, "E1-DICE-Alias-Ed25519",
                               pubkey, privkey);
}
