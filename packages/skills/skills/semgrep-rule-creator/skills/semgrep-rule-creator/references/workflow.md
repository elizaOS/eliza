# Semgrep Rule Creation Workflow

Detailed workflow for creating production-quality Semgrep rules.

## Step 1: Analyze the Problem

Before writing any code:

1. **Fetch external documentation**: See [Documentation](../SKILL.md#documentation) for required reading
2. **Understand the exact bug pattern and explain the bug for a junior developer**: What vulnerability, issue or pattern should be detected?
3. **Identify the target language**: What is specific about the bug and that language?
4. **Determine the approach**:
   - **Pattern matching**: Syntactic patterns without data flow
   - **Taint mode**: Data flows from untrusted source to dangerous sink

### When to Use Taint Mode

Taint mode is a powerful feature in Semgrep that can track the flow of data from one location to another. By using taint mode, you can:

- **Track data flow across multiple variables**: Trace how data moves across different variables, functions, components, and identify insecure flow paths (e.g., situations where a specific sanitizer is not used).
- **Find injection vulnerabilities**: Identify injection vulnerabilities such as SQL injection, command injection, and XSS attacks.
- **Write simple and resilient Semgrep rules**: Simplify rules that are resilient to code patterns nested in if statements, loops, and other structures.

## Step 2: Write Tests First

**Why test-first?** Writing tests before the rule forces you to think about both vulnerable AND safe cases. Rules written without tests often have hidden false positives (matching safe cases) or false negatives (missing vulnerable variants). Tests make these visible immediately.

Create directory and test file with annotations (`# ruleid:`, `# ok:` only). See [quick-reference.md]({baseDir}/references/quick-reference.md#test-file-annotations) for full syntax.

### Directory Structure

```
<rule-id>/
├── <rule-id>.yaml     # Semgrep rule
└── <rule-id>.<ext>    # Test file with ruleid/ok annotations
```

**CRITICAL**:
1. The comment (`# ruleid:` or `# ok:` ) must be on the line IMMEDIATELY BEFORE the code. Semgrep reports findings on the line after the annotation.
2. The comment must contain ONLY the comment marker and annotation (e.g., `# ruleid: my-rule`). No other text, comments, or code on the same line.

### Test Case Design

You must include test cases for:
- Clear vulnerable cases (must match)
- Clear safe cases (must not match)
- Edge cases and variations
- Different coding styles
- Sanitized/validated input (must not match)
- Unrelated code (must not match) - normal code with no relation to the rule's target pattern
- Nested structures (e.g., inside if statements, loops, try/catch blocks, callbacks)

## Step 3: Analyze AST Structure

**Why analyze AST?** Semgrep matches against the AST, not raw text. Code that looks similar may parse differently (e.g., `foo.bar()` vs `foo().bar`). The AST dump shows exactly what Semgrep sees, preventing patterns that fail due to unexpected tree structure. Understanding how exactly Semgrep parses code is crucial for writing precise patterns.

```bash
semgrep --dump-ast -l <language> <rule-id>.<ext>
```

Example output helps understand:
- How function calls are represented
- How variables are bound
- How control flow is structured

## Step 4: Write the Rule

Choose the appropriate pattern operators and write the rule.

For pattern operator syntax (basic matching, scope operators, metavariable filters, focus), see [quick-reference.md](quick-reference.md).

### Validate and Test

#### Validate YAML Syntax

```bash
semgrep --validate --config <rule-id>.yaml
```

#### Run Tests

```bash
cd <rule-directory>
semgrep --test --config <rule-id>.yaml <rule-id>.<ext>
```

#### Expected Output

```
1/1: ✓ All tests passed
```

#### Debug Failures

If tests fail, check:
1. **Missed lines**: Rule didn't match when it should
   - Pattern too specific
   - Missing pattern variant
2. **Incorrect lines**: Rule matched when it shouldn't
   - Pattern too broad
   - Need `pattern-not` exclusion

#### Debug Taint Mode Rules

```bash
semgrep --dataflow-traces -f <rule-id>.yaml <rule-id>.<ext>
```

Shows:
- Source locations
- Sink locations
- Data flow path
- Why taint didn't propagate (if applicable)

## Step 5: Iterate Until Tests Pass
Work on writing Semgrep rule (patterns) iteratively to ensure the Semgrep rule works correctly.

Each time when you introduce any changes, test Semgrep rule:

```bash
semgrep --test --config <rule-id>.yaml <rule-id>.<ext>
```

For debugging taint mode rules:
```bash
semgrep --dataflow-traces -f <rule-id>.yaml <rule-id>.<ext>
```

**Verification checkpoint**: Output MUST show "All tests passed". **Only proceed when validation passes**.


**Verification checkpoint**: Proceed to Step 6: Optimize the Rule when:
- "All tests passed"
- No "missed lines" (false negatives)
- No "incorrect lines" (false positives)

### Common Fixes

| Problem | Solution |
|---------|----------|
| Too many matches | Add `pattern-not` exclusions |
| Missing matches | Add `pattern-either` variants |
| Wrong line matched | Adjust `focus-metavariable` |
| Taint not flowing | Check sanitizers aren't too broad |
| Taint false positive | Add sanitizer pattern |

## Step 6: Optimize the Rule

After all tests pass, remove redundant patterns (quote variants, ellipsis subsets, redundant patterns).

### Semgrep Pattern Equivalences

Semgrep treats certain patterns as equivalent:

| Written | Also Matches | Reason |
|---------|--------------|--------|
| `"string"` | `'string'` | Quote style normalized (in languages where both are equivalent) |
| `func(...)` | `func()`, `func(a)`, `func(a,b)` | Ellipsis matches zero or more |
| `func($X, ...)` | `func($X)`, `func($X, a, b)` | Trailing ellipsis is optional |

### Common Redundancies to Remove

**1. Quote Variants** (depends on the language)

Before:
```yaml
pattern-either:
  - pattern: hashlib.new("md5", ...)
  - pattern: hashlib.new('md5', ...)
```

After:
```yaml
pattern-either:
  - pattern: hashlib.new("md5", ...)
```

**2. Ellipsis Subsets**

Before:
```yaml
pattern-either:
  - pattern: dangerous($X, ...)
  - pattern: dangerous($X)
  - pattern: dangerous($X, $Y)
```

After:
```yaml
pattern: dangerous($X, ...)
```

**3. Consolidate with Metavariables**

Before:
```yaml
pattern-either:
  - pattern: md5($X)
  - pattern: sha1($X)
  - pattern: sha256($X)
```

After:
```yaml
patterns:
  - pattern: $FUNC($X)
  - metavariable-regex:
      metavariable: $FUNC
      regex: ^(md5|sha1|sha256)$
```

### Optimization Checklist

1. Remove patterns differing only in quote style
2. Remove patterns that are subsets of `...` patterns
3. Consolidate similar patterns using metavariable-regex
4. Remove duplicate patterns in pattern-either
5. Simplify nested pattern-either when possible
6. Replace complex regex patterns with metavariable-comparison
7. **Re-run tests after each optimization**

### Verify After Optimization

```bash
semgrep --test --config <rule-id>.yaml <rule-id>.<ext>
```

**CRITICAL**: Always re-run tests after optimization. Some "redundant" patterns may actually be necessary due to AST structure differences. If any test fails, revert the optimization that caused it.

**Task complete ONLY when**: All tests pass after optimization.


## Step 7: Final Run
Run the Semgrep rule you created using: `semgrep --config <rule-id>.yaml <rule-id>.<ext>`.

Ensure that message:
 1. Contains a short and concise explanation of the matched pattern
 2. Has no uninterpolated metavariables (e.g., $OP, $VAR). All metavariables referenced in the message must be captured by the pattern so they interpolate to actual code. 

Fix any message issues and re-run that Semgrep rule after each fix.