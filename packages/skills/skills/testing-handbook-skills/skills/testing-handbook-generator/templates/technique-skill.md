# Technique Skill Template

Use this template for cross-cutting techniques that apply to multiple tools (harness writing, coverage analysis, sanitizers, dictionaries, etc.).

## Template Structure

```markdown
---
name: {technique-name-lowercase}
type: technique
description: >
  {Summary of what this technique does}. Use when {trigger conditions}.
---

# {Technique Name}

{Brief introduction - what this technique is and why it matters}

## Overview

{High-level explanation of the technique}

### Key Concepts

| Concept | Description |
|---------|-------------|
| {Concept 1} | {Brief explanation} |
| {Concept 2} | {Brief explanation} |

## When to Apply

**Apply this technique when:**
- {Trigger 1}
- {Trigger 2}
- {Trigger 3}

**Skip this technique when:**
- {Skip condition 1}
- {Skip condition 2}

## Quick Reference

{Essential commands or patterns in one place}

| Task | Command/Pattern |
|------|-----------------|
| {Task 1} | `{command or pattern}` |
| {Task 2} | `{command or pattern}` |
| {Task 3} | `{command or pattern}` |

## Step-by-Step

{Detailed workflow for applying this technique}

### Step 1: {First Step}

{Instructions with code examples}

\```{language}
{Example code}
\```

### Step 2: {Second Step}

{Instructions}

### Step 3: {Third Step}

{Instructions}

## Common Patterns

{Code patterns that demonstrate this technique}

### Pattern: {Pattern Name 1}

**Use Case:** {When to use this pattern}

**Before:**
\```{language}
{Code before applying technique}
\```

**After:**
\```{language}
{Code after applying technique}
\```

### Pattern: {Pattern Name 2}

**Use Case:** {When to use this pattern}

**Before:**
\```{language}
{Code before}
\```

**After:**
\```{language}
{Code after}
\```

## Advanced Usage

### Tips and Tricks

{Practical tips from experienced practitioners}

| Tip | Why It Helps |
|-----|--------------|
| {Tip 1} | {Explanation} |
| {Tip 2} | {Explanation} |
| {Tip 3} | {Explanation} |

### {Advanced Topic 1}

{Details}

### {Advanced Topic 2}

{Details}

## Anti-Patterns

{What NOT to do}

| Anti-Pattern | Problem | Correct Approach |
|--------------|---------|------------------|
| {Bad practice 1} | {Why it's bad} | {What to do instead} |
| {Bad practice 2} | {Why it's bad} | {What to do instead} |
| {Bad practice 3} | {Why it's bad} | {What to do instead} |

## Tool-Specific Guidance

{How this technique applies to specific fuzzers/tools - this is KEY for discoverability}

### libFuzzer

{Specific guidance for libFuzzer}

\```bash
{libFuzzer-specific command}
\```

**Integration tips:**
- {Tip specific to libFuzzer}
- {Tip specific to libFuzzer}

### AFL++

{Specific guidance for AFL++}

\```bash
{AFL++-specific command}
\```

**Integration tips:**
- {Tip specific to AFL++}
- {Tip specific to AFL++}

### cargo-fuzz (Rust)

{Specific guidance for Rust fuzzing}

\```bash
{cargo-fuzz command}
\```

**Integration tips:**
- {Tip specific to cargo-fuzz}

### go-fuzz (Go)

{Specific guidance for Go fuzzing}

\```bash
{go-fuzz command}
\```

### {Other Tool}

{Add sections for other relevant tools from handbook}

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| {Issue 1} | {Cause} | {Fix} |
| {Issue 2} | {Cause} | {Fix} |
| {Issue 3} | {Cause} | {Fix} |

## Related Skills

{Links to tools and other techniques - bidirectional references}

### Tools That Use This Technique

| Skill | How It Applies |
|-------|----------------|
| **{fuzzer-skill-1}** | {How this technique is used with this fuzzer} |
| **{fuzzer-skill-2}** | {How this technique is used with this fuzzer} |
| **{tool-skill-1}** | {How this technique applies to this tool} |

### Related Techniques

| Skill | Relationship |
|-------|--------------|
| **{technique-skill-1}** | {How they work together - e.g., "Use coverage to identify where harness improvements are needed"} |
| **{technique-skill-2}** | {Complementary relationship} |

## Resources

### Key External Resources

{For each non-video URL: fetch with WebFetch, summarize key insights}

**[{Title 1}]({URL})**
{Summarized insights from fetched content}

### Video Resources

{Videos - title and URL only, no fetching}

- [{Video Title}]({YouTube/Vimeo URL}) - {Brief description}
```

