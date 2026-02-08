---
name: semgrep
type: tool
description: >
  Semgrep is a fast static analysis tool for finding bugs and enforcing code standards.
  Use when scanning code for security issues or integrating into CI/CD pipelines.
---

# Semgrep

Semgrep is a highly efficient static analysis tool for finding low-complexity bugs and locating specific code patterns. Because of its ease of use, no need to build the code, multiple built-in rules, and convenient creation of custom rules, it is usually the first tool to run on an audited codebase. Furthermore, Semgrep's integration into the CI/CD pipeline makes it a good choice for ensuring code quality.

**Key benefits:**
- Prevents re-entry of known bugs and security vulnerabilities
- Enables large-scale code refactoring, such as upgrading deprecated APIs
- Easily added to CI/CD pipelines
- Custom Semgrep rules mimic the semantics of actual code
- Allows for secure scanning without sharing code with third parties
- Scanning usually takes minutes (not hours/days)
- Easy to use and accessible for both developers and security professionals

## When to Use

**Use Semgrep when:**
- Looking for bugs with easy-to-identify patterns
- Analyzing single files (intraprocedural analysis)
- Detecting systemic bugs (multiple instances across codebase)
- Enforcing secure defaults and code standards
- Performing rapid initial security assessment
- Scanning code without building it first

**Consider alternatives when:**
- Multiple files are required for analysis → Consider Semgrep Pro Engine or CodeQL
- Complex flow analysis is needed → Consider CodeQL
- Advanced taint tracking across files → Consider CodeQL or Semgrep Pro
- Custom in-house framework analysis → May need specialized tooling

## Quick Reference

| Task | Command |
|------|---------|
| Scan with auto-detection | `semgrep --config auto` |
| Scan with specific ruleset | `semgrep --config="p/trailofbits"` |
| Scan with custom rules | `semgrep -f /path/to/rules` |
| Output to SARIF format | `semgrep -c p/default --sarif --output scan.sarif` |
| Test custom rules | `semgrep --test` |
| Disable metrics | `semgrep --metrics=off --config=auto` |
| Filter by severity | `semgrep --config=auto --severity ERROR` |
| Show dataflow traces | `semgrep --dataflow-traces -f rule.yml` |

## Installation

### Prerequisites

- Python 3.7 or later (for pip installation)
- macOS, Linux, or Windows
- Homebrew (optional, for macOS/Linux)

### Install Steps

**Via Python Package Installer:**

```bash
python3 -m pip install semgrep
```

**Via Homebrew (macOS/Linux):**

```bash
brew install semgrep
```

**Via Docker:**

```bash
docker pull returntocorp/semgrep
```

### Keeping Semgrep Updated

```bash
# Check current version
semgrep --version

# Update via pip
python3 -m pip install --upgrade semgrep

# Update via Homebrew
brew upgrade semgrep
```

### Verification

```bash
semgrep --version
```

## Core Workflow

### Step 1: Initial Scan

Start with an auto-configuration scan to evaluate Semgrep's effectiveness:

```bash
semgrep --config auto
```

**Important:** Auto mode submits metrics online. To disable:

```bash
export SEMGREP_SEND_METRICS=off
# OR
semgrep --metrics=off --config auto
```

### Step 2: Select Targeted Rulesets

