# Calc Chain Patterns

## Overview

Calc chains are powerful for chaining equalities and inequalities, but they interact with simplification in non-obvious ways. This guide shows common patterns and pitfalls.

## Quick Reference

**Key principles:**
1. **After simp, check the actual goal state FIRST** - simp may or may not simplify depending on context
2. **Start calc from whatever the goal actually is** - not what you expect it to be
3. **Context matters** - `filter_upwards with ω` enables more simp simplifications than without
4. **Use canonical forms** - `(m:ℝ)⁻¹` not `1/(m:ℝ)` (but only if simp produced it)
5. **Don't fight simp** - work with its transformations, not against them
6. **One simplification pass** - let simp do all transformations, then reason

**Debugging checklist when calc fails:**
- [ ] Did I use simp before calc?
- [ ] Did I check the actual goal state after simp? (Use LSP or `sorry`)
- [ ] Am I starting calc from the ACTUAL goal, not the expected simplified form?
- [ ] If simp didn't simplify, am I converting in the first calc step?
- [ ] Am I using canonical notation consistently?

## Critical Pattern: simp Before calc

**The Problem:** After `simp [Real.norm_eq_abs]` (or any simp), you must start the calc chain with **whatever form the goal is actually in** after simp runs. This might be the simplified form OR the original form, depending on context.

**What `simp [Real.norm_eq_abs]` CAN do** (context-dependent):
1. Converts `‖x‖` to `|x|` (Real.norm_eq_abs)
2. Converts `|a * b|` to `|a| * |b|` (abs_mul)
3. Simplifies `|positive|` to `positive` (abs_of_pos when provable)
4. Converts `1/(m:ℝ)` to `(m:ℝ)⁻¹` (one_div) - **only in some contexts**

### Example 1: When simp DOES simplify (with ω context)

```lean
-- ❌ WRONG: calc chain starts with original expression
filter_upwards with ω; simp [Real.norm_eq_abs]
calc |(1/(m:ℝ)) * ∑ k : Fin m, f k|
    = |(m:ℝ)⁻¹ * ∑ k : Fin m, f k| := by rw [one_div]
  _ = (m:ℝ)⁻¹ * |∑ k : Fin m, f k| := by rw [abs_mul, abs_of_pos]; positivity
  _ ≤ ...
```

**Error:** `invalid 'calc' step, left-hand side is (m:ℝ)⁻¹ * |∑ ...| but is expected to be |(1/(m:ℝ)) * ∑ ...|`

**Why:** The `filter_upwards with ω; simp [Real.norm_eq_abs]` **already transformed** the goal from `|(1/(m:ℝ)) * ∑...|` to `(m:ℝ)⁻¹ * |∑...|`

```lean
-- ✅ CORRECT: calc chain starts with already-simplified form
filter_upwards with ω; simp [Real.norm_eq_abs]
-- Note: simp already converted |(1/m) * ∑...| to (m:ℝ)⁻¹ * |∑...|
calc (m:ℝ)⁻¹ * |∑ k : Fin m, f k|
    _ ≤ (m:ℝ)⁻¹ * ∑ k : Fin m, |f k| := by
      gcongr; exact Finset.abs_sum_le_sum_abs _ _
  _ ≤ ...
```

**Success:** Start with the simplified form directly, no redundant steps.

### Example 2: When simp does NOT simplify (no ω context)

```lean
-- Context: No filter_upwards, different simp lemmas
-- Goal: ‖1 / (m:ℝ) * ∑ i : Fin m, ...‖ ≤ bound

-- ✅ CORRECT: calc starts with ORIGINAL form (simp didn't simplify it)
simp only [Real.norm_eq_abs, zero_add]
calc |1 / (m:ℝ) * ∑ i : Fin m, ...|
    = (m:ℝ)⁻¹ * |∑ i : Fin m, ...| := by
      rw [one_div, abs_mul, abs_of_pos]; positivity
  _ ≤ ...
```

**Why this works:** Without the `filter_upwards with ω` context, `simp [Real.norm_eq_abs]` did NOT convert `|1/(m:ℝ) * ∑...|` to `(m:ℝ)⁻¹ * |∑...|`, so the calc must start with the original form and perform the conversion explicitly in the first step.

**Key difference:**
- **With `filter_upwards with ω`:** simp simplifies → start calc with simplified form
- **Without that context:** simp doesn't simplify → start calc with original form

### Performance Impact

Removing redundant calc steps:
- **Saves lines:** 15+ redundant steps eliminated across typical session
- **Reduces elaboration time:** From timeout to instant in complex proofs
- **Clearer proofs:** Readers see the actual reasoning, not simp artifacts

### Critical Nuance: When simp DOES vs DOES NOT Simplify

**Important discovery:** `simp [Real.norm_eq_abs]` behavior depends on **context**.

With `filter_upwards with ω` context, simp **DOES** convert `|1/(m:ℝ) * ∑...|` to `(m:ℝ)⁻¹ * |∑...|`:
```lean
-- ✅ simp DOES simplify (with ω context)
filter_upwards with ω; simp [Real.norm_eq_abs]
calc (m:ℝ)⁻¹ * |∑...|  -- Start with simplified form
    _ ≤ ...
```

Without that context, simp **DOES NOT** perform the conversion:
```lean
-- ✅ simp does NOT simplify (no ω context)
simp only [Real.norm_eq_abs, zero_add]
calc |1 / (m:ℝ) * ∑...|  -- Start with ORIGINAL form
    = (m:ℝ)⁻¹ * |∑...|   -- First step: do conversion explicitly
  _ ≤ ...
```

