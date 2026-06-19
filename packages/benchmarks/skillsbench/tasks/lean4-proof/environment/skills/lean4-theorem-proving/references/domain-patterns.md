# Domain-Specific Patterns for Lean 4

## TLDR

**Purpose:** Quick reference for common proof patterns and tactics across mathematical domains.

**When to use:** When working in a specific domain (measure theory, analysis, algebra, etc.) and need proven patterns for common tasks.

**Coverage:** Measure theory (12 patterns), analysis & topology (3 patterns), geometry (8 patterns), algebra (3 patterns), number theory (3 patterns), plus cross-domain tactics.

**For deep measure theory patterns (sub-σ-algebras, conditional expectation, type class errors):** See `references/measure-theory.md`

## Quick Reference by Domain

### Measure Theory & Probability (12 Patterns)

| Pattern | Task | Key Tactic/Approach |
|---------|------|---------------------|
| 1. Proving Integrability | Show function integrable | `bounded + measurable + finite measure` |
| 2. Conditional Expectation | Prove μ[f\|m] = g | Uniqueness theorem (3 conditions) |
| 3. Sub-σ-Algebras | Type class management | See measure-theory.md |
| 4. Almost Everywhere | Convert universal to ae | `ae_of_all`, `filter_upwards` |
| 5. Filtrations | Martingales, adapted processes | Monotone σ-algebras |
| 6. Product Measures | Independence via products | Ionescu-Tulcea |
| 7. Section Variables | Exclude from lemmas | `omit [...] in` |
| 8. Measurability | Automate boilerplate | `measurability`, `@[measurability]` |
| 9. Implicit Parameters | Follow mathlib conventions | Inferrable → implicit |
| 10. Structure Matching | const_mul with sums | Match goal parenthesization |
| 11. Type Matching | Integrable.of_bound | Use canonical forms `(m:ℝ)⁻¹` |
| 12. Pointwise Inequalities | intro vs filter_upwards | `intro ω` for simple cases |

**Common tactics:** `measurability`, `positivity`, `ae_of_all`, `filter_upwards`

### Analysis & Topology (3 Patterns)

| Pattern | Task | Key Tactic/Approach |
|---------|------|---------------------|
| 1. Continuity | Prove continuous | `continuity`, `continuous_def` |
| 2. Compactness | Finite subcover, min/max | `IsCompact.exists_isMinOn` |
| 3. Limits | ε-δ via filters | `Metric.tendsto_atTop` |

**Common tactics:** `continuity`, `fun_prop`

### Geometry (8 Patterns)

| Pattern | Task | Key Tactic/Approach |
|---------|------|---------------------|
| 1. Betweenness | Strict betweenness proofs | `Sbtw.sbtw_lineMap_iff` |
| 2. Triangle angles | Angle sum at vertex | `angle_add_angle_add_angle_eq_pi` |
| 3. Segment to betweenness | Convert membership to Wbtw | `mem_segment_iff_wbtw` |
| 4. Collinearity | Prove point in affine span | `Wbtw.mem_affineSpan` |
| 5. Angles from betweenness | Straight angle at midpoint | `Sbtw.angle₁₂₃_eq_pi` |
| 6. Missing lemmas | Document sorries with strategy | Thin wrappers with alternatives |
| 7. Deep context timeouts | Accept technical limits | Document strategy, move on |
| 8. Angle arithmetic | Work at quotient level | `linarith` + `ring` on Real.Angle |

**Common tactics:** `norm_num` (for angle comparisons), `linarith` (for angle algebra)

### Algebra (3 Patterns)

| Pattern | Task | Key Tactic/Approach |
|---------|------|---------------------|
| 1. Algebraic Instances | Build Ring/CommRing | `inferInstance` or manual |
| 2. Quotients | Define quotient homs | Universal property |
| 3. Universal Properties | Unique morphisms | Existence + uniqueness |

