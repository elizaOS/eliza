/**
 * Constant-time implementation of ML-DSA Decompose (Algorithm 36)
 *
 * This implementation avoids hardware division by using Barrett reduction
 * and branchless conditional selection, ensuring constant-time execution.
 *
 * Based on Trail of Bits' ML-DSA implementation.
 */

#include <stdint.h>
#include <stddef.h>

// ML-DSA parameters
#define Q 8380417
#define GAMMA2_87 ((Q - 1) / 32)  // 261888 for ML-DSA-87
#define GAMMA2_44 ((Q - 1) / 88)  // 95232 for ML-DSA-44/65

// Barrett reduction constants for different gamma2 values
// These allow division by 2*gamma2 without using DIV instruction
// Computed as: ceil(2^32 / (2 * gamma2))
#define BARRETT_MU_87 0x2081ULL      // For gamma2 = 261888 (ML-DSA-87): 2^32 / 523776
#define BARRETT_MU_44 0x5A1DULL      // For gamma2 = 95232 (ML-DSA-44/65): 2^32 / 190464

// Constant-time helper: returns 1 if x != 0, 0 otherwise
static inline uint32_t ct_is_nonzero(uint32_t x) {
    return (x | (uint32_t)(-(int32_t)x)) >> 31;
}

// Constant-time helper: returns 1 if x == 0, 0 otherwise
static inline uint32_t ct_is_zero(uint32_t x) {
    return 1 ^ ct_is_nonzero(x);
}

// Constant-time helper: returns 1 if x < y (unsigned), 0 otherwise
static inline uint32_t ct_lt(uint32_t x, uint32_t y) {
    return (x ^ ((x ^ y) | ((x - y) ^ y))) >> 31;
}

// Constant-time helper: returns 1 if x > y (unsigned), 0 otherwise
static inline uint32_t ct_gt(uint32_t x, uint32_t y) {
    return ct_lt(y, x);
}

// Constant-time helper: returns mask (0xFFFFFFFF if bit != 0, 0 otherwise)
static inline uint32_t ct_mask(uint32_t bit) {
    return (uint32_t)(-(int32_t)ct_is_nonzero(bit));
}

// Constant-time helper: select x if bit != 0, y otherwise
static inline uint32_t ct_select(uint32_t x, uint32_t y, uint32_t bit) {
    uint32_t m = ct_mask(bit);
    return (x & m) | (y & ~m);
}

// Constant-time helper: select x if bit != 0, y otherwise (signed version)
static inline int32_t ct_select_signed(int32_t x, int32_t y, uint32_t bit) {
    return (int32_t)ct_select((uint32_t)x, (uint32_t)y, bit);
}

/**
 * Barrett reduction to compute r / (2 * gamma2) without DIV instruction
 *
 * For gamma2 = 261888 (ML-DSA-87):
 *   2 * gamma2 = 523776
 *   mu = ceil(2^32 / 523776) = 8192 + some correction
 *
 * q = (r * mu) >> 32
 */
static inline uint32_t barrett_div(uint32_t r, uint64_t mu, uint32_t divisor) {
    uint64_t q = ((uint64_t)r * mu) >> 32;
    // Correction: if r - q*divisor >= divisor, add 1
    uint32_t remainder = r - (uint32_t)q * divisor;
    uint32_t correction = ct_gt(remainder, divisor - 1) | ct_is_zero(remainder - divisor + divisor);
    return (uint32_t)q + (correction & ct_lt(remainder, r + 1));
}

/**
 * CONSTANT-TIME: Decompose using Barrett reduction
 *
 * Decomposes r into (r1, r0) such that r = r1 * (2 * gamma2) + r0
 * where -gamma2 < r0 <= gamma2.
 *
 * This implementation:
 * 1. Uses Barrett reduction instead of hardware division
 * 2. Uses branchless conditional selection instead of if statements
 */
