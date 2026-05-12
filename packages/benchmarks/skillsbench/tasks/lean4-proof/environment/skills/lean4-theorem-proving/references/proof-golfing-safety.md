# Proof Golfing: Safety, Workflow & Reference

**Safety warnings, systematic workflow, anti-patterns, and appendix. For quick reference, see [proof-golfing.md](proof-golfing.md).**

## Contents
- [Critical Safety Warnings](#critical-safety-warnings)
- [Systematic Workflow](#systematic-workflow)
- [Anti-Patterns](#anti-patterns)
- [Failed Optimizations (Learning)](#failed-optimizations-learning)
- [Appendix](#appendix)

---

## Critical Safety Warnings

### The 93% False Positive Problem

**Key finding:** Without proper analysis, 93% of "optimization opportunities" are false positives that make code WORSE.

**The Multiple-Use Heuristic:**
- Bindings used 1-2 times: Safe to inline
- Bindings used 3-4 times: 40% worth optimizing (check carefully)
- Bindings used 5+ times: NEVER inline (would increase size 2-4×)

**Example - DON'T optimize:**
```lean
let μ_map := Measure.map (fun ω i => X (k i) ω) μ  -- 20 tokens
-- Used 7 times in proof
-- Current: 20 + (2 × 7) = 34 tokens
-- Inlined: 20 × 7 = 140 tokens (4× WORSE!)
```

### When NOT to Optimize

**Skip if ANY of these:**
- ❌ Let binding used ≥3 times
- ❌ Complex proof with case analysis
- ❌ Semantic naming aids understanding
- ❌ Would create deeply nested lambdas (>2 levels)
- ❌ Readability Cost = (nesting depth) × (complexity) × (repetition) > 5

### Saturation Indicators

**Stop when:**
- ✋ Optimization success rate < 20%
- ✋ Time per optimization > 15 minutes
- ✋ Most patterns are false positives
- ✋ Debating whether 2-token savings is worth it

**Benchmark:** Well-maintained codebases reach saturation after ~20-25 optimizations.

---

## Systematic Workflow

### Phase 0: Pre-Optimization Audit (2 min)

Before applying patterns:
1. Remove commented code and unused lemmas
2. Fix linter warnings
3. Run `lake build` for clean baseline

This cleanup often accounts for 60%+ of available savings.

### Phase 1: Pattern Discovery (5 min)

Use systematic search, not sequential reading:

```bash
# 1. Find let+have+exact (HIGHEST value)
grep -A 10 "let .*:=" file.lean | grep -B 8 "exact"

# 2. Find by-exact wrappers
grep -B 1 "exact" file.lean | grep "by$"

# 3. Find ext+simp patterns
grep -n "ext.*simp" file.lean

# 4. Find rw+exact (for rwa)
grep -A 1 "rw \[" file.lean | grep "exact"
```

**Expected:** 10-15 targets per file

### Phase 2: Safety Verification (CRITICAL)

For each let+have+exact pattern:

1. Count let binding uses (or use `analyze_let_usage.py`)
2. If used ≥3 times → SKIP (false positive)
3. If used ≤2 times → Proceed with optimization

**Other patterns:** Verify compilation test will catch issues.

### Phase 3: Apply with Testing (5 min per pattern)

1. Apply optimization
2. Run `lake build`
3. If fails: revert immediately, move to next
4. If succeeds: continue

**Strategy:** Apply 3-5 optimizations, then batch test.

### Phase 4: Check Saturation

After 5-10 optimizations, check indicators:
- Success rate < 20% → Stop
- Time per optimization > 15 min → Stop
- Mostly false positives → Stop

**Recommendation:** Declare victory at saturation.

---

## Anti-Patterns

### Don't Use Semicolons Just to Combine Lines

```lean
-- ❌ Bad (no savings)
intro x; exact proof  -- Semicolon is a token!

-- ✅ Good (when saves ≥2 lines AND sequential)
ext x; simp [...]; use y; simp  -- Sequential operations
```

**When semicolons ARE worth it:**
- ✅ Sequential operations (ext → simp → use)
- ✅ Saves ≥2 lines
- ✅ Simple steps

### Don't Over-Inline

If inlining creates unreadable proof, keep intermediate steps:

```lean
-- ❌ Bad - unreadable
exact combine (obscure nested lambdas spanning 100+ chars)

-- ✅ Good - clear intent
have h1 : A := ...
have h2 : B := ...
exact combine h1 h2
```

### Don't Remove Helpful Names

```lean
-- ❌ Bad
have : ... := by ...  -- 10 lines
have : ... := by ...  -- uses first anonymous have

-- ✅ Good
have h_key_property : ... := by ...
have h_conclusion : ... := by ...  -- uses h_key_property
```

---

## Failed Optimizations (Learning)

### Not All `ext` Calls Are Redundant

```lean
-- Original (works)
ext x; simp [prefixCylinder]

-- Attempted (FAILS!)
simp [prefixCylinder]  -- simp alone didn't make progress
```

**Lesson:** Sometimes simp needs goal decomposed first. Always test.

### omega with Fin Coercions

```lean
-- Attempted (FAILS with counterexample!)
by omega

-- Correct (works)
Nat.add_lt_add_left hij k
```

**Lesson:** omega struggles with Fin coercions. Direct lemmas more reliable.

---

## Appendix

### Token Counting Quick Reference

```lean
// ~1 token each
let, have, exact, intro, by, fun

// ~2 tokens each
:=, =>, (fun x => ...), StrictMono

// ~5-10 tokens
let x : Type := definition
have h : Property := by proof
```

**Rule of thumb:**
- Each line ≈ 8-12 tokens
- Each have + proof ≈ 15-20 tokens
- Each inline lambda ≈ 5-8 tokens

### Saturation Metrics

**Session-by-session data:**
- Session 1-2: 60% of patterns worth optimizing
- Session 3: 20% worth optimizing
- Session 4: 6% worth optimizing (diminishing returns)

**Time efficiency:**
- First 15 optimizations: ~2 min each
- Next 7 optimizations: ~5 min each
- Last 3 optimizations: ~18 min each

**Point of diminishing returns:** Success rate < 20% and time > 15 min per optimization.

### Real-World Benchmarks

**Cumulative across sessions:**
- 23 proofs optimized
- ~108 lines removed
- ~34% token reduction average
- ~68% reduction per optimized proof
- 100% compilation success (with multi-candidate approach)

**Technique effectiveness:**
1. let+have+exact: 50% of all savings, 60-80% per instance
2. Smart ext: 50% reduction, no clarity loss
3. ext-simp chains: Saves ≥2 lines when natural
4. rwa: Instant wins, zero risk
5. ext+rfl → rfl: High value when works

---

**Related:** [proof-golfing.md](proof-golfing.md) (quick reference), [proof-golfing-patterns.md](proof-golfing-patterns.md) (pattern details)