**Common tactics:** `ring`, `field_simp`, `group`

### Number Theory & Combinatorics (3 Patterns)

| Pattern | Task | Key Tactic/Approach |
|---------|------|---------------------|
| 1. Induction | Lists/Nats | `induction` with cases |
| 2. Divisibility | Prove n ∣ m | `cases' even_or_odd`, `use` |
| 3. List Counting | Complex counting proofs | Positional splitting, complementary counting |

**Common tactics:** `linarith`, `norm_num`, `omega`

### Cross-Domain

**Essential tactics:** `simp only`, `by_cases`, `rcases`, `rw`, `ext`, `apply`, `exact`, `refine`

**Equality via uniqueness:** Works across all domains (measures, functions, homs)

---

## Measure Theory & Probability

### Pattern 1: Proving Integrability

**Golden rule:** `bounded + measurable + finite measure = integrable`

```lean
lemma integrable_of_bounded_measurable
    [IsFiniteMeasure μ] {f : X → ℝ}
    (h_meas : Measurable f)
    (h_bound : ∃ C, ∀ x, ‖f x‖ ≤ C) :
    Integrable f μ := by
  obtain ⟨C, hC⟩ := h_bound
  exact Integrable.of_bound h_meas.aestronglyMeasurable C (ae_of_all _ hC)
```

**Key variations:**
- AE bound: Use `AEMeasurable` and `∀ᵐ x ∂μ, ‖f x‖ ≤ C`
- Indicator: `hf.indicator hA` when `hf : Integrable f μ`

### Pattern 2: Conditional Expectation Equality

**Uniqueness theorem:** To show μ[f | m] = g, prove all three:
1. g is m-measurable
2. g is integrable
3. ∀ B (m-measurable set): ∫ x in B, g x ∂μ = ∫ x in B, f x ∂μ

```lean
lemma condExp_eq_of_integral_eq
    {f g : Ω → ℝ} (hf : Integrable f μ)
    (hg_meas : Measurable[m] g)
    (hg_int : Integrable g μ)
    (h_eq : ∀ s, MeasurableSet[m] s → ∫ x in s, g x ∂μ = ∫ x in s, f x ∂μ) :
    μ[f | m] =ᵐ[μ] g := by
  symm
  exact ae_eq_condExp_of_forall_setIntegral_eq (μ := μ) (m := m) hm
    hf hg_meas hg_int h_eq
```

### Pattern 3: Sub-σ-Algebras and Type Class Management

**Critical issues:**
- Binder order: instance parameters before plain parameters
- Never use `‹_›` for ambient space (resolves incorrectly)
- Provide trimmed measure instances with `haveI`

```lean
-- ✅ Correct pattern
lemma my_condexp_lemma {Ω : Type*} {m₀ : MeasurableSpace Ω}
    {μ : Measure Ω} [IsFiniteMeasure μ]
    {m : MeasurableSpace Ω} (hm : m ≤ m₀) : Result := by
  haveI : IsFiniteMeasure (μ.trim hm) := isFiniteMeasure_trim μ hm
  haveI : SigmaFinite (μ.trim hm) := sigmaFinite_trim μ hm
  -- Now call mathlib lemmas
```

**For complete coverage:** See `references/measure-theory.md` for sub-σ-algebra patterns, condExpWith, debugging type class errors, and binder order requirements.

### Pattern 4: Almost Everywhere Properties

**From universal to ae:**
```lean
have h : ∀ x, P x := ...
have h_ae : ∀ᵐ x ∂μ, P x := ae_of_all _ h
```

**Combining ae properties:**
```lean
filter_upwards [h1, h2] with x hP hQ
-- Now have: ∀ᵐ x ∂μ, P x ∧ Q x
```

**ae equality reasoning:**
```lean
-- Transitivity
h1.trans h2  -- f =ᵐ[μ] g → g =ᵐ[μ] h → f =ᵐ[μ] h

-- Substitution
hf.congr h  -- Integrable f μ → f =ᵐ[μ] g → Integrable g μ
```

