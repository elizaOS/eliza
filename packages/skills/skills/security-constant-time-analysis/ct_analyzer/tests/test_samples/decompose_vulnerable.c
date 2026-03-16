/**
 * Vulnerable implementation of ML-DSA Decompose (Algorithm 36)
 *
 * This implementation uses hardware division which has data-dependent timing,
 * making it vulnerable to timing side-channel attacks like KyberSlash.
 *
 * DO NOT use this in production - for testing purposes only.
 */

#include <stdint.h>

// ML-DSA parameters
#define Q 8380417
#define GAMMA2_87 ((Q - 1) / 32)  // 261888 for ML-DSA-87
#define GAMMA2_44 ((Q - 1) / 88)  // 95232 for ML-DSA-44/65

/**
 * VULNERABLE: Decompose using hardware division
 *
 * Decomposes r into (r1, r0) such that r = r1 * (2 * gamma2) + r0
 * where -gamma2 < r0 <= gamma2.
 *
 * This uses the / and % operators which compile to DIV/IDIV instructions
 * on x86, which have data-dependent timing.
 */
void decompose_vulnerable(int32_t r, int32_t gamma2, int32_t *r1, int32_t *r0) {
    int32_t two_gamma2 = 2 * gamma2;

    // VULNERABLE: Hardware division with data-dependent timing
    *r1 = r / two_gamma2;
    *r0 = r % two_gamma2;

    // Center r0 around 0
    if (*r0 > gamma2) {
        *r0 -= two_gamma2;
        *r1 += 1;
    }
}

/**
 * VULNERABLE: UseHint using branches on potentially secret data
 *
 * The hint values may be derived from secret data in some contexts,
 * making these branches potentially exploitable.
 */
int32_t use_hint_vulnerable(int32_t r, int32_t hint, int32_t gamma2) {
    int32_t r1, r0;

    // This decompose call is also vulnerable
    decompose_vulnerable(r, gamma2, &r1, &r0);

    // VULNERABLE: Branch on hint which may depend on secret data
    if (hint == 0) {
        return r1;
    }

    // VULNERABLE: Branch on r0's sign
    if (r0 > 0) {
        return (r1 + 1) % ((Q - 1) / (2 * gamma2) + 1);
    } else {
        return (r1 - 1 + ((Q - 1) / (2 * gamma2) + 1)) % ((Q - 1) / (2 * gamma2) + 1);
    }
}

// Test functions to ensure code is not dead-code eliminated
int32_t test_decompose(int32_t r) {
    int32_t r1, r0;
    decompose_vulnerable(r, GAMMA2_87, &r1, &r0);
    return r1 + r0;
}

int32_t test_use_hint(int32_t r, int32_t hint) {
    return use_hint_vulnerable(r, hint, GAMMA2_87);
}