## Field Extraction Guide

| Template Field | Handbook Source |
|----------------|-----------------|
| `{technique-name-lowercase}` | Slugified from directory/title |
| `{Summary}` | From `_index.md` frontmatter or intro |
| Key Concepts | Extract definitions from handbook |
| Step-by-Step | Main workflow from handbook |
| Common Patterns | Code examples from handbook |
| Tool Integration | From tool-specific subsections |
| Related Skills | Map to fuzzer and tool skills |

## Tool-Specific Section Guide

Include tool-specific guidance for tools covered in the handbook:

| Language | Tools to Include |
|----------|------------------|
| C/C++ | libFuzzer, AFL++, honggfuzz |
| Rust | cargo-fuzz, libFuzzer |
| Go | go-fuzz, native fuzzing |
| Python | Atheris, Hypothesis |
| JavaScript | jsfuzz |

## Related Skills Mapping

When generating a technique skill, create bidirectional links:

| If Technique Is About | Link To These Skills |
|-----------------------|---------------------|
| Harness writing | All fuzzer skills that use harnesses |
| Sanitizers | All fuzzer skills (they all use sanitizers) |
| Coverage | Fuzzer skills, static analysis tools |
| Corpus/dictionaries | All fuzzer skills |

## Example: Writing Fuzzing Harnesses

```markdown
---
name: fuzz-harness-writing
type: technique
description: >
  Techniques for writing effective fuzzing harnesses. Use when creating
  new fuzz targets or improving existing harness code.
---

# Writing Fuzzing Harnesses

A harness is the entrypoint for your fuzz test. The fuzzer calls this function
with random data, and the harness routes that data to your code under test.

## Overview

### Key Concepts

| Concept | Description |
|---------|-------------|
| Harness | Function that receives fuzzer input and calls target code |
| SUT | System Under Test - the code being fuzzed |
| Entry point | Function signature required by the fuzzer |

## When to Apply

**Apply this technique when:**
- Creating a new fuzz target
- Fuzz campaign has low coverage
- Crashes are not reproducible

**Skip this technique when:**
- Using existing well-tested harnesses
- Tool provides automatic harness generation

## Quick Reference

| Task | Pattern |
|------|---------|
| Minimal C++ harness | `extern "C" int LLVMFuzzerTestOneInput(const uint8_t*, size_t)` |
| Minimal Rust harness | `fuzz_target!(|data: &[u8]| { ... })` |
| Minimal Go harness | `func Fuzz(data []byte) int { ... }` |
| Size validation | `if (size < MIN) return 0;` |

## Step-by-Step

### Step 1: Identify Entry Points

Find functions that:
- Accept external input
- Parse data formats
- Perform validation

### Step 2: Write Minimal Harness

\```c++
extern "C" int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    target_function(data, size);
    return 0;
}
\```

### Step 3: Add Input Validation

\```c++
extern "C" int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    if (size < MIN_SIZE || size > MAX_SIZE) return 0;
    target_function(data, size);
    return 0;
}
\```

## Common Patterns

### Pattern: Size-Bounded Input

**Use Case:** When target expects minimum input size

**Before:**
\```c++
extern "C" int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    parse_message(data, size);  // May crash on tiny inputs
    return 0;
}
\```

**After:**
\```c++
extern "C" int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    if (size < sizeof(header_t)) return 0;  // Skip invalid sizes
    parse_message(data, size);
    return 0;
}
\```

## Advanced Usage

### Tips and Tricks

| Tip | Why It Helps |
|-----|--------------|
| Start with parsers | High bug density, clear entry points |
| Use FuzzedDataProvider | Structured data extraction from fuzz input |
| Mock I/O operations | Prevents hangs, enables determinism |

### Structure-Aware Fuzzing

{How to use proto definitions, grammars, etc.}

## Anti-Patterns

| Anti-Pattern | Problem | Correct Approach |
|--------------|---------|------------------|
| Global state | Non-deterministic | Reset state in harness |
| Blocking I/O | Hangs fuzzer | Mock or skip I/O |
| Memory leaks | Resource exhaustion | Free in harness |

## Tool-Specific Guidance

### libFuzzer

\```c++
extern "C" int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    // Your code here
    return 0;
}
\```

**Integration tips:**
- Use `FuzzedDataProvider` for structured extraction
- Compile with `-fsanitize=fuzzer`

### AFL++

\```c++
int main(int argc, char **argv) {
    #ifdef __AFL_HAVE_MANUAL_CONTROL
        __AFL_INIT();
    #endif

    unsigned char *buf = NULL;
    size_t len = 0;
    while (__AFL_LOOP(10000)) {
        // Read from stdin, call target
    }
    return 0;
}
\```

**Integration tips:**
- Use persistent mode for performance
- Consider deferred initialization

### cargo-fuzz (Rust)

\```rust
#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    // Your code here
});
\```

## Related Skills

### Tools That Use This Technique

| Skill | How It Applies |
|-------|----------------|
| **libfuzzer** | Uses LLVMFuzzerTestOneInput harness signature |
| **aflpp** | Supports persistent mode harnesses |
| **cargo-fuzz** | Uses Rust-specific harness macros |
| **go-fuzz** | Uses Go-specific harness signature |

### Related Techniques

| Skill | Relationship |
|-------|--------------|
| **coverage-analysis** | Measure harness effectiveness |
| **address-sanitizer** | Detect bugs found by harness |
| **fuzzing-corpus** | Provide seed inputs to harness |

...
```