Use the [Semgrep Registry](https://semgrep.dev/explore) to select rulesets:

```bash
# Security-focused rulesets
semgrep --config="p/trailofbits"
semgrep --config="p/cwe-top-25"
semgrep --config="p/owasp-top-ten"

# Language-specific
semgrep --config="p/javascript"

# Multiple rulesets
semgrep --config="p/trailofbits" --config="p/r2c-security-audit"
```

### Step 3: Review and Triage Results

Filter results by severity:

```bash
semgrep --config=auto --severity ERROR
```

Use output formats for easier analysis:

```bash
# SARIF for VS Code SARIF Explorer
semgrep -c p/default --sarif --output scan.sarif

# JSON for automation
semgrep -c p/default --json --output scan.json
```

### Step 4: Configure Ignored Files

Create `.semgrepignore` file to exclude paths:

```
# Ignore specific files/directories
path/to/ignore/file.ext
path_to_ignore/

# Ignore by extension
*.ext

# Include .gitignore patterns
:include .gitignore
```

**Note:** By default, Semgrep skips `/tests`, `/test`, and `/vendors` folders.

## How to Customize

### Writing Custom Rules

Semgrep rules are YAML files with pattern-matching syntax. Basic structure:

```yaml
rules:
  - id: rule-id
    languages: [go]
    message: Some message
    severity: ERROR # INFO / WARNING / ERROR
    pattern: test(...)
```

### Running Custom Rules

```bash
# Single file
semgrep --config custom_rule.yaml

# Directory of rules
semgrep --config path/to/rules/
```

### Key Syntax Reference

| Syntax/Operator | Description | Example |
|-----------------|-------------|---------|
| `...` | Match zero or more arguments/statements | `func(..., arg=value, ...)` |
| `$X`, `$VAR` | Metavariable (captures and tracks values) | `$FUNC($INPUT)` |
| `<... ...>` | Deep expression operator (nested matching) | `if <... user.is_admin() ...>:` |
| `pattern-inside` | Match only within context | Pattern inside a loop |
| `pattern-not` | Exclude specific patterns | Negative matching |
| `pattern-either` | Logical OR (any pattern matches) | Multiple alternatives |
| `patterns` | Logical AND (all patterns match) | Combined conditions |
| `metavariable-pattern` | Nested metavariable constraints | Constrain captured values |
| `metavariable-comparison` | Compare metavariable values | `$X > 1337` |

### Example: Detecting Insecure Request Verification

```yaml
rules:
  - id: requests-verify-false
    languages: [python]
    message: requests.get with verify=False disables SSL verification
    severity: WARNING
    pattern: requests.get(..., verify=False, ...)
```

### Example: Taint Mode for SQL Injection

```yaml
rules:
  - id: sql-injection
    mode: taint
    pattern-sources:
      - pattern: request.args.get(...)
    pattern-sinks:
      - pattern: cursor.execute($QUERY)
    pattern-sanitizers:
      - pattern: int(...)
    message: Potential SQL injection with unsanitized user input
    languages: [python]
    severity: ERROR
```

### Testing Custom Rules

Create test files with annotations:

```python
# ruleid: requests-verify-false
requests.get(url, verify=False)

# ok: requests-verify-false
requests.get(url, verify=True)
```

Run tests:

```bash
semgrep --test ./path/to/rules/
```

For autofix testing, create `.fixed` files (e.g., `test.py` → `test.fixed.py`):

```bash
semgrep --test
# Output: 1/1: ✓ All tests passed
#         1/1: ✓ All fix tests passed
```

## Configuration

### Configuration File

Semgrep doesn't require a central config file. Configuration is done via:
- Command-line flags
- Environment variables
- `.semgrepignore` for path exclusions

### Ignore Patterns

Create `.semgrepignore` in repository root:

```
# Ignore directories
tests/
vendor/
node_modules/

# Ignore file types
*.min.js
*.generated.go

# Include .gitignore patterns
:include .gitignore
```

### Suppressing False Positives

Add inline comments to suppress specific findings:

```python
# nosemgrep: rule-id
risky_function()
```

**Best practices:**
- Specify the exact rule ID (not generic `# nosemgrep`)
- Explain why the rule is disabled
- Report false positives to improve rules

### Metadata in Custom Rules

Include metadata for better context:

```yaml
rules:
  - id: example-rule
    metadata:
      cwe: "CWE-89"
      confidence: HIGH
      likelihood: MEDIUM
      impact: HIGH
      subcategory: vuln
    # ... rest of rule
```

## Advanced Usage

### Tips and Tricks

| Tip | Why It Helps |
|-----|--------------|
| Use `--time` flag | Identifies slow rules and files for optimization |
| Limit ellipsis usage | Reduces false positives and improves performance |
| Use `pattern-inside` for context | Creates clearer, more focused findings |
| Enable autocomplete | Speeds up command-line workflow |
| Use `focus-metavariable` | Highlights specific code locations in output |

### Scanning Non-Standard Extensions

Force language interpretation for unusual file extensions:

```bash
semgrep --config=/path/to/config --lang python --scan-unknown-extensions /path/to/file.xyz
```

### Dataflow Tracing

Use `--dataflow-traces` to understand how values flow to findings:

```bash
semgrep --dataflow-traces -f taint_rule.yml test.py
```

Example output:

```
Taint comes from:
  test.py
    2┆ data = get_user_input()

This is how taint reaches the sink:
  test.py
    3┆ return output(data)
```

### Polyglot File Scanning

Scan embedded languages (e.g., JavaScript in HTML):

```yaml
rules:
  - id: eval-in-html
    languages: [html]
    message: eval in JavaScript
    patterns:
      - pattern: <script ...>$Y</script>
      - metavariable-pattern:
          metavariable: $Y
          language: javascript
          patterns:
            - pattern: eval(...)
    severity: WARNING
```

### Constant Propagation

Match instances where metavariables hold specific values:

```yaml
rules:
  - id: high-value-check
    languages: [python]
    message: $X is higher than 1337
    patterns:
      - pattern: function($X)
      - metavariable-comparison:
          metavariable: $X
          comparison: $X > 1337
    severity: WARNING
```

### Autofix Feature

Add automatic fixes to rules:

```yaml
rules:
  - id: ioutil-readdir-deprecated
    languages: [golang]
    message: ioutil.ReadDir is deprecated. Use os.ReadDir instead.
    severity: WARNING
    pattern: ioutil.ReadDir($X)
    fix: os.ReadDir($X)
```

Preview fixes without applying:

```bash
semgrep -f rule.yaml --dryrun --autofix
```

Apply fixes:

```bash
semgrep -f rule.yaml --autofix
```

### Performance Optimization

Analyze performance:

```bash
semgrep --config=auto --time
```

Optimize rules:
1. Use `paths` to narrow file scope
2. Minimize ellipsis usage
3. Use `pattern-inside` to establish context first
4. Remove unnecessary metavariables

### Managing Third-Party Rules

Use [semgrep-rules-manager](https://github.com/iosifache/semgrep-rules-manager/) to collect third-party rules:

```bash
pip install semgrep-rules-manager
mkdir -p $HOME/custom-semgrep-rules
semgrep-rules-manager --dir $HOME/custom-semgrep-rules download
semgrep -f $HOME/custom-semgrep-rules
```

## CI/CD Integration

### GitHub Actions

#### Recommended Approach

1. Full scan on main branch with broad rulesets (scheduled)
2. Diff-aware scanning for pull requests with focused rules
3. Block PRs with unresolved findings (once mature)

#### Example Workflow

```yaml
name: Semgrep
on:
  pull_request: {}
  push:
    branches: ["master", "main"]
  schedule:
    - cron: '0 0 1 * *' # Monthly

jobs:
  semgrep-schedule:
    if: ((github.event_name == 'schedule' || github.event_name == 'push' || github.event.pull_request.merged == true)
        && github.actor != 'dependabot[bot]')
    name: Semgrep default scan
    runs-on: ubuntu-latest
    container:
      image: returntocorp/semgrep
    steps:
      - name: Checkout main repository
        uses: actions/checkout@v4
      - run: semgrep ci
        env:
          SEMGREP_RULES: p/default

  semgrep-pr:
    if: (github.event_name == 'pull_request' && github.actor != 'dependabot[bot]')
    name: Semgrep PR scan
    runs-on: ubuntu-latest
    container:
      image: returntocorp/semgrep
    steps:
      - uses: actions/checkout@v4
      - run: semgrep ci
        env:
          SEMGREP_RULES: >
            p/cwe-top-25
            p/owasp-top-ten
            p/r2c-security-audit
            p/trailofbits
```

#### Adding Custom Rules in CI

**Rules in same repository:**

```yaml
env:
  SEMGREP_RULES: p/default custom-semgrep-rules-dir/
```

**Rules in private repository:**

```yaml
env:
  SEMGREP_PRIVATE_RULES_REPO: semgrep-private-rules
steps:
  - name: Checkout main repository
    uses: actions/checkout@v4
  - name: Checkout private custom Semgrep rules
    uses: actions/checkout@v4
    with:
      repository: ${{ github.repository_owner }}/${{ env.SEMGREP_PRIVATE_RULES_REPO }}
      token: ${{ secrets.SEMGREP_RULES_TOKEN }}
      path: ${{ env.SEMGREP_PRIVATE_RULES_REPO }}
  - run: semgrep ci
    env:
      SEMGREP_RULES: ${{ env.SEMGREP_PRIVATE_RULES_REPO }}
```

### Testing Rules in CI

```yaml
name: Test Semgrep rules

on: [push, pull_request]

jobs:
  semgrep-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v4
        with:
          python-version: "3.11"
          cache: "pip"
      - run: python -m pip install -r requirements.txt
      - run: semgrep --test --test-ignore-todo ./path/to/rules/
```

## Common Mistakes

| Mistake | Why It's Wrong | Correct Approach |
|---------|----------------|------------------|
| Using `--config auto` on private code | Sends metadata to Semgrep servers | Use `--metrics=off` or specific rulesets |
| Forgetting `.semgrepignore` | Scans excluded directories like `/vendor` | Create `.semgrepignore` file |
| Not testing rules with false positives | Rules generate noise | Add `# ok:` test cases |
| Using generic `# nosemgrep` | Makes code review harder | Use `# nosemgrep: rule-id` with explanation |
| Overusing ellipsis `...` | Degrades performance and accuracy | Use specific patterns when possible |
| Not including metadata in rules | Makes triage difficult | Add CWE, confidence, impact fields |

## Limitations

- **Single-file analysis:** Cannot track data flow across files without Semgrep Pro Engine
- **No build required:** Cannot analyze compiled code or resolve dynamic dependencies
- **Pattern-based:** May miss vulnerabilities requiring deep semantic understanding
- **Limited taint tracking:** Complex taint analysis is still evolving
- **Custom frameworks:** In-house proprietary frameworks may not be well-supported

## Related Skills

| Skill | When to Use Together |
|-------|---------------------|
| **codeql** | For cross-file taint tracking and complex data flow analysis |
| **sarif-parsing** | For processing Semgrep SARIF output in pipelines |

## Resources

### Key External Resources

**[Trail of Bits public Semgrep rules](https://github.com/trailofbits/semgrep-rules)**
Community-contributed Semgrep rules for security audits, with contribution guidelines and quality standards.

**[Semgrep Registry](https://semgrep.dev/explore)**
Official registry of Semgrep rules, searchable by language, framework, and security category.

**[Semgrep Playground](https://semgrep.dev/playground/new)**
Interactive online tool for writing and testing Semgrep rules. Use "simple mode" for easy pattern combination.

**[Learn Semgrep Syntax](https://semgrep.dev/learn)**
Comprehensive guide on Semgrep rule-writing fundamentals.

**[Trail of Bits Blog: How to introduce Semgrep to your organization](https://blog.trailofbits.com/2024/01/12/how-to-introduce-semgrep-to-your-organization/)**
Seven-step plan for organizational adoption of Semgrep, including pilot testing, evangelization, and CI/CD integration.

**[Trail of Bits Blog: Discovering goroutine leaks with Semgrep](https://blog.trailofbits.com/2021/11/08/discovering-goroutine-leaks-with-semgrep/)**
Real-world example of writing custom rules to detect Go-specific issues.

### Video Resources

- [Introduction to Semgrep - Trail of Bits Webinar](https://www.youtube.com/watch?v=yKQlTbVlf0Q)
- [Detect complex code patterns using semantic grep](https://www.youtube.com/watch?v=IFRp2Y3cqOw)
- [Semgrep part 1 - Embrace Secure Defaults, Block Anti-patterns and more](https://www.youtube.com/watch?v=EIjoqwT53E4)
- [Semgrep Weekly Wednesday Office Hours: Modifying Rules to Reduce False Positives](https://www.youtube.com/watch?v=VSL44ZZ7EvY)
- [Raining CVEs On WordPress Plugins With Semgrep | Nullcon Goa 2022](https://www.youtube.com/watch?v=RvKLn2ofMAo)
