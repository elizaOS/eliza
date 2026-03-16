/**
 * Vulnerable Kotlin code sample for constant-time analysis testing.
 *
 * This file demonstrates common timing side-channel vulnerabilities in Kotlin:
 * - Variable-time division operations
 * - Timing-unsafe comparisons
 * - Variable-latency math operations
 * - Predictable randomness
 *
 * DO NOT USE THIS CODE IN PRODUCTION - it is intentionally vulnerable.
 */

import kotlin.random.Random
import kotlin.math.sqrt
import kotlin.math.pow

/**
 * Vulnerable modular reduction using division.
 * Division has data-dependent timing on most platforms.
 */
fun vulnerableModReduce(value: Int, modulus: Int): Int {
    // VULNERABLE: Division has variable-time execution (idiv bytecode)
    val quotient = value / modulus
    // VULNERABLE: Modulo has variable-time execution (irem bytecode)
    val remainder = value % modulus

    // Use quotient to prevent dead code elimination
    require(quotient >= 0) { "Unexpected negative quotient" }

    return remainder
}

/**
 * Vulnerable long division.
 * Long division (ldiv) also has timing side-channels.
 */
fun vulnerableLongDivide(value: Long, divisor: Long): Long {
    // VULNERABLE: Long division has variable-time execution (ldiv bytecode)
    return value / divisor
}

/**
 * Vulnerable floating-point division.
 */
fun vulnerableFloatDivide(a: Double, b: Double): Double {
    // VULNERABLE: Float division has variable latency (ddiv bytecode)
    return a / b
}

/**
 * Vulnerable token comparison using contentEquals().
 * This leaks timing information about how many bytes match.
 */
fun vulnerableTokenCompare(provided: ByteArray, expected: ByteArray): Boolean {
    // VULNERABLE: contentEquals() may early-exit on mismatch
    return provided.contentEquals(expected)
}

/**
 * Vulnerable string comparison using equals().
 * String.equals() has early-exit behavior.
 */
fun vulnerableStringCompare(provided: String, expected: String): Boolean {
    // VULNERABLE: String == comparison may early-exit
    return provided == expected
}

/**
 * Vulnerable square root calculation.
 * sqrt() has variable latency based on operand values.
 */
fun vulnerableSqrt(value: Double): Double {
    // VULNERABLE: sqrt has variable latency
    return sqrt(value)
}

/**
 * Vulnerable power calculation.
 * pow() has variable latency based on operand values.
 */
fun vulnerablePow(base: Double, exponent: Double): Double {
    // VULNERABLE: pow has variable latency
    return base.pow(exponent)
}

/**
 * Vulnerable random number generation.
 * kotlin.random.Random is predictable and not cryptographically secure.
 */
fun vulnerableRandomInt(bound: Int): Int {
    // VULNERABLE: kotlin.random.Random is predictable
    return Random.nextInt(bound)
}

/**
 * Vulnerable random using Random.Default singleton.
 */
fun vulnerableRandomDefault(): Int {
    // VULNERABLE: Random.Default is predictable
    return Random.Default.nextInt()
}

/**
 * Vulnerable decompose function similar to ML-DSA.
 * Demonstrates the KyberSlash-style vulnerability.
 */
fun vulnerableDecompose(r: Int, gamma2: Int): Pair<Int, Int> {
    // VULNERABLE: Division has variable-time execution
    var r1 = (r + 127) / (2 * gamma2)

    // VULNERABLE: Modulo has variable-time execution
    var r0 = r % (2 * gamma2)

    // Centering
    if (r0 > gamma2) {
        r0 -= 2 * gamma2
        r1 += 1
    }

    return Pair(r1, r0)
}

/**
 * Vulnerable table lookup using secret as index.
 * This leaks timing through cache behavior.
 */
fun vulnerableTableLookup(secretIndex: Int, table: IntArray): Int {
    // VULNERABLE: Array access indexed by secret leaks cache timing
    return table[secretIndex]
}

/**
 * Vulnerable when expression on secret value.
 * Switch/when statements may leak timing based on case.
 */
fun vulnerableWhenExpression(secretValue: Int): String {
    // VULNERABLE: when compiles to tableswitch/lookupswitch
    return when (secretValue) {
        0 -> "zero"
        1 -> "one"
        2 -> "two"
        else -> "other"
    }
}

/**
 * Test harness to prevent dead code elimination.
 */
fun main() {
    println("Running vulnerable operations for testing...")

    val result1 = vulnerableModReduce(12345, 97)
    println("Mod reduce: $result1")

    val result2 = vulnerableLongDivide(1234567890L, 12345L)
    println("Long divide: $result2")

    val result3 = vulnerableFloatDivide(10.0, 3.0)
    println("Float divide: $result3")

    val a = byteArrayOf(1, 2, 3)
    val b = byteArrayOf(1, 2, 3)
    val result4 = vulnerableTokenCompare(a, b)
    println("Token compare: $result4")

    val result5 = vulnerableSqrt(144.0)
    println("Sqrt: $result5")

    val result6 = vulnerableRandomInt(100)
    println("Random: $result6")

    val (r1, r0) = vulnerableDecompose(1000, 261888)
    println("Decompose: r1=$r1, r0=$r0")

    val table = intArrayOf(1, 2, 3, 4, 5, 6, 7, 8)
    val result8 = vulnerableTableLookup(5, table)
    println("Table lookup: $result8")

    val result9 = vulnerableWhenExpression(1)
    println("When result: $result9")
}
