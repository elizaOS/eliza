/*
 * E1 M-mode TSM CoVE attestation-quote producer. See cove_quote.h.
 *
 * The canonical-JSON emitter reproduces, byte for byte, what the agent verifier
 * canonicalizes (packages/agent/src/services/cove-quote.ts):
 *
 *   - DICE cert TBS: a compact JSON object with keys in the FIXED order
 *       subject, issuer, subjectPublicKey, securityVersion, notBefore, notAfter
 *     then `measurements` (only if present) whose keys are sorted ascending.
 *   - CoveQuoteBody: a compact JSON object with keys in the FIXED order
 *       measurements (keys sorted asc), claims (keys sorted asc),
 *       securityVersion, reportData, nonce, timestamp, hardwareVendor,
 *       platformVersion.
 *   - The full quote envelope: { "body":<body>, "chain":[<cert>,<cert>],
 *       "signature":<b64url> }. Only `body` and the two cert TBS bodies are
 *       signed, so the envelope key order is free; we keep it stable.
 *
 * Strings here are constrained ASCII (sha256:hex, base64url, RFC3339, simple
 * subject names) so no JSON escaping is required; the emitter rejects any byte
 * that would need escaping, failing closed rather than emitting invalid JSON.
 */

#include "cove_quote.h"

#include "../boot-rom/secure/sha256.h"
#include "ed25519_sign.h"

#define DEVICE_ID_SUBJECT "E1-DICE-DeviceID"
#define ALIAS_SUBJECT     "E1-DICE-Alias"

/* ---- local freestanding helpers ---- */

static void cq_memset(uint8_t *dst, uint8_t v, size_t n)
{
    for (size_t i = 0; i < n; i++) {
        dst[i] = v;
    }
}

static void cq_memcpy(uint8_t *dst, const uint8_t *src, size_t n)
{
    for (size_t i = 0; i < n; i++) {
        dst[i] = src[i];
    }
}

static size_t cq_strlen(const char *s)
{
    size_t n = 0;
    while (s[n] != '\0') {
        n++;
    }
    return n;
}

/* ---- bounded, fail-closed string builder ---- */

struct cq_buf {
    char *buf;
    size_t cap;
    size_t len;
    int ok; /* cleared on any overflow or invalid byte; never set again */
};

static void cq_buf_init(struct cq_buf *b, char *buf, size_t cap)
{
    b->buf = buf;
    b->cap = cap;
    b->len = 0;
    b->ok = (buf != NULL && cap > 0) ? 1 : 0;
    if (b->ok) {
        b->buf[0] = '\0';
    }
}

static void cq_putc(struct cq_buf *b, char c)
{
    if (!b->ok) {
        return;
    }
    /* Always keep room for the terminating NUL. */
    if (b->len + 1 >= b->cap) {
        b->ok = 0;
        return;
    }
    b->buf[b->len++] = c;
    b->buf[b->len] = '\0';
}

/*
 * Append a JSON string literal. The value must be printable ASCII with no
 * characters that require escaping (", \, control chars). Any such byte fails
 * the builder closed.
 */
static void cq_put_json_string(struct cq_buf *b, const char *s, size_t n)
{
    if (!b->ok) {
        return;
    }
    cq_putc(b, '"');
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        if (c < 0x20u || c > 0x7eu || c == '"' || c == '\\') {
            b->ok = 0;
            return;
        }
        cq_putc(b, (char)c);
    }
    cq_putc(b, '"');
}

static void cq_put_cstr_json(struct cq_buf *b, const char *s)
{
    cq_put_json_string(b, s, cq_strlen(s));
}

/* Append a raw (already-valid-JSON) literal: object key punctuation, numbers. */
static void cq_put_raw(struct cq_buf *b, const char *s)
{
    while (*s != '\0') {
        cq_putc(b, *s++);
    }
}

static void cq_put_bool(struct cq_buf *b, int v)
{
    cq_put_raw(b, v ? "true" : "false");
}

static void cq_put_u32(struct cq_buf *b, uint32_t v)
{
    char tmp[10];
    size_t n = 0;
    if (v == 0) {
        cq_putc(b, '0');
        return;
    }
    while (v != 0 && n < sizeof tmp) {
        tmp[n++] = (char)('0' + (v % 10u));
        v /= 10u;
    }
    while (n > 0) {
        cq_putc(b, tmp[--n]);
    }
}

