# Mathlib Style Guide for Lean 4

Quick reference for mathlib style conventions when writing Lean 4 proofs.

**Official documentation:**
- [Library Style Guidelines](https://leanprover-community.github.io/contribute/style.html)
- [Naming Conventions](https://leanprover-community.github.io/contribute/naming.html)

## Essential Rules

### 1. Copyright Headers (CRITICAL)

Every `.lean` file must start with a copyright header:

```lean
/-
Copyright (c) YYYY Author Name. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Authors: Author Name
-/
import Mathlib.Foo
import Mathlib.Bar

/-!
# Module docstring
```

**Key points:**
- Goes at the very top (first line)
- No blank line between copyright and imports
- Authors line has no period at the end
- Use `Authors:` even for single author
- Imports follow immediately after copyright (no blank line)
- Blank line between imports and module docstring

### 2. Module Docstrings (REQUIRED)

Every file must have a module docstring with `/-!` delimiter:

```lean
/-!
# Title of Module

Brief description of what this file does.

## Main results

- `theorem_name`: Description of what it proves
- `another_theorem`: More description

## Notation

- `|_|`: Custom notation (if any)

## References

- [Author2000] Full citation
-/
```

### 3. Naming Conventions

**Case conventions:**
- `snake_case`: Theorems, lemmas, proofs (anything returning `Prop`)
- `UpperCamelCase`: Types, structures, classes, inductive types
- `lowerCamelCase`: Functions returning non-Prop types, definitions

**When UpperCamelCase appears in snake_case names, use lowerCamelCase:**
```lean
-- ✅ GOOD
def iidProjectiveFamily    -- IID becomes iid
theorem conditionallyIID_of_exchangeable  -- IID becomes iid in snake_case

-- ❌ BAD
def IIDProjectiveFamily    -- Don't use uppercase in function names
```

**Prop-valued classes:**
- If the class is a noun: `IsProbabilityMeasure`, `IsNormal`
- If it's an adjective: `Normal` (no Is prefix needed)

**Inequality naming:**
- Use `le`/`lt` (not `ge`/`gt`) for first occurrence of ≤/<
- Use `ge`/`gt` to indicate arguments are swapped

### 4. Line Length

**Rule:** Lines should not exceed 100 characters

**Breaking strategies:**
```lean
-- Break after function parameters (before :)
theorem foo {μ : Measure (Ω[α])} [IsProbabilityMeasure μ] [StandardBorelSpace α]
    [StandardBorelSpace (Ω[α])] :
    Statement := by

-- Break after :=
def longDefinition :=
    complex_expression_here

-- Break in calc chains after relation symbols
calc a = b := by proof1
  _ = c := by proof2
  _ = d := by proof3

-- Indent continuation lines by 4 spaces (or 2 for certain contexts)
```

**Check for violations:**
```bash
awk 'length > 100 {print FILENAME ":" NR ": " length($0) " chars"}' **/*.lean
```

### 5. File Names

**Rule:** Use `UpperCamelCase.lean` for all files

```lean
-- ✅ GOOD
Core.lean
DeFinetti.lean
ConditionallyIID.lean
ViaKoopman.lean

-- ❌ BAD
core.lean
de_finetti.lean
```

**Exception:** Very rare cases like `lp.lean` for ℓ^p spaces (not typical)

### 6. Tactic Mode Formatting

**Key rules:**
```lean
-- ✅ GOOD: by at end of previous line
theorem foo : Statement := by
  intro x
  cases x
  · exact h1  -- First case (focused with ·)
  · exact h2  -- Second case

-- ❌ BAD: by on its own line
theorem foo : Statement :=
  by
  intro x

-- ✅ GOOD: Focusing dot for subgoals
by
  constructor
  · -- First goal
    sorry
  · -- Second goal
    sorry

-- ⚠️ DISCOURAGED: Semicolons (prefer newlines)
by simp; ring  -- Okay but not preferred
```

**Prefer term mode for simple proofs:**
```lean
-- ✅ GOOD
theorem foo : P := proof_term

-- ⚠️ LESS GOOD
theorem foo : P := by exact proof_term
```

### 7. Calculation Proofs (calc)

**Pattern:**
```lean
calc expression
    = step1 := by justification1
  _ = step2 := by justification2
  _ ≤ step3 := by justification3
```

**Key points:**
- Align relation symbols (=, ≤, <)
- Justify each step
- Can use `by` for rewrites or direct proof terms

### 8. Implicit Parameters

**Use `{param : Type}` when:**
- Type is inferrable from other parameters
- Parameter appears in types but not needed at call site

**Use `(param : Type)` when:**
- Primary data arguments
- Parameter used in function body, not in types
- Named hypotheses/proofs
- Parameters in return types

**Example:**
```lean
-- ✅ GOOD: n inferrable from c
lemma foo {n : ℕ} {c : Fin n → ℝ} : Statement

-- ✅ GOOD: μ and X are primary subjects
theorem bar {μ : Measure Ω} (X : ℕ → Ω → α) : Statement

-- ✅ GOOD: n used in body
def baz (n : ℕ) (F : Ω[α] → ℝ) : Ω[α] → ℝ :=
  fun ω => F ((shift^[n]) ω)
```

See [domain-patterns.md](domain-patterns.md) for detailed implicit parameter conversion patterns.

## Documentation Content Guidelines

### Avoid Development History References

**Don't reference "earlier drafts", "previous versions", or development history:**

```lean
-- ❌ BAD
/-- In earlier drafts, this used axioms, but now it doesn't. -/
/-- Originally defined differently, but we changed the approach. -/
/-- This replaces the old broken implementation. -/

-- ✅ GOOD
/-- Uses mathlib's standard measure theory infrastructure. -/
/-- Constructs via the Koopman representation. -/
```

**Rationale:** Comments should be timeless documentation of current state. History belongs in git commits.

### Avoid Discussing Lean `axiom` Declarations (After Proved)

Once a theorem has been proved (removing the `axiom` keyword), don't highlight that it no longer uses axioms:

```lean
-- ❌ BAD (after development complete)
/-- This construction is completely **axiom-free** and uses only standard mathlib. -/

-- ✅ GOOD
/-- This construction uses mathlib's standard measure theory infrastructure. -/
```

**Exception:** During development, documenting axiom placeholders is appropriate:
```lean
-- ✅ GOOD (during development)
/-- Key lemma for the martingale proof. For now, accepting as axiom. -/
axiom conditionallyIID_of_exchangeable : ...
```

**Note:** Discussion of *mathematical* axioms (Choice, etc.) is perfectly acceptable when mathematically relevant.

## Code Quality Checks

### Before Committing

**1. Check copyright headers:**
```bash
head -5 **/*.lean | grep -A 5 "Copyright"
```

**2. Check line lengths:**
```bash
awk 'length > 100 {print FILENAME ":" NR}' **/*.lean
```

**3. Check naming violations:**
```bash
grep -n "^theorem [A-Z]" **/*.lean  # Should be empty (use snake_case)
grep -n "^def [a-z_].*: Prop" **/*.lean  # Should be empty (Prop = theorem)
```

**4. Count sorries (should decrease over time):**
```bash
grep -c "sorry" **/*.lean
```

**5. Check for disallowed syntax:**
```bash
grep -n "\\$" **/*.lean  # Should use <|
grep -n "\\lambda" **/*.lean  # Should use fun
```

### Verify No Custom Axioms

```lean
#print axioms YourModule.main_theorem
```

Should show only standard mathlib axioms:
- `Classical.choice`
- `propext`
- `Quot.sound`

## Quick Checklist for New Files

- [ ] Copyright header at top
- [ ] Imports immediately after copyright (no blank line)
- [ ] Module docstring with `/-!` delimiter
- [ ] Naming: `snake_case` theorems, `UpperCamelCase` types, `lowerCamelCase` functions
- [ ] Lines ≤ 100 chars
- [ ] `by` at end of line (not alone)
- [ ] Docstrings on main declarations
- [ ] No development history references
- [ ] No sorries in committed code (unless explicitly documented WIP)

## Common Formatting Examples

### Good File Structure

```lean
/-
Copyright (c) 2025 Your Name. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Authors: Your Name
-/
import Mathlib.Foo
import Mathlib.Bar

/-!
# Module Title

Description of module.

## Main results

- `main_theorem`: What it proves
-/

noncomputable section

open Set Function

variable {α : Type*} [MeasurableSpace α]

/-! ### Helper lemmas -/

lemma helper1 : ... := by
  ...

lemma helper2 : ... := by
  ...

/-! ### Main theorems -/

/-- Main theorem proving X. -/
theorem main_theorem : ... := by
  ...
```

## Resources

- **Official Style Guide:** https://leanprover-community.github.io/contribute/style.html
- **Naming Conventions:** https://leanprover-community.github.io/contribute/naming.html
- **How to Contribute:** https://leanprover-community.github.io/lean3/contribute/index.html
- **Mathlib Zulip:** https://leanprover.zulipchat.com/ (#mathlib4 channel)

## Related References

- [domain-patterns.md](domain-patterns.md) - Implicit parameter conversion patterns
- [proof-golfing.md](proof-golfing.md) - Simplifying proofs after compilation
- [compilation-errors.md](compilation-errors.md) - Debugging common errors
