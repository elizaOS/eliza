//! Vulnerable implementations of ML-DSA decompose for testing the constant-time analyzer.
//!
//! DO NOT use this in production - for testing purposes only.

/// ML-DSA modulus
const Q: i32 = 8380417;

/// Gamma2 for ML-DSA-87
const GAMMA2_87: i32 = (Q - 1) / 32; // 261888

/// Gamma2 for ML-DSA-44/65
const GAMMA2_44: i32 = (Q - 1) / 88; // 95232

/// VULNERABLE: Decompose using hardware division
///
/// This implementation uses the / and % operators which compile to IDIV
/// instructions on x86, which have data-dependent timing.
///
/// This makes it vulnerable to timing side-channel attacks like KyberSlash.
#[inline(never)]
pub fn decompose_vulnerable(r: i32, gamma2: i32) -> (i32, i32) {
    let two_gamma2 = 2 * gamma2;

    // VULNERABLE: Hardware division with data-dependent timing
    let mut r1 = r / two_gamma2;
    let mut r0 = r % two_gamma2;

    // Center r0 around 0
    // VULNERABLE: Branch on r0 which may depend on secret data
    if r0 > gamma2 {
        r0 -= two_gamma2;
        r1 += 1;
    }

    (r1, r0)
}

/// VULNERABLE: UseHint using branches on potentially secret-derived data
///
/// The hint values may be derived from secret data in some contexts,
/// making these branches potentially exploitable.
#[inline(never)]
pub fn use_hint_vulnerable(r: i32, hint: i32, gamma2: i32) -> i32 {
    let (r1, r0) = decompose_vulnerable(r, gamma2);

    let m = (Q - 1) / (2 * gamma2);

    // VULNERABLE: Branch on hint which may depend on secret data
    if hint == 0 {
        return r1;
    }

    // VULNERABLE: Branch on r0's sign
    if r0 > 0 {
        (r1 + 1) % (m + 1)
    } else {
        (r1 - 1 + m + 1) % (m + 1)
    }
}

/// VULNERABLE: Floating-point division
///
/// Uses floating-point division which has variable latency on most processors.
#[inline(never)]
pub fn fp_divide_vulnerable(a: f64, b: f64) -> f64 {
    // VULNERABLE: FDIV/DIVSD has variable latency
    a / b
}

/// VULNERABLE: Square root
///
/// Uses floating-point square root which has variable latency.
#[inline(never)]
pub fn fp_sqrt_vulnerable(x: f64) -> f64 {
    // VULNERABLE: FSQRT/SQRTSD has variable latency
    x.sqrt()
}

fn main() {
    // Test calls to prevent dead code elimination
    let (r1, r0) = decompose_vulnerable(12345, GAMMA2_87);
    println!("Decompose: r1={}, r0={}", r1, r0);

    let result = use_hint_vulnerable(12345, 1, GAMMA2_87);
    println!("UseHint: {}", result);

    let div_result = fp_divide_vulnerable(100.0, 3.0);
    println!("FP Divide: {}", div_result);

    let sqrt_result = fp_sqrt_vulnerable(2.0);
    println!("FP Sqrt: {}", sqrt_result);
}