/* Emit "key": (no value). */
static void cq_put_key(struct cq_buf *b, const char *key)
{
    cq_put_cstr_json(b, key);
    cq_putc(b, ':');
}

/* ---- encoders ---- */

static const char HEX_LC[16] = {
    '0', '1', '2', '3', '4', '5', '6', '7',
    '8', '9', 'a', 'b', 'c', 'd', 'e', 'f',
};

/* Emit "sha256:" + lowercase hex of a 32-byte digest, as a JSON string. */
static void cq_put_measurement(struct cq_buf *b,
                               const uint8_t digest[SHA256_DIGEST_LEN])
{
    if (!b->ok) {
        return;
    }
    cq_putc(b, '"');
    cq_put_raw(b, "sha256:");
    for (size_t i = 0; i < SHA256_DIGEST_LEN; i++) {
        cq_putc(b, HEX_LC[digest[i] >> 4]);
        cq_putc(b, HEX_LC[digest[i] & 0x0fu]);
    }
    cq_putc(b, '"');
}

static const char B64URL[64] = {
    'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
    'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '-', '_',
};

/* Emit unpadded base64url of `in` as a JSON string. */
static void cq_put_b64url(struct cq_buf *b, const uint8_t *in, size_t n)
{
    if (!b->ok) {
        return;
    }
    cq_putc(b, '"');
    size_t i = 0;
    while (i + 3 <= n) {
        uint32_t v = ((uint32_t)in[i] << 16) | ((uint32_t)in[i + 1] << 8) |
                     (uint32_t)in[i + 2];
        cq_putc(b, B64URL[(v >> 18) & 0x3fu]);
        cq_putc(b, B64URL[(v >> 12) & 0x3fu]);
        cq_putc(b, B64URL[(v >> 6) & 0x3fu]);
        cq_putc(b, B64URL[v & 0x3fu]);
        i += 3;
    }
    size_t rem = n - i;
    if (rem == 1) {
        uint32_t v = (uint32_t)in[i] << 16;
        cq_putc(b, B64URL[(v >> 18) & 0x3fu]);
        cq_putc(b, B64URL[(v >> 12) & 0x3fu]);
    } else if (rem == 2) {
        uint32_t v = ((uint32_t)in[i] << 16) | ((uint32_t)in[i + 1] << 8);
        cq_putc(b, B64URL[(v >> 18) & 0x3fu]);
        cq_putc(b, B64URL[(v >> 12) & 0x3fu]);
        cq_putc(b, B64URL[(v >> 6) & 0x3fu]);
    }
    cq_putc(b, '"');
}

/* ---- measurement folding (mirrors teeevidence_quote.py) ---- */

/* extend(register, segment): new = H(prev_digest || H(segment)). */
static void cq_extend(uint8_t reg[SHA256_DIGEST_LEN], const struct cove_blob *seg)
{
    uint8_t seg_digest[SHA256_DIGEST_LEN];
    struct sha256_ctx ctx;
    sha256(seg->data, seg->len, seg_digest);
    sha256_init(&ctx);
    sha256_update(&ctx, reg, SHA256_DIGEST_LEN);
    sha256_update(&ctx, seg_digest, SHA256_DIGEST_LEN);
    sha256_final(&ctx, reg);
    cq_memset(seg_digest, 0, sizeof seg_digest);
}

/* boot/os start from H("") then extend over each segment in order. */
static void cq_fold_chain(uint8_t reg[SHA256_DIGEST_LEN],
                          const struct cove_blob *segs, size_t count)
{
    sha256(NULL, 0, reg);
    for (size_t i = 0; i < count; i++) {
        cq_extend(reg, &segs[i]);
    }
}

static void cq_hash_blob(uint8_t out[SHA256_DIGEST_LEN],
                         const struct cove_blob *blob)
{
    sha256(blob->data, blob->len, out);
}

/* H(a || b) over two concatenated blobs (npuFirmware fold). */
static void cq_hash_pair(uint8_t out[SHA256_DIGEST_LEN],
                         const struct cove_blob *a, const struct cove_blob *b)
{
    struct sha256_ctx ctx;
    sha256_init(&ctx);
    if (a->data != NULL && a->len != 0) {
        sha256_update(&ctx, a->data, a->len);
    }
    if (b->data != NULL && b->len != 0) {
        sha256_update(&ctx, b->data, b->len);
    }
    sha256_final(&ctx, out);
}

