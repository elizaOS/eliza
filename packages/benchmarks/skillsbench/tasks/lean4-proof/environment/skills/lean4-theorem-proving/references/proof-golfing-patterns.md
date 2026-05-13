# Proof Golfing Patterns

**Detailed pattern explanations for proof optimization. For quick reference table and overview, see [proof-golfing.md](proof-golfing.md).**

## Contents
- [High-Priority Patterns (⭐⭐⭐⭐⭐)](#high-priority-patterns-)
- [Medium-Priority Patterns (⭐⭐⭐⭐)](#medium-priority-patterns-)
- [Medium-Priority Patterns (⭐⭐⭐)](#medium-priority-patterns--1)
- [Documentation Quality Patterns (⭐⭐)](#documentation-quality-patterns-)

---

## High-Priority Patterns (⭐⭐⭐⭐⭐)

### Pattern -1: Linter-Guided simp Cleanup (Performance)

```lean
-- Before (linter warns: unused)
simp only [decide_eq_false_iff_not, decide_eq_true_eq]
-- After
simp only [decide_eq_true_eq]
```

Remove unused `simp` arguments flagged by linter. Zero risk (compiler-verified), faster elaboration.

### Pattern 0: `by rfl` → `rfl` (Directness)

```lean
-- Before
theorem tiling_count : allTilings.length = 11 := by rfl
-- After
theorem tiling_count : allTilings.length = 11 := rfl

-- Before
theorem count : a = 9 ∧ b = 2 := by constructor <;> rfl
-- After
theorem count : a = 9 ∧ b = 2 := ⟨rfl, rfl⟩
```

Term mode for definitional equalities. Use `⟨_, _⟩` instead of `constructor <;> rfl`. Zero risk.

### Pattern 1: `rw; exact` → `rwa`

```lean
-- Before
rw [h1, h2] at h; exact h
-- After
rwa [h1, h2] at h
```

Standard mathlib idiom. `rwa` = "rewrite and assumption". Zero risk.

### Pattern 2: `ext + rfl` → `rfl`

```lean
-- Before
have h : f = g := by ext x; rfl
-- After
have h : f = g := rfl
```

When terms are definitionally equal, `rfl` suffices. Low risk - test with build, revert if fails.

### Pattern 2A: `rw; simp_rw` → `rw; simpa` (Simplicity)

```lean
-- Before
have h := this.interior_compl
rw [compl_iInter] at h
simp_rw [compl_compl] at h
exact h
-- After
have h := this.interior_compl
rw [compl_iInter] at h
simpa [compl_compl] using h
```

Use `simpa` for binder-aware simplification. Zero risk.

### Pattern 2B: Eta-Reduction (Simplicity)

```lean
-- Before
eq_empty_iff_forall_notMem.mpr (fun x hx => hU_sub_int hx)
-- After
eq_empty_iff_forall_notMem.mpr hU_sub_int
```

Pattern: `fun x => f x` is just `f`. Zero risk.

### Pattern 2C: Direct `.mpr`/`.mp` (Directness)

```lean
-- Before
have h : U.Nonempty := by rwa [nonempty_iff_ne_empty]
-- After
have h : U.Nonempty := nonempty_iff_ne_empty.mpr h_ne
```

When `rwa` does trivial work, use direct term application. Zero risk.

### Pattern 2D: `intro-dsimp-exact` → Lambda (Directness)

```lean
-- Before
have h : ∀ i : Fin m, p (ι i) := by intro i; dsimp [p, ι]; exact i.isLt
-- After
have h : ∀ i : Fin m, p (ι i) := fun i => i.isLt
```

Convert `intro x; dsimp; exact term` to direct lambda. 75% reduction.

### Pattern 2E: Extract Repeated Patterns to Helpers (Reusability)

```lean
-- Before (duplication)
have hf' : ∀ x ∈ Ioo a b, HasDerivAt f (deriv f x) x := by intro x hx; exact ...
have hg' : ∀ x ∈ Ioo a b, HasDerivAt g (deriv g x) x := by intro x hx; exact ...

-- After (single helper)
have toHasDerivAt {h : ℝ → ℝ} (hd : DifferentiableOn ℝ h (Ioo a b)) :
    ∀ x ∈ Ioo a b, HasDerivAt h (deriv h x) x := fun x hx => ...
have hf' := toHasDerivAt hfd
have hg' := toHasDerivAt hgd
```

40% reduction when pattern appears 2+ times. Low risk.

### Pattern 3: let+have+exact Inline (Conciseness)

```lean
-- Before
lemma foo := by
  let k' := fun i => (k i).val
  have hk' : StrictMono k' := by ...
  exact hX m k' hk'
-- After
lemma foo := by exact hX m (fun i => (k i).val) (fun i j hij => ...)
```

**⚠️ HIGH RISK:** 60-80% reduction but 93% false positive rate! MUST verify let used ≤2 times.

### Pattern 3A: Single-Use `have` Inline (Clarity)

```lean
-- Before
have h_meas : Measurable f := measurable_pi_lambda _ ...
rw [← Measure.map_map hproj h_meas]
-- After
rw [← Measure.map_map hproj (measurable_pi_lambda _ ...)]
```

Inline `have` used once if term < 40 chars and no semantic value. 30-50% reduction.

### Pattern 3B: Remove `by exact` Wrapper (Directness)

```lean
-- Before
have hζ_compProd : ... := by exact compProd_map_condDistrib hξ.aemeasurable
-- After
have hζ_compProd : ... := compProd_map_condDistrib hξ.aemeasurable
```

`by exact foo` is redundant - use term mode directly. Zero risk.

### Pattern 3C: Dot Notation for Constructors (Conciseness)

```lean
-- Before
apply EventuallyEq.mul hIH
exact EventuallyEq.rfl
-- After
exact hIH.mul .rfl
```

Use `.rfl`, `.symm`, `.trans` instead of full constructor names. Zero risk.

### Pattern 3D: Calc Blocks → `.trans` Chains (Conciseness)

```lean
-- Before
calc ∫ ω, ... = ... := step1 _ = ... := step2
-- After
(step1.trans step2).symm
```

When calc chains are short (2-3 steps), `.trans` chains can be more concise. Low risk.

### Pattern 3E: Inline `show` in Rewrites (Conciseness)

```lean
-- Before (3 lines)
have h1 : (m + m) / 2 = m := by omega
rw [h1]
-- After (1 line)
rw [show (m + m) / 2 = m by omega, ...]
```

Combine `have` + `rw` into `rw [show ... by ...]`. 50-70% reduction for short proofs.

### Pattern 3F: Transport Operator ▸ (Conciseness)

```lean
-- Before
theorem count : ValidData.card = 11 := by rw [h_eq, all_card]
-- After
theorem count : ValidData.card = 11 := h_eq ▸ all_card
```

Pattern: `(eq : a = b) ▸ (proof_of_P_b) : P_a`. Zero risk.

---

## Medium-Priority Patterns (⭐⭐⭐⭐)

### Pattern 4: Redundant `ext` Before `simp` (Simplicity)

```lean
-- Before
have h : (⟨i.val, ...⟩ : Fin n) = ι i := by apply Fin.ext; simp [ι]
-- After
have h : (⟨i.val, ...⟩ : Fin n) = ι i := by simp [ι]
```

For Fin/Prod/Subtype, `simp` handles extensionality automatically. 50% reduction.

### Pattern 5: `congr; ext; rw` → `simp only` (Simplicity)

```lean
-- Before
lemma foo : Measure.map ... := by congr 1; ext ω i; rw [h]
-- After
lemma foo : Measure.map ... := by simp only [h]
```

`simp` handles congruence and extensionality automatically. 67% reduction.

### Pattern 5A: Remove Redundant `show` Wrappers (Simplicity)

```lean
-- Before
rw [show X = Y by simp, other]; simp [...]
-- After
simp [...]
```

Remove `show X by simp` wrappers when simp handles the equality directly. 50-75% reduction.

### Pattern 5B: Convert-Based Helper Inlining (Directness)

```lean
-- Before
have hfun : f = g := by ext x; simp [...]
simpa [hfun] using main_proof
-- After
convert main_proof using 2; ext x; simp [...]
```

Inline helper equality used once with `convert ... using N`. 30-40% reduction.

### Pattern 5C: Inline Single-Use Definitions (Clarity)

```lean
-- Before
def allData := allTilings.map Tiling.data
def All := allData.toFinset
-- After
def All := (allTilings.map Tiling.data).toFinset
```

Inline definitions used exactly once. 3-4 lines saved.

### Pattern 6: Smart `ext` (Simplicity)

```lean
-- Before
apply Subtype.ext; apply Fin.ext; simp [ι]
-- After
ext; simp [ι]
```

`ext` handles multiple nested extensionality layers automatically. 50% reduction.

### Pattern 7: `simp` Closes Goals Directly (Simplicity)

```lean
-- Before
have h : a < b := by simp [defs]; exact lemma
-- After
have h : a < b := by simp [defs]
```

Skip explicit `exact` when simp makes goal trivial. 67% reduction.

---

## Medium-Priority Patterns (⭐⭐⭐)

### Pattern 7A: `simpa using` → `exact` (Clarity)

```lean
-- Before
simpa using h
-- After
exact h
```

When `simpa` does no simplification, use `exact`. Zero risk.

### Pattern 7B: Unused Lambda Variable Cleanup (Quality)

```lean
-- Before (linter warns)
fun i j hij => proof_not_using_i_or_j
-- After
fun _ _ hij => proof_not_using_i_or_j
```

Replace unused lambda parameters with `_`. Zero risk.

### Pattern 7C: calc with rfl for Definitions (Performance)

```lean
calc (f b - f a) * g'
    = Δf * g' := rfl
  _ = Δg * f' := by simpa [Δf, Δg, ...] using h
  _ = (g b - g a) * f' := rfl
```

Use `rfl` for definitional unfolding steps - faster than proof search.

### Pattern 7D: refine with ?_ (Clarity)

```lean
-- Before
have eq : ... := by ...
exact ⟨c, hc, f', g', hf', hg', eq⟩
-- After
refine ⟨c, hc, f', g', hf', hg', ?_⟩
calc ... -- proof inline
```

Use `refine ... ?_` for term construction with one remaining proof.

### Pattern 7E: Named Arguments in obtain (Safety)

```lean
-- Before (type error!)
obtain ⟨c, hc, h⟩ := lemma hab hfc (toHasDerivAt hfd) ...
-- After (self-documenting)
obtain ⟨c, hc, h⟩ := lemma (f := f) (hab := hab) (hfc := hfc) ...
```

Use named arguments for complex `obtain` with implicit parameters.

### Pattern 8: have-calc Inline (Clarity)

```lean
-- Before
have h : sqrt x < sqrt y := Real.sqrt_lt_sqrt hn hlt
calc sqrt x < sqrt y := h
-- After
calc sqrt x < sqrt y := Real.sqrt_lt_sqrt hn hlt
```

Inline `have` used once in calc if term < 40 chars.

### Pattern 9: Inline Constructor Branches (Conciseness)

```lean
-- Before
constructor; · intro k hk; exact hX m k hk; · intro ν hν; have h := ...; exact h.symm
-- After
constructor; · intro k hk; exact hX m k hk; · intro ν hν; exact (...).symm
```

Inline simple constructor branches. 30-57% reduction.

### Pattern 10: Direct Lemma Over Automation (Simplicity)

```lean
-- Before (fails!)
by omega  -- Error with Fin coercions
-- After (works!)
Nat.add_lt_add_left hij k
```

Use direct mathlib lemmas over automation when available.

### Pattern 11: Multi-Pattern Match (Simplicity)

```lean
-- Before (nested cases)
cases n with | zero => ... | succ n' => cases n' with ...
-- After (flat match)
match n with | 0 | 1 | 2 => omega | _+3 => rfl
```

Replace nested cases with flat match. ~7 lines saved.

### Pattern 12: Successor Pattern (n+k) (Clarity)

```lean
-- Before (deeply nested)
cases i with | zero => ... | succ i' => cases i' with ...
-- After (direct offset)
match i with | 0 => omega | 1 | 2 => rfl | n+3 => [proof]
```

Use `| n+k =>` for "n ≥ k" range cases. ~25 lines saved.

### Pattern 13: Symmetric Cases with `<;>` (Conciseness)

```lean
-- Before (duplicate structure)
cases h with | inl => ... | inr => ...  -- identical bodies
-- After
rcases h with rfl | rfl <;> (intro h; have : ... := ...; omega)
```

Use `rcases ... <;>` when both branches structurally identical. ~11 lines saved.

### Pattern 14: Inline omega (Conciseness)

```lean
-- Before
have : 2 < n + 3 := by omega; exact hzero _ this
-- After
exact hzero _ (by omega)
```

Inline trivial arithmetic with `by omega` when used once as argument.

### Pattern 15: match After ext (Clarity)

```lean
-- Before
ext n; cases n with | zero => ... | succ n' => cases n' with ...
-- After
ext n; match n with | 0 => exact ha0 | 1 => ... | n+2 => ...
```

Use `match` after `ext` instead of nested `cases`. ~3 lines saved.

---

## Documentation Quality Patterns (⭐⭐)

### Remove Duplicate Inline Comments

```lean
-- Before (with comprehensive docstring above)
/-- Computes measure by factoring through permutation... -/
calc Measure.map ...
    -- Factor as permutation composed with identity
    = ... := by rw [...]

-- After (docstring is the single source of truth)
/-- Computes measure by factoring through permutation... -/
calc Measure.map ...
    = ... := by rw [...]
```

**When to apply:** Comprehensive docstring already explains the proof strategy.
**When NOT to apply:** Inline comments provide details NOT in docstring.

---

**Related:** [proof-golfing.md](proof-golfing.md) (quick reference), [proof-golfing-safety.md](proof-golfing-safety.md) (safety & workflow)
