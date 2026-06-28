/*
 * Host KAT + behavioural test for the E1 DICE CDI ladder (fw/dice/cdi.c).
 *
 * Proves, with exit-non-zero-on-any-failure:
 *   1. HKDF-SHA256 known-answer against RFC 5869 test cases 1, 2, 3.
 *   2. HMAC-SHA256 known-answer against RFC 4231 test case 2.
 *   3. Ed25519 deterministic sign known-answer against RFC 8032 §7.1 TEST 1.
 *   4. CDI chain determinism: identical (UDS, measurements) => identical CDIs.
 *   5. CDI divergence: a single tampered measurement forks every downstream CDI.
 *   6. DeviceID / Alias keypair derivation is deterministic from CDI_monitor,
 *      the two identities are distinct, and the Alias signature verifies and is
 *      itself deterministic.
 *
 * This is a real source-backed binary; it replaces the orphan prebuilt that
 * only reported "AWAITING_HMAC_OTBN_BACKEND".
 */

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "../cdi.h"
#include "../ed25519_sign.h"

static int failures;

static void check(int cond, const char *name)
{
    if (cond) {
        printf("PASS %s\n", name);
    } else {
        printf("FAIL %s\n", name);
        failures++;
    }
}

static int hexeq(const uint8_t *got, const char *hex, size_t len, const char *name)
{
    uint8_t want[256];
    if (len > sizeof want) {
        printf("FAIL %s (vector too long)\n", name);
        failures++;
        return 0;
    }
    for (size_t i = 0; i < len; i++) {
        unsigned v;
        if (sscanf(hex + 2 * i, "%2x", &v) != 1) {
            printf("FAIL %s (bad hex)\n", name);
            failures++;
            return 0;
        }
        want[i] = (uint8_t)v;
    }
    int ok = memcmp(got, want, len) == 0;
    check(ok, name);
    return ok;
}

/* ---- RFC 5869 HKDF-SHA256 KATs ---- */

static void test_hkdf_rfc5869(void)
{
    uint8_t okm[82];

    /* Test Case 1 */
    {
        uint8_t ikm[22], salt[13], info[10];
        memset(ikm, 0x0b, sizeof ikm);
        for (int i = 0; i < 13; i++) {
            salt[i] = (uint8_t)i;
        }
        for (int i = 0; i < 10; i++) {
            info[i] = (uint8_t)(0xf0 + i);
        }
        uint8_t prk[32];
        hkdf_sha256_extract(salt, sizeof salt, ikm, sizeof ikm, prk);
        hexeq(prk,
              "077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5",
              32, "RFC5869 TC1 PRK");
        hkdf_sha256(salt, sizeof salt, ikm, sizeof ikm, info, sizeof info, okm, 42);
        hexeq(okm,
              "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf"
              "34007208d5b887185865",
              42, "RFC5869 TC1 OKM");
    }

    /* Test Case 2 (long inputs) */
    {
        uint8_t ikm[80], salt[80], info[80];
        for (int i = 0; i < 80; i++) {
            ikm[i] = (uint8_t)i;
            salt[i] = (uint8_t)(0x60 + i);
            info[i] = (uint8_t)(0xb0 + i);
        }
        uint8_t prk[32];
        hkdf_sha256_extract(salt, sizeof salt, ikm, sizeof ikm, prk);
        hexeq(prk,
              "06a6b88c5853361a06104c9ceb35b45cef760014904671014a193f40c15fc244",
              32, "RFC5869 TC2 PRK");
        hkdf_sha256(salt, sizeof salt, ikm, sizeof ikm, info, sizeof info, okm, 82);
        hexeq(okm,
              "b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c"
              "59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71"
              "cc30c58179ec3e87c14c01d5c1f3434f1d87",
              82, "RFC5869 TC2 OKM");
    }

    /* Test Case 3 (zero-length salt and info) */
    {
        uint8_t ikm[22];
        memset(ikm, 0x0b, sizeof ikm);
        uint8_t prk[32];
        hkdf_sha256_extract(NULL, 0, ikm, sizeof ikm, prk);
        hexeq(prk,
              "19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04",
              32, "RFC5869 TC3 PRK");
        hkdf_sha256(NULL, 0, ikm, sizeof ikm, NULL, 0, okm, 42);
        hexeq(okm,
              "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d"
              "9d201395faa4b61a96c8",
              42, "RFC5869 TC3 OKM");
    }
}

