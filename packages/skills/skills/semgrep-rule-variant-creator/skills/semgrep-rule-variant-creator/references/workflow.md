# Detailed Variant Creation Workflow

Complete step-by-step workflow for porting Semgrep rules to new languages.

## Core Principle: Independent Cycles

Each target language goes through the complete 4-phase cycle independently:

```
FOR EACH target language:
  ┌─────────────────────────────────────────────────────────┐
  │ Phase 1: Applicability Analysis                         │
  │   └─→ APPLICABLE? Continue                              │
  │   └─→ NOT_APPLICABLE? Skip to next language             │
  │                                                         │
  │ Phase 2: Test Creation (Test-First)                     │
  │   └─→ Create test file with ruleid/ok annotations       │
  │                                                         │
  │ Phase 3: Rule Creation                                  │
  │   └─→ Analyze AST, write rule, update metadata          │
  │                                                         │
  │ Phase 4: Validation                                     │
  │   └─→ Tests pass? Complete, proceed to next language    │
  │   └─→ Tests fail? Iterate phases 2-4                    │
  └─────────────────────────────────────────────────────────┘
```

**Do NOT batch**: Complete all phases for one language before starting the next.

## Phase 1: Applicability Analysis

### Step 1.1: Parse the Original Rule

Extract key components:

```yaml
# Example original rule
rules:
  - id: python-sql-injection
    mode: taint
    languages: [python]
    severity: ERROR
    message: SQL injection vulnerability
    pattern-sources:
      - pattern: request.args.get(...)
    pattern-sinks:
      - pattern: cursor.execute($QUERY, ...)
    pattern-sanitizers:
      - pattern: sanitize(...)
```

Document:
- **Rule ID**: python-sql-injection
- **Mode**: taint (optional, if taint mode used via `mode: taint`)
- **Sources**: request.args.get(...) (via `pattern-sources` - if taint analysis mode used)
- **Sinks**: cursor.execute($QUERY, ...) (via `pattern-sinks` - if taint analysis mode used)
- **Sanitizers**: sanitize(...) (via `pattern-sanitizers` - optional, if taint analysis used)

### Step 1.2: Analyze for Target Language

For each target language, determine applicability.

See [applicability-analysis.md]({baseDir}/references/applicability-analysis.md) for detailed guidance.

### Step 1.3: Document Verdict

```
TARGET: golang
VERDICT: APPLICABLE
REASONING: SQL injection applies to Go. database/sql package provides
Query/Exec functions that can be vulnerable to injection when string
concatenation is used instead of parameterized queries.
EQUIVALENT_CONSTRUCTS:
  - Source: request.args.get → r.URL.Query().Get(), r.FormValue()
  - Sink: cursor.execute → db.Query(), db.Exec()
```

If `NOT_APPLICABLE`, document why and proceed to next target language.

## Phase 2: Test Creation

### Step 2.1: Create Directory Structure

```bash
mkdir <original-rule-id>-<language>
```

Example:
```bash
mkdir python-sql-injection-golang
```

### Step 2.2: Write Test File

Create test file with target language extension:

```go
// python-sql-injection-golang.go
package main

import (
    "database/sql"
    "net/http"
)

// Vulnerable cases - MUST be flagged
func vulnerable1(db *sql.DB, r *http.Request) {
    userID := r.URL.Query().Get("id")
    // ruleid: python-sql-injection-golang
    db.Query("SELECT * FROM users WHERE id = " + userID)
}

func vulnerable2(db *sql.DB, r *http.Request) {
    name := r.FormValue("name")
    // ruleid: python-sql-injection-golang
    db.Exec("DELETE FROM users WHERE name = '" + name + "'")
}

// Safe cases - must NOT be flagged
func safeParameterized(db *sql.DB, r *http.Request) {
    userID := r.URL.Query().Get("id")
    // ok: python-sql-injection-golang
    db.Query("SELECT * FROM users WHERE id = ?", userID)
}

func safeHardcoded(db *sql.DB) {
    // ok: python-sql-injection-golang
    db.Query("SELECT * FROM users WHERE id = 1")
}
```

### Step 2.3: Test Case Requirements

**Minimum cases:**
- 2+ vulnerable cases (`ruleid:`)
- 2+ safe cases (`ok:`)

**Include variations:**
- Different sink functions (Query, Exec, QueryRow)
- Different source patterns (URL params, form values)
- Different string construction (concatenation, fmt.Sprintf)
- Safe patterns (parameterized queries, hardcoded values)

### Step 2.4: Annotation Placement

**CRITICAL**: The annotation comment must be on the line IMMEDIATELY BEFORE the code:

