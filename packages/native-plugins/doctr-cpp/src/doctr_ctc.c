/*
 * CTC greedy decoder for doctr-cpp Phase 2.
 *
 * Logits matrix is (timesteps, alphabet_size) where alphabet_size ==
 * vocab_len + 1 and position 0 is the CTC blank. Greedy decoding:
 *   - argmax per timestep
 *   - collapse repeated argmaxes
 *   - drop blanks
 *
 * Confidences: per emitted character, take the mean softmax
 * probability across the timesteps that voted for it. For Phase 2
 * this is good enough; Phase 3 can switch to a beam decoder with
 * proper per-character probs.
 *
 * Vocab is a UTF-8 string passed in by the caller (read from the GGUF
 * by the session ctor). UTF-8 codepoints are walked byte-aware so
 * accented chars (€, ç, ô, …) emit the right number of bytes.
 */

#include "doctr_internal.h"

#include <errno.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

/* Walk UTF-8 string and split into a list of (start_byte, length) pairs.
 * Returns the codepoint count or -EINVAL on malformed input. The caller
 * provides storage for at most `max_cp` pairs. */
static int utf8_index(const char *s, int slen, int *off, int *len, int max_cp) {
    int n = 0;
    int i = 0;
    while (i < slen) {
        if (n >= max_cp) return -ENOSPC;
        unsigned char b = (unsigned char)s[i];
        int cl;
        if      ((b & 0x80) == 0x00) cl = 1;
        else if ((b & 0xE0) == 0xC0) cl = 2;
        else if ((b & 0xF0) == 0xE0) cl = 3;
        else if ((b & 0xF8) == 0xF0) cl = 4;
        else return -EINVAL;
        if (i + cl > slen) return -EINVAL;
        off[n] = i;
        len[n] = cl;
        ++n;
        i += cl;
    }
    return n;
}

int doctr_ctc_greedy_decode(
    const float *logits, int timesteps, int alphabet_size,
    const char *vocab_utf8, int vocab_len,
    char *text, size_t text_capacity, size_t *text_len,
    float *confs, size_t confs_capacity, size_t *confs_len)
{
    if (text_len) *text_len = 0;
    if (confs_len) *confs_len = 0;
    if (text_capacity == 0) return -ENOSPC;
    text[0] = '\0';

    /* Build a UTF-8 codepoint index of the vocab. The CTC head's
     * "alphabet position p" maps to vocab character (p-1) when p>=1;
     * p==0 is blank. */
    int *cp_off = (int *)malloc(sizeof(int) * (vocab_len + 1));
    int *cp_len = (int *)malloc(sizeof(int) * (vocab_len + 1));
    if (!cp_off || !cp_len) { free(cp_off); free(cp_len); return -ENOMEM; }
    int slen = (int)strlen(vocab_utf8);
    int n_cp = utf8_index(vocab_utf8, slen, cp_off, cp_len, vocab_len + 1);
    if (n_cp < 0 || n_cp != vocab_len) {
        free(cp_off); free(cp_len);
        return -EINVAL;
    }

    /* Argmax + softmax-of-max per timestep. */
    int   *am = (int   *)malloc(sizeof(int)   * timesteps);
    float *pm = (float *)malloc(sizeof(float) * timesteps);
    if (!am || !pm) { free(am); free(pm); free(cp_off); free(cp_len); return -ENOMEM; }
    for (int t = 0; t < timesteps; ++t) {
        const float *row = logits + (size_t)t * alphabet_size;
        float mx = row[0]; int ai = 0;
        for (int k = 1; k < alphabet_size; ++k) {
            if (row[k] > mx) { mx = row[k]; ai = k; }
        }
        /* Numerically-stable softmax probability of the argmax. */
        float sum = 0.0f;
        for (int k = 0; k < alphabet_size; ++k) sum += expf(row[k] - mx);
        am[t] = ai;
        pm[t] = 1.0f / sum;  /* expf(mx - mx) / sum = 1/sum */
    }

    /* Collapse repeats and drop blanks. */
    size_t out_text = 0;
    size_t out_conf = 0;
    int prev = -1;          /* alphabet position of previous emit */
    int run_start = -1;
    float run_sum = 0.0f;
    int   run_n = 0;

    for (int t = 0; t <= timesteps; ++t) {
        int cur = (t < timesteps) ? am[t] : -1;
        if (cur != prev) {
            /* Flush previous run. */
            if (prev > 0 /* not blank */ && run_n > 0) {
                int cp = prev - 1;
                int blen = cp_len[cp];
                if (out_text + (size_t)blen + 1 > text_capacity) {
                    free(am); free(pm); free(cp_off); free(cp_len);
                    return -ENOSPC;
                }
                if (out_conf + 1 > confs_capacity) {
                    free(am); free(pm); free(cp_off); free(cp_len);
                    return -ENOSPC;
                }
                memcpy(text + out_text, vocab_utf8 + cp_off[cp], (size_t)blen);
                out_text += (size_t)blen;
                confs[out_conf++] = run_sum / (float)run_n;
            }
            prev = cur;
            run_start = t;
            run_sum = (cur >= 0 && t < timesteps) ? pm[t] : 0.0f;
            run_n   = (cur >= 0 && t < timesteps) ? 1 : 0;
        } else if (t < timesteps) {
            run_sum += pm[t];
            run_n++;
        }
    }
    text[out_text] = '\0';
    if (text_len)  *text_len  = out_text;
    if (confs_len) *confs_len = out_conf;

    free(am); free(pm); free(cp_off); free(cp_len);
    (void)run_start;
    return 0;
}