/* reportData = "sha256:" + hex(SHA256(nonce_utf8 || ephemeral_pubkey)). */
static void cq_report_data_digest(uint8_t out[SHA256_DIGEST_LEN],
                                  const char *nonce,
                                  const uint8_t *epk, size_t epk_len)
{
    struct sha256_ctx ctx;
    sha256_init(&ctx);
    sha256_update(&ctx, (const uint8_t *)nonce, cq_strlen(nonce));
    if (epk != NULL && epk_len != 0) {
        sha256_update(&ctx, epk, epk_len);
    }
    sha256_final(&ctx, out);
}

/* ---- measurement set ---- */

/*
 * Holds the computed quote measurements. `present` flags the three optional
 * registers; the five base registers are always present.
 */
struct cq_measurements {
    uint8_t boot[SHA256_DIGEST_LEN];
    uint8_t monitor[SHA256_DIGEST_LEN];
    uint8_t os[SHA256_DIGEST_LEN];
    uint8_t policy[SHA256_DIGEST_LEN];
    uint8_t device[SHA256_DIGEST_LEN];
    uint8_t agent[SHA256_DIGEST_LEN];
    uint8_t npu_firmware[SHA256_DIGEST_LEN];
    uint8_t model_weights[SHA256_DIGEST_LEN];
    int npu_protected;
    int has_model_weights;
};

static int blob_present(const struct cove_blob *b)
{
    return b->data != NULL && b->len != 0;
}

static void cq_build_measurements(const struct cove_launch_chain *c,
                                  const struct cove_launch_conditions *cond,
                                  struct cq_measurements *m)
{
    const struct cove_blob boot_segs[4] = { c->rom, c->lifecycle, c->bl1, c->bl2 };
    const struct cove_blob os_segs[3] = { c->kernel, c->initramfs, c->dtb };

    cq_fold_chain(m->boot, boot_segs, 4);
    cq_hash_blob(m->monitor, &c->tsm);
    cq_fold_chain(m->os, os_segs, 3);
    cq_hash_blob(m->policy, &c->policy);
    cq_hash_blob(m->device, &c->device_policy);
    cq_hash_blob(m->agent, &c->agent);

    m->npu_protected = cond->npu_private_queue_owned &&
                       blob_present(&c->npu_firmware) &&
                       blob_present(&c->npu_queue_policy);
    if (m->npu_protected) {
        cq_hash_pair(m->npu_firmware, &c->npu_firmware, &c->npu_queue_policy);
    } else {
        cq_memset(m->npu_firmware, 0, SHA256_DIGEST_LEN);
    }

    m->has_model_weights = blob_present(&c->model_weights);
    if (m->has_model_weights) {
        cq_hash_blob(m->model_weights, &c->model_weights);
    } else {
        cq_memset(m->model_weights, 0, SHA256_DIGEST_LEN);
    }
}

/*
 * Emit the measurements object with keys sorted ascending, exactly as the
 * verifier's sortObject() produces. Ascending order over the present keys:
 *   agent, boot, device, [modelWeights], monitor, [npuFirmware], os, policy
 */
static void cq_emit_measurements(struct cq_buf *b, const struct cq_measurements *m)
{
    cq_putc(b, '{');
    cq_put_key(b, "agent");
    cq_put_measurement(b, m->agent);
    cq_putc(b, ',');
    cq_put_key(b, "boot");
    cq_put_measurement(b, m->boot);
    cq_putc(b, ',');
    cq_put_key(b, "device");
    cq_put_measurement(b, m->device);
    if (m->has_model_weights) {
        cq_putc(b, ',');
        cq_put_key(b, "modelWeights");
        cq_put_measurement(b, m->model_weights);
    }
    cq_putc(b, ',');
    cq_put_key(b, "monitor");
    cq_put_measurement(b, m->monitor);
    if (m->npu_protected) {
        cq_putc(b, ',');
        cq_put_key(b, "npuFirmware");
        cq_put_measurement(b, m->npu_firmware);
    }
    cq_putc(b, ',');
    cq_put_key(b, "os");
    cq_put_measurement(b, m->os);
    cq_putc(b, ',');
    cq_put_key(b, "policy");
    cq_put_measurement(b, m->policy);
    cq_putc(b, '}');
}

/*
 * Emit the claims object with keys sorted ascending:
 *   debugDisabled, ioProtected, memoryEncrypted, monitorMeasured,
 *   npuProtected, productionLifecycle, secureBoot
 */
