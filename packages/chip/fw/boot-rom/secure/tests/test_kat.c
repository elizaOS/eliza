/*
 * Host KAT harness for the E1 secure-boot crypto and OPNPHN01 verifier.
 *
 * Covers:
 *   - SHA-256 NIST known-answer vectors (FIPS 180-4 examples + NESSIE/long).
 *   - RFC 8032 Ed25519 TEST 1-4 vectors, plus a tampered signature that MUST
 *     be rejected.
 *   - OPNPHN01 positive image (accepted) and negative images (tampered payload,
 *     wrong key, rollback downgrade, bad magic, revoked key_id) — each must be
 *     rejected with the exact verify_result code.
 *
 * Built and run with host gcc by run_tests.sh. Exits non-zero on any failure.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "sha256.h"
#include "ed25519_ct.h"
#include "verify.h"
#include "measure.h"
#include "expected.h"

static int g_failures = 0;

static int hexnib(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static size_t unhex(const char *h, uint8_t *out, size_t cap)
{
    size_t n = 0;
    while (h[0] && h[1] && n < cap) {
        int hi = hexnib(h[0]), lo = hexnib(h[1]);
        if (hi < 0 || lo < 0) break;
        out[n++] = (uint8_t)((hi << 4) | lo);
        h += 2;
    }
    return n;
}

static void check(const char *name, int ok)
{
    if (ok) {
        printf("  PASS %s\n", name);
    } else {
        printf("  FAIL %s\n", name);
        g_failures++;
    }
}

/* ---- SHA-256 NIST KATs ---- */

struct sha256_kat {
    const char *msg;
    size_t msg_len;
    const char *digest_hex;
    int repeat; /* if >1, message is repeated this many times */
};

