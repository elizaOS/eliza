/*
 * Host KAT for the E1 CoVE attestation-quote producer (fw/dice/cove_quote.c).
 *
 * Builds a quote from fixed UDS + measured-launch inputs + nonce + ephemeral
 * pubkey and emits its canonical JSON. The DeviceID public key (the verifier's
 * trust anchor) is printed as base64url on stderr so the cross-language
 * round-trip harness can pass it as trustedRotPublicKey.
 *
 * Modes:
 *   test_cove_quote                 build, self-check, print JSON to stdout
 *   test_cove_quote --pubkey        print only the DeviceID pubkey (base64url)
 *   test_cove_quote <file>          write JSON to <file>, summary to stdout
 *
 * The self-checks (deterministic build, non-empty output, fail-closed on NULL)
 * make this a real test; the cross-language Ed25519/JSON byte-exactness proof
 * is verify_cove_quote_roundtrip.mjs, which consumes this binary's output.
 */

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "../cove_quote.h"
#include "../ed25519_sign.h"
#include "../../boot-rom/secure/sha256.h"

static int failures;

static void check(int cond, const char *name)
{
    if (cond) {
        fprintf(stderr, "PASS %s\n", name);
    } else {
        fprintf(stderr, "FAIL %s\n", name);
        failures++;
    }
}

static void fill(uint8_t *p, size_t n, uint8_t base)
{
    for (size_t i = 0; i < n; i++) {
        p[i] = (uint8_t)(base + i);
    }
}

/* Fixed launch images (KAT inputs). */
static const uint8_t ROM[] = "E1-mask-rom-v0";
static const uint8_t LIFECYCLE[] = "lifecycle:LOCKED";
static const uint8_t BL1[] = "BL1-image-bytes";
static const uint8_t BL2[] = "BL2-image-bytes";
static const uint8_t TSM[] = "E1-mmode-tsm-monitor-image";
static const uint8_t KERNEL[] = "linux-kernel-image";
static const uint8_t INITRAMFS[] = "initramfs-cpio";
static const uint8_t DTB[] = "device-tree-blob";
static const uint8_t POLICY[] = "{\"tee\":\"policy\"}";
static const uint8_t DEVICE_POLICY[] = "device-assignment-policy";
static const uint8_t AGENT[] = "eliza-agent-package";
static const uint8_t NPU_FW[] = "npu-firmware-blob";
static const uint8_t NPU_POLICY[] = "npu-queue-policy";
static const uint8_t MODEL_WEIGHTS[] = "sealed-model-weights";

static struct cove_blob blob(const uint8_t *p, size_t n)
{
    struct cove_blob b = { p, n };
    return b;
}

/* sizeof - 1 drops the implicit NUL terminator of the string literal. */
#define BLOB(x) blob((x), sizeof(x) - 1)

static void make_chain(struct cove_launch_chain *c)
{
    memset(c, 0, sizeof *c);
    c->rom = BLOB(ROM);
    c->lifecycle = BLOB(LIFECYCLE);
    c->bl1 = BLOB(BL1);
    c->bl2 = BLOB(BL2);
    c->tsm = BLOB(TSM);
    c->kernel = BLOB(KERNEL);
    c->initramfs = BLOB(INITRAMFS);
    c->dtb = BLOB(DTB);
    c->policy = BLOB(POLICY);
    c->device_policy = BLOB(DEVICE_POLICY);
    c->agent = BLOB(AGENT);
    c->npu_firmware = BLOB(NPU_FW);
    c->npu_queue_policy = BLOB(NPU_POLICY);
    c->model_weights = BLOB(MODEL_WEIGHTS);
}

static const char NONCE[] = "nonce-0123456789abcdef";
static const char TIMESTAMP[] = "2026-05-21T00:00:00Z";
static const char NOT_BEFORE[] = "2026-05-21T00:00:00Z";
static const char NOT_AFTER[] = "2027-05-21T00:00:00Z";

static void make_request(struct cove_quote_request *req,
                         const uint8_t *epk, size_t epk_len)
{
    memset(req, 0, sizeof *req);
    req->nonce = NONCE;
    req->ephemeral_pubkey = epk;
    req->ephemeral_pubkey_len = epk_len;
    req->timestamp = TIMESTAMP;
    req->hardware_vendor = "eliza";
    req->platform_version = "e1-model-v0";
    req->not_before = NOT_BEFORE;
    req->not_after = NOT_AFTER;
    req->security_version = 1;
}

/* b64url-encode without padding (matches cove_quote.c). */
static void b64url(const uint8_t *in, size_t n, char *out)
{
    static const char A[64] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    size_t i = 0, o = 0;
    while (i + 3 <= n) {
        uint32_t v = ((uint32_t)in[i] << 16) | ((uint32_t)in[i + 1] << 8) | in[i + 2];
        out[o++] = A[(v >> 18) & 63];
        out[o++] = A[(v >> 12) & 63];
        out[o++] = A[(v >> 6) & 63];
        out[o++] = A[v & 63];
        i += 3;
    }
    size_t rem = n - i;
    if (rem == 1) {
        uint32_t v = (uint32_t)in[i] << 16;
        out[o++] = A[(v >> 18) & 63];
        out[o++] = A[(v >> 12) & 63];
    } else if (rem == 2) {
        uint32_t v = ((uint32_t)in[i] << 16) | ((uint32_t)in[i + 1] << 8);
        out[o++] = A[(v >> 18) & 63];
        out[o++] = A[(v >> 12) & 63];
        out[o++] = A[(v >> 6) & 63];
    }
    out[o] = '\0';
}

