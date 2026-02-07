# Bug Detection Patterns

Anti-patterns to detect when analyzing commits for bug introduction.

## Overview

When reviewing fix commits, look for changes that may introduce new bugs or security vulnerabilities. These patterns represent common ways that "fixes" can make things worse.

---

## Security Anti-Patterns

### Access Control Weakening

**Pattern:** Removal or weakening of access restrictions

**Detection:**
```bash
# Search for removed access modifiers
git diff <source>..<target> | grep "^-" | grep -E "(onlyOwner|onlyAdmin|require\(msg\.sender|auth|access)"

# Search for visibility changes
git diff <source>..<target> | grep -E "^[-+].*(public|external|internal|private)"
```

**Examples:**
```diff
- function withdraw() external onlyOwner {
+ function withdraw() external {
```

```diff
- require(msg.sender == owner, "Not owner");
+ // Removed for gas optimization
```

**Risk:** Privilege escalation, unauthorized access

---

### Validation Removal

**Pattern:** Removal of input validation or precondition checks

**Detection:**
```bash
# Search for removed require/assert statements
git diff <source>..<target> | grep "^-" | grep -E "(require|assert|revert|throw)"

# Search for removed if-checks
git diff <source>..<target> | grep "^-" | grep -E "if\s*\("
```

**Examples:**
```diff
- require(amount > 0, "Zero amount");
- require(amount <= balance, "Insufficient balance");
  balance -= amount;
```

```diff
- if (input == null) throw new IllegalArgumentException();
  process(input);
```

**Risk:** Input bypass, unexpected states, crashes

---

### Error Handling Reduction

**Pattern:** Removal or weakening of error handling

**Detection:**
```bash
# Search for removed try/catch
git diff <source>..<target> | grep "^-" | grep -E "(try|catch|except|finally)"

# Search for removed error checks
git diff <source>..<target> | grep "^-" | grep -E "(error|Error|err|Err)"
```

**Examples:**
```diff
- try {
    result = riskyOperation();
- } catch (Exception e) {
-   logger.error("Operation failed", e);
-   return fallbackValue;
- }
+ result = riskyOperation();
```

**Risk:** Silent failures, unhandled exceptions, crashes

---

### External Call Reordering

**Pattern:** State updates moved after external calls (reentrancy risk)

**Detection:**
```bash
# Search for external calls followed by state changes
git diff <source>..<target> | grep -A10 "\.call\|\.transfer\|\.send"
```

**Examples:**
```diff
- balance[msg.sender] = 0;
- (bool success,) = msg.sender.call{value: amount}("");
+ (bool success,) = msg.sender.call{value: amount}("");
+ balance[msg.sender] = 0;  // State change after external call!
```

**Risk:** Reentrancy attacks

---

### Integer Operation Changes

**Pattern:** Removal of overflow/underflow protection

**Detection:**
```bash
# Search for SafeMath removal
git diff <source>..<target> | grep "^-" | grep -E "(SafeMath|safeAdd|safeSub|safeMul|safeDiv)"

# Search for unchecked blocks
git diff <source>..<target> | grep -E "unchecked\s*\{"
```

**Examples:**
```diff
- using SafeMath for uint256;
- balance = balance.sub(amount);
+ balance = balance - amount;  // No overflow protection
```

```diff
- total = total + amount;  // Solidity 0.8 has built-in checks
+ unchecked {
+   total = total + amount;  // Disabled overflow check
+ }
```

**Risk:** Integer overflow/underflow

---

### Cryptographic Weakening

**Pattern:** Changes to cryptographic operations that reduce security

**Detection:**
```bash
# Search for crypto-related changes
git diff <source>..<target> | grep -E "(hash|Hash|encrypt|decrypt|sign|verify|random|nonce|salt|key|Key)"

# Search for algorithm names
git diff <source>..<target> | grep -E "(SHA|MD5|AES|RSA|ECDSA|keccak)"
```

**Examples:**
```diff
- bytes32 hash = keccak256(abi.encodePacked(nonce, data));
+ bytes32 hash = keccak256(abi.encodePacked(data));  // Removed nonce!
```

```diff
- return crypto.createHash('sha256').update(data).digest();
+ return crypto.createHash('md5').update(data).digest();  // Weak hash!
```

**Risk:** Hash collisions, signature bypass, predictability

---

### Memory Safety Issues

**Pattern:** Changes that introduce memory safety bugs

