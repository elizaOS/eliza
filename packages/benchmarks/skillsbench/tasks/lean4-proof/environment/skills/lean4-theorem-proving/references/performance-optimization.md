# Performance Optimization in Lean 4

Advanced patterns for preventing elaboration timeouts and type-checking performance issues.

**When to use this reference:**
- Hitting WHNF (Weak Head Normal Form) timeouts
- `isDefEq` timeouts during type-checking
- Elaboration taking 500k+ heartbeats even on simple goals
- Build times exploding on proofs involving polymorphic combinators

---

## Quick Reference

| Problem | Pattern | Expected Improvement |
|---------|---------|---------------------|
| WHNF timeout on `eLpNorm`/`MemLp` goals | Pattern 1: Irreducible wrapper | 500k+ → <10k heartbeats |
| `isDefEq` timeout on complex functions | Pattern 1: Pin type parameters | 5-10min → <30sec |
| Repeated measurability proofs | Pattern 1: Pre-prove with wrapper | 28 lines → 8 lines |
| Elaboration timeouts in polymorphic code | Pattern 1: `@[irreducible]` + explicit params | Build success vs timeout |
| Nested lemma applications timeout | Pattern 2: Break into focused helpers | Timeout → compiles |
| Theorem declaration itself times out | Pattern 3: Monomorphization | Timeout → 15s build |

---

## Pattern 1: Irreducible Wrappers for Complex Functions

### Problem

When polymorphic goals like `eLpNorm` or `MemLp` contain complex function expressions, Lean's type checker tries to unfold them to solve polymorphic parameters (`p : ℝ≥0∞`, measure `μ`, typeclass instances). This causes WHNF and `isDefEq` timeouts.

**Example that times out:**
```lean
-- This hits 500k heartbeat limit during elaboration:
have : eLpNorm (fun ω => blockAvg f X 0 n ω - blockAvg f X 0 n' ω) 2 μ < ⊤ := by
  -- Lean unfolds blockAvg → (n:ℝ)⁻¹ * Finset.sum ...
  -- Then chases typeclass instances through every layer
  -- WHNF TIMEOUT!
```

**Root cause:** The expansion of `blockAvg`:
```lean
def blockAvg (f : α → ℝ) (X : ℕ → Ω → α) (m n : ℕ) (ω : Ω) : ℝ :=
  (n : ℝ)⁻¹ * (Finset.range n).sum (fun k => f (X (m + k) ω))
```

becomes deeply nested when substituted into `eLpNorm`, triggering expensive typeclass synthesis.

### Solution: Irreducible Wrapper Pattern

**Step 1: Create frozen wrapper**

```lean
/-- Frozen alias for `blockAvg f X 0 n`. Marked `@[irreducible]` so it
    will *not* unfold during type-checking. -/
@[irreducible]
def blockAvgFrozen {Ω : Type*} (f : ℝ → ℝ) (X : ℕ → Ω → ℝ) (n : ℕ) : Ω → ℝ :=
  fun ω => blockAvg f X 0 n ω
```

**Key point:** `@[irreducible]` prevents definitional unfolding but allows `rw` for manual expansion.

**Step 2: Pre-prove helper lemmas (fast to elaborate)**

These lemmas are cheap because the wrapper is frozen:

```lean
lemma blockAvgFrozen_measurable {Ω : Type*} [MeasurableSpace Ω]
    (f : ℝ → ℝ) (X : ℕ → Ω → ℝ)
    (hf : Measurable f) (hX : ∀ i, Measurable (X i)) (n : ℕ) :
    Measurable (blockAvgFrozen f X n) := by
  rw [blockAvgFrozen]  -- Manual unfold when needed
  exact blockAvg_measurable f X hf hX 0 n

lemma blockAvgFrozen_abs_le_one {Ω : Type*} [MeasurableSpace Ω]
    (f : ℝ → ℝ) (X : ℕ → Ω → ℝ)
    (hf_bdd : ∀ x, |f x| ≤ 1) (n : ℕ) :
    ∀ ω, |blockAvgFrozen f X n ω| ≤ 1 := by
  intro ω
  rw [blockAvgFrozen]
  exact blockAvg_abs_le_one f X hf_bdd 0 n ω

lemma blockAvgFrozen_diff_memLp_two {Ω : Type*} [MeasurableSpace Ω] {μ : Measure Ω}
    [IsProbabilityMeasure μ]
    (f : ℝ → ℝ) (X : ℕ → Ω → ℝ)
    (hf : Measurable f) (hX : ∀ i, Measurable (X i))
    (hf_bdd : ∀ x, |f x| ≤ 1) (n n' : ℕ) :
    MemLp (fun ω => blockAvgFrozen f X n ω - blockAvgFrozen f X n' ω) (2 : ℝ≥0∞) μ := by
  apply memLp_two_of_bounded (M := 2)
  · exact (blockAvgFrozen_measurable f X hf hX n).sub
      (blockAvgFrozen_measurable f X hf hX n')
  intro ω
  have hn  : |blockAvgFrozen f X n  ω| ≤ 1 := blockAvgFrozen_abs_le_one f X hf_bdd n  ω
  have hn' : |blockAvgFrozen f X n' ω| ≤ 1 := blockAvgFrozen_abs_le_one f X hf_bdd n' ω
  calc |blockAvgFrozen f X n ω - blockAvgFrozen f X n' ω|
      ≤ |blockAvgFrozen f X n ω| + |blockAvgFrozen f X n' ω| := by
        simpa [sub_eq_add_neg] using abs_add (blockAvgFrozen f X n ω) (- blockAvgFrozen f X n' ω)
    _ ≤ 1 + 1 := add_le_add hn hn'
    _ = 2 := by norm_num
```

**Step 3: Use in timeout-prone code**

**Before (times out):**
```lean
have hblockAvg_memLp : ∀ n, n > 0 → MemLp (blockAvg f X 0 n) 2 μ := by
  intro n hn_pos
  apply memLp_two_of_bounded
  · -- Measurable: blockAvg is a finite sum of measurable functions
    show Measurable (fun ω => (n : ℝ)⁻¹ * (Finset.range n).sum (fun k => f (X (0 + k) ω)))
    exact Measurable.const_mul (Finset.measurable_sum _ fun k _ =>
      hf_meas.comp (hX_meas (0 + k))) _
  intro ω
  -- 20+ line calc proof
  -- WHNF TIMEOUT HERE AT 500k+ HEARTBEATS
```

**After (fast):**
```lean
have hblockAvg_memLp : ∀ n, n > 0 → MemLp (blockAvg f X 0 n) 2 μ := by
  intro n hn_pos
  have h_eq : blockAvg f X 0 n = blockAvgFrozen f X n := by rw [blockAvgFrozen]
  rw [h_eq]
  apply memLp_two_of_bounded (M := 1)
  · exact blockAvgFrozen_measurable f X hf_meas hX_meas n
  exact fun ω => blockAvgFrozen_abs_le_one f X hf_bdd n ω
```

---

## Supporting Techniques

### Technique 1: Always Pin Polymorphic Parameters

**Problem:** Type inference on polymorphic parameters triggers expensive searches.

```lean
-- ❌ BAD: Lean infers p and μ (expensive)
have : eLpNorm (blockAvg f X 0 n - blockAvg f X 0 n') 2 μ < ⊤

-- ✅ GOOD: Explicit parameters (cheap)
have : eLpNorm (fun ω => BA n ω - BA n' ω) (2 : ℝ≥0∞) (μ := μ) < ⊤
```

**Why:** Explicit `(p := (2 : ℝ≥0∞))` and `(μ := μ)` prevent type class search through function body.

### Technique 2: Use `rw` Not `simp` for Irreducible Definitions

**Problem:** `simp` cannot unfold `@[irreducible]` definitions.

