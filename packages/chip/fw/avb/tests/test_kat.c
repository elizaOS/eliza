/*
 * Host KAT + negative harness for the E1 AVB vbmeta verifier.
 *
 * Covers:
 *   - The positive vbmeta image (good.bin): accepted, with the boot hash
 *     descriptor verified against the real partition bytes, the chain
 *     descriptor recorded as a pin whose pubkey hashes to the expected chain
 *     key, and the descriptor counts as built.
 *   - Negatives, each rejected with the exact avb_result code:
 *       tampered_descriptor.bin -> AVB_ERR_HASH
 *       wrong_key.bin           -> AVB_ERR_PUBKEY_HASH
 *       bad_magic.bin           -> AVB_ERR_MAGIC
 *       bad_rollback.bin        -> AVB_ERR_ROLLBACK
 *       truncated_aux.bin       -> AVB_ERR_BLOCK_BOUNDS
 *       bad_hash_descriptor.bin -> AVB_ERR_HASH_DESCRIPTOR
 *   - A parity-fault trust input is rejected before parse (AVB_ERR_PARITY).
 *   - A wrong partition image fed to a hash target is rejected.
 *
 * Built and run by run_tests.sh with host gcc. Exits non-zero on any wrong
 * decision; prints the terminal line "AVB vbmeta verify test PASS" on success.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "avb_verify.h"
#include "expected.h"

static int g_failures = 0;

static void check(const char *name, int ok)
{
    printf("%s %s\n", ok ? "PASS" : "FAIL", name);
    if (!ok) {
        g_failures++;
    }
}

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

static void base_trust(struct avb_trust_inputs *t)
{
    memcpy(t->expected_pubkey_hash, TEST_AVB_PINNED_KEY_HASH, 32);
    t->rollback_min = TEST_AVB_ROLLBACK_MIN;
    t->parity_ok = 1;
}

/* Verify a file with the given trust inputs and optional hash targets. */
static enum avb_result verify_file(const char *dir, const char *name,
                                   const struct avb_trust_inputs *t,
                                   const struct avb_hash_target *targets,
                                   size_t n_targets,
                                   struct avb_verify_outcome *out)
{
    char path[512];
    snprintf(path, sizeof(path), "%s/%s", dir, name);
    size_t len = 0;
    uint8_t *buf = read_file(path, &len);
    if (!buf) {
        return (enum avb_result)-1;
    }
    enum avb_result rc = avb_verify(buf, len, t, targets, n_targets, out);
    free(buf);
    return rc;
}

static int ct_hash_eq(const uint8_t *a, const uint8_t *b)
{
    int d = 0;
    for (int i = 0; i < 32; i++) d |= a[i] ^ b[i];
    return d == 0;
}

