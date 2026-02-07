# Fuzzer Skill Template

Use this template for language-specific fuzzers (libFuzzer, AFL++, cargo-fuzz, etc.).

## Template Structure

```markdown
---
name: {fuzzer-name-lowercase}
type: fuzzer
description: >
  {Summary from handbook}. Use for fuzzing {language} projects.
---

# {Fuzzer Name}

{Brief introduction from handbook - what this fuzzer is and its key differentiator}

## When to Use

{Comparison with other fuzzers for the same language}

| Fuzzer | Best For | Complexity |
|--------|----------|------------|
| {This fuzzer} | {Use case} | {Level} |
| {Alternative 1} | {Use case} | {Level} |
| {Alternative 2} | {Use case} | {Level} |

**Choose {Fuzzer Name} when:**
- {Criterion 1}
- {Criterion 2}

## Quick Start

{Minimal working example - get fuzzing in <5 minutes}

\```{language}
{Minimal harness code}
\```

Compile and run:
\```bash
{Minimal commands to compile and run}
\```

## Installation

{Platform-specific installation instructions}

### Prerequisites

- {Prerequisite 1}
- {Prerequisite 2}

### Linux/macOS

\```bash
{Installation commands}
\```

### Verification

\```bash
{Command to verify installation}
\```

## Writing a Harness

{How to write a fuzzing harness for this fuzzer}

### Harness Structure

\```{language}
{Standard harness template with comments}
\```

### Harness Rules

{Key rules from handbook - what to do and avoid in harness}

| Do | Don't |
|----|-------|
| {Good practice 1} | {Bad practice 1} |
| {Good practice 2} | {Bad practice 2} |

> **See Also:** For detailed harness writing techniques, patterns for handling complex inputs,
> and advanced strategies, see the **fuzz-harness-writing** technique skill.

## Compilation

{How to compile fuzz targets}

### Basic Compilation

\```bash
{Basic compile command}
\```

### With Sanitizers

\```bash
{Compile with ASan/UBSan}
\```

> **See Also:** For detailed sanitizer configuration, common issues, and advanced flags,
> see the **address-sanitizer** and **undefined-behavior-sanitizer** technique skills.

### Build Flags

| Flag | Purpose |
|------|---------|
| {Flag 1} | {Purpose} |
| {Flag 2} | {Purpose} |

## Corpus Management

{How to create and manage input corpus}

### Creating Initial Corpus

{Where to get seed inputs}

\```bash
{Commands for corpus setup}
\```

### Corpus Minimization

\```bash
{Commands to minimize corpus}
\```

> **See Also:** For corpus creation strategies, dictionaries, and seed selection,
> see the **fuzzing-corpus** technique skill.

## Running Campaigns

{How to run fuzzing campaigns}

### Basic Run

\```bash
{Basic run command}
\```

### Multi-Core Fuzzing

\```bash
{Parallel fuzzing command if supported}
\```

### Interpreting Output

{How to read fuzzer output, coverage, crashes}

| Output | Meaning |
|--------|---------|
| {Output indicator 1} | {What it means} |
| {Output indicator 2} | {What it means} |

## Coverage Analysis

{How to measure and improve coverage}

### Generating Coverage Reports

\```bash
{Coverage commands}
\```

### Improving Coverage

{Tips for reaching more code paths}

> **See Also:** For detailed coverage analysis techniques, identifying coverage gaps,
> and systematic coverage improvement, see the **coverage-analysis** technique skill.

## Sanitizer Integration

{How to use AddressSanitizer, UndefinedBehaviorSanitizer, etc.}

### AddressSanitizer (ASan)

\```bash
{ASan compile flags}
\```

### UndefinedBehaviorSanitizer (UBSan)

\```bash
{UBSan compile flags}
\```

### MemorySanitizer (MSan)

\```bash
{MSan compile flags - if applicable}
\```

### Common Sanitizer Issues

| Issue | Solution |
|-------|----------|
| {Issue 1} | {Fix} |
| {Issue 2} | {Fix} |

## Advanced Usage

### Tips and Tricks

| Tip | Why It Helps |
|-----|--------------|
| {Tip 1} | {Explanation} |
| {Tip 2} | {Explanation} |
| {Tip 3} | {Explanation} |

### {Advanced Topic 1 - e.g., Structure-Aware Fuzzing}

{Details}

### {Advanced Topic 2 - e.g., Custom Mutators}

{Details}

### Performance Tuning

{How to maximize fuzzing throughput}

| Setting | Impact |
|---------|--------|
| {Setting 1} | {Effect} |
| {Setting 2} | {Effect} |

## Real-World Examples

{Examples from handbook of fuzzing real projects}

### Example: {Project Name}

{Context and what we're fuzzing}

\```{language}
{Harness code}
\```

\```bash
{Commands to fuzz example project}
\```

## Troubleshooting

{Common issues and solutions from handbook}

| Problem | Cause | Solution |
|---------|-------|----------|
| {Problem 1} | {Cause} | {Solution} |
| {Problem 2} | {Cause} | {Solution} |
| {Problem 3} | {Cause} | {Solution} |

## Related Skills

{Cross-references to technique skills that complement this fuzzer}

### Technique Skills

| Skill | Use Case |
|-------|----------|
| **fuzz-harness-writing** | Detailed guidance on writing effective harnesses |
| **address-sanitizer** | Memory error detection during fuzzing |
| **coverage-analysis** | Measuring and improving code coverage |
| **fuzzing-corpus** | Building and managing seed corpora |
| **fuzzing-dictionaries** | Creating dictionaries for format-aware fuzzing |

### Related Fuzzers

| Skill | When to Consider |
|-------|------------------|
| **{alternative-fuzzer-1}** | {When this alternative is better} |
| **{alternative-fuzzer-2}** | {When this alternative is better} |

## Resources

{From resources section - fetch non-video URLs with WebFetch}

### Key External Resources

{For each non-video URL: fetch with WebFetch, summarize key insights}

**[{Title 1}]({URL})**
{Summarized insights: setup guides, tips, examples extracted from the page}

**[{Title 2}]({URL})**
{Summarized insights from fetched content}

### Video Resources

{Videos - title and URL only, no fetching}

- [{Video Title}]({YouTube/Vimeo URL}) - {Brief description}
```