**Detection:**
```bash
# Search for buffer/array operations
git diff <source>..<target> | grep -E "(malloc|free|memcpy|strcpy|buffer|array\[)"

# Search for bounds checks
git diff <source>..<target> | grep "^-" | grep -E "(length|size|bounds|index)"
```

**Examples:**
```diff
- if (index < array.length) {
    return array[index];
- }
```

```diff
- strncpy(dest, src, sizeof(dest) - 1);
+ strcpy(dest, src);  // No bounds check!
```

**Risk:** Buffer overflow, use-after-free, out-of-bounds access

---

### Concurrency Issues

**Pattern:** Removal of synchronization or race condition introduction

**Detection:**
```bash
# Search for lock/synchronization changes
git diff <source>..<target> | grep -E "(lock|Lock|mutex|synchronized|atomic|volatile)"

# Search for removed synchronization
git diff <source>..<target> | grep "^-" | grep -E "(lock|synchronized)"
```

**Examples:**
```diff
- synchronized (this) {
    counter++;
- }
+ counter++;  // No synchronization!
```

**Risk:** Race conditions, data corruption

---

## General Bug Patterns

### Logic Inversion

**Pattern:** Boolean logic changed incorrectly

**Detection:**
```bash
# Search for condition changes
git diff <source>..<target> | grep -E "^[-+].*if\s*\(|^[-+].*\?|^[-+].*&&|^[-+].*\|\|"
```

**Examples:**
```diff
- if (isValid) {
+ if (!isValid) {
    process();
  }
```

```diff
- return a && b;
+ return a || b;
```

---

### Off-by-One Errors

**Pattern:** Boundary conditions changed incorrectly

**Detection:**
```bash
# Search for comparison operators
git diff <source>..<target> | grep -E "^[-+].*(<=|>=|<|>|==)"
```

**Examples:**
```diff
- for (i = 0; i < length; i++)
+ for (i = 0; i <= length; i++)  // Off-by-one!
```

```diff
- if (index < array.length)
+ if (index <= array.length)  // Off-by-one!
```

---

### Null/Undefined Handling

**Pattern:** Removal of null checks

**Detection:**
```bash
# Search for null checks
git diff <source>..<target> | grep "^-" | grep -E "(null|NULL|nil|None|undefined)"
```

**Examples:**
```diff
- if (obj == null) return defaultValue;
  return obj.getValue();  // Potential NPE
```

---

### Resource Leaks

**Pattern:** Removal of cleanup code

**Detection:**
```bash
# Search for resource management
git diff <source>..<target> | grep "^-" | grep -E "(close|Close|dispose|Dispose|free|Free|release|Release)"
```

**Examples:**
```diff
  file = open(path)
- try:
    data = file.read()
- finally:
-   file.close()
```

---

## Analysis Workflow

### Step 1: Get the Diff

```bash
git diff <source>..<target> > changes.diff
```

### Step 2: Scan for Anti-Patterns

Run detection commands for each pattern category:

```bash
# Security patterns
grep "^-" changes.diff | grep -E "(require|assert|onlyOwner|auth)"
grep "^-" changes.diff | grep -E "(try|catch|except)"

# Logic patterns
grep -E "^[-+].*if\s*\(" changes.diff
grep -E "^[-+].*(<=|>=|<|>)" changes.diff
```

### Step 3: Manual Review

For each detected pattern:
1. Read the surrounding context
2. Understand the intent of the change
3. Determine if the pattern indicates a bug
4. Document findings

### Step 4: Rate Severity

| Severity | Criteria |
|----------|----------|
| Critical | Exploitable security vulnerability |
| High | Security regression or data loss risk |
| Medium | Logic error with limited impact |
| Low | Code smell, minor issue |
| Info | Observation, no immediate risk |

---

## False Positive Handling

Not every detected pattern is a bug. Consider:

**Intentional changes:**
- Removing redundant validation
- Simplifying error handling
- Refactoring for clarity

**Context matters:**
- Is the removed check truly necessary?
- Is there equivalent protection elsewhere?
- Does the surrounding code handle the case?

**Verify with:**
1. Read the full commit context
2. Check commit message for explanation
3. Look for replacement logic
4. Consider the broader codebase

---

## Reporting Format

For each detected concern:

```markdown
### Bug Introduction Concern

**Pattern:** [Pattern name]
**Commit:** [hash]
**File:** [path:line]
**Severity:** [Critical/High/Medium/Low/Info]

**Change:**
```diff
[relevant diff snippet]
```

**Analysis:**
[Explanation of why this is concerning]

**Recommendation:**
[Suggested action]
```