void decompose_constant_time(uint32_t r, uint32_t gamma2, uint32_t *r1, int32_t *r0) {
    uint32_t two_gamma2 = 2 * gamma2;

    // Barrett reduction: compute r1 = r / (2 * gamma2)
    // Using precomputed constants - select the right one using constant-time selection
    // This avoids any runtime division
    uint64_t mu_87 = BARRETT_MU_87;
    uint64_t mu_44 = BARRETT_MU_44;

    // Constant-time selection of mu based on gamma2
    // Note: We use bit operations to select without branching
    uint32_t is_87 = ct_is_zero(gamma2 - GAMMA2_87);
    uint64_t mu = (mu_87 & (uint64_t)ct_mask(is_87)) |
                  (mu_44 & (uint64_t)ct_mask(ct_is_zero(is_87)));

    // Compute quotient using multiplication and shift (no DIV)
    uint64_t q64 = ((uint64_t)r * mu) >> 32;
    uint32_t q = (uint32_t)q64;

    // Compute remainder: r0 = r - q * (2 * gamma2)
    int32_t r0_temp = (int32_t)(r - q * two_gamma2);

    // Correction: handle case where Barrett underestimates
    // If r0_temp >= 2*gamma2, increment q and adjust r0
    uint32_t needs_correction = ct_gt((uint32_t)r0_temp, two_gamma2 - 1);
    q += needs_correction;
    r0_temp = ct_select_signed(r0_temp - (int32_t)two_gamma2, r0_temp, needs_correction);

    // Center r0 around 0: if r0 > gamma2, subtract 2*gamma2 and increment r1
    // This is done branchlessly using constant-time selection
    uint32_t needs_centering = ct_gt((uint32_t)r0_temp, gamma2);

    *r0 = ct_select_signed(r0_temp - (int32_t)two_gamma2, r0_temp, needs_centering);
    *r1 = q + needs_centering;
}

/**
 * CONSTANT-TIME: UseHint using branchless selection
 *
 * All conditional logic is replaced with constant-time bit operations.
 */
uint32_t use_hint_constant_time(uint32_t r, uint32_t hint, uint32_t gamma2) {
    uint32_t r1;
    int32_t r0;

    // Decompose (constant-time)
    decompose_constant_time(r, gamma2, &r1, &r0);

    // m = (Q - 1) / (2 * gamma2)
    // Precomputed values to avoid runtime division
    // For gamma2 = 261888: m = 8380416 / 523776 = 16 - 1 = 15
    // For gamma2 = 95232: m = 8380416 / 190464 = 44 - 1 = 43
    uint32_t m_87 = 15;
    uint32_t m_44 = 43;
    uint32_t is_87_hint = ct_is_zero(gamma2 - GAMMA2_87);
    uint32_t m = ct_select(m_87, m_44, is_87_hint);

    // If hint == 0, return r1
    // If hint != 0:
    //   If r0 > 0, return (r1 + 1) mod (m + 1)
    //   Else return (r1 - 1 + (m + 1)) mod (m + 1)

    // Compute both branches
    uint32_t m_plus_1 = m + 1;

    // r1_inc = (r1 + 1) mod (m + 1)
    // Since r1 < m+1, we just need to check if r1 + 1 == m + 1
    uint32_t r1_plus_1 = r1 + 1;
    uint32_t r1_inc = ct_select(0, r1_plus_1, ct_is_zero(r1_plus_1 - m_plus_1));

    // r1_dec = (r1 - 1 + (m + 1)) mod (m + 1) = (r1 + m) mod (m + 1)
    uint32_t r1_plus_m = r1 + m;
    uint32_t r1_dec = ct_select(r1_plus_m - m_plus_1, r1_plus_m,
                                 ct_gt(r1_plus_m, m_plus_1 - 1));

    // Select based on r0 > 0 (constant-time)
    // r0 > 0 is equivalent to r0 being positive and non-zero
    uint32_t r0_positive = ct_gt((uint32_t)((r0 >> 31) ^ r0), 0) & ct_is_zero((uint32_t)(r0 >> 31));
    uint32_t adjusted = ct_select(r1_inc, r1_dec, r0_positive);

    // Final selection based on hint
    return ct_select(adjusted, r1, ct_is_zero(hint));
}

// Test functions to ensure code is not dead-code eliminated
uint32_t test_decompose_ct(uint32_t r) {
    uint32_t r1;
    int32_t r0;
    decompose_constant_time(r, GAMMA2_87, &r1, &r0);
    return r1 + (uint32_t)r0;
}

uint32_t test_use_hint_ct(uint32_t r, uint32_t hint) {
    return use_hint_constant_time(r, hint, GAMMA2_87);
}
