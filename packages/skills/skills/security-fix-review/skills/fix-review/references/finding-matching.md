# Finding Matching Strategies

Techniques for matching security findings to code commits.

## Overview

Matching findings to commits requires multiple approaches since:
- Commit messages may not reference finding IDs
- Findings may span multiple files
- Multiple commits may partially address a single finding
- A single commit may address multiple findings

---

## Matching Approaches

### 1. Direct ID Reference

Search commit messages for finding IDs:

```bash
# Search for TOB-style IDs in commit messages
git log <source>..<target> --grep="TOB-" --oneline

# Search for generic finding references
git log <source>..<target> --grep="[Ff]inding" --oneline
git log <source>..<target> --grep="[Ff]ix" --oneline
```

**Confidence:** High when found, but many commits lack explicit references.

### 2. File Path Matching

Match findings by affected files:

```bash
# Get files changed in commit range
git diff <source>..<target> --name-only

# Compare with files mentioned in finding
# Finding: "The vulnerability exists in contracts/Vault.sol"
# Check: Does any commit modify contracts/Vault.sol?
```

**Workflow:**
1. Extract file paths from finding description
2. List changed files in commit range
3. Identify commits touching those files
4. Analyze those commits in detail

### 3. Function/Symbol Matching

Match by function or variable names:

```bash
# Search for function name in diffs
git log <source>..<target> -p | grep -A5 -B5 "function withdraw"

# Search for specific patterns
git log <source>..<target> -S "functionName" --oneline
```

**Extract symbols from findings:**
- Function names: `withdraw()`, `transfer()`, `validateInput()`
- Variable names: `balance`, `owner`, `allowance`
- Contract/class names: `Vault`, `TokenManager`

### 4. Code Pattern Matching

Match by vulnerability pattern:

```bash
# Finding mentions "missing require statement"
# Search for added require statements
git diff <source>..<target> | grep "^+" | grep "require"

# Finding mentions "reentrancy"
# Search for state changes and external calls
git diff <source>..<target> | grep -E "(\.call|\.transfer|\.send)"
```

---

## Matching Workflow

### Step 1: Extract Finding Metadata

For each finding, extract:

| Field | Example |
|-------|---------|
| ID | TOB-CLIENT-1 |
| Title | Missing access control in withdraw() |
| Severity | High |
| Files | contracts/Vault.sol:L45-L67 |
| Functions | withdraw(), _validateCaller() |
| Pattern | Access control |
| Recommendation | Add onlyOwner modifier |

### Step 2: Search for Direct Matches

```bash
# Check for ID in commit messages
git log <source>..<target> --grep="TOB-CLIENT-1" --oneline

# Check for title keywords
git log <source>..<target> --grep="access control" --oneline
git log <source>..<target> --grep="withdraw" --oneline
```

### Step 3: Identify Relevant Commits

For each file mentioned in the finding:

```bash
# Get commits that modified the file
git log <source>..<target> --oneline -- contracts/Vault.sol

# Get the diff for that file
git diff <source>..<target> -- contracts/Vault.sol
```

### Step 4: Analyze Fix Quality

For each potentially matching commit:

1. **Read the full diff** - Understand what changed
2. **Compare with recommendation** - Does the fix follow the suggested approach?
3. **Check completeness** - Are all instances of the vulnerability fixed?
4. **Verify correctness** - Is the fix itself correct (no logic errors)?

---

## Status Assignment Criteria

### FIXED

Assign when:
- Code change directly addresses the root cause
- Fix follows the report's recommendation (or equivalent)
- All instances of the vulnerability are addressed
- No obvious issues with the fix itself

**Evidence required:**
- Commit hash
- File and line numbers
- Brief explanation of how fix addresses the finding

### PARTIALLY_FIXED

Assign when:
- Some instances fixed, others remain
- Fix addresses symptoms but not root cause
- Fix is incomplete (missing edge cases)
- Fix works but doesn't follow best practice

**Evidence required:**
- What was fixed (with commit hash)
- What remains unfixed
- Specific gaps in the fix

### NOT_ADDRESSED

Assign when:
- No commits modify relevant files
- Changes to relevant files don't address the finding
- Finding relates to architecture/design not changed

**Evidence required:**
- Confirmation that relevant files were checked
- Brief explanation of why no fix was found

### CANNOT_DETERMINE

Assign when:
- Finding is ambiguous
- Code changes are unclear
- Requires runtime analysis to verify
- Need additional context from developers

**Evidence required:**
- What was analyzed
- Specific questions that need answers
- Suggested next steps

---

## Complex Scenarios

### Multiple Commits for One Finding

When several commits contribute to fixing a single finding:

1. List all relevant commits
2. Analyze each contribution
3. Determine if combined effect is FIXED or PARTIALLY_FIXED
4. Document each commit's contribution

**Example:**
```
TOB-XXX-1: Access control vulnerability in withdraw()

Commits:
- abc123: Added onlyOwner modifier
- def456: Added balance check
- ghi789: Added event emission

Combined: FIXED
- abc123 addresses the core access control issue
- def456 adds defense in depth
- ghi789 improves auditability
```

### One Commit for Multiple Findings

When a single commit addresses multiple findings:

1. Analyze the commit once
2. Map specific changes to each finding
3. Assign status to each finding individually
4. Reference the same commit in multiple findings

### Interacting Findings

When findings are related and fixes may interact:

1. Identify the relationship
2. Analyze fixes together
3. Check for conflicts or regressions
4. Document the interaction

**Example:**
```
TOB-XXX-1: Reentrancy in withdraw()
TOB-XXX-2: Missing balance validation

These interact: A reentrancy fix might break the balance check
Analysis: Commit abc123 uses checks-effects-interactions pattern
Result: Both findings addressed without conflict
```

---

## Handling Ambiguity

### When Finding Description is Vague

1. Search for related patterns in the codebase
2. Look for commit messages mentioning the issue
3. Check if any changes seem security-related
4. Mark as CANNOT_DETERMINE if unclear

### When Multiple Interpretations Exist

1. Document both interpretations
2. Analyze against both
3. Note which interpretation the fix addresses
4. Flag for developer clarification if needed

### When Fix Differs from Recommendation

The fix may be valid even if different from the recommendation:

1. Understand the recommended approach
2. Analyze the actual fix
3. Determine if it addresses the root cause
4. Mark as FIXED if effective, note the difference

---

## Git Commands Reference

```bash
# List commits in range
git log <source>..<target> --oneline

# Search commit messages
git log <source>..<target> --grep="pattern" --oneline

# Get files changed
git diff <source>..<target> --name-only

# Get full diff
git diff <source>..<target>

# Get diff for specific file
git diff <source>..<target> -- path/to/file

# Search for code changes
git log <source>..<target> -S "code_pattern" --oneline

# Get commit details
git show <commit> --stat
git show <commit> -p

# Blame specific lines
git blame <commit> -- path/to/file
```