```go
// ruleid: my-rule
vulnerableCode()  // This line gets flagged

// ok: my-rule
safeCode()  // This line must NOT be flagged
```

## Phase 3: Rule Creation

### Step 3.1: Analyze AST

```bash
semgrep --dump-ast -l go python-sql-injection-golang.go
```

Study the AST structure for:
- How function calls are represented
- How string concatenation appears
- How method calls are structured

### Step 3.2: Write the Rule

Create rule file with adapted patterns:

```yaml
# python-sql-injection-golang.yaml
rules:
  - id: python-sql-injection-golang
    mode: taint
    languages: [go]
    severity: ERROR
    message: >-
      SQL injection vulnerability. User input from $SOURCE flows to
      database query without sanitization.
    metadata:
      original-rule: python-sql-injection
      ported-from: python
    pattern-sources:
      - patterns:
          - pattern: $R.URL.Query().Get(...)
      - patterns:
          - pattern: $R.FormValue(...)
    pattern-sinks:
      - patterns:
          - pattern: $DB.Query($QUERY, ...)
          - focus-metavariable: $QUERY
      - patterns:
          - pattern: $DB.Exec($QUERY, ...)
          - focus-metavariable: $QUERY
      - patterns:
          - pattern: $DB.QueryRow($QUERY, ...)
          - focus-metavariable: $QUERY
```

### Step 3.3: Update Metadata

For each ported rule:
- **id**: Append `-<language>` to original ID
- **languages**: Change to target language
- **message**: Adapt if needed for language context
- **metadata**: Add `original-rule` and `ported-from` fields

### Step 3.4: Adapt Pattern Syntax

See [language-syntax-guide.md]({baseDir}/references/language-syntax-guide.md) for translation guidance.

## Phase 4: Validation

### Step 4.1: Validate YAML

```bash
semgrep --validate --config python-sql-injection-golang.yaml
```

Fix any syntax errors before proceeding.

### Step 4.2: Run Tests

```bash
semgrep --test --config python-sql-injection-golang.yaml python-sql-injection-golang.go
```

### Step 4.3: Check Results

**Success:**
```
1/1: ✓ All tests passed
```

**Failure - missed lines:**
```
✗ python-sql-injection-golang
  missed lines: [15, 22]
```

Rule didn't match when it should. Check:
- Pattern too specific
- Missing pattern variant
- AST structure mismatch

**Failure - incorrect lines:**
```
✗ python-sql-injection-golang
  incorrect lines: [30, 35]
```

Rule matched when it shouldn't. Check:
- Pattern too broad
- Need pattern-not exclusion
- Sanitizer pattern missing

### Step 4.4: Debug Taint Rules

If using taint mode and having issues:

```bash
semgrep --dataflow-traces -f python-sql-injection-golang.yaml python-sql-injection-golang.go
```

Shows:
- Where taint originates
- How taint propagates
- Where taint reaches sinks
- Why taint might not flow (sanitizers, breaks in flow)

### Step 4.5: Iterate Until Pass

Repeat phases 2-4 as needed:
1. Add test cases to cover edge cases
2. Adjust patterns to match/exclude correctly
3. Re-run tests
4. Continue until "All tests passed"

## Phase 5: Proceed to Next Language

Only after all tests pass for one language:
1. Document completion
2. Move to next target language
3. Start fresh at Phase 1

## Output Structure

After completing all target languages:

```
python-sql-injection-golang/
├── python-sql-injection-golang.yaml
└── python-sql-injection-golang.go

python-sql-injection-java/
├── python-sql-injection-java.yaml
└── python-sql-injection-java.java

# If a language was NOT_APPLICABLE, no directory is created
# Document the reason in your response
```

## Troubleshooting

### Pattern Not Matching

1. **Dump AST**: `semgrep --dump-ast -l <lang> file`
2. **Compare structure**: Your pattern vs actual AST
3. **Check metavariables**: Correct binding?
4. **Try broader pattern**: Then narrow down

### Taint Not Propagating

1. **Use --dataflow-traces**: See where taint stops
2. **Check sanitizers**: Too broad?
3. **Verify sources**: Pattern actually matching?
4. **Check focus-metavariable**: On correct part of sink?

### Too Many False Positives

1. **Add pattern-not**: Exclude safe patterns
2. **Add sanitizers**: Validation functions
3. **Use pattern-inside**: Limit scope
4. **Check safe test cases**: Are they actually safe?

### YAML Syntax Errors

1. **Run --validate**: Get specific error
2. **Check indentation**: YAML is whitespace-sensitive
3. **Quote strings**: If they contain special characters
4. **Use multiline**: For complex patterns (`|` or `>-`)

## Example: Complete Workflow

### Original Rule