```lean
-- ❌ BAD: simp can't unfold @[irreducible]
have : blockAvg f X 0 n = blockAvgFrozen f X n := by
  simp [blockAvgFrozen]  -- Error: simp made no progress

-- ✅ GOOD: rw explicitly unfolds
have : blockAvg f X 0 n = blockAvgFrozen f X n := by
  rw [blockAvgFrozen]
```

**Why:** `rw` uses the defining equation directly; `simp` respects `@[irreducible]` attribute.

### Technique 3: Pre-prove Facts, Don't Recompute

**Problem:** Reproving the same fact triggers expensive elaboration each time.

```lean
-- ❌ BAD: Recompute MemLp every time (expensive)
intro n n'
have : MemLp (fun ω => blockAvg f X 0 n ω - blockAvg f X 0 n' ω) 2 μ := by
  apply memLp_two_of_bounded
  · -- 10 lines proving measurability
  intro ω
  -- 10 lines proving boundedness

-- ✅ GOOD: One precomputed lemma (cheap)
lemma blockAvgFrozen_diff_memLp_two ... : MemLp ... := by
  -- Proof once (elaborates fast due to irreducible wrapper)

-- Usage:
intro n n'
exact blockAvgFrozen_diff_memLp_two f X hf hX hf_bdd n n'
```

**Benefit:** One slow elaboration → many fast reuses.

### Technique 4: Use Let-Bindings for Complex Terms

**Problem:** Lean re-elaborates complex function expressions multiple times.

```lean
-- ❌ BAD: Lean re-elaborates the function multiple times
have hn  : eLpNorm (blockAvgFrozen f X n - blockAvgFrozen f X n') 2 μ < ⊤
have hn' : MemLp (blockAvgFrozen f X n - blockAvgFrozen f X n') 2 μ

-- ✅ GOOD: Bind once, reuse
let diff := fun ω => blockAvgFrozen f X n ω - blockAvgFrozen f X n' ω
have hn  : eLpNorm diff (2 : ℝ≥0∞) μ < ⊤
have hn' : MemLp diff (2 : ℝ≥0∞) μ
```

**Why:** `let` creates a single binding that's reused definitionally.

---

## Pattern 2: Break Nested Lemma Applications into Focused Helpers

### Problem

Nested applications of the same lemma in a single proof cause deterministic elaboration timeouts, even when each individual application is fast.

**Example that times out:**
```lean
-- ❌ TIMEOUT: Nested applications of geometric_lemma
have result : complex_property := by
  have h1 := geometric_lemma ...
  have h2 := geometric_lemma ...  -- Uses h1
  have h3 := geometric_lemma ...  -- Uses h2
  calc ...  -- Combines h1, h2, h3
    -- Deterministic timeout at 200k heartbeats!
```

**Root cause:** Unification/type-checking complexity compounds with nesting, even though each application is individually simple.

### Solution: One Lemma Application Per Helper

```lean
-- ✅ NO TIMEOUT: Break into focused helpers
have helper1 : intermediate_fact1 := by
  exact geometric_lemma ...  -- One application

have helper2 : intermediate_fact2 := by
  exact geometric_lemma ...  -- One application

have helper3 : intermediate_fact3 := by
  exact geometric_lemma ...  -- One application

have result : complex_property := by
  calc ...
    _ = ... := by rw [helper1]
    _ = ... := by rw [helper2, helper3]
```

**Key principles:**
1. **One complex lemma call per helper** - avoid nesting multiple applications
2. **Meaningful names** - `angle_DBH_eq_DBA`, not `h1`, `h2`, `h3`
3. **Final proof is simple rewrite chain** - just combine the helpers
4. **Each helper independently verifiable** - reduces unification complexity

### Why This Works

Breaking into smaller proofs:
- Reduces complexity of each unification problem
- Allows Lean to cache intermediate results
- Makes each step independently type-checkable
- Avoids compounding elaboration cost

### When to Apply

- Proof uses same complex lemma 3+ times
- "Deterministic timeout" during compilation
- Timeout disappears when you `sorry` intermediate steps
- Proofs involving multiple geometric/algebraic transformations

---

## Pattern 3: Monomorphization to Eliminate Instance Synthesis

### Problem

