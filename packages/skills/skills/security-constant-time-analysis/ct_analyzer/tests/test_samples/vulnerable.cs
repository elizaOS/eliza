/**
 * Vulnerable C# code sample for constant-time analysis testing.
 *
 * This file demonstrates common timing side-channel vulnerabilities in C#:
 * - Variable-time division operations
 * - Timing-unsafe comparisons
 * - Variable-latency math operations
 * - Predictable randomness
 *
 * DO NOT USE THIS CODE IN PRODUCTION - it is intentionally vulnerable.
 */

using System;
using System.Linq;

public class Vulnerable
{
    /// <summary>
    /// Vulnerable modular reduction using division.
    /// Division has data-dependent timing on most platforms.
    /// </summary>
    public static int VulnerableModReduce(int value, int modulus)
    {
        // VULNERABLE: Division has variable-time execution (div opcode)
        int quotient = value / modulus;
        // VULNERABLE: Modulo has variable-time execution (rem opcode)
        int remainder = value % modulus;

        // Use quotient to prevent dead code elimination
        if (quotient < 0)
        {
            throw new ArgumentException("Unexpected negative quotient");
        }

        return remainder;
    }

    /// <summary>
    /// Vulnerable long division.
    /// Long division also has timing side-channels.
    /// </summary>
    public static long VulnerableLongDivide(long value, long divisor)
    {
        // VULNERABLE: Long division has variable-time execution
        return value / divisor;
    }

    /// <summary>
    /// Vulnerable floating-point division.
    /// </summary>
    public static double VulnerableFloatDivide(double a, double b)
    {
        // VULNERABLE: Float division has variable latency
        return a / b;
    }

    /// <summary>
    /// Vulnerable token comparison using SequenceEqual().
    /// This leaks timing information about how many bytes match.
    /// </summary>
    public static bool VulnerableTokenCompare(byte[] provided, byte[] expected)
    {
        // VULNERABLE: SequenceEqual() may early-exit on mismatch
        return provided.SequenceEqual(expected);
    }

    /// <summary>
    /// Vulnerable string comparison using Equals().
    /// String.Equals() has early-exit behavior.
    /// </summary>
    public static bool VulnerableStringCompare(string provided, string expected)
    {
        // VULNERABLE: String.Equals() may early-exit
        return provided.Equals(expected);
    }

    /// <summary>
    /// Vulnerable square root calculation.
    /// Math.Sqrt() has variable latency based on operand values.
    /// </summary>
    public static double VulnerableSqrt(double value)
    {
        // VULNERABLE: Math.Sqrt has variable latency
        return Math.Sqrt(value);
    }

    /// <summary>
    /// Vulnerable power calculation.
    /// Math.Pow() has variable latency based on operand values.
    /// </summary>
    public static double VulnerablePow(double baseVal, double exponent)
    {
        // VULNERABLE: Math.Pow has variable latency
        return Math.Pow(baseVal, exponent);
    }

    /// <summary>
    /// Vulnerable random number generation.
    /// System.Random is predictable and not cryptographically secure.
    /// </summary>
    public static int VulnerableRandomInt(int maxValue)
    {
        // VULNERABLE: System.Random is predictable
        Random rand = new Random();
        return rand.Next(maxValue);
    }

    /// <summary>
    /// Vulnerable decompose function similar to ML-DSA.
    /// Demonstrates the KyberSlash-style vulnerability.
    /// </summary>
    public static (int r1, int r0) VulnerableDecompose(int r, int gamma2)
    {
        // VULNERABLE: Division has variable-time execution
        int r1 = (r + 127) / (2 * gamma2);

        // VULNERABLE: Modulo has variable-time execution
        int r0 = r % (2 * gamma2);

        // Centering
        if (r0 > gamma2)
        {
            r0 -= 2 * gamma2;
            r1 += 1;
        }

        return (r1, r0);
    }

    /// <summary>
    /// Vulnerable table lookup using secret as index.
    /// This leaks timing through cache behavior.
    /// </summary>
    public static int VulnerableTableLookup(int secretIndex, int[] table)
    {
        // VULNERABLE: Array access indexed by secret leaks cache timing
        return table[secretIndex];
    }

    /// <summary>
    /// Test harness to prevent dead code elimination.
    /// </summary>
    public static void Main(string[] args)
    {
        Console.WriteLine("Running vulnerable operations for testing...");

        int result1 = VulnerableModReduce(12345, 97);
        Console.WriteLine($"Mod reduce: {result1}");

        long result2 = VulnerableLongDivide(1234567890L, 12345L);
        Console.WriteLine($"Long divide: {result2}");

        double result3 = VulnerableFloatDivide(10.0, 3.0);
        Console.WriteLine($"Float divide: {result3}");

        byte[] a = { 1, 2, 3 };
        byte[] b = { 1, 2, 3 };
        bool result4 = VulnerableTokenCompare(a, b);
        Console.WriteLine($"Token compare: {result4}");

        double result5 = VulnerableSqrt(144);
        Console.WriteLine($"Sqrt: {result5}");

        int result6 = VulnerableRandomInt(100);
        Console.WriteLine($"Random: {result6}");

        var result7 = VulnerableDecompose(1000, 261888);
        Console.WriteLine($"Decompose: r1={result7.r1}, r0={result7.r0}");

        int[] table = { 1, 2, 3, 4, 5, 6, 7, 8 };
        int result8 = VulnerableTableLookup(5, table);
        Console.WriteLine($"Table lookup: {result8}");
    }
}