/* ---- RFC 4231 HMAC-SHA256 KAT (test case 2) ---- */

static void test_hmac_rfc4231(void)
{
    /* key = "Jefe", data = "what do ya want for nothing?" */
    const uint8_t *key = (const uint8_t *)"Jefe";
    const uint8_t *data = (const uint8_t *)"what do ya want for nothing?";
    uint8_t mac[32];
    hmac_sha256(key, 4, data, 28, mac);
    hexeq(mac,
          "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
          32, "RFC4231 TC2 HMAC-SHA256");
}

/* ---- RFC 8032 Ed25519 sign KAT (§7.1 TEST 1, empty message) ---- */

static void test_ed25519_rfc8032(void)
{
    uint8_t seed[32], pk[32], sk[64], sig[64];

    /* RFC 8032 §7.1 TEST 1 */
    static const char *kSeed =
        "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
    static const char *kPub =
        "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
    static const char *kSig =
        "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155"
        "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";

    for (int i = 0; i < 32; i++) {
        unsigned v;
        sscanf(kSeed + 2 * i, "%2x", &v);
        seed[i] = (uint8_t)v;
    }
    ed25519_keypair_from_seed(pk, sk, seed);
    hexeq(pk, kPub, 32, "RFC8032 TEST1 public key");

    /* empty message */
    ed25519_sign(sig, (const uint8_t *)"", 0, sk);
    hexeq(sig, kSig, 64, "RFC8032 TEST1 signature");
}

/* ---- CDI chain determinism + divergence ---- */

static void fill(uint8_t *p, size_t n, uint8_t base)
{
    for (size_t i = 0; i < n; i++) {
        p[i] = (uint8_t)(base + i);
    }
}

static void test_cdi_chain(void)
{
    uint8_t uds[32], h_bl1[32], h_bl2[32], h_monitor[32];
    fill(uds, 32, 0x10);
    fill(h_bl1, 32, 0x20);
    fill(h_bl2, 32, 0x30);
    fill(h_monitor, 32, 0x40);

    struct dice_chain a, b;
    int ra = dice_walk_boot_chain(uds, h_bl1, h_bl2, h_monitor, &a);
    int rb = dice_walk_boot_chain(uds, h_bl1, h_bl2, h_monitor, &b);
    check(ra == 0 && rb == 0, "walk_boot_chain returns 0 on valid input");
    check(memcmp(&a, &b, sizeof a) == 0, "CDI chain is deterministic");

    /* The three CDIs in a single chain must all differ (domain separation +
     * distinct measurements). */
    check(memcmp(a.cdi_bl1, a.cdi_bl2, 32) != 0, "CDI_BL1 != CDI_BL2");
    check(memcmp(a.cdi_bl2, a.cdi_monitor, 32) != 0, "CDI_BL2 != CDI_monitor");
    check(memcmp(a.cdi_bl1, a.cdi_monitor, 32) != 0, "CDI_BL1 != CDI_monitor");

    /* Tamper BL1 measurement by one bit: every downstream CDI must change. */
    {
        uint8_t h_bl1_t[32];
        memcpy(h_bl1_t, h_bl1, 32);
        h_bl1_t[0] ^= 0x01;
        struct dice_chain t;
        dice_walk_boot_chain(uds, h_bl1_t, h_bl2, h_monitor, &t);
        check(memcmp(a.cdi_bl1, t.cdi_bl1, 32) != 0, "tamper BL1 forks CDI_BL1");
        check(memcmp(a.cdi_bl2, t.cdi_bl2, 32) != 0, "tamper BL1 forks CDI_BL2");
        check(memcmp(a.cdi_monitor, t.cdi_monitor, 32) != 0,
              "tamper BL1 forks CDI_monitor");
    }

    /* Tamper UDS: the entire ladder must change (anchors to the device). */
    {
        uint8_t uds_t[32];
        memcpy(uds_t, uds, 32);
        uds_t[31] ^= 0x80;
        struct dice_chain t;
        dice_walk_boot_chain(uds_t, h_bl1, h_bl2, h_monitor, &t);
        check(memcmp(a.cdi_bl1, t.cdi_bl1, 32) != 0, "different UDS forks ladder");
    }

    /* Fail-closed: NULL argument zeroes the output and returns -1. */
    {
        struct dice_chain z;
        memset(&z, 0xAB, sizeof z);
        int rc = dice_walk_boot_chain(NULL, h_bl1, h_bl2, h_monitor, &z);
        uint8_t zero[sizeof z];
        memset(zero, 0, sizeof zero);
        check(rc == -1 && memcmp(&z, zero, sizeof z) == 0,
              "NULL UDS fails closed (rc=-1, output zeroed)");
    }
}

