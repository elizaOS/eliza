# Applicability Analysis

Phase 1 of the variant creation workflow. Before porting a rule, analyze whether the vulnerability pattern applies to the target language.

## Analysis Process

For EACH target language, answer these questions:

### 1. Does the Vulnerability Class Exist?

**Determine if the vulnerability type is possible in the target language.**

Examples:
- Buffer overflow: Applies to C/C++, may apply to Rust (in unsafe blocks), does NOT apply to Python/Java
- SQL injection: Applies to any language with database access
- XSS: Applies to any language generating HTML output
- Memory leak: Relevant in C/C++, less relevant in garbage-collected languages
- Type confusion: Relevant in dynamically typed languages, less relevant in strongly typed

### 2. Does an Equivalent Construct Exist?

**Identify what the original rule detects and find equivalents.**

Parse the original rule to identify:
- **Sinks**: What dangerous functions/methods does it detect?
- **Sources**: Where does tainted data originate?
- **Pattern type**: Is it taint-mode or pattern-matching?

Then research the target language:
- What are the equivalent dangerous functions?
- What are the common source patterns?
- Are there language-specific idioms to consider?

### 3. Are the Semantics Similar Enough?

**Verify the pattern translates meaningfully.**

Consider:
- Does the vulnerability manifest the same way?
- Are there language-specific mitigations that change detection needs?
- Would the ported rule provide actual security value?

## Verdict Format

Document your analysis for each target language:

```
TARGET: <language>
VERDICT: APPLICABLE | APPLICABLE_WITH_ADAPTATION | NOT_APPLICABLE
REASONING: <specific analysis>
ADAPTATIONS_NEEDED: <if APPLICABLE_WITH_ADAPTATION>
EQUIVALENT_CONSTRUCTS:
  - Original: <function/pattern>
  - Target: <equivalent function/pattern>
```

## Verdict Definitions

### APPLICABLE

The pattern translates directly with minor syntax adjustments.

**Criteria:**
- Equivalent constructs exist with same semantics
- Vulnerability manifests identically
- Detection logic remains the same

**Example:**
```
Original: Python os.system(user_input)
Target: Go exec.Command(user_input)

VERDICT: APPLICABLE
REASONING: Both execute shell commands with user input. Vulnerability is
identical (command injection). Detection logic (taint from input to exec)
translates directly.
```

### APPLICABLE_WITH_ADAPTATION

The pattern can be ported but requires significant changes.

**Criteria:**
- Vulnerability class exists but manifests differently
- Equivalent constructs exist but with different APIs
- Additional patterns needed for target language idioms

**Example:**
```
Original: Python pickle.loads(untrusted)
Target: Java ObjectInputStream.readObject()

VERDICT: APPLICABLE_WITH_ADAPTATION
REASONING: Both detect deserialization vulnerabilities but the APIs differ
significantly. Java requires detection of ObjectInputStream creation and
readObject() calls, not a single function call.
ADAPTATIONS_NEEDED:
  - Different sink patterns (readObject vs loads)
  - May need pattern-inside for ObjectInputStream context
  - Consider readUnshared() variant
```

### NOT_APPLICABLE

The pattern should not be ported to this language.

**Criteria:**
- Vulnerability class doesn't exist in target language
- No equivalent construct exists
- Pattern would be meaningless or misleading

**Example:**
```
Original: C buffer overflow detection
Target: Python

VERDICT: NOT_APPLICABLE
REASONING: Python handles memory management automatically. Buffer overflows
in the traditional C sense don't exist. The vulnerability class is not
present in the target language.
```

## Common Applicability Patterns

### Always Translate (Language-Agnostic Vulnerabilities)

These vulnerability classes exist across most languages:
- SQL injection (any language with DB access)
- Command injection (any language with shell execution)
- Path traversal (any language with file operations)
- SSRF (any language with HTTP clients)
- XSS (any language generating HTML)

### Sometimes Translate (Context-Dependent)

These require careful analysis:
- Deserialization: Different mechanisms per language
- Cryptographic weaknesses: Language-specific crypto libraries
- Race conditions: Depends on concurrency model
- Integer overflow: Depends on type system

### Rarely Translate (Language-Specific)

These are often NOT_APPLICABLE for other languages:
- Memory corruption (C/C++ specific)
- Type juggling (PHP specific)
- Prototype pollution (JavaScript specific)
- GIL-related issues (Python specific)

## Library-Specific Rules

When the original rule targets a third-party library:

### Step 1: Identify the Library's Purpose

What functionality does the library provide?
- ORM / Database access
- HTTP client/server
- Serialization
- Templating
- etc.

### Step 2: Research Target Language Ecosystem

For the target language, identify:
- Standard library equivalents
- Popular third-party libraries with same functionality
- Language-specific idioms for this functionality

### Step 3: Decide on Scope

Options:
- **Native constructs only**: Port to standard library equivalents
- **Popular library**: Port to the most common library in target ecosystem
- **Multiple variants**: Create separate rules for multiple libraries

**Recommendation**: Start with standard library or most popular option. Additional library variants can be created separately if needed.

## Analysis Checklist

Before proceeding past Phase 1:

- [ ] Parsed original rule and identified pattern type
- [ ] Identified sinks, sources, and sanitizers (if taint mode)
- [ ] Researched equivalent constructs in target language
- [ ] Documented verdict with specific reasoning
- [ ] If APPLICABLE_WITH_ADAPTATION, listed required changes
- [ ] If NOT_APPLICABLE, documented clear explanation

## Example Analysis

**Original Rule**: Python command injection via subprocess

```yaml
rules:
  - id: python-command-injection
    mode: taint
    languages: [python]
    pattern-sources:
      - pattern: request.args.get(...)
    pattern-sinks:
      - pattern: subprocess.call($CMD, shell=True, ...)
```

**Target**: Go

```
TARGET: Go
VERDICT: APPLICABLE_WITH_ADAPTATION

REASONING:
- Command injection exists in Go (vulnerability class present)
- Go uses exec.Command() and exec.CommandContext() for command execution
- Go doesn't have shell=True equivalent; commands run directly by default
- Shell execution in Go requires explicit bash -c wrapping

EQUIVALENT_CONSTRUCTS:
  - Original sink: subprocess.call(cmd, shell=True)
  - Target sinks:
    - exec.Command("bash", "-c", cmd)
    - exec.Command("sh", "-c", cmd)
    - exec.Command(cmd) when cmd comes from user input

ADAPTATIONS_NEEDED:
1. Different sink patterns for Go's exec package
2. Source patterns need Go HTTP handler equivalents (r.URL.Query(), r.FormValue())
3. Consider both direct exec.Command and shell-wrapped variants
```

**Target**: Java

```
TARGET: Java
VERDICT: APPLICABLE

REASONING:
- Command injection exists in Java (vulnerability class present)
- Java uses Runtime.exec() and ProcessBuilder for command execution
- Direct equivalent functionality available

EQUIVALENT_CONSTRUCTS:
  - Original sink: subprocess.call(cmd, shell=True)
  - Target sinks:
    - Runtime.getRuntime().exec(cmd)
    - new ProcessBuilder(cmd).start()

ADAPTATIONS_NEEDED:
- Source patterns need Java servlet equivalents (request.getParameter())
- Consider both Runtime.exec and ProcessBuilder patterns
```
