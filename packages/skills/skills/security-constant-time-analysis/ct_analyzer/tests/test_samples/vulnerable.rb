# Vulnerable Ruby code sample for constant-time analysis testing.
#
# This file demonstrates common timing side-channel vulnerabilities in Ruby:
# - Variable-time division operations
# - Timing-unsafe string comparisons
# - Variable-latency math operations
# - Predictable randomness
# - Table lookups indexed by secrets
# - Variable-length encoding functions
# - Bit shift operations
#
# DO NOT USE THIS CODE IN PRODUCTION - it is intentionally vulnerable.

require 'json'
require 'base64'

# Vulnerable modular reduction using division.
# Division has data-dependent timing on most platforms.
def vulnerable_mod_reduce(value, modulus)
  # VULNERABLE: Division has variable-time execution
  quotient = value / modulus
  # VULNERABLE: Modulo has variable-time execution
  remainder = value % modulus

  # Use quotient to prevent dead code elimination
  raise "Unexpected negative quotient" if quotient < 0

  remainder
end

# Vulnerable token comparison using early-exit equality.
# This leaks timing information about how many characters match.
def vulnerable_token_compare(provided, expected)
  # VULNERABLE: == on strings may early-exit
  provided == expected
end

# Vulnerable string search using include?.
# include?() has early-terminating behavior.
def vulnerable_string_search(haystack, needle)
  # VULNERABLE: include? has early-terminating behavior
  haystack.include?(needle)
end

# Vulnerable string prefix check using start_with?.
# start_with?() has early-terminating behavior.
def vulnerable_string_startswith(text, prefix)
  # VULNERABLE: start_with? has early-terminating behavior
  text.start_with?(prefix)
end

# Vulnerable square root calculation.
# Math.sqrt() has variable latency based on operand values.
def vulnerable_sqrt(value)
  # VULNERABLE: Math.sqrt has variable latency
  Math.sqrt(value)
end

# Vulnerable random number generation.
# rand() is predictable and not cryptographically secure.
def vulnerable_random_token(length)
  chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  token = ""

  length.times do
    # VULNERABLE: rand is predictable
    token += chars[rand(chars.length)]
  end

  token
end

# Vulnerable random integer generation.
# rand() is predictable.
def vulnerable_random_int(min_val, max_val)
  # VULNERABLE: rand is predictable
  rand(min_val..max_val)
end

# Vulnerable ML-DSA-like decompose function with division.
# Demonstrates the KyberSlash-style vulnerability.
def vulnerable_decompose(r, gamma2)
  # VULNERABLE: Division has variable-time execution
  r1 = (r + 127) / (2 * gamma2)

  # VULNERABLE: Modulo has variable-time execution
  r0 = r % (2 * gamma2)

  # Centering
  if r0 > gamma2
    r0 -= 2 * gamma2
    r1 += 1
  end

  [r1, r0]
end

# Vulnerable regex matching.
# =~ has variable-time execution.
def vulnerable_regex_match(text, pattern)
  # VULNERABLE: =~ has variable-time execution
  text =~ pattern
end

# Vulnerable table lookup using secret as index.
# This leaks timing through cache behavior.
def vulnerable_table_lookup(secret_index, table)
  # VULNERABLE: Array access indexed by secret leaks cache timing
  table[secret_index]
end

# Vulnerable S-box lookup (common in AES implementations).
# Cache timing varies based on which cache line is accessed.
def vulnerable_sbox_lookup(secret_byte)
  # Standard AES S-box (first 16 values as example)
  sbox = [
    0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5,
    0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  ]
  # VULNERABLE: Table lookup indexed by secret byte
  sbox[secret_byte % sbox.length]
end

# Vulnerable bit shift where shift amount depends on secret.
def vulnerable_bit_shift(secret, shift_amount)
  # VULNERABLE: Left shift amount derived from secret
  result = 1 << shift_amount
  # VULNERABLE: Right shift
  result2 = secret >> (shift_amount % 8)
  result + result2
end

# Vulnerable encoding of secret data.
# Variable-length output leaks information about input.
def vulnerable_encode_secret(secret)
  # VULNERABLE: Base64 output length depends on input
  Base64.encode64(secret)
end

# Vulnerable JSON encoding of secret data.
# Output length and encoding time varies with input.
def vulnerable_json_encode(secret_data)
  # VULNERABLE: JSON encoding produces variable-length output
  secret_data.to_json
end

# Vulnerable pack operation.
def vulnerable_pack_secret(values)
  # VULNERABLE: pack may leak data length via timing
  values.pack("C*")
end

# Test harness to prevent dead code elimination
def run_tests
  puts "Running vulnerable operations for testing..."

  result1 = vulnerable_mod_reduce(12345, 97)
  puts "Mod reduce: #{result1}"

  result2 = vulnerable_token_compare("secret123", "secret123")
  puts "Token compare: #{result2}"

  result3 = vulnerable_sqrt(144)
  puts "Sqrt: #{result3}"

  result5 = vulnerable_random_token(16)
  puts "Token: #{result5}"

  result6 = vulnerable_decompose(1000, 261888)
  puts "Decompose: r1=#{result6[0]}, r0=#{result6[1]}"

  result7 = vulnerable_table_lookup(5, [1, 2, 3, 4, 5, 6, 7, 8])
  puts "Table lookup: #{result7}"

  result8 = vulnerable_sbox_lookup(10)
  puts "S-box lookup: #{result8}"

  result9 = vulnerable_bit_shift(0xDEADBEEF, 4)
  puts "Bit shift: #{result9}"

  result10 = vulnerable_encode_secret("secret")
  puts "Encoded: #{result10}"

  result11 = vulnerable_json_encode({ "key" => "value" })
  puts "JSON: #{result11}"
end

run_tests if __FILE__ == $PROGRAM_NAME