```yaml
# python-command-injection.yaml
rules:
  - id: python-command-injection
    mode: taint
    languages: [python]
    severity: ERROR
    message: Command injection vulnerability
    pattern-sources:
      - pattern: request.args.get(...)
    pattern-sinks:
      - pattern: os.system(...)
      - pattern: subprocess.call($CMD, shell=True, ...)
    pattern-sanitizers:
      - pattern: shlex.quote(...)
```

### Target Languages: Go and Java

---

### Go Variant

**Phase 1: Applicability**
```
TARGET: Go
VERDICT: APPLICABLE
REASONING: Command injection applies. Go's os/exec package can execute
commands. When user input is passed to exec.Command or wrapped in shell
execution, it's vulnerable.
```

**Phase 2: Test File** (`python-command-injection-golang.go`)
```go
package main

import (
    "net/http"
    "os/exec"
)

func vulnerable1(r *http.Request) {
    cmd := r.URL.Query().Get("cmd")
    // ruleid: python-command-injection-golang
    exec.Command("bash", "-c", cmd).Run()
}

func vulnerable2(r *http.Request) {
    input := r.FormValue("input")
    // ruleid: python-command-injection-golang
    exec.Command("sh", "-c", input).Run()
}

func safeNoShell(r *http.Request) {
    arg := r.URL.Query().Get("arg")
    // ok: python-command-injection-golang
    exec.Command("echo", arg).Run()
}

func safeHardcoded() {
    // ok: python-command-injection-golang
    exec.Command("ls", "-la").Run()
}
```

**Phase 3: Rule** (`python-command-injection-golang.yaml`)
```yaml
rules:
  - id: python-command-injection-golang
    mode: taint
    languages: [go]
    severity: ERROR
    message: Command injection via shell execution
    metadata:
      original-rule: python-command-injection
      ported-from: python
    pattern-sources:
      - pattern: $R.URL.Query().Get(...)
      - pattern: $R.FormValue(...)
    pattern-sinks:
      - patterns:
          - pattern: exec.Command("bash", "-c", $CMD, ...)
          - focus-metavariable: $CMD
      - patterns:
          - pattern: exec.Command("sh", "-c", $CMD, ...)
          - focus-metavariable: $CMD
```

**Phase 4: Validate**
```bash
semgrep --validate --config python-command-injection-golang.yaml
semgrep --test --config python-command-injection-golang.yaml python-command-injection-golang.go
# Output: ✓ All tests passed
```

---

### Java Variant

**Phase 1: Applicability**
```
TARGET: Java
VERDICT: APPLICABLE
REASONING: Command injection applies. Java's Runtime.exec() and
ProcessBuilder can execute commands. User input passed directly is vulnerable.
```

**Phase 2: Test File** (`python-command-injection-java.java`)
```java
import javax.servlet.http.*;
import java.io.*;

public class CommandTest {
    // ruleid: python-command-injection-java
    public void vulnerable1(HttpServletRequest request) throws Exception {
        String cmd = request.getParameter("cmd");
        Runtime.getRuntime().exec(cmd);
    }

    // ruleid: python-command-injection-java
    public void vulnerable2(HttpServletRequest request) throws Exception {
        String cmd = request.getParameter("cmd");
        new ProcessBuilder(cmd).start();
    }

    // ok: python-command-injection-java
    public void safeHardcoded() throws Exception {
        Runtime.getRuntime().exec("ls -la");
    }

    // ok: python-command-injection-java
    public void safeArray(HttpServletRequest request) throws Exception {
        String arg = request.getParameter("arg");
        Runtime.getRuntime().exec(new String[]{"echo", arg});
    }
}
```

**Phase 3: Rule** (`python-command-injection-java.yaml`)
```yaml
rules:
  - id: python-command-injection-java
    mode: taint
    languages: [java]
    severity: ERROR
    message: Command injection vulnerability
    metadata:
      original-rule: python-command-injection
      ported-from: python
    pattern-sources:
      - pattern: (HttpServletRequest $REQ).getParameter(...)
    pattern-sinks:
      - pattern: Runtime.getRuntime().exec($CMD)
        focus-metavariable: $CMD
      - patterns:
          - pattern: new ProcessBuilder($CMD, ...).start()
          - focus-metavariable: $CMD
```

**Phase 4: Validate**
```bash
semgrep --validate --config python-command-injection-java.yaml
semgrep --test --config python-command-injection-java.yaml python-command-injection-java.java
# Output: ✓ All tests passed
```

---

### Final Output

```
python-command-injection-golang/
├── python-command-injection-golang.yaml
└── python-command-injection-golang.go

python-command-injection-java/
├── python-command-injection-java.yaml
└── python-command-injection-java.java
```
