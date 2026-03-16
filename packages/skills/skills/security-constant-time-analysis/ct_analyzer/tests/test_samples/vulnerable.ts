/**
 * Vulnerable TypeScript code sample for constant-time analysis testing.
 *
 * This file demonstrates common timing side-channel vulnerabilities in JavaScript/TypeScript:
 * - Variable-time division operations
 * - Timing-unsafe string comparisons
 * - Variable-latency math operations
 * - Predictable randomness
 *
 * DO NOT USE THIS CODE IN PRODUCTION - it is intentionally vulnerable.
 */

/**
 * Vulnerable modular reduction using division.
 * Division has data-dependent timing on most platforms.
 */
export function vulnerableModReduce(value: number, modulus: number): number {
    // VULNERABLE: Division has variable-time execution
    const quotient = Math.floor(value / modulus);
    // VULNERABLE: Modulo has variable-time execution
    const remainder = value % modulus;

    // Use quotient to prevent dead code elimination
    if (quotient < 0) {
        throw new Error("Unexpected negative quotient");
    }

    return remainder;
}

/**
 * Vulnerable token comparison using early-exit equality.
 * This leaks timing information about how many characters match.
 */
export function vulnerableTokenCompare(provided: string, expected: string): boolean {
    // VULNERABLE: === on strings may early-exit
    return provided === expected;
}

/**
 * Vulnerable comparison using localeCompare.
 * localeCompare() has variable-time execution.
 */
export function vulnerableLocaleCompare(a: string, b: string): boolean {
    // VULNERABLE: localeCompare has variable-time execution
    return a.localeCompare(b) === 0;
}

/**
 * Vulnerable string search using indexOf.
 * indexOf() has early-terminating behavior.
 */
export function vulnerableStringSearch(haystack: string, needle: string): boolean {
    // VULNERABLE: indexOf has early-terminating behavior
    return haystack.indexOf(needle) !== -1;
}

/**
 * Vulnerable string check using includes.
 * includes() has early-terminating behavior.
 */
export function vulnerableIncludes(haystack: string, needle: string): boolean {
    // VULNERABLE: includes has early-terminating behavior
    return haystack.includes(needle);
}

/**
 * Vulnerable square root calculation.
 * Math.sqrt() has variable latency based on operand values.
 */
export function vulnerableSqrt(value: number): number {
    // VULNERABLE: Math.sqrt has variable latency
    return Math.sqrt(value);
}

/**
 * Vulnerable power calculation.
 * Math.pow() has variable latency based on operand values.
 */
export function vulnerablePow(base: number, exponent: number): number {
    // VULNERABLE: Math.pow has variable latency
    return Math.pow(base, exponent);
}

/**
 * Vulnerable random number generation.
 * Math.random() is predictable and not cryptographically secure.
 */
export function vulnerableRandomToken(length: number): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let token = '';

    for (let i = 0; i < length; i++) {
        // VULNERABLE: Math.random is predictable
        token += chars[Math.floor(Math.random() * chars.length)];
    }

    return token;
}

/**
 * Vulnerable string prefix check using startsWith.
 * startsWith() has early-terminating behavior.
 */
export function vulnerableStartsWith(str: string, prefix: string): boolean {
    // VULNERABLE: startsWith has early-terminating behavior
    return str.startsWith(prefix);
}

/**
 * Vulnerable ML-DSA-like decompose function with division.
 * Demonstrates the KyberSlash-style vulnerability.
 */
export function vulnerableDecompose(r: number, gamma2: number): { r1: number; r0: number } {
    // VULNERABLE: Division has variable-time execution
    let r1 = Math.floor((r + 127) / (2 * gamma2));

    // VULNERABLE: Modulo has variable-time execution
    let r0 = r % (2 * gamma2);

    // Centering
    if (r0 > gamma2) {
        r0 -= 2 * gamma2;
        r1 += 1;
    }

    return { r1, r0 };
}

// Test harness to prevent dead code elimination
function runTests(): void {
    console.log("Running vulnerable operations for testing...");

    const result1 = vulnerableModReduce(12345, 97);
    console.log(`Mod reduce: ${result1}`);

    const result2 = vulnerableTokenCompare("secret123", "secret123");
    console.log(`Token compare: ${result2}`);

    const result3 = vulnerableSqrt(144);
    console.log(`Sqrt: ${result3}`);

    const result4 = vulnerablePow(2, 10);
    console.log(`Pow: ${result4}`);

    const result5 = vulnerableRandomToken(16);
    console.log(`Token: ${result5}`);

    const result6 = vulnerableDecompose(1000, 261888);
    console.log(`Decompose: r1=${result6.r1}, r0=${result6.r0}`);
}

// Export for testing
export { runTests };