### Pattern 5: Filtrations and Martingales

```lean
def Filtration (f : ℕ → MeasurableSpace Ω) : Prop :=
  Monotone f ∧ ∀ n, f n ≤ m₀

def Adapted (X : ℕ → Ω → ℝ) (f : ℕ → MeasurableSpace Ω) : Prop :=
  ∀ n, Measurable[f n] (X n)

def IsMartingale (X : ℕ → Ω → ℝ) (f : ℕ → MeasurableSpace Ω) : Prop :=
  Adapted X f ∧ (∀ n, Integrable (X n) μ) ∧
  ∀ m n, m ≤ n → μ[X n | f m] =ᵐ[μ] X m
```

### Pattern 6: Product Measures and Independence

```lean
-- Infinite product via Ionescu-Tulcea
noncomputable def productMeasure (ν : Measure α) : Measure (ℕ → α) :=
  Measure.pi (fun _ => ν)

lemma independent_of_product :
    ∀ n m, n ≠ m →
    IndepFun (fun ω => ω n) (fun ω => ω m) (productMeasure ν) := by
  sorry
```

### Pattern 7: Managing Section Variables with `omit`

Exclude section variables from specific lemmas:

```lean
section IntegrationHelpers
variable [MeasurableSpace Ω] {μ : Measure Ω}

-- This lemma doesn't need MeasurableSpace Ω
omit [MeasurableSpace Ω] in
lemma abs_integral_mul_le_L2 [IsFiniteMeasure μ] {f g : Ω → ℝ}
    (hf : MemLp f 2 μ) (hg : MemLp g 2 μ) :
    |∫ x, f x * g x ∂μ| ≤ ... := by sorry

end IntegrationHelpers
```

**Critical:** `omit [...] in` must appear **before** docstring, not after.

**When to use:** Lemma doesn't use section variable, or variable causes unwanted instance requirements.

### Pattern 8: Automating Measurability Proofs

**Manual vs automated:**

```lean
-- ❌ Manual: verbose
lemma measurable_projection {n : ℕ} :
    Measurable (fun (x : ℕ → α) => fun (i : Fin n) => x i.val) := by
  refine measurable_pi_lambda _ (fun i => ?_)
  exact measurable_pi_apply i.val

-- ✅ Automated: clean
lemma measurable_projection {n : ℕ} :
    Measurable (fun (x : ℕ → α) => fun (i : Fin n) => x i.val) := by
  measurability
```

**Make lemmas discoverable:**

```lean
@[measurability]
lemma measurable_shiftSeq {d : ℕ} : Measurable (shiftSeq (β:=β) d) := by
  measurability
```

**For function compositions:**

```lean
-- Use fun_prop with measurability discharger
have h : Measurable (fun ω => fun i => X (k i) ω) := by
  fun_prop (disch := measurability)
```

**Combine attributes for maximum automation:**

```lean
@[measurability, fun_prop]
lemma measurable_myFunc : Measurable myFunc := by measurability
```

**When automation works well:**
- ✅ Product types and compositions
- ✅ Pi-type projections
- ✅ Coordinate permutations
- ✅ After adding `@[measurability]` attributes

**When automation doesn't work:**
- ⚠️ Complex set operations (can timeout)
- ⚠️ Custom definitions unknown to fun_prop
- **Solution:** Break into smaller steps or use direct proof

**Real-world results:** Simplified 33 proofs, eliminated ~90 lines of boilerplate.

### Pattern 9: Implicit vs Explicit Parameters

**Core principle:** `{param}` when inferrable, `(param)` when primary data or not inferrable.

**Use implicit `{param}` when:**
```lean
-- ✅ n inferrable from S
def prefixCylinder {n : ℕ} (S : Set (Fin n → α)) : Set (ℕ → α)

-- ✅ n inferrable from c
lemma l2_bound {n : ℕ} {c : Fin n → ℝ} (σSq ρ : ℝ) : ...
```

