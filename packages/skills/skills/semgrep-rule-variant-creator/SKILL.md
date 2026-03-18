---
name: semgrep-rule-variant-creator
description: "Create variant Semgrep rules from existing detections to catch related vulnerability patterns. Use when extending a Semgrep rule to cover additional code patterns, languages, or frameworks, when a rule catches one variant but misses others, or when adapting rules for a different tech stack."
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
---

# Semgrep Rule Variant Creator

## When to Use

- Extending an existing Semgrep rule to cover additional vulnerability patterns
- A rule catches one variant but misses similar patterns in different syntax
- Adapting rules from one framework/language to another
- Broadening detection after a specific vulnerability is found
- Creating a family of related rules from a single exemplar

## When NOT to Use

- Writing rules from scratch (use semgrep-rule-creator)
- Complex cross-function data flow (use CodeQL)
- Rules for non-code files

## Variant Creation Workflow

### 1. Analyze the Original Rule

```yaml
# Original rule - catches one pattern
rules:
  - id: sql-injection-format-string
    languages: [python]
    pattern: cursor.execute(f"...{$INPUT}...")
    severity: ERROR
    message: "SQL injection via f-string"
```

### 2. Identify Missing Variants

Think about:
- Other string construction methods (concatenation, `.format()`, `%` operator)
- Other SQL execution methods (`executemany`, `raw`, ORM `.extra()`)
- Framework-specific variants (Django, SQLAlchemy, asyncpg)
- Variable indirection (assigned to variable first, then executed)

### 3. Create Variant Rules

```yaml
rules:
  - id: sql-injection-all-string-construction
    languages: [python]
    severity: ERROR
    message: "SQL injection via string construction: $QUERY"
    pattern-either:
      # f-string
      - pattern: $CURSOR.execute(f"...{$INPUT}...")
      # concatenation
      - pattern: $CURSOR.execute("..." + $INPUT + "...")
      # format method
      - pattern: $CURSOR.execute("...".format(..., $INPUT, ...))
      # percent operator
      - pattern: $CURSOR.execute("..." % $INPUT)
    pattern-not:
      # Exclude parameterized queries
      - pattern: $CURSOR.execute("...", (...))
```

### 4. Add Framework Variants

```yaml
  # Django ORM variant
  - id: django-raw-sql-injection
    languages: [python]
    pattern-either:
      - pattern: $MODEL.objects.raw(f"...{$INPUT}...")
      - pattern: $MODEL.objects.raw("..." + $INPUT)
      - pattern: $MODEL.objects.extra(where=[f"...{$INPUT}..."])
    severity: ERROR
    message: "Django ORM SQL injection"
```

## Variant Dimensions

| Dimension | Example Variants |
|-----------|-----------------|
| String construction | f-string, concat, format, template |
| API methods | execute, executemany, raw, query |
| Frameworks | Django, Flask, FastAPI, SQLAlchemy |
| Languages | Python, JavaScript, Java, Go |
| Encoding | Direct, base64, URL-encoded, hex |
| Indirection | Direct use, variable assignment, function return |

## Testing Variants

Create comprehensive test files that cover all variant patterns:

```python
# ruleid: sql-injection-all-string-construction
cursor.execute(f"SELECT * FROM users WHERE id = {uid}")

# ruleid: sql-injection-all-string-construction
cursor.execute("SELECT * FROM users WHERE id = " + uid)

# ok: sql-injection-all-string-construction
cursor.execute("SELECT * FROM users WHERE id = %s", (uid,))
```

```bash
semgrep --test rules/
```

## Best Practices

1. Group related variants under a common rule ID prefix
2. Use `pattern-either` to combine variants in one rule when possible
3. Always add `pattern-not` exclusions for safe patterns
4. Test each variant independently with annotated test cases
5. Document which variant the original rule was based on
