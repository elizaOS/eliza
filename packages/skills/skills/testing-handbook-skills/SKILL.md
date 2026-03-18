---
name: testing-handbook-skills
description: "Application security testing toolkit from the Trail of Bits Testing Handbook. Helps the agent set up fuzzing campaigns, write fuzz harnesses, run coverage-guided fuzzers (libFuzzer, AFL++, cargo-fuzz, Atheris, Ruzzy), and triage crashes. Covers memory-safety sanitizers (AddressSanitizer, UBSan, MSan), static analysis with Semgrep and CodeQL, cryptographic validation using Wycheproof test vectors, and constant-time verification. Use when testing C, C++, Rust, Python, or Ruby code for vulnerabilities, improving code coverage, building seed corpora, creating fuzzing dictionaries, overcoming fuzzing obstacles, or integrating security checks into CI/CD with OSS-Fuzz."
---

# Testing Handbook Skills

Comprehensive security testing toolkit generated from the [Trail of Bits Application Security Testing Handbook](https://appsec.guide/).

## When to Use

- Setting up fuzzing campaigns for C/C++, Rust, Python, or Ruby
- Writing fuzzing harnesses for target functions
- Analyzing code coverage to guide testing
- Running sanitizers (AddressSanitizer, UBSan, MSan) to catch memory bugs
- Performing constant-time testing for cryptographic code
- Using Wycheproof test vectors for crypto validation

## When NOT to Use

- Smart contract auditing or chain-specific review work
- Writing custom static-analysis rules from scratch
- General code review outside a security-testing workflow
- Vulnerability hunting without a concrete testing plan

## Sub-Skills (17 total)

### Fuzzers

| Fuzzer | Language | Best For | Skill Path |
|--------|----------|----------|------------|
| **libFuzzer** | C/C++ | LLVM-based coverage-guided fuzzing | [skills/libfuzzer/SKILL.md](skills/libfuzzer/SKILL.md) |
| **AFL++** | C/C++ | Advanced mutation-based fuzzing | [skills/aflpp/SKILL.md](skills/aflpp/SKILL.md) |
| **libAFL** | C/C++ | LibAFL-based custom fuzzers | [skills/libafl/SKILL.md](skills/libafl/SKILL.md) |
| **cargo-fuzz** | Rust | Rust native fuzzing with libFuzzer backend | [skills/cargo-fuzz/SKILL.md](skills/cargo-fuzz/SKILL.md) |
| **Atheris** | Python | Python coverage-guided fuzzing | [skills/atheris/SKILL.md](skills/atheris/SKILL.md) |
| **Ruzzy** | Ruby | Ruby coverage-guided fuzzing | [skills/ruzzy/SKILL.md](skills/ruzzy/SKILL.md) |

### Techniques

| Technique | Purpose | Skill Path |
|-----------|---------|------------|
| **Harness Writing** | Writing effective fuzzing harnesses | [skills/harness-writing/SKILL.md](skills/harness-writing/SKILL.md) |
| **Coverage Analysis** | Measuring and improving code coverage | [skills/coverage-analysis/SKILL.md](skills/coverage-analysis/SKILL.md) |
| **Fuzzing Dictionary** | Creating effective fuzzing dictionaries | [skills/fuzzing-dictionary/SKILL.md](skills/fuzzing-dictionary/SKILL.md) |
| **Fuzzing Obstacles** | Overcoming common fuzzing barriers | [skills/fuzzing-obstacles/SKILL.md](skills/fuzzing-obstacles/SKILL.md) |
| **AddressSanitizer** | Memory error detection with ASan | [skills/address-sanitizer/SKILL.md](skills/address-sanitizer/SKILL.md) |

### Static Analysis

| Tool | Purpose | Skill Path |
|------|---------|------------|
| **Semgrep** | Fast pattern-matching security scans | [skills/semgrep/SKILL.md](skills/semgrep/SKILL.md) |
| **CodeQL** | Deep semantic code analysis | [skills/codeql/SKILL.md](skills/codeql/SKILL.md) |

### Cryptographic Testing

| Tool | Purpose | Skill Path |
|------|---------|------------|
| **Wycheproof** | Test vectors for crypto implementations | [skills/wycheproof/SKILL.md](skills/wycheproof/SKILL.md) |
| **Constant-Time Testing** | Verify constant-time crypto properties | [skills/constant-time-testing/SKILL.md](skills/constant-time-testing/SKILL.md) |

### Infrastructure

| Tool | Purpose | Skill Path |
|------|---------|------------|
| **OSS-Fuzz** | Google's continuous fuzzing service | [skills/ossfuzz/SKILL.md](skills/ossfuzz/SKILL.md) |

### Meta

| Tool | Purpose | Skill Path |
|------|---------|------------|
| **Generator** | Generate new skills from the Testing Handbook | [skills/testing-handbook-generator/SKILL.md](skills/testing-handbook-generator/SKILL.md) |

## Workflow

### Starting a fuzzing campaign

1. **Choose a fuzzer** based on your target language (see Fuzzers table)
2. **Write a harness** using the harness-writing skill
3. **Build with sanitizers** (AddressSanitizer recommended as baseline)
4. **Create a seed corpus** with representative inputs
5. **Run the campaign** and monitor coverage
6. **Analyze coverage** to find uncovered code and improve the harness
7. **Triage crashes** and deduplicate findings

### Setting up CI/CD testing

1. **OSS-Fuzz** for open-source projects (continuous fuzzing)
2. **Semgrep + CodeQL** for static analysis in PRs
3. **Wycheproof** test vectors for crypto validation

## Quick Start by Language

| Language | Fuzzer | Harness | Sanitizer |
|----------|--------|---------|-----------|
| C/C++ | libFuzzer or AFL++ | `LLVMFuzzerTestOneInput` | ASan + UBSan |
| Rust | cargo-fuzz | `fuzz_target!` macro | Built-in sanitizers |
| Python | Atheris | `atheris.FuzzedDataProvider` | N/A |
| Ruby | Ruzzy | `ruzzy` harness pattern | N/A |

## Source Material

Generated from the [Trail of Bits Application Security Testing Handbook](https://appsec.guide/) using the testing-handbook-generator meta-skill.