When theorem declarations with heavy type parameters timeout, the issue is often **instance synthesis at declaration time**, not the proof body. Generic types with many typeclass constraints cause Lean to synthesize instances for every combination of parameters.

**Example that times out at declaration:**
```lean
-- ❌ TIMEOUT: Theorem declaration never completes
theorem angle_AGH_eq_110_of_D
    {V : Type*} {P : Type*}
    [NormedAddCommGroup V] [InnerProductSpace ℝ V]
    [MetricSpace P] [NormedAddTorsor V P]
    [FiniteDimensional ℝ V] [Module.Oriented ℝ V (Fin 2)]
    (h_dim : Module.finrank ℝ V = 2)
    (A B C G H D : P)
    (h_AB_ne : A ≠ B) (h_AC_ne : A ≠ C) (h_BC_ne : B ≠ C)
    -- ... 20+ more parameters
```

**Root cause:** 25 parameters (20 type classes + 5 concrete) trigger combinatorial instance synthesis. Build never completes even for valid theorems.

### Solution: Specialize to Concrete Types

**Step 1: Define concrete type alias**
```lean
-- At file start
abbrev P := EuclideanSpace ℝ (Fin 2)
```

**Step 2: Use concrete type in theorem**
```lean
-- ✅ BUILDS IN 15s: Only 12 concrete parameters
theorem angle_AGH_eq_110_of_D
    (A B C G H D : P)  -- Concrete type!
    (h_AB_ne : A ≠ B) (h_AC_ne : A ≠ C) (h_BC_ne : B ≠ C)
    (h_isosceles : dist A B = dist A C)
    (h_angle_BAC : ∠ B A C = Real.pi / 9)
    -- ... 6 more concrete hypotheses
```

### Key Benefits

**Instance synthesis:** Eliminated - concrete type has all instances pre-computed
**Compilation:** Theorem declaration instant, build completes in 15s
**Code reduction:** 25 parameters → 12 parameters (296 lines saved in proof body)

### When to Monomorphize

**✅ Monomorphize when:**
- Theorem declaration itself times out (instance synthesis problem)
- >15 type parameters with heavy typeclass constraints
- Proof >800 lines in deep context
- Working with concrete mathematical objects (ℝ², ℝ³, specific spaces)

**❌ Keep generic when:**
- Proof <500 lines and compiles quickly
- Genuinely polymorphic result (works for any field, any dimension)
- No instance synthesis issues
- Result intended for mathlib (prefer generality)

### Progressive Simplification Metrics

Track these to validate monomorphization success:

```lean
-- Before monomorphization:
-- Parameters: 25 (20 type classes + 5 concrete)
-- Compilation: Timeout (>1000s) or >400k heartbeats
-- Lines: 1146 with ~300 lines of parametric machinery
-- Sorries: 13 (scattered, poorly documented)

-- After monomorphization:
-- Parameters: 12 (all concrete points + hypotheses)
-- Compilation: 15 seconds
-- Lines: 850 (296 lines removed = -20%)
-- Sorries: 11 (categorized, documented with strategies)
```

### The Golden Rule

**Specialize first, prove it works, then consider generalization.** Don't pay the abstraction tax upfront when working with concrete objects.

---

## When to Use Pattern 1

Apply irreducible wrappers when you see:

1. **WHNF timeouts** in goals containing `eLpNorm`, `MemLp`, or other polymorphic combinators
2. **`isDefEq` timeouts** during type-checking of complex function expressions
3. **Repeated expensive computations** of measurability, boundedness, or integrability
4. **Elaboration heartbeat warnings** (>100k heartbeats) on seemingly simple goals
5. **Build timeouts** that disappear when you `sorry` specific proofs

**Common polymorphic culprits:**
- `eLpNorm`, `MemLp`, `snorm` (Lp spaces)
- `Integrable`, `AEStronglyMeasurable` (integration)
- `ContinuousOn`, `UniformContinuousOn` (topology)
- Complex dependent type combinators

---

## What NOT to Do