**Keep explicit `(param)` when:**
```lean
-- ✅ Primary data
theorem deFinetti (μ : Measure Ω) (X : ℕ → Ω → α) : ...

-- ✅ Used in body, not types
def shiftedCylinder (n : ℕ) (F : Ω[α] → ℝ) : Ω[α] → ℝ :=
  fun ω => F ((shift^[n]) ω)

-- ✅ In return type
lemma foo (n : ℕ) : Fin n → α := ...
```

**When in doubt, keep explicit.** See [mathlib-style.md](mathlib-style.md) for conventions.

### Pattern 10: Measurable Structure Must Match Goal

When using `Measurable.const_mul` with sums, structure must match goal's parenthesization.

```lean
-- ❌ WRONG: constant inside each term
have h : Measurable (fun ω => (1/(m:ℝ)) * ∑ k, f k ω) :=
  Finset.measurable_sum _ (fun k _ => Measurable.const_mul ...)
-- Applies const_mul to EACH TERM - wrong variable binding!

-- ✅ CORRECT: constant wraps entire sum
have h : Measurable (fun ω => (1/(m:ℝ)) * ∑ k, f k ω) :=
  Measurable.const_mul (Finset.measurable_sum _ (fun k _ => ...)) _
-- const_mul wraps whole sum, matching goal structure
```

**Key:** Match goal parenthesization: `c * (∑ ...)` not `∑ (c * ...)`

### Pattern 11: Integrable.of_bound Type Matching

Bound expression in measurability hypothesis must match canonical form after `simp`.

```lean
-- ❌ WRONG: Definition uses 1/(m:ℝ) but goal has (m:ℝ)⁻¹ after simp
have h_meas : Measurable (fun ω => 1/(m:ℝ) * ∑ i, f i ω) := ...
apply Integrable.of_bound h_meas.aestronglyMeasurable 1
filter_upwards with ω; simp [Real.norm_eq_abs]
-- Type mismatch: goal has (m:ℝ)⁻¹ but h_meas has 1/(m:ℝ)

-- ✅ CORRECT: Use canonical form (m:ℝ)⁻¹ from start
have h_meas : Measurable (fun ω => (m:ℝ)⁻¹ * ∑ i, f i ω) := ...
apply Integrable.of_bound h_meas.aestronglyMeasurable 1
filter_upwards with ω; simp [Real.norm_eq_abs]
-- Matches exactly after simp!
```

**Rule:** Use canonical forms: `(m:ℝ)⁻¹` not `1/(m:ℝ)`. See [calc-patterns.md](calc-patterns.md).

### Pattern 12: Pointwise Inequalities

**Use `intro ω` for simple pointwise proofs:**

```lean
-- ❌ WRONG: filter_upwards doesn't unfold for simple inequalities
filter_upwards with ω
exact abs_sub_le _ _ _
-- Error: type mismatch in implicit EventuallyEq form

-- ✅ CORRECT: intro for simple pointwise
intro ω
exact abs_sub_le _ _ _
-- Works: explicit inequality with ω
```

**When to use:**
- `intro ω`: Simple pointwise inequalities, just applying lemmas
- `filter_upwards`: Combining multiple ae conditions, measure theory structure

### Common Measure Theory Tactics

```lean
measurability    -- Prove measurability automatically
positivity       -- Prove positivity of measures/integrals
ae_of_all        -- Universal → ae
filter_upwards   -- Combine ae properties
```

**Automation philosophy:**
- ✅ Use for: boilerplate (measurability), trivial arithmetic (omega/linarith)
- ❌ Don't hide: key mathematical insights, proof architecture, non-obvious lemma applications

---

## Analysis & Topology

### Pattern 1: Continuity Proofs

