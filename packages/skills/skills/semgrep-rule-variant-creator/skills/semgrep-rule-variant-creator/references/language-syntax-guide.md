# Language Syntax Translation Guide

Guidance for translating Semgrep patterns between languages. This is NOT a pre-built mapping—use these principles to research and adapt patterns for your specific case.

## General Translation Principles

### 1. Never Assume Syntax Equivalence

What looks similar may parse differently:

```python
# Python: method call on object
obj.method(arg)

# Go: might be method OR field access + function call
obj.Method(arg)      # Method call
obj.Field(arg)       # Field holding function, then called
```

**Always dump the AST** for your target language to see the actual structure.

### 2. Research Before Translating

For each construct in the original rule:
1. Search target language documentation for equivalent
2. Look for multiple ways the same thing can be written
3. Check if language idioms differ significantly

### 3. Preserve Detection Intent, Not Literal Syntax

The goal is detecting the same vulnerability, not matching identical syntax.

```yaml
# Original (Python) - detects eval of user input
pattern: eval($USER_INPUT)

# Go doesn't have eval() - what's the equivalent danger?
# Research shows: template execution, reflect-based eval, etc.
# Adapt to what actually creates the vulnerability in Go
```

## AST Analysis

### Always Dump the AST

```bash
semgrep --dump-ast -l <target-language> test-file
```

Compare how similar constructs are represented:

```python
# Python
cursor.execute(query)
```

```go
// Go
db.Query(query)
```

The AST structure may differ significantly even for conceptually similar operations.

### Key Differences to Watch

| Aspect | May Differ |
|--------|-----------|
| Method calls | Receiver position, syntax |
| Function arguments | Named vs positional, defaults |
| String handling | Interpolation, concatenation |
| Error handling | Exceptions vs return values |
| Imports | How namespaces work |

## Metavariable Adaptation

### Metavariables Work Cross-Language

Semgrep metavariables (`$X`, `$FUNC`, etc.) work in all languages:

```yaml
# Works in Python
pattern: $OBJ.execute($QUERY)

# Works in Java
pattern: $OBJ.executeQuery($QUERY)

# Works in Go
pattern: $DB.Query($QUERY, ...)
```

### Ellipsis Behavior

`...` matches language-appropriate constructs:
- In Python: matches arguments, statements
- In Go: matches arguments, statements (handles multi-return)
- In Java: matches arguments, statements, annotations

## Common Translation Categories

### Database Queries

**Research for your target language:**
- Standard library database package
- Popular ORM frameworks
- Raw query execution methods

Common patterns to look for:
- Query execution methods
- Prepared statement patterns
- String interpolation into queries

### Command Execution

**Research for your target language:**
- Standard library process/exec package
- Shell execution vs direct execution
- Argument passing (array vs string)

### File Operations

**Research for your target language:**
- File open/read/write APIs
- Path construction methods
- Directory traversal patterns

### HTTP Handling

**Research for your target language:**
- Request parameter access
- Header access
- Body parsing

## Researching Equivalents

### Step 1: Identify What the Original Detects

Parse the original rule:
- What function/method is the sink?
- What's the vulnerability being detected?
- What makes it dangerous?

### Step 2: Search Target Language Docs

Search for:
- `"<target language> <functionality>"` (e.g., "golang exec command")
- `"<target language> <vulnerability>"` (e.g., "java sql injection")
- Standard library documentation
- [Semgrep Pattern Examples](https://semgrep.dev/docs/writing-rules/pattern-examples) - Per-language pattern references

### Step 3: Find All Variants

A single Python function may have multiple equivalents:

```python
# Python has one main way
os.system(cmd)
```

```java
// Java has multiple
Runtime.getRuntime().exec(cmd);
new ProcessBuilder(cmd).start();
ProcessBuilder.command(cmd).start();
```

Include all common variants in your rule.

### Step 4: Check for Idioms

Languages have preferred patterns:

```python
# Python: often inline
cursor.execute(f"SELECT * FROM users WHERE id = {user_id}")
```

```go
// Go: typically uses placeholders
db.Query("SELECT * FROM users WHERE id = ?", userID)
// Vulnerability is when they DON'T use placeholders
db.Query("SELECT * FROM users WHERE id = " + userID)
```

## Source Pattern Translation

### Web Framework Sources

Original rule sources need framework-specific translation:

```yaml
# Python Flask
pattern: request.args.get(...)

# Java Servlet
pattern: $REQUEST.getParameter(...)

# Go net/http
pattern: $R.URL.Query().Get(...)
pattern: $R.FormValue(...)

# Node.js Express
pattern: $REQ.query.$PARAM
pattern: $REQ.body.$PARAM
```

### User Input Sources

Research common input sources for target language, for example:
- HTTP request parameters
- Command line arguments
- Environment variables
- File reads
- Standard input

## Sanitizer Translation

### Research Sanitization Patterns

Each language has different sanitization approaches:

```python
# Python
shlex.quote(cmd)  # Shell escaping
html.escape(s)    # HTML escaping
```

```go
// Go
template.HTMLEscapeString(s)
// Prepared statements (implicit sanitization)
db.Query("SELECT ... WHERE id = ?", id)
```

```java
// Java
StringEscapeUtils.escapeHtml4(s)
PreparedStatement (implicit sanitization)
```

## Import/Namespace Considerations

### Pattern May Need Context

Some languages require matching imports:

```yaml
# Python - function in global namespace after import
pattern: pickle.loads(...)

# Java - may need full path or import context
pattern: java.io.ObjectInputStream
pattern: ObjectInputStream
```

### When to Use Full Paths

- When function name is common/ambiguous
- When you want to match specific library
- When namespace matters for security

## Testing Your Translation

### Verify with AST Dump

After writing test cases, verify patterns match:

```bash
# Dump AST of test file
semgrep --dump-ast -l <lang> test-file

# Compare with your pattern
# Adjust pattern to match AST structure
```

### Test Edge Cases

Each language has unique edge cases:
- Different string types (Go: string vs []byte)
- Different call syntaxes (method chaining)
- Different argument patterns

## Example: Translating SQL Injection Rule

**Original (Python):**
```yaml
pattern-sinks:
  - pattern: $CURSOR.execute($QUERY, ...)
```

**Research for Go:**
1. Standard database package: `database/sql`
2. Query methods: `Query`, `QueryRow`, `Exec`, `QueryContext`, etc.
3. ORM equivalents: GORM, sqlx, etc.

**Translated (Go - standard library):**
```yaml
pattern-sinks:
  - pattern: $DB.Query($QUERY, ...)
  - pattern: $DB.QueryRow($QUERY, ...)
  - pattern: $DB.Exec($QUERY, ...)
  - pattern: $DB.QueryContext($CTX, $QUERY, ...)
```

**Research for Java:**
1. JDBC: `Statement`, `PreparedStatement`
2. Query methods: `executeQuery`, `executeUpdate`, `execute`

**Translated (Java):**
```yaml
pattern-sinks:
  - pattern: (Statement $S).executeQuery($QUERY)
  - pattern: (Statement $S).executeUpdate($QUERY)
  - pattern: (Statement $S).execute($QUERY)
```

## Checklist Before Writing Rule

- [ ] Dumped AST for target language test file
- [ ] Researched equivalent functions/methods
- [ ] Identified all common variants
- [ ] Checked for language-specific idioms
- [ ] Identified appropriate source patterns
- [ ] Identified appropriate sanitizer patterns
- [ ] Verified patterns match AST structure
