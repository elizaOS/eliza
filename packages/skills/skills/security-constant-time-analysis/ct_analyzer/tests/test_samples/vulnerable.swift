/**
 * Vulnerable Swift code sample for constant-time analysis testing.
 *
 * This file demonstrates common timing side-channel vulnerabilities in Swift:
 * - Variable-time division operations
 * - Timing-unsafe comparisons
 * - Variable-latency math operations
 * - Branching on secret values
 *
 * DO NOT USE THIS CODE IN PRODUCTION - it is intentionally vulnerable.
 */

import Foundation

/**
 * Vulnerable modular reduction using division.
 * Division has data-dependent timing on most platforms.
 */
func vulnerableModReduce(value: Int32, modulus: Int32) -> Int32 {
    // VULNERABLE: Division has variable-time execution (SDIV on ARM64, IDIV on x86)
    let quotient = value / modulus
    // VULNERABLE: Modulo has variable-time execution
    let remainder = value % modulus

    // Use quotient to prevent dead code elimination
    precondition(quotient >= 0, "Unexpected negative quotient")

    return remainder
}

/**
 * Vulnerable unsigned division.
 */
func vulnerableUnsignedDivide(value: UInt32, divisor: UInt32) -> UInt32 {
    // VULNERABLE: Unsigned division has variable-time execution (UDIV on ARM64)
    return value / divisor
}

/**
 * Vulnerable 64-bit division.
 */
func vulnerableLongDivide(value: Int64, divisor: Int64) -> Int64 {
    // VULNERABLE: 64-bit division has variable-time execution
    return value / divisor
}

/**
 * Vulnerable floating-point division.
 */
func vulnerableFloatDivide(a: Double, b: Double) -> Double {
    // VULNERABLE: Float division has variable latency (FDIV on ARM64)
    return a / b
}

/**
 * Vulnerable token comparison using == operator.
 * This may early-exit on mismatch.
 */
func vulnerableTokenCompare(provided: [UInt8], expected: [UInt8]) -> Bool {
    // VULNERABLE: Array == comparison may early-exit
    return provided == expected
}

/**
 * Vulnerable string comparison.
 */
func vulnerableStringCompare(provided: String, expected: String) -> Bool {
    // VULNERABLE: String == comparison has variable timing
    return provided == expected
}

/**
 * Vulnerable square root calculation.
 * sqrt() has variable latency based on operand values.
 */
func vulnerableSqrt(value: Double) -> Double {
    // VULNERABLE: sqrt has variable latency (FSQRT on ARM64)
    return sqrt(value)
}

/**
 * Vulnerable power calculation.
 */
func vulnerablePow(base: Double, exponent: Double) -> Double {
    // VULNERABLE: pow has variable latency
    return pow(base, exponent)
}

/**
 * Vulnerable decompose function similar to ML-DSA.
 * Demonstrates the KyberSlash-style vulnerability.
 */
func vulnerableDecompose(r: Int32, gamma2: Int32) -> (Int32, Int32) {
    // VULNERABLE: Division has variable-time execution
    var r1 = (r + 127) / (2 * gamma2)

    // VULNERABLE: Modulo has variable-time execution
    var r0 = r % (2 * gamma2)

    // VULNERABLE: Branch based on computed value
    if r0 > gamma2 {
        r0 -= 2 * gamma2
        r1 += 1
    }

    return (r1, r0)
}

/**
 * Vulnerable table lookup using secret as index.
 * This leaks timing through cache behavior.
 */
func vulnerableTableLookup(secretIndex: Int, table: [Int]) -> Int {
    // VULNERABLE: Array access indexed by secret leaks cache timing
    return table[secretIndex]
}

/**
 * Vulnerable conditional selection.
 * Ternary operator compiles to conditional branch.
 */
func vulnerableConditionalSelect(secret: Int32, a: Int32, b: Int32) -> Int32 {
    // VULNERABLE: Ternary compiles to conditional branch
    return secret != 0 ? a : b
}

/**
 * Vulnerable switch on secret value.
 */
func vulnerableSwitch(secretValue: Int) -> String {
    // VULNERABLE: Switch compiles to conditional branches or jump table
    switch secretValue {
    case 0:
        return "zero"
    case 1:
        return "one"
    case 2:
        return "two"
    default:
        return "other"
    }
}

/**
 * Vulnerable optional unwrapping.
 */
func vulnerableOptionalUnwrap(maybeSecret: Int?) -> Int {
    // VULNERABLE: Optional unwrapping introduces branches
    if let secret = maybeSecret {
        return secret * 2
    }
    return 0
}

/**
 * Test harness to prevent dead code elimination.
 */
func runTests() {
    print("Running vulnerable operations for testing...")

    let result1 = vulnerableModReduce(value: 12345, modulus: 97)
    print("Mod reduce: \(result1)")

    let result2 = vulnerableUnsignedDivide(value: 12345, divisor: 97)
    print("Unsigned divide: \(result2)")

    let result3 = vulnerableLongDivide(value: 1234567890, divisor: 12345)
    print("Long divide: \(result3)")

    let result4 = vulnerableFloatDivide(a: 10.0, b: 3.0)
    print("Float divide: \(result4)")

    let a: [UInt8] = [1, 2, 3]
    let b: [UInt8] = [1, 2, 3]
    let result5 = vulnerableTokenCompare(provided: a, expected: b)
    print("Token compare: \(result5)")

    let result6 = vulnerableSqrt(value: 144.0)
    print("Sqrt: \(result6)")

    let result7 = vulnerablePow(base: 2.0, exponent: 10.0)
    print("Pow: \(result7)")

    let (r1, r0) = vulnerableDecompose(r: 1000, gamma2: 261888)
    print("Decompose: r1=\(r1), r0=\(r0)")

    let table = [1, 2, 3, 4, 5, 6, 7, 8]
    let result8 = vulnerableTableLookup(secretIndex: 5, table: table)
    print("Table lookup: \(result8)")

    let result9 = vulnerableConditionalSelect(secret: 1, a: 100, b: 200)
    print("Conditional select: \(result9)")

    let result10 = vulnerableSwitch(secretValue: 1)
    print("Switch result: \(result10)")
}

// Run the tests
runTests()