**General rule:** After simp, **always check the goal state** to see what form it's in. Start calc from whatever the goal actually is, not what you expect it to be.

### Debugging Workflow

If you get "invalid 'calc' step" errors:

1. **Check what simp did:** Add `trace_simp` to see transformations
   ```lean
   filter_upwards with ω
   trace_simp [Real.norm_eq_abs]  -- Shows what simp simplified
   calc ...
   ```

2. **Inspect goal state:** Use LSP or `sorry` to see current goal
   ```lean
   filter_upwards with ω; simp [Real.norm_eq_abs]
   sorry  -- Check goal state here
   ```

3. **Start calc from actual goal:** Match what you see in goal state, not what you expect
   - If goal is `(m:ℝ)⁻¹ * |∑...|`, start calc there
   - If goal is `|1/(m:ℝ) * ∑...|`, start calc there and convert in first step

### When This Pattern Applies

This pattern applies whenever:
- Using `simp` before `calc` (not just `Real.norm_eq_abs`)
- Simp lemmas that transform the goal structure (division, abs, norms)
- Building calc chains in measure theory (norms and integrability often simplified)

**General rule:** After any simp, check the goal state before starting calc.

## Type Annotations in Calc Chains

**Use canonical forms that simp produces:**

```lean
-- ❌ WRONG: Non-canonical form
calc |(1/(m:ℝ)) * ∑...|  -- simp will convert to (m:ℝ)⁻¹

-- ✅ CORRECT: Canonical form
calc (m:ℝ)⁻¹ * |∑...|    -- matches what simp produces
```

**Why canonical forms matter:**
1. **Type matching:** Integrable.of_bound and similar lemmas expect canonical forms
2. **Consistency:** All proofs use same notation
3. **Avoids simp loops:** Non-canonical forms may get simplified repeatedly

**Canonical forms:**
- Division: `(m:ℝ)⁻¹` not `1/(m:ℝ)` or `↑m⁻¹`
- Coercion: `(m:ℝ)` not `↑m` (when explicit)
- Norms: `|x|` not `‖x‖` after `Real.norm_eq_abs`

## Common Calc Patterns

### Triangle Inequality Chains

```lean
-- Common pattern for |a - c| ≤ |a - b| + |b - c|
intro ω  -- Use intro, not filter_upwards for simple pointwise
calc |f ω - h ω|
    _ = |f ω - g ω + (g ω - h ω)| := by ring_nf
  _ ≤ |f ω - g ω| + |g ω - h ω| := abs_add _ _
  _ ≤ ...
```

### Sum Bound Chains

```lean
-- Pattern for bounding |(m:ℝ)⁻¹ * ∑ k, f k|
filter_upwards with ω; simp [Real.norm_eq_abs]
calc (m:ℝ)⁻¹ * |∑ k : Fin m, f k|
    _ ≤ (m:ℝ)⁻¹ * ∑ k : Fin m, |f k| := by
      gcongr; exact Finset.abs_sum_le_sum_abs _ _
  _ ≤ (m:ℝ)⁻¹ * ∑ k : Fin m, bound k := by
      gcongr with k; exact individual_bound k
  _ = ... := by ring
```

### Gcongr in Calc

`gcongr` works seamlessly in calc chains for monotone operations:

```lean
calc (m:ℝ)⁻¹ * |∑ k, f k|
    _ ≤ (m:ℝ)⁻¹ * ∑ k, |f k| := by gcongr; exact sum_bound
  _ ≤ (m:ℝ)⁻¹ * (m * C) := by gcongr; exact term_bound
```

## Anti-Patterns

### ❌ Redundant simp Steps in Calc

Don't manually perform what simp already did:

```lean
-- ❌ BAD
simp [Real.norm_eq_abs]
calc |(1/(m:ℝ)) * ∑...|
    = |(m:ℝ)⁻¹ * ∑...| := by rw [one_div]  -- simp already did this!
  _ = (m:ℝ)⁻¹ * |∑...| := by rw [abs_mul, abs_of_pos]; positivity  -- and this!

-- ✅ GOOD
simp [Real.norm_eq_abs]  -- Do simplifications once
calc (m:ℝ)⁻¹ * |∑...|   -- Start from result
  _ ≤ ...                -- Focus on actual reasoning
```

### ❌ Fighting Against Simp

If calc keeps failing, don't try to force it:

```lean
-- ❌ BAD: Adding rw to "fix" simp's transformations
simp [Real.norm_eq_abs]
calc |(1/(m:ℝ)) * ∑...|
    = ... := by rw [← one_div, ← Real.norm_eq_abs]; simp  -- fighting simp!

-- ✅ GOOD: Work with simp's transformations
simp [Real.norm_eq_abs]
calc (m:ℝ)⁻¹ * |∑...|  -- Accept simp's result
  _ ≤ ...
```

### ❌ Mixing Simplified and Unsimplified Forms

Be consistent within a calc chain:

```lean
-- ❌ BAD: mixing 1/(m:ℝ) and (m:ℝ)⁻¹
calc (m:ℝ)⁻¹ * |∑...|
    _ ≤ 1/(m:ℝ) * bound := ...  -- inconsistent notation!

-- ✅ GOOD: consistent notation
calc (m:ℝ)⁻¹ * |∑...|
    _ ≤ (m:ℝ)⁻¹ * bound := ...
```
