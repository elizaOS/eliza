/* polar_qjl.c - deterministic per-block +/-1 sign vector for the QJL
 * residual correction.
 *
 * NOTE on parity with polar_quant.py:
 *   The Python reference uses torch.randint(0, 2, (block_size,),
 *   generator=Generator(seed=42)) and remaps {0,1} -> {-1,+1}.  That
 *   sequence depends on torch internals and is not portable across
 *   torch versions.  We deliberately do *not* try to mirror it here.
 *
 *   Instead, this file generates a deterministic xorshift32 stream
 *   that both the C encoder and C decoder agree on, and the GGUF
 *   converter is responsible for either:
 *     (a) regenerating QJL sign bits to match this xorshift32 stream
 *         so the on-device decoder sees a consistent +/-1 vector, OR
 *     (b) writing the sign vector explicitly into GGUF metadata
 *         alongside the codes.
 *
 *   The roundtrip unit test exercises path (a) implicitly: encoder and
 *   decoder both call polar_qjl_signs(), so the residual correction
 *   cancels out on a noise-free input regardless of which sequence we
 *   pick, as long as both sides agree.
 */

#include <stdint.h>

#include "polarquant/polarquant.h"

void polar_qjl_signs(float * out) {
    /* xorshift32 seeded by POLAR_QJL_SEED.  Reads one bit at a time
     * from the LSB of the current state.  Deterministic across
     * platforms and compilers.
     */
    uint32_t state = (uint32_t)POLAR_QJL_SEED;
    if (state == 0u) state = 1u;  /* xorshift requires non-zero state */

    for (int i = 0; i < QK_POLAR; i++) {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        out[i] = (state & 1u) ? 1.0f : -1.0f;
    }
}