static void cq_emit_claims(struct cq_buf *b,
                           const struct cove_launch_conditions *cond,
                           int npu_protected)
{
    cq_putc(b, '{');
    cq_put_key(b, "debugDisabled");
    cq_put_bool(b, cond->lifecycle_locked);
    cq_putc(b, ',');
    cq_put_key(b, "ioProtected");
    cq_put_bool(b, cond->iopmp_programmed);
    cq_putc(b, ',');
    cq_put_key(b, "memoryEncrypted");
    cq_put_bool(b, cond->memory_encryption_active);
    cq_putc(b, ',');
    cq_put_key(b, "monitorMeasured");
    cq_put_bool(b, cond->monitor_measured);
    cq_putc(b, ',');
    cq_put_key(b, "npuProtected");
    cq_put_bool(b, npu_protected);
    cq_putc(b, ',');
    cq_put_key(b, "productionLifecycle");
    cq_put_bool(b, cond->lifecycle_locked);
    cq_putc(b, ',');
    cq_put_key(b, "secureBoot");
    cq_put_bool(b, cond->secure_boot_verified);
    cq_putc(b, '}');
}

/* Emit "sha256:" + hex as a JSON string (reportData). */
static void cq_emit_report_data(struct cq_buf *b,
                                const uint8_t digest[SHA256_DIGEST_LEN])
{
    cq_put_measurement(b, digest);
}

/* ---- canonical body (the bytes the Alias key signs) ---- */

/*
 * Emit the CoveQuoteBody in the verifier's fixed key order. The bytes emitted
 * here, when this is the only thing written to a fresh buffer, are exactly
 * canonicalBodyBytes(body) on the TS side.
 */
static void cq_emit_body(struct cq_buf *b,
                         const struct cq_measurements *m,
                         const struct cove_launch_conditions *cond,
                         const struct cove_quote_request *req,
                         const uint8_t report_data[SHA256_DIGEST_LEN])
{
    cq_putc(b, '{');
    cq_put_key(b, "measurements");
    cq_emit_measurements(b, m);
    cq_putc(b, ',');
    cq_put_key(b, "claims");
    cq_emit_claims(b, cond, m->npu_protected);
    cq_putc(b, ',');
    cq_put_key(b, "securityVersion");
    cq_put_u32(b, req->security_version);
    cq_putc(b, ',');
    cq_put_key(b, "reportData");
    cq_emit_report_data(b, report_data);
    cq_putc(b, ',');
    cq_put_key(b, "nonce");
    cq_put_cstr_json(b, req->nonce);
    cq_putc(b, ',');
    cq_put_key(b, "timestamp");
    cq_put_cstr_json(b, req->timestamp);
    cq_putc(b, ',');
    cq_put_key(b, "hardwareVendor");
    cq_put_cstr_json(b, req->hardware_vendor);
    cq_putc(b, ',');
    cq_put_key(b, "platformVersion");
    cq_put_cstr_json(b, req->platform_version);
    cq_putc(b, '}');
}

/* ---- DICE certificate TBS (the bytes the issuer key signs) ---- */

/*
 * Emit a cert TBS in the verifier's fixed key order:
 *   subject, issuer, subjectPublicKey, securityVersion, notBefore, notAfter
 * No `measurements` is emitted: the DeviceID/Alias certs in this chain carry
 * identity + validity only (the measurement set lives in the body). The
 * verifier's canonicalTbsBytes omits `measurements` when absent, so the bytes
 * here match exactly.
 */
static void cq_emit_cert_tbs(struct cq_buf *b,
                             const char *subject, const char *issuer,
                             const uint8_t subject_pubkey[ED25519_PUBKEY_LEN],
                             uint32_t security_version,
                             const char *not_before, const char *not_after)
{
    cq_putc(b, '{');
    cq_put_key(b, "subject");
    cq_put_cstr_json(b, subject);
    cq_putc(b, ',');
    cq_put_key(b, "issuer");
    cq_put_cstr_json(b, issuer);
    cq_putc(b, ',');
    cq_put_key(b, "subjectPublicKey");
    cq_put_b64url(b, subject_pubkey, ED25519_PUBKEY_LEN);
    cq_putc(b, ',');
    cq_put_key(b, "securityVersion");
    cq_put_u32(b, security_version);
    cq_putc(b, ',');
    cq_put_key(b, "notBefore");
    cq_put_cstr_json(b, not_before);
    cq_putc(b, ',');
    cq_put_key(b, "notAfter");
    cq_put_cstr_json(b, not_after);
    cq_putc(b, '}');
}

