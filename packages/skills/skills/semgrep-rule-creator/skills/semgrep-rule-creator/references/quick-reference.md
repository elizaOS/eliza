# Semgrep Rule Quick Reference

## Required Rule Fields

```yaml
rules:
  - id: rule-id          # Unique identifier (lowercase, hyphens)
    languages:                 # Target language(s)
      - python
    severity: HIGH            # LOW, MEDIUM, HIGH, CRITICAL (ERROR/WARNING/INFO are legacy)
    message: Description      # Shown when rule matches
    pattern: code(...)        # OR use patterns/pattern-either/mode:taint
```

## Pattern Operators

### Basic Matching
```yaml
pattern: foo(...)              # Match function call
patterns:                      # AND - all must match
  - pattern: $X
  - pattern-not: safe($X)
pattern-either:                # OR - any can match
  - pattern: foo(...)
  - pattern: bar(...)
pattern-regex: ^foo.*bar$      # PCRE2 regex matching (multiline mode)
```

### Metavariables
- `$VAR` - Match any single expression
  - **Must be uppercase**: `$X`, `$FUNC`, `$VAR_1` (NOT `$x`, `$var`)
- `$_` - Anonymous metavariable (matches but doesn't bind)
- `$...VAR` - Match zero or more arguments (ellipsis metavariable)
- `...` - Ellipsis, match anything in between

### Typed Metavariables

Constrain metavariables to specific types (reduces false positives):

```yaml
# C/C++ - match only int16_t parameters
pattern: (int16_t $X)

# C/C++ - match function with typed parameter
pattern: some_func((int $ARG))

# Java - match Logger type
pattern: (java.util.logging.Logger $LOGGER).log(...)

# Go - match pointer type (uses colon syntax)
pattern: ($READER : *zip.Reader).Open($INPUT)

# TypeScript - match specific type
pattern: ($X: DomSanitizer).sanitize(...)

Use in taint mode to track only specific types as sources:
pattern-sources:
  - pattern: (int $X)        # Only int parameters are taint sources
  - pattern: (int16_t $X)    # Only int16_t parameters
  - pattern: int $X = $INIT; # Local variable declarations


### Deep Expression Matching
```yaml
<... $EXPR ...>               # Recursively match pattern in nested expressions
```

### Scope Operators
```yaml
pattern-inside: |              # Must be inside this pattern
  def $FUNC(...):
    ...
pattern-not-inside: |          # Must NOT be inside this pattern
  with $CTX:
    ...
```

### Negation
```yaml
pattern-not: safe(...)         # Exclude this pattern
pattern-not-regex: ^test_      # Exclude by regex
```

### Metavariable Filters
```yaml
metavariable-regex:
  metavariable: $FUNC
  regex: (unsafe|dangerous).*

metavariable-pattern:
  metavariable: $ARG
  pattern: request.$X

metavariable-comparison:
  metavariable: $NUM
  comparison: $NUM > 1024
```

### Focus
```yaml
focus-metavariable: $TARGET    # Report finding on this metavariable only
```

## Taint Mode

```yaml
rules:
  - id: taint-rule
    mode: taint
    languages: [python]
    severity: HIGH
    message: Tainted data reaches sink
    pattern-sources:
      - pattern: user_input()
      - pattern: request.args.get(...)
    pattern-sinks:
      - pattern: eval(...)
      - pattern: os.system(...)
    pattern-sanitizers:           # Optional
      - pattern: sanitize(...)
      - pattern: escape(...)
```

### Taint Options
```yaml
pattern-sources:
  - pattern: source(...)
    exact: true                   # Only exact match is source (default: false)
    by-side-effect: true          # Taints variable by side effect

pattern-sanitizers:
  - pattern: sanitize($X)
    exact: true                   # Only exact match (default: false)
    by-side-effect: true          # Sanitizes by side effect

pattern-sinks:
  - pattern: sink(...)
    exact: false                  # Subexpressions also sinks (default: true)
```

## Test File Annotations

Only allowed annotations are `ok: rule-id` and `ok: rule-id`.

```python
# ruleid: rule-id
vulnerable_code()              # This line MUST match

# ok: rule-id
safe_code()                    # This line MUST NOT match
```

DO NOT use multi-line comments for test annotations, for example:
/* ruleid: ... */

## Debugging Commands

```bash
# Test rules
semgrep --test --config <rule-id>.yaml <rule-id>.<ext>

# Validate YAML syntax
semgrep --validate --config <rule-id>.yaml

# Run with dataflow traces (for taint mode rules)
semgrep --dataflow-traces -f <rule-id>.yaml <rule-id>.<ext>

# Dump AST to understand code structure
semgrep --dump-ast -l <language> <rule-id>.<ext>

# Run single rule
semgrep -f <rule-id>.yaml <rule-id>.<ext>
```

## Troubleshooting

### Common Pitfalls

1. **Wrong annotation line**: `ruleid:` must be on the line IMMEDIATELY BEFORE the finding. No other text or code
2. **Too generic patterns**: Avoid `pattern: $X` without constraints
3. **YAML syntax errors**: Validate with `semgrep --validate`

### Pattern Not Matching

1. Check AST structure: `semgrep --dump-ast -l <language> <rule-id>.<ext>`
2. Verify metavariable binding
3. Check for whitespace/formatting differences
4. Try more general pattern first, then narrow down

### Taint Not Propagating

1. Use `--dataflow-traces` to see flow
2. Check if sanitizer is too broad
3. Verify source pattern matches
4. Check sink focus-metavariable

### Too Many False Positives

1. Add `pattern-not` for safe cases
2. Add sanitizers for validation functions
3. Use `pattern-inside` to limit scope
4. Use `metavariable-regex` to filter