## Field Extraction Guide

| Template Field | Handbook Source |
|----------------|-----------------|
| `{fuzzer-name-lowercase}` | Slugified directory name (e.g., `libfuzzer`, `aflpp`) |
| `{Summary from handbook}` | From `index.md` frontmatter or first paragraph |
| `{language}` | Parent directory (e.g., `c-cpp` → C/C++, `rust` → Rust) |
| Quick Start | Extract minimal example from handbook |
| Harness | From handbook or link to techniques/writing-harnesses |
| Sanitizers | From handbook or link to techniques/asan |
| Real-World Examples | From handbook examples section |
| Related Skills | Map to other handbook sections that complement this fuzzer |

## Related Skills Mapping

When generating a fuzzer skill, identify and link to these technique skills:

| Handbook Section | Generated Skill Name | Link Context |
|------------------|---------------------|--------------|
| `/fuzzing/techniques/writing-harnesses/` | `fuzz-harness-writing` | Harness section |
| `/fuzzing/techniques/asan/` | `address-sanitizer` | Sanitizer section |
| `/fuzzing/techniques/ubsan/` | `undefined-behavior-sanitizer` | Sanitizer section |
| `/fuzzing/techniques/coverage/` | `coverage-analysis` | Coverage section |
| `/fuzzing/techniques/corpus/` | `fuzzing-corpus` | Corpus section |
| `/fuzzing/techniques/dictionaries/` | `fuzzing-dictionaries` | Corpus section |

## Example: libFuzzer

```markdown
---
name: libfuzzer
type: fuzzer
description: >
  Coverage-guided fuzzer built into LLVM. Use for fuzzing C/C++ projects
  that can be compiled with Clang.
---

# libFuzzer

libFuzzer is an in-process, coverage-guided fuzzer that is part of the LLVM project.
It's the recommended starting point for fuzzing C/C++ projects due to its simplicity
and integration with the LLVM toolchain.

## When to Use

| Fuzzer | Best For | Complexity |
|--------|----------|------------|
| libFuzzer | Quick setup, single-threaded | Low |
| AFL++ | Multi-core, diverse mutations | Medium |
| LibAFL | Custom fuzzers, research | High |

**Choose libFuzzer when:**
- You need a simple, quick setup
- Project uses Clang for compilation
- Single-threaded fuzzing is sufficient

## Quick Start

\```c++
extern "C" int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    // Call your code with fuzzer-provided data
    my_function(data, size);
    return 0;
}
\```

Compile and run:
\```bash
clang++ -fsanitize=fuzzer,address harness.cc target.cc -o fuzz_target
./fuzz_target corpus/
\```

## Writing a Harness

### Harness Structure

\```c++
#include <stdint.h>
#include <stddef.h>

extern "C" int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    // 1. Validate input size if needed
    if (size < MIN_SIZE) return 0;

    // 2. Call target function with fuzz data
    target_function(data, size);

    // 3. Return 0 (non-zero reserved for future use)
    return 0;
}
\```

### Harness Rules

| Do | Don't |
|----|-------|
| Reset global state between runs | Rely on state from previous runs |
| Handle edge cases gracefully | Exit on invalid input |
| Keep harness deterministic | Use random number generators |
| Free allocated memory | Create memory leaks |

> **See Also:** For advanced harness patterns, handling complex inputs, and
> structure-aware fuzzing, see the **fuzz-harness-writing** technique skill.

## Sanitizer Integration

### AddressSanitizer (ASan)

\```bash
clang++ -fsanitize=fuzzer,address -g harness.cc -o fuzz_target
\```

### Common Sanitizer Issues

| Issue | Solution |
|-------|----------|
| ASan slows fuzzing | Use `-fsanitize-recover=address` for non-fatal errors |
| Stack exhaustion | Increase stack with `ASAN_OPTIONS=stack_size=...` |

> **See Also:** For comprehensive sanitizer configuration and troubleshooting,
> see the **address-sanitizer** technique skill.

## Related Skills

### Technique Skills

| Skill | Use Case |
|-------|----------|
| **fuzz-harness-writing** | Advanced harness patterns and structure-aware fuzzing |
| **address-sanitizer** | Memory error detection configuration |
| **coverage-analysis** | Measuring fuzzing effectiveness |
| **fuzzing-corpus** | Seed corpus creation and management |

### Related Fuzzers

| Skill | When to Consider |
|-------|------------------|
| **aflpp** | Multi-core fuzzing or when libFuzzer plateaus |
| **honggfuzz** | Hardware-based coverage on Linux |

...
```

## Notes

- Always include sanitizer section (ASan is essential for fuzzing)
- ALWAYS include Related Skills section linking to technique skills
- Use "See Also" callouts in relevant sections pointing to technique skills
- Keep total lines under 500
- Include comparison with other fuzzers for same language
- Fetch non-video external resources with WebFetch, extract key insights
- For videos (YouTube, Vimeo): include title/URL only, do not fetch
- Related skills help users discover deeper content on harnesses, sanitizers, etc.
