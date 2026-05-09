/* polar_hadamard.c - in-place Walsh-Hadamard transform of size QK_POLAR.
 *
 * Iterative Cooley-Tukey-style butterfly: log2(QK_POLAR) = 7 stages of
 * length-2 add/sub on adjacent groups, doubling the group size each
 * stage.  Self-inverse up to a uniform scaling factor of 1/sqrt(QK_POLAR);
 * the polarquant kernels apply that scale exactly once when going from
 * the rotated coordinates back to the per-block frame.
 *
 * Matches polar_quant._hadamard_matrix(128) in row-major dense form -
 * see polar_dequantize_ref.c for the bit-exact verification path the
 * test suite exercises.
 */

#include "polarquant/polarquant.h"

void polar_hadamard_inplace(float * x) {
    /* Sizes 1, 2, 4, ..., QK_POLAR/2 = 64.  At each stage we pair up
     * adjacent groups of `h` elements: the first group becomes
     * x[i] + x[i+h] and the second becomes x[i] - x[i+h].
     */
    for (int h = 1; h < QK_POLAR; h <<= 1) {
        for (int i = 0; i < QK_POLAR; i += (h << 1)) {
            for (int j = i; j < i + h; j++) {
                const float a = x[j];
                const float b = x[j + h];
                x[j]     = a + b;
                x[j + h] = a - b;
            }
        }
    }
}