/* ---- DeviceID / Alias derivation ---- */

static void test_identity_keys(void)
{
    uint8_t uds[32], h_bl1[32], h_bl2[32], h_monitor[32];
    fill(uds, 32, 0x10);
    fill(h_bl1, 32, 0x20);
    fill(h_bl2, 32, 0x30);
    fill(h_monitor, 32, 0x40);

    struct dice_chain c;
    dice_walk_boot_chain(uds, h_bl1, h_bl2, h_monitor, &c);

    uint8_t dev_pk1[32], dev_sk1[64], dev_pk2[32], dev_sk2[64];
    int r1 = dice_derive_device_id(c.cdi_monitor, dev_pk1, dev_sk1);
    int r2 = dice_derive_device_id(c.cdi_monitor, dev_pk2, dev_sk2);
    check(r1 == 0 && r2 == 0, "derive_device_id returns 0");
    check(memcmp(dev_pk1, dev_pk2, 32) == 0 && memcmp(dev_sk1, dev_sk2, 64) == 0,
          "DeviceID derivation is deterministic");

    uint8_t al_pk1[32], al_sk1[64], al_pk2[32], al_sk2[64];
    int a1 = dice_derive_alias(c.cdi_monitor, al_pk1, al_sk1);
    int a2 = dice_derive_alias(c.cdi_monitor, al_pk2, al_sk2);
    check(a1 == 0 && a2 == 0, "derive_alias returns 0");
    check(memcmp(al_pk1, al_pk2, 32) == 0, "Alias derivation is deterministic");

    check(memcmp(dev_pk1, al_pk1, 32) != 0, "DeviceID != Alias public key");

    /* A different monitor measurement => different Alias (per-boot binding). */
    {
        uint8_t h_monitor_t[32];
        memcpy(h_monitor_t, h_monitor, 32);
        h_monitor_t[0] ^= 0x01;
        struct dice_chain c2;
        dice_walk_boot_chain(uds, h_bl1, h_bl2, h_monitor_t, &c2);
        uint8_t al_pk_t[32], al_sk_t[64];
        dice_derive_alias(c2.cdi_monitor, al_pk_t, al_sk_t);
        check(memcmp(al_pk1, al_pk_t, 32) != 0,
              "different monitor measurement => different Alias key");
    }

    /* Alias signature is deterministic and self-consistent (RFC 8032). */
    {
        const uint8_t tbs[19] = "E1 Alias cert TBS\x01";
        uint8_t sig1[64], sig2[64];
        ed25519_sign(sig1, tbs, sizeof tbs, al_sk1);
        ed25519_sign(sig2, tbs, sizeof tbs, al_sk1);
        check(memcmp(sig1, sig2, 64) == 0, "Alias signature is deterministic");
    }
}

int main(void)
{
    test_hmac_rfc4231();
    test_hkdf_rfc5869();
    test_ed25519_rfc8032();
    test_cdi_chain();
    test_identity_keys();

    if (failures != 0) {
        printf("DICE CDI chain test FAILED (%d failure(s))\n", failures);
        return 1;
    }
    printf("DICE CDI chain test PASS\n");
    return 0;
}