**❌ Don't mark helper lemmas as irreducible** - only the main wrapper:
```lean
-- ❌ WRONG
@[irreducible]
lemma blockAvgFrozen_measurable ... := ...

-- ✅ CORRECT
lemma blockAvgFrozen_measurable ... := ...  -- Normal lemma
```

**❌ Don't use `simp` on irreducible defs** - use `rw` instead:
```lean
-- ❌ WRONG
simp [blockAvgFrozen]  -- Makes no progress

-- ✅ CORRECT
rw [blockAvgFrozen]
```

**❌ Don't skip pinning type parameters** - always explicit:
```lean
-- ❌ WRONG
eLpNorm diff 2 μ  -- Type inference cost

-- ✅ CORRECT
eLpNorm diff (2 : ℝ≥0∞) (μ := μ)
```

**❌ Don't put irreducible wrapper in a section with `variable`** - use explicit params:
```lean
-- ❌ WRONG
section
variable {μ : Measure Ω}
@[irreducible]
def wrapper := ...  -- May cause issues
end

-- ✅ CORRECT
@[irreducible]
def wrapper {Ω : Type*} {μ : Measure Ω} := ...  -- Explicit params
```

---

## Expected Results

When this pattern is applied correctly:

| Metric | Before | After |
|--------|--------|-------|
| **Elaboration heartbeats** | 500k+ (timeout) | <10k (fast) |
| **Build time** | 5-10min (timeout) | <30sec (success) |
| **Proof lines** | 28 lines inline | 8 lines (reusing lemmas) |
| **Maintainability** | Low (repeated logic) | High (reusable lemmas) |

---

## Analogy to Other Languages

This pattern is the Lean 4 equivalent of:
- **C++:** `extern template` (preventing unwanted template instantiation)
- **Haskell:** `NOINLINE` pragma (preventing unwanted inlining)
- **Rust:** `#[inline(never)]` (controlling inlining for compile times)

The goal is the same: **control compilation cost by preventing unwanted expansion**.

---

## Related Patterns

- **[measure-theory.md](measure-theory.md)** - Measure theory specific type class patterns
- **[compilation-errors.md](compilation-errors.md)** - Fixing timeout errors (Error 2)
- **[compiler-guided-repair.md](compiler-guided-repair.md)** - Using compiler feedback to fix issues

---

## Advanced: When Irreducible Isn't Enough

If `@[irreducible]` still causes timeouts, consider:

1. **Split into smaller wrappers:** Multiple frozen pieces instead of one large one
2. **Use `abbrev` for simple aliases:** When you want transparency but controlled unfolding
3. **Provide explicit type annotations:** Help Lean avoid searches
4. **Reduce polymorphism:** Sometimes monomorphic wrappers are faster

**Example of splitting:**
```lean
-- Instead of one complex frozen function:
@[irreducible]
def complexFrozen := fun ω => f (g (h (X ω)))

-- Split into parts:
@[irreducible] def frozenH (X : Ω → α) : Ω → β := fun ω => h (X ω)
@[irreducible] def frozenG (Y : Ω → β) : Ω → γ := fun ω => g (Y ω)
@[irreducible] def frozenF (Z : Ω → γ) : Ω → ℝ := fun ω => f (Z ω)

-- Compose:
def complexFrozen := frozenF (frozenG (frozenH X))
```

---

## Debugging Elaboration Performance

**See elaboration heartbeats:**
```lean
set_option trace.profiler true in
theorem my_theorem := by
  -- Shows heartbeat count for each tactic
```

**Find expensive `isDefEq` checks:**
```lean
set_option trace.Meta.isDefEq true in
theorem my_theorem := by
  -- Shows all definitional equality checks
```

**Increase limit temporarily (debugging only):**
```lean
set_option maxHeartbeats 1000000 in  -- 10x normal
theorem my_theorem := by
  -- This is a WORKAROUND not a fix!
  -- Use irreducible wrappers instead
```

**Remember:** Increasing `maxHeartbeats` is a **band-aid**. The real fix is preventing unwanted unfolding with `@[irreducible]`.