int main(int argc, char **argv)
{
    uint8_t uds[DICE_UDS_LEN], h_bl1[32], h_bl2[32], h_monitor[32];
    uint8_t epk[32];
    fill(uds, sizeof uds, 0x10);
    fill(h_bl1, sizeof h_bl1, 0x20);
    fill(h_bl2, sizeof h_bl2, 0x30);
    fill(epk, sizeof epk, 0x50);
    /* h_monitor must equal SHA-256(tsm) so the Alias binds the measured TSM. */
    sha256(TSM, sizeof TSM - 1, h_monitor);

    struct cove_launch_chain chain;
    struct cove_launch_conditions cond = {
        .secure_boot_verified = 1,
        .lifecycle_locked = 1,
        .memory_encryption_active = 1,
        .iopmp_programmed = 1,
        .npu_private_queue_owned = 1,
        .monitor_measured = 1,
    };
    struct cove_quote_request req;
    make_chain(&chain);
    make_request(&req, epk, sizeof epk);

    static char json[8192];
    uint8_t dev_pub[ED25519_PUBKEY_LEN];
    size_t json_len = 0;

    int rc = cove_quote_build(uds, h_bl1, h_bl2, h_monitor, &chain, &cond, &req,
                              dev_pub, json, sizeof json, &json_len);

    /* --pubkey mode: emit only the DeviceID public key (base64url). */
    if (argc > 1 && strcmp(argv[1], "--pubkey") == 0) {
        if (rc != 0) {
            fprintf(stderr, "build failed\n");
            return 1;
        }
        char b64[64];
        b64url(dev_pub, sizeof dev_pub, b64);
        printf("%s\n", b64);
        return 0;
    }

    check(rc == 0, "cove_quote_build returns 0 on valid input");
    check(json_len > 0 && json_len == strlen(json), "JSON length is consistent");

    /* Determinism: a second build yields byte-identical output. */
    {
        static char json2[8192];
        uint8_t dev_pub2[ED25519_PUBKEY_LEN];
        size_t len2 = 0;
        int rc2 = cove_quote_build(uds, h_bl1, h_bl2, h_monitor, &chain, &cond,
                                   &req, dev_pub2, json2, sizeof json2, &len2);
        check(rc2 == 0 && len2 == json_len && memcmp(json, json2, json_len) == 0,
              "quote build is deterministic");
        check(memcmp(dev_pub, dev_pub2, sizeof dev_pub) == 0,
              "DeviceID pubkey is deterministic");
    }

    /* Fail-closed: NULL UDS zeroes outputs and returns -1. */
    {
        static char j[8192];
        uint8_t dp[ED25519_PUBKEY_LEN];
        size_t l = 123;
        memset(dp, 0xAB, sizeof dp);
        int frc = cove_quote_build(NULL, h_bl1, h_bl2, h_monitor, &chain, &cond,
                                   &req, dp, j, sizeof j, &l);
        uint8_t zero[ED25519_PUBKEY_LEN];
        memset(zero, 0, sizeof zero);
        check(frc == -1 && l == 0 && j[0] == '\0' &&
                  memcmp(dp, zero, sizeof dp) == 0,
              "NULL UDS fails closed (rc=-1, outputs zeroed)");
    }

    /* Fail-closed: too-small buffer returns -1, no partial JSON claimed. */
    {
        char tiny[16];
        uint8_t dp[ED25519_PUBKEY_LEN];
        size_t l = 99;
        int frc = cove_quote_build(uds, h_bl1, h_bl2, h_monitor, &chain, &cond,
                                   &req, dp, tiny, sizeof tiny, &l);
        check(frc == -1 && l == 0 && tiny[0] == '\0',
              "undersized buffer fails closed");
    }

    if (failures != 0) {
        fprintf(stderr, "CoVE quote KAT FAILED (%d failure(s))\n", failures);
        return 1;
    }

    if (argc > 1) {
        FILE *f = fopen(argv[1], "wb");
        if (f == NULL) {
            fprintf(stderr, "cannot open %s\n", argv[1]);
            return 1;
        }
        fwrite(json, 1, json_len, f);
        fclose(f);
        fprintf(stderr, "CoVE quote KAT PASS (wrote %zu bytes to %s)\n",
                json_len, argv[1]);
    } else {
        /* JSON to stdout (consumed by the round-trip harness); PASS to stderr. */
        fwrite(json, 1, json_len, stdout);
        fputc('\n', stdout);
        fprintf(stderr, "CoVE quote KAT PASS (%zu bytes)\n", json_len);
    }
    return 0;
}
