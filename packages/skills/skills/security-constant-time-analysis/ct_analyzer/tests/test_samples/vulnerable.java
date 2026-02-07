/**
 * Vulnerable Java code sample for constant-time analysis testing.
 *
 * This file demonstrates common timing side-channel vulnerabilities in Java:
 * - Variable-time division operations
 * - Timing-unsafe comparisons
 * - Variable-latency math operations
 * - Predictable randomness
 *
 * DO NOT USE THIS CODE IN PRODUCTION - it is intentionally vulnerable.
 */

import java.util.Arrays;
import java.util.Random;

public class vulnerable {

    /**
     * Vulnerable modular reduction using division.
     * Division has data-dependent timing on most platforms.
     */
    public static int vulnerableModReduce(int value, int modulus) {
        // VULNERABLE: Division has variable-time execution (idiv bytecode)
        int quotient = value / modulus;
        // VULNERABLE: Modulo has variable-time execution (irem bytecode)
        int remainder = value % modulus;

        // Use quotient to prevent dead code elimination
        if (quotient < 0) {
            throw new IllegalArgumentException("Unexpected negative quotient");
        }

        return remainder;
    }

    /**
     * Vulnerable long division.
     * Long division (ldiv) also has timing side-channels.
     */
    public static long vulnerableLongDivide(long value, long divisor) {
        // VULNERABLE: Long division has variable-time execution (ldiv bytecode)
        return value / divisor;
    }

    /**
     * Vulnerable floating-point division.
     */
    public static double vulnerableFloatDivide(double a, double b) {
        // VULNERABLE: Float division has variable latency (ddiv bytecode)
        return a / b;
    }

    /**
     * Vulnerable token comparison using Arrays.equals().
     * This leaks timing information about how many bytes match.
     */
    public static boolean vulnerableTokenCompare(byte[] provided, byte[] expected) {
        // VULNERABLE: Arrays.equals() may early-exit on mismatch
        return Arrays.equals(provided, expected);
    }

    /**
     * Vulnerable string comparison using equals().
     * String.equals() has early-exit behavior.
     */
    public static boolean vulnerableStringCompare(String provided, String expected) {
        // VULNERABLE: String.equals() may early-exit
        return provided.equals(expected);
    }

    /**
     * Vulnerable square root calculation.
     * Math.sqrt() has variable latency based on operand values.
     */
    public static double vulnerableSqrt(double value) {
        // VULNERABLE: Math.sqrt has variable latency
        return Math.sqrt(value);
    }

    /**
     * Vulnerable power calculation.
     * Math.pow() has variable latency based on operand values.
     */
    public static double vulnerablePow(double base, double exponent) {
        // VULNERABLE: Math.pow has variable latency
        return Math.pow(base, exponent);
    }

    /**
     * Vulnerable random number generation.
     * java.util.Random is predictable and not cryptographically secure.
     */
    public static int vulnerableRandomInt(int bound) {
        // VULNERABLE: java.util.Random is predictable
        Random rand = new Random();
        return rand.nextInt(bound);
    }

    /**
     * Vulnerable decompose function similar to ML-DSA.
     * Demonstrates the KyberSlash-style vulnerability.
     */
    public static int[] vulnerableDecompose(int r, int gamma2) {
        // VULNERABLE: Division has variable-time execution
        int r1 = (r + 127) / (2 * gamma2);

        // VULNERABLE: Modulo has variable-time execution
        int r0 = r % (2 * gamma2);

        // Centering
        if (r0 > gamma2) {
            r0 -= 2 * gamma2;
            r1 += 1;
        }

        return new int[]{r1, r0};
    }

    /**
     * Vulnerable table lookup using secret as index.
     * This leaks timing through cache behavior.
     */
    public static int vulnerableTableLookup(int secretIndex, int[] table) {
        // VULNERABLE: Array access indexed by secret leaks cache timing
        return table[secretIndex];
    }

    /**
     * Test harness to prevent dead code elimination.
     */
    public static void main(String[] args) {
        System.out.println("Running vulnerable operations for testing...");

        int result1 = vulnerableModReduce(12345, 97);
        System.out.println("Mod reduce: " + result1);

        long result2 = vulnerableLongDivide(1234567890L, 12345L);
        System.out.println("Long divide: " + result2);

        double result3 = vulnerableFloatDivide(10.0, 3.0);
        System.out.println("Float divide: " + result3);

        byte[] a = {1, 2, 3};
        byte[] b = {1, 2, 3};
        boolean result4 = vulnerableTokenCompare(a, b);
        System.out.println("Token compare: " + result4);

        double result5 = vulnerableSqrt(144);
        System.out.println("Sqrt: " + result5);

        int result6 = vulnerableRandomInt(100);
        System.out.println("Random: " + result6);

        int[] result7 = vulnerableDecompose(1000, 261888);
        System.out.println("Decompose: r1=" + result7[0] + ", r0=" + result7[1]);

        int[] table = {1, 2, 3, 4, 5, 6, 7, 8};
        int result8 = vulnerableTableLookup(5, table);
        System.out.println("Table lookup: " + result8);
    }
}