/*
 * Emit a full cert object: the TBS keys followed by `signature`. The verifier
 * recomputes canonicalTbsBytes from the same TBS keys (ignoring `signature`),
 * so appending the signature does not affect what was signed.
 */
static void cq_emit_cert(struct cq_buf *b,
                         const char *subject, const char *issuer,
                         const uint8_t subject_pubkey[ED25519_PUBKEY_LEN],
                         uint32_t security_version,
                         const char *not_before, const char *not_after,
                         const uint8_t signature[ED25519_SIG_LEN])
{
    cq_putc(b, '{');
    cq_put_key(b, "subject");
    cq_put_cstr_json(b, subject);
    cq_putc(b, ',');
    cq_put_key(b, "issuer");
    cq_put_cstr_json(b, issuer);
    cq_putc(b, ',');
    cq_put_key(b, "subjectPublicKey");
    cq_put_b64url(b, subject_pubkey, ED25519_PUBKEY_LEN);
    cq_putc(b, ',');
    cq_put_key(b, "securityVersion");
    cq_put_u32(b, security_version);
    cq_putc(b, ',');
    cq_put_key(b, "notBefore");
    cq_put_cstr_json(b, not_before);
    cq_putc(b, ',');
    cq_put_key(b, "notAfter");
    cq_put_cstr_json(b, not_after);
    cq_putc(b, ',');
    cq_put_key(b, "signature");
    cq_put_b64url(b, signature, ED25519_SIG_LEN);
    cq_putc(b, '}');
}

/*
 * Sign a TBS by emitting it into a scratch buffer and running ed25519_sign over
 * the exact emitted bytes. Returns 0 on success, -1 if the scratch overflowed.
 */
static int cq_sign_cert_tbs(const char *subject, const char *issuer,
                            const uint8_t subject_pubkey[ED25519_PUBKEY_LEN],
                            uint32_t security_version,
                            const char *not_before, const char *not_after,
                            const uint8_t signer_priv[ED25519_PRIVKEY_LEN],
                            uint8_t sig_out[ED25519_SIG_LEN])
{
    char scratch[512];
    struct cq_buf tbs;
    cq_buf_init(&tbs, scratch, sizeof scratch);
    cq_emit_cert_tbs(&tbs, subject, issuer, subject_pubkey, security_version,
                     not_before, not_after);
    if (!tbs.ok) {
        cq_memset((uint8_t *)scratch, 0, sizeof scratch);
        return -1;
    }
    ed25519_sign(sig_out, (const uint8_t *)tbs.buf, tbs.len, signer_priv);
    cq_memset((uint8_t *)scratch, 0, sizeof scratch);
    return 0;
}

/* ---- top-level build ---- */

static void cove_fail_closed(uint8_t device_id_pubkey[ED25519_PUBKEY_LEN],
                             char *out, size_t out_cap, size_t *out_len)
{
    if (device_id_pubkey != NULL) {
        cq_memset(device_id_pubkey, 0, ED25519_PUBKEY_LEN);
    }
    if (out != NULL && out_cap > 0) {
        out[0] = '\0';
    }
    if (out_len != NULL) {
        *out_len = 0;
    }
}