```lean
-- From preimage of open sets
lemma continuous_of_isOpen_preimage
    {f : X → Y} (h : ∀ U, IsOpen U → IsOpen (f ⁻¹' U)) :
    Continuous f := by
  rw [continuous_def]; exact h

-- Using automation
lemma continuous_comp_add :
    Continuous (fun (p : ℝ × ℝ) => p.1 + p.2) := by
  continuity
```

### Pattern 2: Compactness Arguments

```lean
-- Min/max on compact sets
example {K : Set ℝ} (hK : IsCompact K) (hne : K.Nonempty) :
    ∃ x ∈ K, ∀ y ∈ K, f x ≤ f y :=
  IsCompact.exists_isMinOn hK hne (continuous_id.comp continuous_f)
```

### Pattern 3: Limits via Filters

```lean
-- ε-δ criterion
lemma tendsto_of_forall_eventually
    (h : ∀ ε > 0, ∀ᶠ n in atTop, ‖x n - L‖ < ε) :
    Tendsto x atTop (𝓝 L) := by
  rw [Metric.tendsto_atTop]; exact h
```

**Common tactics:** `continuity`, `fun_prop`

---

## Geometry

### Pattern 1: Betweenness via Line Parameters

**Key lemma:** `Sbtw.sbtw_lineMap_iff` characterizes strict betweenness: `Sbtw ℝ A (lineMap A B s) B ↔ A ≠ B ∧ s ∈ Set.Ioo 0 1`. Eliminates manual field-by-field Sbtw proofs - parameter in (0,1) gives betweenness, then `Sbtw.angle₁₂₃_eq_pi` yields straight angle.

```lean
-- Two-liner instead of 50+ lines
have h_sbtw : Sbtw ℝ A H B := Sbtw.sbtw_lineMap_iff.mpr ⟨h_ne_AB, hs_in_Ioo⟩
have : ∠ A H B = π := h_sbtw.angle₁₂₃_eq_pi
```

### Pattern 2: Triangle Angle Sum

`angle_add_angle_add_angle_eq_pi` gives sum at specified vertex. Order adapts to input - no canonical form fighting. Use directly without rearrangement.

```lean
have angle_sum : ∠ B H C + ∠ H C B + ∠ C B H = π := angle_add_angle_add_angle_eq_pi C ⟨h_ne_BC, h_ne_CH, h_ne_HB⟩
```

### Pattern 3: Segment Membership to Betweenness

**Replace parametric obtains with direct mathlib conversion.** `mem_segment_iff_wbtw` converts `x ∈ segment ℝ A B` to `Wbtw ℝ A x B` in one step.

```lean
-- ❌ BAD: 70 lines extracting parameters, proving strict bounds
obtain ⟨s, hs_ge, hs_le, hH_eq⟩ := h_H_on_AB
-- ... 50+ lines proving 0 < s < 1 from H ≠ A, H ≠ B ...
have : Sbtw ℝ A H B := ...

-- ✅ GOOD: 1 line
have : Sbtw ℝ A H B := ⟨mem_segment_iff_wbtw.mp h_H_on_AB, h_H_ne_A, h_H_ne_B⟩
```

### Pattern 4: Collinearity from Betweenness

**Direct collinearity proof.** `Wbtw.mem_affineSpan` proves `G ∈ affineSpan ℝ {A, C}` from `Wbtw ℝ A G C` without parametric machinery.

```lean
-- ❌ BAD: Manual lineMap construction (10+ lines)
obtain ⟨t, ht_ge, ht_le, hG_eq⟩ := h_G_on_AC
have : G ∈ affineSpan ℝ {A, C} := by
  rw [hG_eq]
  -- Convert to lineMap, prove membership...

-- ✅ GOOD: Direct
have : G ∈ affineSpan ℝ {A, C} := (mem_segment_iff_wbtw.mp h_G_on_AC).mem_affineSpan
```