## Example: AddressSanitizer

```markdown
---
name: address-sanitizer
type: technique
description: >
  Memory error detection for C/C++ fuzzing. Use when fuzzing C/C++ code
  to detect memory corruption bugs like buffer overflows and use-after-free.
---

# AddressSanitizer (ASan)

AddressSanitizer is a fast memory error detector for C/C++. It finds buffer
overflows, use-after-free, and other memory bugs with ~2x slowdown.

## Quick Reference

| Task | Command |
|------|---------|
| Enable ASan (Clang) | `-fsanitize=address` |
| Enable ASan (GCC) | `-fsanitize=address` |
| Disable leak detection | `ASAN_OPTIONS=detect_leaks=0` |
| Increase stack size | `ASAN_OPTIONS=stack_size=...` |

## Tool-Specific Guidance

### libFuzzer

\```bash
clang++ -fsanitize=fuzzer,address -g harness.cc -o fuzz
\```

**Integration tips:**
- Always combine with fuzzer sanitizer
- Use `-g` for better stack traces

### AFL++

\```bash
AFL_USE_ASAN=1 afl-clang-fast++ -g harness.cc -o fuzz
\```

**Integration tips:**
- Use `AFL_USE_ASAN` environment variable
- Consider memory limits with `AFL_MAP_SIZE`

## Related Skills

### Tools That Use This Technique

| Skill | How It Applies |
|-------|----------------|
| **libfuzzer** | Compile with `-fsanitize=fuzzer,address` |
| **aflpp** | Use `AFL_USE_ASAN=1` |
| **honggfuzz** | Compile with `-fsanitize=address` |

### Related Techniques

| Skill | Relationship |
|-------|--------------|
| **undefined-behavior-sanitizer** | Often used together for comprehensive detection |
| **fuzz-harness-writing** | Harness must handle ASan-detected crashes |
| **coverage-analysis** | Coverage guides fuzzer to trigger ASan errors |

...
```

## Notes

- Technique skills should be tool-agnostic in overview, tool-specific in guidance
- ALWAYS include Tool-Specific Guidance section for major tools
- ALWAYS include Related Skills with bidirectional links
- Include Tips and Tricks in Advanced Usage section
- Link to related technique skills
- Keep under 500 lines
- Fetch non-video external resources with WebFetch, extract key insights
- For videos (YouTube, Vimeo): include title/URL only, do not fetch
