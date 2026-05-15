/*
 * Phase 2 reference-impl test for the recognizer path.
 *
 * The full crnn_vgg16_bn forward needs the converted GGUF weights
 * (BiLSTM layers, linear head, ~30M weights total). Phase 2 doesn't
 * ship those weights inside the repo, so this test exercises the
 * weight-free portions of the recognizer pipeline:
 *
 *   1. The 32xN resize+normalize preprocess that runs before the
 *      VGG-16-BN backbone.
 *   2. The CTC greedy decoder against a hand-crafted (timesteps,
 *      vocab+1) logits matrix that should decode to a known string.
 *      This is the only piece of the recognizer that lives entirely
 *      on the C side and is not dependent on the GGUF weights.
 *
 * NOTE — bit-exact end-to-end CTC decode against weights is *PENDING*
 * for Phase 2: it requires the converted GGUF on disk plus a labelled
 * crop fixture, neither of which lives in this repo. That parity test
 * is the next step before this library replaces RapidOcrCoordAdapter
 * in plugin-vision.
 */

#include "doctr/doctr.h"
#include "doctr_internal.h"

#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures = 0;

#define EXPECT(cond, ...) do { \
    if (!(cond)) { \
        fprintf(stderr, "[recognizer-ref] FAIL %s:%d: ", __FILE__, __LINE__); \
        fprintf(stderr, __VA_ARGS__); \
        fprintf(stderr, "\n"); \
        ++failures; \
    } \
} while (0)

static void test_resize_preprocess(void) {
    /* Synthetic 64x64 grayscale-ish RGB. Resize down to 32x128 (the
     * doctr crnn input convention). */
    const int sw = 64, sh = 64;
    uint8_t *img = (uint8_t *)malloc((size_t)sw * sh * 3);
    EXPECT(img != NULL, "img alloc failed");
    if (!img) return;
    for (int y = 0; y < sh; ++y) {
        for (int x = 0; x < sw; ++x) {
            uint8_t v = (uint8_t)((x + y) & 0xff);
            uint8_t *p = img + ((size_t)y * sw + x) * 3;
            p[0] = p[1] = p[2] = v;
        }
    }

    const int th = 32, tw = 128;
    float *out = (float *)malloc(sizeof(float) * 3 * th * tw);
    EXPECT(out != NULL, "out alloc failed");
    if (!out) { free(img); return; }

    int rc = doctr_resize_rgb_to_chw(img, sw, sh, out, th, tw);
    EXPECT(rc == 0, "resize returned %d", rc);

    /* Spot check: every output pixel should be finite. The
     * normalization pass is the easiest place for NaN/Inf to creep
     * in if upstream got the formula wrong. */
    int n_finite = 0;
    int n_total = 3 * th * tw;
    for (int i = 0; i < n_total; ++i) if (isfinite(out[i])) ++n_finite;
    EXPECT(n_finite == n_total,
           "expected all-finite, got %d/%d", n_finite, n_total);

    free(out);
    free(img);
}

/* Hand-crafted CTC test: vocab "AB", alphabet_size=3 (blank, A, B).
 * Logits chosen so argmax sequence is [A, A, blank, B, B] which CTC
 * collapses to "AB". */
static void test_ctc_greedy_decode_sanity(void) {
    const char *vocab = "AB";
    const int vocab_len = 2;
    const int alphabet = vocab_len + 1;
    const int T = 5;
    /* Pre-softmax logits. Use big positive on the desired class so the
     * resulting softmax is essentially one-hot and confidences come
     * out close to 1.0. Layout: row-major (T, alphabet). */
    float L[5 * 3] = {
        /* t=0: pick A (idx 1) */ -10.0f, 10.0f, -10.0f,
        /* t=1: pick A (idx 1) */ -10.0f, 10.0f, -10.0f,
        /* t=2: blank (idx 0)  */  10.0f,-10.0f, -10.0f,
        /* t=3: pick B (idx 2) */ -10.0f,-10.0f,  10.0f,
        /* t=4: pick B (idx 2) */ -10.0f,-10.0f,  10.0f,
    };

    char text[16] = {0};
    float confs[16] = {0};
    size_t text_len = 0, confs_len = 0;
    int rc = doctr_ctc_greedy_decode(
        L, T, alphabet, vocab, vocab_len,
        text, sizeof text, &text_len,
        confs, sizeof(confs)/sizeof(confs[0]), &confs_len);
    EXPECT(rc == 0, "ctc decode returned %d", rc);
    EXPECT(text_len == 2, "text_len=%zu, expected 2", text_len);
    EXPECT(strcmp(text, "AB") == 0, "decoded %s, expected AB", text);
    EXPECT(confs_len == 2, "confs_len=%zu, expected 2", confs_len);
    EXPECT(confs[0] > 0.99f && confs[1] > 0.99f,
           "expected near-1.0 confidences, got %.4f, %.4f", confs[0], confs[1]);
}