### Pattern 5: Angle Proofs from Betweenness

**Combine with Pattern 3 for instant angle proofs.** Chain `mem_segment_iff_wbtw` → `Sbtw` → `Sbtw.angle₁₂₃_eq_pi`.

```lean
have angle_AHB_eq_pi : ∠ A H B = π :=
  Sbtw.angle₁₂₃_eq_pi ⟨mem_segment_iff_wbtw.mp h_H_on_AB, h_H_ne_A, h_H_ne_B⟩
```

### Pattern 6: Infrastructure Wrappers for Missing Lemmas

**Create thin wrappers with documented sorries.** When mathlib lacks domain-specific lemmas, isolate missing pieces with clear documentation and alternatives.

```lean
namespace AngleTools
/-- Right subtraction: from `∠XTY = π`, get `∠TZY = ∠XZY − ∠XZT`.
    Missing mathlib lemma for angle splitting at external vertex.
    Alternative: Use Module.Oriented with oangle_add (complex). -/
lemma sub_right (X T Y Z : P) (hπ : ∠ X T Y = Real.pi) :
    ∠ T Z Y = ∠ X Z Y - ∠ X Z T := by
  sorry
end AngleTools

-- Usage: Clean structure throughout proof
have angle_ABD : ∠ A B D = π / 3 := by
  calc ∠ A B D = ∠ A B C - ∠ D B C := AngleTools.sub_right A D C B angle_ADC_eq_pi
    _ = 4 * π / 9 - π / 9 := by rw [angle_ABC, h_DBC]
    _ = π / 3 := by ring
```

**Benefits:** Sorry is isolated, strategy documented, proof structure maintainable.

### Pattern 7: Deep Context Timeouts

**After ~1000 lines, standard lemmas can timeout.** Use cheaper alternatives or document strategy.

#### Technique A: Non-Degeneracy via `angle_self_right`

**Problem:** In deep contexts, `angle_self_of_ne` times out in contradiction proofs.

**Key insight:** The unoriented angle ∠ P X X = π/2 (not 0). This comes from `angle_self_right`, a cheap `[simp]` lemma that avoids the expensive `angle_self_of_ne`.

```lean
-- General pattern: Given h_angle : ∠ P X Y = α where α ≠ π/2
-- Goal: Prove Y ≠ X

-- Example: h_angle_CBD : ∠ C B D = π/9, prove D ≠ B
have h_DB_ne : D ≠ B := by
  intro h_eq
  rw [h_eq] at h_angle_CBD
  -- Now have: ∠ C B B = π/9

  -- Key step: Get the actual value of degenerate angle
  have angle_CBB : ∠ C B B = ((π / 2 : ℝ) : Real.Angle) := by
    simp [EuclideanGeometry.angle_self_right]  -- Fast! [simp] lemma

  -- Derive the impossible equation: π/9 = π/2
  have : ((π / 9 : ℝ) : Real.Angle) = ((π / 2 : ℝ) : Real.Angle) := by
    rw [← h_angle_CBD, angle_CBB]

  exact pi_div_nine_ne_pi_div_two this  -- Use helper lemma
```

**Helper lemma pattern** (prove once using `toReal_injective`):
```lean
lemma pi_div_nine_ne_pi_div_two :
    ((π / 9 : ℝ) : Real.Angle) ≠ ((π / 2 : ℝ) : Real.Angle) := by
  rw [← Real.Angle.toReal_injective.ne_iff]
  -- Convert to -π < x ≤ π range
  have h_range1 : -π < π/9 ∧ π/9 ≤ π := by constructor <;> linarith [Real.pi_pos]
  have h_range2 : -π < π/2 ∧ π/2 ≤ π := by constructor <;> linarith [Real.pi_pos]
  rw [Real.Angle.toReal_coe_eq_self_iff.mpr h_range1]
  rw [Real.Angle.toReal_coe_eq_self_iff.mpr h_range2]
  linarith [Real.pi_pos]
```

