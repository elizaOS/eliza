"""
Vulnerable Python code sample for constant-time analysis testing.

This file demonstrates common timing side-channel vulnerabilities in Python:
- Variable-time division operations
- Timing-unsafe string comparisons
- Variable-latency math operations
- Predictable randomness
- Table lookups indexed by secrets
- Variable-length encoding functions
- Bit shift operations

DO NOT USE THIS CODE IN PRODUCTION - it is intentionally vulnerable.
"""

import base64
import json
import math
import random
import struct


def vulnerable_mod_reduce(value: int, modulus: int) -> int:
    """
    Vulnerable modular reduction using division.
    Division has data-dependent timing on most platforms.
    """
    # VULNERABLE: Division has variable-time execution
    quotient = value // modulus
    # VULNERABLE: Modulo has variable-time execution
    remainder = value % modulus

    # Use quotient to prevent dead code elimination
    if quotient < 0:
        raise ValueError("Unexpected negative quotient")

    return remainder


def vulnerable_token_compare(provided: str, expected: str) -> bool:
    """
    Vulnerable token comparison using early-exit equality.
    This leaks timing information about how many characters match.
    """
    # VULNERABLE: == on strings may early-exit
    return provided == expected


def vulnerable_string_search(haystack: str, needle: str) -> bool:
    """
    Vulnerable string search using find.
    find() has early-terminating behavior.
    """
    # VULNERABLE: find has early-terminating behavior
    return haystack.find(needle) != -1


def vulnerable_string_startswith(text: str, prefix: str) -> bool:
    """
    Vulnerable string prefix check using startswith.
    startswith() has early-terminating behavior.
    """
    # VULNERABLE: startswith has early-terminating behavior
    return text.startswith(prefix)


def vulnerable_sqrt(value: float) -> float:
    """
    Vulnerable square root calculation.
    math.sqrt() has variable latency based on operand values.
    """
    # VULNERABLE: math.sqrt has variable latency
    return math.sqrt(value)


def vulnerable_pow(base: float, exponent: float) -> float:
    """
    Vulnerable power calculation.
    math.pow() has variable latency based on operand values.
    """
    # VULNERABLE: math.pow has variable latency
    return math.pow(base, exponent)


def vulnerable_random_token(length: int) -> str:
    """
    Vulnerable random number generation.
    random module is predictable and not cryptographically secure.
    """
    chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    token = ""

    for _ in range(length):
        # VULNERABLE: random.choice is predictable
        token += random.choice(chars)

    return token


def vulnerable_random_int(min_val: int, max_val: int) -> int:
    """
    Vulnerable random integer generation.
    random.randint() is predictable.
    """
    # VULNERABLE: random.randint is predictable
    return random.randint(min_val, max_val)


def vulnerable_decompose(r: int, gamma2: int) -> tuple[int, int]:
    """
    Vulnerable ML-DSA-like decompose function with division.
    Demonstrates the KyberSlash-style vulnerability.
    """
    # VULNERABLE: Division has variable-time execution
    r1 = (r + 127) // (2 * gamma2)

    # VULNERABLE: Modulo has variable-time execution
    r0 = r % (2 * gamma2)

    # Centering
    if r0 > gamma2:
        r0 -= 2 * gamma2
        r1 += 1

    return r1, r0


def vulnerable_table_lookup(secret_index: int, table: list) -> int:
    """
    Vulnerable table lookup using secret as index.
    This leaks timing through cache behavior.
    """
    # VULNERABLE: Array access indexed by secret leaks cache timing
    return table[secret_index]


def vulnerable_sbox_lookup(secret_byte: int) -> int:
    """
    Vulnerable S-box lookup (common in AES implementations).
    Cache timing varies based on which cache line is accessed.
    """
    # Standard AES S-box (first 16 values as example)
    sbox = [
        0x63,
        0x7C,
        0x77,
        0x7B,
        0xF2,
        0x6B,
        0x6F,
        0xC5,
        0x30,
        0x01,
        0x67,
        0x2B,
        0xFE,
        0xD7,
        0xAB,
        0x76,
    ]
    # VULNERABLE: Table lookup indexed by secret byte
    return sbox[secret_byte % len(sbox)]


def vulnerable_bit_shift(secret: int, shift_amount: int) -> int:
    """
    Vulnerable bit shift where shift amount depends on secret.
    """
    # VULNERABLE: Left shift amount derived from secret
    result = 1 << shift_amount
    # VULNERABLE: Right shift
    result2 = secret >> (shift_amount % 8)
    return result + result2


def vulnerable_encode_secret(secret: bytes) -> str:
    """
    Vulnerable encoding of secret data.
    Variable-length output leaks information about input.
    """
    # VULNERABLE: Base64 output length depends on input
    encoded = base64.b64encode(secret).decode()
    return encoded


def vulnerable_json_encode(secret_data: dict) -> str:
    """
    Vulnerable JSON encoding of secret data.
    Output length and encoding time varies with input.
    """
    # VULNERABLE: JSON encoding produces variable-length output
    return json.dumps(secret_data)


def vulnerable_struct_pack(secret_value: int) -> bytes:
    """
    Vulnerable struct packing.
    """
    # VULNERABLE: struct.pack timing may vary
    return struct.pack(">I", secret_value)


def vulnerable_int_to_bytes(secret: int) -> bytes:
    """
    Vulnerable integer to bytes conversion.
    Output length reveals information about the integer size.
    """
    # VULNERABLE: to_bytes output length may leak integer magnitude
    byte_length = (secret.bit_length() + 7) // 8 or 1
    return secret.to_bytes(byte_length, "big")


def run_tests() -> None:
    """Test harness to prevent dead code elimination."""
    print("Running vulnerable operations for testing...")

    result1 = vulnerable_mod_reduce(12345, 97)
    print(f"Mod reduce: {result1}")

    result2 = vulnerable_token_compare("secret123", "secret123")
    print(f"Token compare: {result2}")

    result3 = vulnerable_sqrt(144)
    print(f"Sqrt: {result3}")

    result4 = vulnerable_pow(2, 10)
    print(f"Pow: {result4}")

    result5 = vulnerable_random_token(16)
    print(f"Token: {result5}")

    result6 = vulnerable_decompose(1000, 261888)
    print(f"Decompose: r1={result6[0]}, r0={result6[1]}")

    result7 = vulnerable_table_lookup(5, [1, 2, 3, 4, 5, 6, 7, 8])
    print(f"Table lookup: {result7}")

    result8 = vulnerable_sbox_lookup(10)
    print(f"S-box lookup: {result8}")

    result9 = vulnerable_bit_shift(0xDEADBEEF, 4)
    print(f"Bit shift: {result9}")

    result10 = vulnerable_encode_secret(b"secret")
    print(f"Encoded: {result10}")

    result11 = vulnerable_json_encode({"key": "value"})
    print(f"JSON: {result11}")


if __name__ == "__main__":
    run_tests()