static void test_ctc_greedy_decode_blank_only(void) {
    /* All blank logits should produce empty string. */
    const char *vocab = "AB";
    const int alphabet = 3;
    const int T = 4;
    float L[4 * 3] = {
        10.0f, -10.0f, -10.0f,
        10.0f, -10.0f, -10.0f,
        10.0f, -10.0f, -10.0f,
        10.0f, -10.0f, -10.0f,
    };
    char text[8] = {0};
    float confs[8] = {0};
    size_t text_len = 99, confs_len = 99;
    int rc = doctr_ctc_greedy_decode(
        L, T, alphabet, vocab, 2,
        text, sizeof text, &text_len,
        confs, sizeof(confs)/sizeof(confs[0]), &confs_len);
    EXPECT(rc == 0, "blank-only decode returned %d", rc);
    EXPECT(text_len == 0, "expected empty text, got len=%zu", text_len);
    EXPECT(confs_len == 0, "expected zero confs, got %zu", confs_len);
    EXPECT(text[0] == '\0', "text not NUL-terminated");
}

static void test_ctc_greedy_decode_buffer_too_small(void) {
    /* Single-char output but text buffer holds only 1 byte; -ENOSPC. */
    const char *vocab = "A";
    const int alphabet = 2;
    const int T = 1;
    float L[1 * 2] = { -10.0f, 10.0f };
    char text[1] = {0};
    float confs[4] = {0};
    size_t text_len = 0, confs_len = 0;
    int rc = doctr_ctc_greedy_decode(
        L, T, alphabet, vocab, 1,
        text, sizeof text, &text_len,
        confs, sizeof(confs)/sizeof(confs[0]), &confs_len);
    EXPECT(rc == -ENOSPC,
           "expected -ENOSPC for tiny text buffer, got %d", rc);
}

/* Honest gate: the full forward needs weights. Without a GGUF, the
 * library must refuse cleanly rather than fabricate a string. We
 * confirm that doctr_open against a missing path returns -ENOENT —
 * the rest of the forward path simply cannot be reached without a
 * session, which is the documented contract. */
static void test_full_forward_without_weights_refuses(void) {
    doctr_session *s = (doctr_session *)0xdeadbeef;
    int rc = doctr_open("/nonexistent-doctr.gguf", &s);
    EXPECT(rc == -ENOENT, "expected -ENOENT for missing GGUF, got %d", rc);
    EXPECT(s == NULL, "expected NULL session on failure");

    /* Calling doctr_recognize_word with a NULL session must return
     * -EINVAL rather than crash. */
    uint8_t pixels[3 * 32 * 128] = {0};
    doctr_image img = { .rgb = pixels, .width = 128, .height = 32 };
    char text[64] = {0};
    float confs[64] = {0};
    doctr_recognition reco = {
        .text_utf8 = text, .text_utf8_capacity = sizeof text,
        .char_confidences = confs,
        .char_confidences_capacity = sizeof(confs)/sizeof(confs[0]),
    };
    rc = doctr_recognize_word(NULL, &img, &reco);
    EXPECT(rc == -EINVAL,
           "doctr_recognize_word(NULL) returned %d, expected -EINVAL", rc);
}

int main(void) {
    test_resize_preprocess();
    test_ctc_greedy_decode_sanity();
    test_ctc_greedy_decode_blank_only();
    test_ctc_greedy_decode_buffer_too_small();
    test_full_forward_without_weights_refuses();
    printf("[recognizer-ref] failures=%d\n", failures);
    return failures == 0 ? 0 : 1;
}