**Why this works:**
- `angle_self_right` is marked `[simp]`, so `simp` resolves it instantly (no timeout)
- Avoids expensive `angle_self_of_ne` which requires non-degeneracy proof
- Works entirely in Real.Angle (quotient group), no `toReal` unwrapping
- Helper lemmas (like `pi_div_nine_ne_pi_div_two`) proved once, reused everywhere

**Applicability:** Works when α ≠ π/2. For most angle values this is true (π/9, π/3, π/4, 2π/3, etc.).

**General pattern:** To prove Y ≠ X when you know ∠ P X Y = α:
1. Assume Y = X for contradiction
2. Substitute: get ∠ P X X = α
3. Apply `angle_self_right`: get ∠ P X X = π/2
4. Derive impossible equation: α = π/2 in Real.Angle
5. Apply contradiction helper lemma that proves α ≠ π/2

#### Technique B: Document and Continue

When no cheap alternative exists, document the strategy:

```lean
have h_DB_ne : D ≠ B := by
  -- If D = B, then ∠CBD = ∠CBB = π/2 by angle_self_right,
  -- contradicting h_angle_CBD : ∠CBD = π/9.
  -- Elaboration times out in deep context (>1000 lines)
  sorry
```

**When to use:** Proof >1000 lines, simple logic times out. Try cheap lemmas first (Technique A), then document strategy.

### Pattern 8: Angle Arithmetic at Quotient Level

**Work with Real.Angle's group structure directly.** Don't unwrap to ℝ via `toReal` for arithmetic—the quotient handles algebra automatically.

**Key insight:** Real.Angle ≃ ℝ / (2π) is a group. Addition, subtraction, and linear algebra work directly at the quotient level. Only use `toReal` when you need real number properties (like `< π`), not for algebra.

```lean
-- ❌ BAD: Unwrap to ℝ, prove bounds, wrap back up
have E : ∠ABD + π/9 = 4*π/9 := split
have toReal_E : (∠ABD).toReal + (π/9).toReal = (4*π/9).toReal := ... -- need bound proofs!
have result : ∠ABD = π/3 := add_right_cancel ... -- manual group operation

-- ✅ GOOD: Use group operations directly
calc ∠ABD = (4*π/9 : Real.Angle) - (π/9 : Real.Angle) := by linarith [split]
  _ = π/3 := by ring
```

**Why `linarith` works:** It operates on ANY additive group, not just ℝ. Given `a + b = c` in any group, `linarith` derives `a = c - b`, `b = c - a`, etc.

**Type coercion spam = code smell:** If you need `((π/3 : ℝ) : Real.Angle)` everywhere, you're fighting the type system. Let Lean's coercion work—write `4*π/9 - π/9` and Lean infers Real.Angle from context.

**Separation of concerns:**
- **Group level** (Real.Angle): `+`, `-`, equality via `linarith`
- **Arithmetic level** (ℝ component): `4*π/9 - π/9 = π/3` via `ring`

```lean
-- Clean pattern
calc (x : Real.Angle)
    = y - z := by linarith [group_fact]  -- group algebra
  _ = a - b := by rw [substitutions]     -- still in quotient
  _ = c := by ring                        -- arithmetic on ℝ component
```

**Infrastructure lemma strategy:** One infrastructure admit (e.g., `angle_split_external`) with clean pattern everywhere beats many scattered admits at call sites. Infrastructure admits are well-isolated, documented, and can be proven later without touching call sites.

**Common tactics:** `norm_num` (for angle comparisons), `linarith` (for angle algebra)

---

## Algebra

### Pattern 1: Building Algebraic Instances

```lean
-- Compositional
instance : CommRing (Polynomial R) := inferInstance

-- Manual for custom types
instance : Ring MyType := {
  add := my_add,
  add_assoc := my_add_assoc,
  -- ... all required fields
}
```