static void test_sha256(void)
{
    printf("SHA-256 NIST KAT:\n");
    static const struct sha256_kat kats[] = {
        {"", 0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", 1},
        {"abc", 3, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", 1},
        {"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", 56,
         "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1", 1},
        /* 1,000,000 'a' (FIPS 180-4 long-message example). */
        {"a", 1, "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0", 1000000},
    };

    for (size_t i = 0; i < sizeof(kats) / sizeof(kats[0]); i++) {
        uint8_t want[32], got[32];
        unhex(kats[i].digest_hex, want, sizeof(want));
        struct sha256_ctx ctx;
        sha256_init(&ctx);
        for (int r = 0; r < kats[i].repeat; r++) {
            sha256_update(&ctx, kats[i].msg, kats[i].msg_len);
        }
        sha256_final(&ctx, got);
        char nm[64];
        snprintf(nm, sizeof(nm), "sha256 vector %zu", i);
        check(nm, memcmp(want, got, 32) == 0);
    }
}

/* ---- RFC 8032 Ed25519 vectors ---- */

struct ed_vec {
    const char *sk_pk; /* 64-byte: secret(32)||public(32); we use public only */
    const char *pk;
    const char *msg;   /* hex, may be empty */
    const char *sig;
};

static void test_ed25519(void)
{
    printf("RFC 8032 Ed25519 KAT:\n");
    /* TEST 1-4 from RFC 8032 §7.1. */
    static const struct ed_vec vecs[] = {
        {NULL,
         "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
         "",
         "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"},
        {NULL,
         "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
         "72",
         "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"},
        {NULL,
         "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
         "af82",
         "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a"},
        {NULL,
         "278117fc144c72340f67d0f2316e8386ceffbf2b2428c9c51fef7c597f1d426e",
         "08b8b2b733424243760fe426a4b54908632110a66c2f6591eabd3345e3e4eb98"
         "fa6e264bf09efe12ee50f8f54e9f77b1e355f6c50544e23fb1433ddf73be84d8"
         "79de7c0046dc4996d9e773f4bc9efe5738829adb26c81b37c93a1b270b20329d"
         "658675fc6ea534e0810a4432826bf58c941efb65d57a338bbd2e26640f89ffbc"
         "1a858efcb8550ee3a5e1998bd177e93a7363c344fe6b199ee5d02e82d522c4fe"
         "ba15452f80288a821a579116ec6dad2b3b310da903401aa62100ab5d1a36553e"
         "06203b33890cc9b832f79ef80560ccb9a39ce767967ed628c6ad573cb116dbef"
         "efd75499da96bd68a8a97b928a8bbc103b6621fcde2beca1231d206be6cd9ec7"
         "aff6f6c94fcd7204ed3455c68c83f4a41da4af2b74ef5c53f1d8ac70bdcb7ed1"
         "85ce81bd84359d44254d95629e9855a94a7c1958d1f8ada5d0532ed8a5aa3fb2"
         "d17ba70eb6248e594e1a2297acbbb39d502f1a8c6eb6f1ce22b3de1a1f40cc24"
         "554119a831a9aad6079cad88425de6bde1a9187ebb6092cf67bf2b13fd65f270"
         "88d78b7e883c8759d2c4f5c65adb7553878ad575f9fad878e80a0c9ba63bcbcc"
         "2732e69485bbc9c90bfbd62481d9089beccf80cfe2df16a2cf65bd92dd597b07"
         "07e0917af48bbb75fed413d238f5555a7a569d80c3414a8d0859dc65a46128ba"
         "b27af87a71314f318c782b23ebfe808b82b0ce26401d2e22f04d83d1255dc51a"
         "ddd3b75a2b1ae0784504df543af8969be3ea7082ff7fc9888c144da2af58429e"
         "c96031dbcad3dad9af0dcbaaaf268cb8fcffead94f3c7ca495e056a9b47acdb7"
         "51fb73e666c6c655ade8297297d07ad1ba5e43f1bca32301651339e22904cc8c"
         "42f58c30c04aafdb038dda0847dd988dcda6f3bfd15c4b4c4525004aa06eeff8"
         "ca61783aacec57fb3d1f92b0fe2fd1a85f6724517b65e614ad6808d6f6ee34df"
         "f7310fdc82aebfd904b01e1dc54b2927094b2db68d6f903b68401adebf5a7e08"
         "d78ff4ef5d63653a65040cf9bfd4aca7984a74d37145986780fc0b16ac451649"
         "de6188a7dbdf191f64b5fc5e2ab47b57f7f7276cd419c17a3ca8e1b939ae49e4"
         "88acba6b965610b5480109c8b17b80e1b7b750dfc7598d5d5011fd2dcc5600a3"
         "2ef5b52a1ecc820e308aa342721aac0943bf6686b64b2579376504ccc493d97e"
         "6aed3fb0f9cd71a43dd497f01f17c0e2cb3797aa2a2f256656168e6c496afc5f"
         "b93246f6b1116398a346f1a641f3b041e989f7914f90cc2c7fff357876e506b5"
         "0d334ba77c225bc307ba537152f3f1610e4eafe595f6d9d90d11faa933a15ef1"
         "369546868a7f3a45a96768d40fd9d03412c091c6315cf4fde7cb68606937380d"
         "b2eaaa707b4c4185c32eddcdd306705e4dc1ffc872eeee475a64dfac86aba41c"
         "0618983f8741c5ef68d3a101e8a3b8cac60c905c15fc910840b94c00a0b9d0",
         "0aab4c900501b3e24d7cdf4663326a3a87df5e4843b2cbdb67cbf6e460fec350"
         "aa5371b1508f9f4528ecea23c436d94b5e8fcd4f681e30a6ac00a9704a188a03"}};

    for (size_t i = 0; i < sizeof(vecs) / sizeof(vecs[0]); i++) {
        uint8_t pk[32], sig[64];
        uint8_t msg[2048];
        unhex(vecs[i].pk, pk, sizeof(pk));
        unhex(vecs[i].sig, sig, sizeof(sig));
        size_t mlen = unhex(vecs[i].msg, msg, sizeof(msg));

        int r = ed25519_verify(sig, pk, msg, mlen);
        char nm[64];
        snprintf(nm, sizeof(nm), "ed25519 TEST %zu accepts valid sig", i + 1);
        check(nm, r == 1);

        /* Tampered: flip one bit of the signature S; must be rejected. */
        uint8_t bad_sig[64];
        memcpy(bad_sig, sig, 64);
        bad_sig[40] ^= 0x01;
        snprintf(nm, sizeof(nm), "ed25519 TEST %zu rejects tampered sig", i + 1);
        check(nm, ed25519_verify(bad_sig, pk, msg, mlen) == 0);
    }

    /* Tampered message on TEST 2 must be rejected. */
    {
        uint8_t pk[32], sig[64], msg[8];
        unhex(vecs[1].pk, pk, sizeof(pk));
        unhex(vecs[1].sig, sig, sizeof(sig));
        size_t mlen = unhex(vecs[1].msg, msg, sizeof(msg));
        msg[0] ^= 0xff;
        check("ed25519 rejects tampered message", ed25519_verify(sig, pk, msg, mlen) == 0);
    }
}

/* ---- OPNPHN01 image tests ---- */

static uint8_t *read_file(const char *path, size_t *len_out)
{
    FILE *f = fopen(path, "rb");
    if (!f) {
        fprintf(stderr, "  cannot open %s\n", path);
        return NULL;
    }
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz < 0) {
        fclose(f);
        return NULL;
    }
    uint8_t *buf = malloc((size_t)sz);
    if (buf && fread(buf, 1, (size_t)sz, f) != (size_t)sz) {
        free(buf);
        buf = NULL;
    }
    fclose(f);
    *len_out = (size_t)sz;
    return buf;
}

static void base_otp(struct opnphn01_otp *otp)
{
    memcpy(otp->expected_pubkey_hash, TEST_ROOT_KEY_HASH, 32);
    otp->rollback_min = TEST_OTP_ROLLBACK_MIN;
    otp->revoked_key_bitmap = TEST_OTP_REVOKED_BITMAP;
    otp->lifecycle_state = TEST_OTP_LIFECYCLE;
    otp->otp_parity_ok = 1;
}

static enum verify_result verify_file(const char *dir, const char *name,
                                      const struct opnphn01_otp *otp)
{
    char path[512];
    snprintf(path, sizeof(path), "%s/%s", dir, name);
    size_t len = 0;
    uint8_t *buf = read_file(path, &len);
    if (!buf) {
        return (enum verify_result)-1;
    }
    struct opnphn01_header hdr;
    const uint8_t *payload = NULL;
    size_t payload_len = 0;
    enum verify_result rc = opnphn01_verify(buf, len, otp, &hdr, &payload, &payload_len);
    free(buf);
    return rc;
}

static void test_images(const char *dir)
{
    printf("OPNPHN01 image KAT:\n");
    struct opnphn01_otp otp;

    base_otp(&otp);
    check("good.bin accepted", verify_file(dir, "good.bin", &otp) == VERIFY_OK);

    base_otp(&otp);
    check("bad_payload.bin -> PAYLOAD_HASH",
          verify_file(dir, "bad_payload.bin", &otp) == VERIFY_ERR_PAYLOAD_HASH);

    base_otp(&otp);
    check("wrong_key.bin -> PUBKEY_HASH",
          verify_file(dir, "wrong_key.bin", &otp) == VERIFY_ERR_PUBKEY_HASH);

    base_otp(&otp);
    check("bad_rollback.bin -> ROLLBACK",
          verify_file(dir, "bad_rollback.bin", &otp) == VERIFY_ERR_ROLLBACK);

    base_otp(&otp);
    check("bad_magic.bin -> MAGIC",
          verify_file(dir, "bad_magic.bin", &otp) == VERIFY_ERR_MAGIC);

    /* revoked.bin is validly signed but uses key_id=3; revoke that slot. */
    base_otp(&otp);
    otp.revoked_key_bitmap = TEST_REVOKED_BITMAP_WITH_KEY3;
    check("revoked.bin -> KEY_REVOKED",
          verify_file(dir, "revoked.bin", &otp) == VERIFY_ERR_KEY_REVOKED);

    /* SCRAP lifecycle halts before parse even on a good image. */
    base_otp(&otp);
    otp.lifecycle_state = OPNPHN01_LC_SCRAP;
    check("good.bin on SCRAP -> LIFECYCLE_SCRAP",
          verify_file(dir, "good.bin", &otp) == VERIFY_ERR_LIFECYCLE_SCRAP);

    /* OTP parity fault halts before parse. */
    base_otp(&otp);
    otp.otp_parity_ok = 0;
    check("good.bin with parity fault -> OTP_PARITY",
          verify_file(dir, "good.bin", &otp) == VERIFY_ERR_OTP_PARITY);

    /* Lifecycle below the image minimum is rejected. */
    base_otp(&otp);
    otp.lifecycle_state = OPNPHN01_LC_DEV; /* good.bin requires LOCKED */
    check("good.bin on DEV (< min_lifecycle) -> LIFECYCLE",
          verify_file(dir, "good.bin", &otp) == VERIFY_ERR_LIFECYCLE);
}

/* ---- Measurement chain (W3) ---- */

static void test_measure(void)
{
    printf("Boot measurement chain:\n");
    struct boot_measure m;
    uint8_t z[32] = {0};
    uint8_t stage1[32], stage2[32], reg[32], expect[32];

    for (int i = 0; i < 32; i++) {
        stage1[i] = (uint8_t)i;
        stage2[i] = (uint8_t)(0x40 + i);
    }

    boot_measure_init(&m);
    check("init register is zero", memcmp(m.reg, z, 32) == 0);

    /* Independent recompute: reg1 = SHA256(0^32 || stage1). */
    {
        struct sha256_ctx c;
        sha256_init(&c);
        sha256_update(&c, z, 32);
        sha256_update(&c, stage1, 32);
        sha256_final(&c, expect);
    }
    keymgr_advance(&m, KEYMGR_STAGE_CREATOR, stage1);
    boot_measure_export(&m, reg);
    check("extend stage1 matches SHA256(0||h1)", memcmp(reg, expect, 32) == 0);
    check("stage advanced to CREATOR", m.stage == KEYMGR_STAGE_CREATOR);

    /* reg2 = SHA256(reg1 || stage2). */
    {
        struct sha256_ctx c;
        sha256_init(&c);
        sha256_update(&c, reg, 32);
        sha256_update(&c, stage2, 32);
        sha256_final(&c, expect);
    }
    keymgr_advance(&m, KEYMGR_STAGE_OWNER_INTERMEDIATE, stage2);
    boot_measure_export(&m, reg);
    check("extend stage2 matches SHA256(reg1||h2)", memcmp(reg, expect, 32) == 0);

    /* A skip (RESET -> OWNER) is rejected and leaves the chain unchanged. */
    {
        struct boot_measure m2;
        boot_measure_init(&m2);
        enum keymgr_stage rej = keymgr_advance(&m2, KEYMGR_STAGE_OWNER, stage1);
        check("skipping ladder stages is rejected", rej == KEYMGR_STAGE_RESET);
        check("rejected skip leaves register zero", memcmp(m2.reg, z, 32) == 0);
    }
}

int main(int argc, char **argv)
{
    const char *img_dir = (argc > 1) ? argv[1] : ".";
    test_sha256();
    test_ed25519();
    test_measure();
    test_images(img_dir);

    if (g_failures != 0) {
        printf("\nKAT FAILED: %d check(s) failed.\n", g_failures);
        return 1;
    }
    printf("\nKAT PASSED: all checks green.\n");
    return 0;
}
