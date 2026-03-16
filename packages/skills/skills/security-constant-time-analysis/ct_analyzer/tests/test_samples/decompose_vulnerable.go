// Package decompose contains vulnerable implementations of ML-DSA decompose
// for testing the constant-time analyzer.
//
// DO NOT use this in production - for testing purposes only.
package main

// ML-DSA parameters
const (
	Q       = 8380417
	Gamma87 = (Q - 1) / 32  // 261888 for ML-DSA-87
	Gamma44 = (Q - 1) / 88  // 95232 for ML-DSA-44/65
)

// DecomposeVulnerable uses hardware division which has data-dependent timing.
// This is vulnerable to timing side-channel attacks like KyberSlash.
//
// VULNERABLE: Uses / and % operators which compile to DIV instructions
// that have variable execution time based on operand values.
func DecomposeVulnerable(r int32, gamma2 int32) (r1 int32, r0 int32) {
	twoGamma2 := 2 * gamma2

	// VULNERABLE: Hardware division with data-dependent timing
	r1 = r / twoGamma2
	r0 = r % twoGamma2

	// Center r0 around 0
	// VULNERABLE: Branch on r0 which may depend on secret data
	if r0 > gamma2 {
		r0 -= twoGamma2
		r1 += 1
	}

	return r1, r0
}

// UseHintVulnerable uses branches on potentially secret-derived data.
//
// VULNERABLE: Contains conditional branches that may leak timing information
// when the hint or r values are derived from secret data.
func UseHintVulnerable(r int32, hint int32, gamma2 int32) int32 {
	r1, r0 := DecomposeVulnerable(r, gamma2)

	m := (Q - 1) / (2 * gamma2)

	// VULNERABLE: Branch on hint which may depend on secret data
	if hint == 0 {
		return r1
	}

	// VULNERABLE: Branch on r0's sign
	if r0 > 0 {
		return (r1 + 1) % (m + 1)
	}
	return (r1 - 1 + m + 1) % (m + 1)
}

// PowerDecomposeVulnerable demonstrates another vulnerable pattern:
// using division for power-of-2 decomposition instead of bit shifts.
func PowerDecomposeVulnerable(r int32, d int32) (r1 int32, r0 int32) {
	// VULNERABLE: Should use bit shifts instead of division
	// This compiles to IDIV even though it could be a simple shift
	divisor := int32(1) << d
	r1 = r / divisor
	r0 = r % divisor
	return r1, r0
}

func main() {
	// Test calls to prevent dead code elimination
	r1, r0 := DecomposeVulnerable(12345, Gamma87)
	_ = r1 + r0

	result := UseHintVulnerable(12345, 1, Gamma87)
	_ = result

	r1p, r0p := PowerDecomposeVulnerable(12345, 13)
	_ = r1p + r0p
}