### Pattern 2: Quotient Constructions

```lean
-- Ring homomorphism from quotient
lemma quotient_ring_hom (I : Ideal R) : RingHom R (R ⧸ I) := by
  refine { toFun := Ideal.Quotient.mk I,
           map_one' := rfl,
           map_mul' := fun x y => rfl,
           map_zero' := rfl,
           map_add' := fun x y => rfl }
```

### Pattern 3: Universal Properties

```lean
-- Unique morphism via universal property
lemma exists_unique_hom (h : ...) : ∃! φ : A →+* B, ... := by
  use my_homomorphism
  constructor
  · -- Prove it satisfies property
  · -- Prove uniqueness
    intro ψ hψ; ext x; sorry
```

**Common tactics:** `ring`, `field_simp`, `group`

---

## Number Theory & Combinatorics

### Pattern 1: Induction

```lean
lemma property_of_list (l : List α) : P l := by
  induction l with
  | nil => sorry  -- Base case
  | cons head tail ih => sorry  -- Inductive case with ih : P tail
```

### Pattern 2: Divisibility

```lean
lemma dvd_example (n : ℕ) : 2 ∣ n * (n + 1) := by
  cases' Nat.even_or_odd n with h h
  · -- n even
    obtain ⟨k, rfl⟩ := h
    use k * (2 * k + 1); ring
  · -- n odd
    obtain ⟨k, rfl⟩ := h
    use (2 * k + 1) * (k + 1); ring
```

### Pattern 3: Complex List Counting

**Key techniques:**

**Positional splitting:** Use first/second position to decompose counting problems.

```lean
-- Example: Count pairs in list where first witness is at position i
-- Split into: (1) second witness before i, (2) second witness after i
have h := countElem_union l.take i l.drop (i+1)
-- Then count each part separately
```

**Complementary counting:** Count what's NOT in a set when direct counting is hard.

```lean
-- Total pairs - pairs_with_property = pairs_without_property
calc l.countPairs P
    = l.length.choose 2 - l.countPairs (¬P ∘₂ ·) := by ...
```

**When to use:** Proofs requiring counting list elements with complex predicates, especially when witnesses appear at multiple positions.

**Common tactics:** `linarith`, `norm_num`, `omega`

---

## Cross-Domain Tactics

**Essential for all domains:**

```lean
-- Simplification
simp only [lem1, lem2]  -- Explicit lemmas (preferred)
simpa using h           -- simp then exact h

-- Case analysis
by_cases h : p          -- Split on decidable
rcases h with ⟨x, hx⟩   -- Destructure exists/and/or

-- Rewriting
rw [lemma]              -- Left-to-right
rw [← lemma]            -- Right-to-left

-- Extensionality
ext x                   -- Function equality pointwise
funext x                -- Alternative

-- Application
apply lemma             -- Apply, leaving subgoals
exact expr              -- Close goal exactly
refine template ?_ ?_   -- Apply with placeholders
```

## Pattern: Equality via Uniqueness

**Works across all domains:**

To show `f = g`, prove both satisfy unique criterion:

```lean
lemma my_eq : f = g := by
  have hf : satisfies_property f := ...
  have hg : satisfies_property g := ...
  exact unique_satisfier hf hg
```

**Examples:**
- **Measures:** Equal if agree on π-system
- **Conditional expectations:** Equal if same integrals on all measurable sets
- **Functions:** Equal if continuous and agree on dense subset
- **Group homomorphisms:** Equal if agree on generators

---

## Related References

- [measure-theory.md](measure-theory.md) - Deep dive on sub-σ-algebras, conditional expectation, type class errors
- [tactics-reference.md](tactics-reference.md) - Comprehensive tactic catalog
- [mathlib-style.md](mathlib-style.md) - Mathlib conventions
- [calc-patterns.md](calc-patterns.md) - Calculation chains and canonical forms