int cove_quote_build(const uint8_t uds[DICE_UDS_LEN],
                     const uint8_t h_bl1[DICE_MEASUREMENT_LEN],
                     const uint8_t h_bl2[DICE_MEASUREMENT_LEN],
                     const uint8_t h_monitor[DICE_MEASUREMENT_LEN],
                     const struct cove_launch_chain *chain,
                     const struct cove_launch_conditions *conditions,
                     const struct cove_quote_request *request,
                     uint8_t device_id_pubkey[ED25519_PUBKEY_LEN],
                     char *out, size_t out_cap, size_t *out_len)
{
    struct dice_chain ladder;
    uint8_t dev_pub[ED25519_PUBKEY_LEN], dev_priv[ED25519_PRIVKEY_LEN];
    uint8_t alias_pub[ED25519_PUBKEY_LEN], alias_priv[ED25519_PRIVKEY_LEN];
    uint8_t dev_sig[ED25519_SIG_LEN], alias_cert_sig[ED25519_SIG_LEN];
    uint8_t body_sig[ED25519_SIG_LEN];
    uint8_t report_digest[SHA256_DIGEST_LEN];
    struct cq_measurements meas;
    char body_scratch[2048];
    struct cq_buf body;
    struct cq_buf full;
    int rc = -1;

    if (uds == NULL || h_bl1 == NULL || h_bl2 == NULL || h_monitor == NULL ||
        chain == NULL || conditions == NULL || request == NULL ||
        device_id_pubkey == NULL || out == NULL || out_len == NULL ||
        request->nonce == NULL || request->timestamp == NULL ||
        request->hardware_vendor == NULL || request->platform_version == NULL ||
        request->not_before == NULL || request->not_after == NULL) {
        cove_fail_closed(device_id_pubkey, out, out_cap, out_len);
        return -1;
    }

    /* Derive DeviceID + Alias from CDI_monitor (real DICE ladder). */
    if (dice_walk_boot_chain(uds, h_bl1, h_bl2, h_monitor, &ladder) != 0) {
        cove_fail_closed(device_id_pubkey, out, out_cap, out_len);
        return -1;
    }
    if (dice_derive_device_id(ladder.cdi_monitor, dev_pub, dev_priv) != 0 ||
        dice_derive_alias(ladder.cdi_monitor, alias_pub, alias_priv) != 0) {
        goto cleanup;
    }

    cq_build_measurements(chain, conditions, &meas);
    cq_report_data_digest(report_digest, request->nonce,
                          request->ephemeral_pubkey,
                          request->ephemeral_pubkey_len);

    /*
     * Sign the body with the Alias key. Emit the canonical body into a scratch
     * buffer so the signed bytes equal exactly what the verifier canonicalizes.
     */
    cq_buf_init(&body, body_scratch, sizeof body_scratch);
    cq_emit_body(&body, &meas, conditions, request, report_digest);
    if (!body.ok) {
        goto cleanup;
    }
    ed25519_sign(body_sig, (const uint8_t *)body.buf, body.len, alias_priv);

    /* DeviceID cert: self-issued, self-signed by the DeviceID key. */
    if (cq_sign_cert_tbs(DEVICE_ID_SUBJECT, DEVICE_ID_SUBJECT, dev_pub,
                         request->security_version, request->not_before,
                         request->not_after, dev_priv, dev_sig) != 0) {
        goto cleanup;
    }
    /* Alias cert: issued by DeviceID, signed by the DeviceID key. */
    if (cq_sign_cert_tbs(ALIAS_SUBJECT, DEVICE_ID_SUBJECT, alias_pub,
                         request->security_version, request->not_before,
                         request->not_after, dev_priv, alias_cert_sig) != 0) {
        goto cleanup;
    }

    /* Assemble the full quote envelope. */
    cq_buf_init(&full, out, out_cap);
    cq_putc(&full, '{');
    cq_put_key(&full, "body");
    cq_emit_body(&full, &meas, conditions, request, report_digest);
    cq_putc(&full, ',');
    cq_put_key(&full, "chain");
    cq_putc(&full, '[');
    cq_emit_cert(&full, DEVICE_ID_SUBJECT, DEVICE_ID_SUBJECT, dev_pub,
                 request->security_version, request->not_before,
                 request->not_after, dev_sig);
    cq_putc(&full, ',');
    cq_emit_cert(&full, ALIAS_SUBJECT, DEVICE_ID_SUBJECT, alias_pub,
                 request->security_version, request->not_before,
                 request->not_after, alias_cert_sig);
    cq_putc(&full, ']');
    cq_putc(&full, ',');
    cq_put_key(&full, "signature");
    cq_put_b64url(&full, body_sig, ED25519_SIG_LEN);
    cq_putc(&full, '}');

    if (!full.ok) {
        cove_fail_closed(device_id_pubkey, out, out_cap, out_len);
        goto cleanup;
    }

    cq_memcpy(device_id_pubkey, dev_pub, ED25519_PUBKEY_LEN);
    *out_len = full.len;
    rc = 0;

cleanup:
    if (rc != 0) {
        cove_fail_closed(device_id_pubkey, out, out_cap, out_len);
    }
    cq_memset(dev_priv, 0, sizeof dev_priv);
    cq_memset(alias_priv, 0, sizeof alias_priv);
    cq_memset((uint8_t *)&ladder, 0, sizeof ladder);
    cq_memset((uint8_t *)body_scratch, 0, sizeof body_scratch);
    return rc;
}
