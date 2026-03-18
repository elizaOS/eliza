---
name: security-constant-time-analysis
description: "Analyze code for timing side-channel vulnerabilities and ensure constant-time operations for security-sensitive comparisons. Use when reviewing cryptographic implementations, secret comparison code, authentication token validation, or any code where timing leaks could reveal secrets."
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
---

# Constant-Time Analysis

## When to Use

- Reviewing code that compares secrets (tokens, passwords, MACs, signatures)
- Auditing cryptographic implementations for timing leaks
- Checking authentication or authorization code for side-channel risks
- Verifying that branching doesn't depend on secret values
- Analyzing code paths that process sensitive data with variable timing

## When NOT to Use

- Non-security-sensitive comparisons (public data)
- Performance optimization (different goal)
- General code review without cryptographic context

## Why Timing Matters

Non-constant-time string comparison reveals information bit by bit:

```python
# VULNERABLE: Early exit leaks prefix length
def check_token(provided, expected):
    if len(provided) != len(expected):
        return False
    for a, b in zip(provided, expected):
        if a != b:
            return False  # Exits early - timing reveals match position
    return True
```

An attacker can measure response times to determine how many characters match, then brute-force one character at a time.

## Safe Patterns by Language

### Python
```python
import hmac
# SAFE: constant-time comparison
hmac.compare_digest(provided_token, expected_token)

# Also safe for bytes
hmac.compare_digest(provided_hash, expected_hash)
```

### Node.js
```javascript
const crypto = require('crypto');
// SAFE: constant-time comparison
crypto.timingSafeEqual(
  Buffer.from(provided),
  Buffer.from(expected)
);
```

### Go
```go
import "crypto/subtle"
// SAFE: constant-time comparison
subtle.ConstantTimeCompare([]byte(provided), []byte(expected))
```

### Rust
```rust
use subtle::ConstantTimeEq;
// SAFE: constant-time comparison
provided.ct_eq(&expected).into()
```

## Detection Patterns

```bash
# Find potentially unsafe secret comparisons
grep -rn "==.*token\|==.*secret\|==.*password\|==.*api_key" --include="*.py" --include="*.js" --include="*.ts" .

# Find safe comparison usage
grep -rn "compare_digest\|timingSafeEqual\|ConstantTimeCompare\|ct_eq" .
```

## Vulnerable Code Patterns

| Pattern | Language | Risk |
|---------|----------|------|
| `if token == expected:` | Python | Timing leak |
| `if (token === expected)` | JavaScript | Timing leak |
| `strings.Compare(a, b)` | Go | Timing leak |
| `token.equals(expected)` | Java | Timing leak |
| `bcrypt.compare(a, b)` | Any | Safe (bcrypt is constant-time) |

## Beyond String Comparison

Timing leaks can also occur in:
- **Conditional branches** on secret values (if/else based on key bits)
- **Array indexing** with secret indices (cache timing)
- **Early returns** in validation functions
- **Database lookups** that vary by existence (user enumeration)
- **Regular expressions** with backtracking on secret data

## Mitigation Strategies

1. Use language-provided constant-time comparison functions
2. Avoid branching on secret values
3. Use constant-time select operations instead of if/else
4. Add artificial delays to normalize response times (last resort)
5. Use hash-then-compare for variable-length secrets