static void test_vbmeta(const char *dir)
{
    printf("AVB vbmeta image KAT:\n");
    struct avb_trust_inputs t;
    struct avb_verify_outcome out;

    const struct avb_hash_target boot_target = {
        .partition_name = "boot",
        .image = TEST_BOOT_IMAGE,
        .image_len = TEST_BOOT_IMAGE_LEN,
    };

    /* Positive: accepted, descriptors verified. */
    base_trust(&t);
    enum avb_result rc = verify_file(dir, "good.bin", &t, &boot_target, 1, &out);
    check("good.bin accepted", rc == AVB_OK);
    check("good.bin counts 1 hash descriptor", out.hash_descriptor_count == 1);
    check("good.bin counts 1 hashtree descriptor",
          out.hashtree_descriptor_count == 1);
    check("good.bin counts 1 chain pin", out.chain_pin_count == 1);
    check("good.bin counts 1 property descriptor",
          out.property_descriptor_count == 1);
    if (out.chain_pin_count == 1) {
        check("chain pin names vendor_boot",
              strcmp(out.chain_pins[0].partition_name, "vendor_boot") == 0);
        /* The chain pin's pubkey must hash to the expected chained-vbmeta key:
           this is the AVB equivalent of the OPNPHN01 key ladder. */
        uint8_t pkh[32];
        sha256(out.chain_pins[0].public_key,
               out.chain_pins[0].public_key_len, pkh);
        check("chain pin pubkey hashes to chained vbmeta key",
              ct_hash_eq(pkh, TEST_AVB_CHAIN_KEY_HASH));
        check("chain pin rollback_index_location is 4",
              out.chain_pins[0].rollback_index_location == 4u);
    }

    /* Positive without a hash target: still accepted (structural-only). */
    base_trust(&t);
    check("good.bin accepted with no hash targets",
          verify_file(dir, "good.bin", &t, NULL, 0, &out) == AVB_OK);

    /* Negative: a wrong partition image must be rejected. */
    base_trust(&t);
    uint8_t wrong_img[TEST_BOOT_IMAGE_LEN];
    memcpy(wrong_img, TEST_BOOT_IMAGE, TEST_BOOT_IMAGE_LEN);
    wrong_img[3] ^= 0xFF;
    struct avb_hash_target wrong_target = {
        .partition_name = "boot",
        .image = wrong_img,
        .image_len = TEST_BOOT_IMAGE_LEN,
    };
    check("good.bin + wrong boot image -> HASH_DESCRIPTOR",
          verify_file(dir, "good.bin", &t, &wrong_target, 1, &out) ==
              AVB_ERR_HASH_DESCRIPTOR);

    /* Negatives. */
    base_trust(&t);
    check("tampered_descriptor.bin -> HASH",
          verify_file(dir, "tampered_descriptor.bin", &t, &boot_target, 1, &out) ==
              AVB_ERR_HASH);

    base_trust(&t);
    check("wrong_key.bin -> PUBKEY_HASH",
          verify_file(dir, "wrong_key.bin", &t, &boot_target, 1, &out) ==
              AVB_ERR_PUBKEY_HASH);

    base_trust(&t);
    check("bad_magic.bin -> MAGIC",
          verify_file(dir, "bad_magic.bin", &t, &boot_target, 1, &out) ==
              AVB_ERR_MAGIC);

    base_trust(&t);
    check("bad_rollback.bin -> ROLLBACK",
          verify_file(dir, "bad_rollback.bin", &t, &boot_target, 1, &out) ==
              AVB_ERR_ROLLBACK);

    base_trust(&t);
    check("truncated_aux.bin -> BLOCK_BOUNDS",
          verify_file(dir, "truncated_aux.bin", &t, &boot_target, 1, &out) ==
              AVB_ERR_BLOCK_BOUNDS);

    base_trust(&t);
    check("bad_hash_descriptor.bin -> HASH_DESCRIPTOR",
          verify_file(dir, "bad_hash_descriptor.bin", &t, &boot_target, 1, &out) ==
              AVB_ERR_HASH_DESCRIPTOR);

    /* Parity fault: rejected before any parse. */
    base_trust(&t);
    t.parity_ok = 0;
    check("parity fault -> PARITY",
          verify_file(dir, "good.bin", &t, &boot_target, 1, &out) ==
              AVB_ERR_PARITY);

    /* Rollback floor exactly equal to the index is accepted. */
    base_trust(&t);
    t.rollback_min = TEST_AVB_ROLLBACK_INDEX;
    check("rollback_min == index accepted",
          verify_file(dir, "good.bin", &t, &boot_target, 1, &out) == AVB_OK);

    /* Rollback floor one above the index is rejected. */
    base_trust(&t);
    t.rollback_min = TEST_AVB_ROLLBACK_INDEX + 1u;
    check("rollback_min > index -> ROLLBACK",
          verify_file(dir, "good.bin", &t, &boot_target, 1, &out) ==
              AVB_ERR_ROLLBACK);
}

int main(int argc, char **argv)
{
    const char *img_dir = (argc > 1) ? argv[1] : ".";
    test_vbmeta(img_dir);

    if (g_failures != 0) {
        printf("\n%d check(s) FAILED\n", g_failures);
        return 1;
    }
    printf("\nAVB vbmeta verify test PASS\n");
    return 0;
}
