# Constant-Time Analyzer (ct-analyzer)

A portable tool for detecting timing side-channel vulnerabilities in compiled cryptographic code. Analyzes assembly output from multiple compilers and architectures to detect instructions that could leak secret data through execution timing.

## Background

Timing side-channel attacks exploit variations in execution time to extract secret information from cryptographic implementations. Common sources include:

- **Hardware division** (`DIV`, `IDIV`): Execution time varies based on operand values
- **Floating-point operations** (`FDIV`, `FSQRT`): Variable latency based on inputs
- **Conditional branches**: Different execution paths have different timing

The infamous [KyberSlash](https://kyberslash.cr.yp.to/) attack demonstrated how division instructions in post-quantum cryptographic implementations could be exploited to recover secret keys.

## Features

- **Multi-language support**: C, C++, Go, Rust, PHP, JavaScript, TypeScript, Python, Ruby
- **Multi-architecture support**: x86_64, ARM64, ARM, RISC-V, PowerPC, s390x, i386
- **Multi-compiler support**: GCC, Clang, Go compiler, Rustc
- **Scripting language support**: PHP (VLD/opcache), JavaScript/TypeScript (V8 bytecode), Python (dis), Ruby (YARV)
- **Optimization-level testing**: Test across O0-O3, Os, Oz
- **Multiple output formats**: Text, JSON, GitHub Actions annotations
- **Cross-compilation**: Analyze code for different target architectures

## Quick Start

```bash
# Install
uv pip install -e .

# Analyze a C file
ct-analyzer crypto.c
```

## Usage

### Basic Analysis

```bash
ct-analyzer <source_file>
```

### Options

| Option | Description |
|--------|-------------|
| `--arch, -a` | Target architecture (x86_64, arm64, arm, riscv64, ppc64le, s390x, i386) |
| `--compiler, -c` | Compiler to use (gcc, clang, go, rustc) |
| `--opt-level, -O` | Optimization level (O0, O1, O2, O3, Os, Oz) - default: O2 |
| `--warnings, -w` | Include conditional branch warnings |
| `--func, -f` | Regex pattern to filter functions |
| `--json` | Output JSON format |
| `--github` | Output GitHub Actions annotations |
| `--list-arch` | List supported architectures |

### Examples

```bash
# Test with different optimization levels
ct-analyzer --opt-level O0 crypto.c
ct-analyzer --opt-level O3 crypto.c

# Cross-compile for ARM64
ct-analyzer --arch arm64 crypto.c

# Include conditional branch warnings
ct-analyzer --warnings crypto.c

# Analyze specific functions
ct-analyzer --func 'decompose|sign' crypto.c

# JSON output for CI
ct-analyzer --json crypto.c

# Analyze Go code
ct-analyzer crypto.go

# Analyze Rust code
ct-analyzer crypto.rs

# Analyze PHP code (requires PHP with VLD extension or opcache)
ct-analyzer crypto.php

# Analyze TypeScript (transpiles to JS first)
ct-analyzer crypto.ts

# Analyze JavaScript (uses V8 bytecode analysis)
ct-analyzer crypto.js

# Analyze Python (uses dis module for bytecode disassembly)
ct-analyzer crypto.py

# Analyze Ruby (uses YARV instruction dump)
ct-analyzer crypto.rb
```

## Detected Vulnerabilities

### Error-Level (Must Fix)

| Category | x86_64 | ARM64 | RISC-V |
|----------|--------|-------|--------|
| Integer Division | DIV, IDIV, DIVQ, IDIVQ | UDIV, SDIV | DIV, DIVU, REM, REMU |
| FP Division | DIVSS, DIVSD, DIVPS, DIVPD | FDIV | FDIV.S, FDIV.D |
| Square Root | SQRTSS, SQRTSD, SQRTPS, SQRTPD | FSQRT | FSQRT.S, FSQRT.D |

### Warning-Level (Review Needed)

Conditional branches that may leak timing if condition depends on secret data:

- x86: JE, JNE, JZ, JNZ, JA, JB, JG, JL, etc.
- ARM: BEQ, BNE, CBZ, CBNZ, TBZ, TBNZ
- RISC-V: BEQ, BNE, BLT, BGE

## Scripting Language Support

### PHP Analysis

PHP analysis uses either the VLD extension (recommended) or opcache debug output:

**Detected PHP Vulnerabilities:**

| Category | Pattern | Recommendation |
|----------|---------|----------------|
| Division | `ZEND_DIV`, `ZEND_MOD` | Use Barrett reduction |
| Cache timing | `chr()`, `ord()` | Use `pack('C', $int)` / `unpack('C', $char)[1]` |
| Table lookups | `bin2hex()`, `hex2bin()`, `base64_encode()` | Use constant-time alternatives |
| Array access | `FETCH_DIM_R` (secret index) | Use constant-time table lookup |
| Bit shifts | `ZEND_SL`, `ZEND_SR` (secret amount) | Mask shift amount |
| Variable encoding | `pack()`, `serialize()`, `json_encode()` | Use fixed-length output |
| Weak RNG | `rand()`, `mt_rand()`, `uniqid()` | Use `random_int()` / `random_bytes()` |
| String comparison | `strcmp()`, `===` on secrets | Use `hash_equals()` |

**Installation:**

```bash
# Install VLD extension (recommended)
# Query latest version from PECL
VLD_VERSION=$(curl -s https://pecl.php.net/package/vld | grep -oP 'vld-\K[0-9.]+(?=\.tgz)' | head -1)
pecl install channel://pecl.php.net/vld-${VLD_VERSION}

# Or build from source (if PECL fails)
git clone https://github.com/derickr/vld.git && cd vld
phpize && ./configure && make && sudo make install

# Or use opcache (built-in, fallback)
# Enabled by default in PHP 7+
```

### JavaScript/TypeScript Analysis

JavaScript analysis uses V8 bytecode via Node.js `--print-bytecode`. TypeScript files are automatically transpiled first.

**Detected JS Vulnerabilities:**

| Category | Pattern | Recommendation |
|----------|---------|----------------|
| Division | `Div`, `Mod` bytecodes | Use constant-time multiply-shift |
| Array access | `LdaKeyedProperty` (secret index) | Use constant-time table lookup |
| Bit shifts | `ShiftLeft`, `ShiftRight` (secret amount) | Mask shift amount |
| Variable encoding | `TextEncoder`, `JSON.stringify()`, `btoa()` | Use fixed-length output |
| Weak RNG | `Math.random()` | Use `crypto.getRandomValues()` or `crypto.randomBytes()` |
| Variable latency | `Math.sqrt()`, `Math.pow()` | Avoid in crypto paths |
| String comparison | `===` on secrets | Use `crypto.timingSafeEqual()` (Node.js) |
| Early-exit search | `indexOf()`, `includes()` | Use constant-time comparison |

**Requirements:**
```bash
# Node.js required
node --version

# TypeScript compiler (optional, for .ts files)
npm install -g typescript
```

### Python Analysis

Python analysis uses the built-in `dis` module to analyze CPython bytecode.

**Detected Python Vulnerabilities:**

| Category | Pattern | Recommendation |
|----------|---------|----------------|
| Division | `BINARY_OP 11 (/)`, `BINARY_OP 6 (%)` | Use Barrett reduction or constant-time alternatives |
| Array access | `BINARY_SUBSCR` (secret index) | Use constant-time table lookup |
| Bit shifts | `BINARY_LSHIFT`, `BINARY_RSHIFT` (secret amount) | Mask shift amount |
| Variable encoding | `int.to_bytes()`, `json.dumps()`, `base64.b64encode()` | Use fixed-length output |
| Weak RNG | `random.random()`, `random.randint()` | Use `secrets.token_bytes()` / `secrets.randbelow()` |
| Variable latency | `math.sqrt()`, `math.pow()` | Avoid in crypto paths |
| String comparison | `==` on secrets | Use `hmac.compare_digest()` |
| Early-exit search | `.find()`, `.startswith()` | Use constant-time comparison |

**Requirements:**
```bash
# Python 3.x required (built-in dis module)
python3 --version
```

### Ruby Analysis

Ruby analysis uses YARV (Yet Another Ruby VM) bytecode via `ruby --dump=insns`.

**Detected Ruby Vulnerabilities:**

| Category | Pattern | Recommendation |
|----------|---------|----------------|
| Division | `opt_div`, `opt_mod` | Use constant-time alternatives |
| Array access | `opt_aref` (secret index) | Use constant-time table lookup |
| Bit shifts | `opt_lshift`, `opt_rshift` (secret amount) | Mask shift amount |
| Variable encoding | `pack()`, `to_json()`, `Base64.encode64()` | Use fixed-length output |
| Weak RNG | `rand()`, `Random.new` | Use `SecureRandom.random_bytes()` |
| Variable latency | `Math.sqrt()` | Avoid in crypto paths |
| String comparison | `==` on secrets | Use `Rack::Utils.secure_compare()` or OpenSSL |
| Early-exit search | `.include?()`, `.start_with?()` | Use constant-time comparison |

**Requirements:**
```bash
# Ruby required (YARV is standard since Ruby 1.9)
ruby --version
```

## Example Output

```text
============================================================
Constant-Time Analysis Report
============================================================
Source: decompose.c
Architecture: arm64
Compiler: clang
Optimization: O2
Functions analyzed: 4
Instructions analyzed: 88

VIOLATIONS FOUND:
----------------------------------------
[ERROR] SDIV
  Function: decompose_vulnerable
  Reason: SDIV has early termination optimization; execution time depends on operand values

[ERROR] SDIV
  Function: use_hint_vulnerable
  Reason: SDIV has early termination optimization; execution time depends on operand values

----------------------------------------
Result: FAILED
Errors: 2, Warnings: 0
```

## Fixing Violations

### Replace Division with Barrett Reduction

```c
// VULNERABLE
int32_t q = a / divisor;

// SAFE: Barrett reduction
// Precompute: mu = ceil(2^32 / divisor)
uint32_t q = (uint32_t)(((uint64_t)a * mu) >> 32);
```

### Replace Branches with Constant-Time Selection

```c
// VULNERABLE
if (secret) {
    result = a;
} else {
    result = b;
}

// SAFE: Constant-time selection
uint32_t mask = -(uint32_t)(secret != 0);
result = (a & mask) | (b & ~mask);
```

### Replace Comparisons

```c
// VULNERABLE
if (memcmp(a, b, len) == 0) { ... }

// SAFE: Use crypto/subtle or equivalent
if (subtle.ConstantTimeCompare(a, b) == 1) { ... }
```

## Test Samples

The repository includes test samples demonstrating vulnerable and secure implementations:

- `ct_analyzer/tests/test_samples/decompose_vulnerable.c` - Vulnerable C implementation
- `ct_analyzer/tests/test_samples/decompose_constant_time.c` - Constant-time C implementation
- `ct_analyzer/tests/test_samples/decompose_vulnerable.go` - Vulnerable Go implementation
- `ct_analyzer/tests/test_samples/decompose_vulnerable.rs` - Vulnerable Rust implementation
- `ct_analyzer/tests/test_samples/vulnerable.php` - Vulnerable PHP implementation
- `ct_analyzer/tests/test_samples/vulnerable.ts` - Vulnerable TypeScript implementation
- `ct_analyzer/tests/test_samples/vulnerable.py` - Vulnerable Python implementation
- `ct_analyzer/tests/test_samples/vulnerable.rb` - Vulnerable Ruby implementation

These implement the Decompose and UseHint algorithms from ML-DSA (FIPS-204) as test cases.

## CI Integration

### GitHub Actions

```yaml
name: Constant-Time Check

on: [push, pull_request]

jobs:
  ct-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Install dependencies
        run: |
          uv pip install -e .

      - name: Check constant-time properties
        run: |
          ct-analyzer --github src/crypto/*.c
```

### GitLab CI

```yaml
ct-check:
  stage: test
  script:
    - uv pip install -e .
    - ct-analyzer --json src/crypto/*.c > ct-report.json
  artifacts:
    reports:
      codequality: ct-report.json
```

## Limitations

1. **Compiler Output Analysis**: Analyzes what the compiler produces, not runtime behavior. Cannot detect:
   - Cache timing attacks from memory access patterns
   - Microarchitectural side-channels (Spectre, etc.)
   - Processor-specific optimizations

2. **No Data Flow Analysis**: Flags all dangerous instructions regardless of whether they operate on secret data. Manual review is needed to determine if flagged code handles secrets. **This means false positives are expected** - for example, division used in loop bounds with public constants will be flagged even though it's not a vulnerability.

3. **False Positive Verification**: For each flagged violation, verify the operands:
   - If operands are compile-time constants or public parameters → likely false positive
   - If operands are derived from keys, plaintext, or secrets → true positive
   - See the SKILL.md documentation for detailed triage guidance

4. **Compiler Variations**: Different compilers/versions may produce different assembly. Test with:
   - Multiple optimization levels
   - Multiple compilers
   - Target production architectures

5. **Scripting Languages**: PHP, JavaScript/TypeScript, Python, and Ruby are supported via bytecode analysis.

## Running Tests

```bash
python3 ct_analyzer/tests/test_analyzer.py
```

## References

- [Cryptocoding Guidelines](https://github.com/veorq/cryptocoding)
- [KyberSlash Attack](https://kyberslash.cr.yp.to/)
- [NIST FIPS 204: ML-DSA](https://csrc.nist.gov/pubs/fips/204/final)
- [Trail of Bits ML-DSA Implementation](https://github.com/trailofbits/ml-dsa)

## Acknowledgments

Based on the [test_ct utility](https://github.com/trailofbits/ml-dsa/pull/16) created for ML-DSA.
