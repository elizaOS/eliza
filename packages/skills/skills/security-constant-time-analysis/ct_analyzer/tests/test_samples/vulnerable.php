<?php
/**
 * Vulnerable PHP code sample for constant-time analysis testing.
 *
 * This file demonstrates common timing side-channel vulnerabilities in PHP:
 * - Variable-time division operations
 * - Timing-unsafe string comparisons
 * - Cache-timing side-channels via table lookups
 * - Predictable randomness
 *
 * DO NOT USE THIS CODE IN PRODUCTION - it is intentionally vulnerable.
 */

/**
 * Vulnerable modular reduction using division.
 * The division and modulo operations have data-dependent timing.
 */
function vulnerable_mod_reduce(int $value, int $modulus): int
{
    // VULNERABLE: Division has data-dependent timing
    $quotient = intdiv($value, $modulus);
    // VULNERABLE: Modulo has data-dependent timing
    $remainder = $value % $modulus;
    return $remainder;
}

/**
 * Vulnerable token comparison using early-exit comparison.
 * This leaks timing information about how many characters match.
 */
function vulnerable_token_compare(string $provided, string $expected): bool
{
    // VULNERABLE: === on strings may early-exit
    return $provided === $expected;
}

/**
 * Vulnerable token comparison using strcmp.
 * strcmp() has variable-time execution.
 */
function vulnerable_strcmp_compare(string $provided, string $expected): bool
{
    // VULNERABLE: strcmp has variable-time execution
    return strcmp($provided, $expected) === 0;
}

/**
 * Vulnerable hex encoding using chr().
 * chr() uses table lookup indexed by secret data.
 */
function vulnerable_byte_to_hex(int $byte): string
{
    $hex_chars = '0123456789abcdef';
    // VULNERABLE: chr() has cache-timing side-channel
    $high = chr(ord($hex_chars[$byte >> 4]));
    $low = chr(ord($hex_chars[$byte & 0x0f]));
    return $high . $low;
}

/**
 * Vulnerable encoding using bin2hex.
 * bin2hex() uses table lookups on secret data.
 */
function vulnerable_encode_secret(string $secret): string
{
    // VULNERABLE: bin2hex uses table lookups
    return bin2hex($secret);
}

/**
 * Vulnerable base64 encoding.
 * base64_encode() uses table lookups on secret data.
 */
function vulnerable_base64_secret(string $secret): string
{
    // VULNERABLE: base64_encode uses table lookups
    return base64_encode($secret);
}

/**
 * Vulnerable random token generation using mt_rand.
 * mt_rand() is predictable and not cryptographically secure.
 */
function vulnerable_generate_token(int $length): string
{
    $chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    $token = '';
    for ($i = 0; $i < $length; $i++) {
        // VULNERABLE: mt_rand is predictable
        $token .= $chars[mt_rand(0, strlen($chars) - 1)];
    }
    return $token;
}

/**
 * Vulnerable unique ID generation using uniqid.
 * uniqid() is predictable.
 */
function vulnerable_generate_id(): string
{
    // VULNERABLE: uniqid is predictable
    return uniqid('prefix_', true);
}

/**
 * Vulnerable array shuffle using shuffle().
 * shuffle() uses mt_rand internally.
 */
function vulnerable_shuffle_array(array $items): array
{
    // VULNERABLE: shuffle uses mt_rand internally
    shuffle($items);
    return $items;
}

// Test harness to prevent dead code elimination
function run_tests(): void
{
    echo "Running vulnerable operations for testing...\n";

    $result1 = vulnerable_mod_reduce(12345, 97);
    echo "Mod reduce: $result1\n";

    $result2 = vulnerable_token_compare("secret123", "secret123");
    echo "Token compare: " . ($result2 ? "true" : "false") . "\n";

    $result3 = vulnerable_byte_to_hex(0xAB);
    echo "Byte to hex: $result3\n";

    $result4 = vulnerable_encode_secret("secret");
    echo "Encoded: $result4\n";

    $result5 = vulnerable_generate_token(16);
    echo "Token: $result5\n";
}

// Only run if executed directly
if (basename(__FILE__) === basename($_SERVER['SCRIPT_FILENAME'] ?? '')) {
    run_tests();
}
