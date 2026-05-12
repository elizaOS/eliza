# Guide: Avoiding Instance Pollution in Lean 4

## The Problem

When you have multiple instances of the same typeclass in scope (e.g., multiple `MeasurableSpace Ω`, `Metric α`, or `LinearOrder β` instances), Lean's elaborator preferentially selects **recently-defined local constants** over the ambient typeclass instance.

**Common scenarios:**
- Working with sub-σ-algebras in measure theory (`MeasurableSpace`)
- Different metrics on the same space (`Metric`, `PseudoMetricSpace`)
- Alternative orderings (`Preorder`, `PartialOrder`, `LinearOrder`)
- Custom group structures (`Group`, `AddGroup`)

**Key example throughout this guide:** `MeasurableSpace Ω` (measure theory), but the patterns apply to any typeclass.

### Example of the Problem

```lean
theorem my_theorem (Ω β : Type*) [inst : MeasurableSpace Ω] [MeasurableSpace β]
    (Z : Ω → β) (hZ : Measurable Z) (B : Set β) (hB : MeasurableSet B) : ... := by

  let mSub : MeasurableSpace Ω := MeasurableSpace.comap Z inferInstance

  -- ❌ ERROR: Lean picks mSub instead of inst!
  have hBpre : MeasurableSet (Z ⁻¹' B) := hB.preimage hZ
  --           ^^^^^^^^^^^^^^^^^^^^^^^^^^^
  -- Elaborates to: @MeasurableSet Ω mSub (Z ⁻¹' B)
  -- But hZ has type: @Measurable Ω β inst _ Z
  -- Type mismatch!
```

**Root Cause**: The `let mSub : MeasurableSpace Ω := ...` creates a NEW local constant that shadows the ambient instance for elaboration purposes.

---

## Solutions Comparison

### ❌ What DOESN'T Work

#### 1. Using `abbrev` in theorem body
```lean
theorem test : ... := by
  abbrev m0 := inferInstance  -- ❌ Syntax error: abbrev not allowed in tactic mode
```

**Why not**: `abbrev` is a top-level command only, cannot be used inside proofs.

#### 2. Using `abbrev` at top-level then `let` binding
```lean
abbrev mSub_def (Ω β : Type*) ... := MeasurableSpace.comap ...

theorem test : ... := by
  let mSub := mSub_def Ω β ...
  -- ❌ Still creates pollution! The `let` binding is the problem
```

**Why not**: Even if the RHS is an `abbrev`, the `let` binding creates a local constant that pollutes instance inference.

#### 3. Using `set` instead of `let`
```lean
theorem test : ... := by
  set mSub : MeasurableSpace Ω := ...
  -- ❌ Same problem as `let`
```

**Why not**: `set` also creates a local constant.

---

## ✅ Solutions That Work

### Solution 1: Don't Create Local Bindings (Best for Simple Cases)

**When to use**: When you only reference the sub-σ-algebra a few times.

```lean
theorem test (Ω β : Type*) [MeasurableSpace Ω] [MeasurableSpace β]
    (Z : Ω → β) (hZ : Measurable Z) (B : Set β) (hB : MeasurableSet B) : ... := by

  -- ✅ No local constant = no pollution
  have hBpre : MeasurableSet (Z ⁻¹' B) := hB.preimage hZ

  -- If you need to reference the sub-σ-algebra, write it out:
  have : (MeasurableSpace.comap Z inferInstance) ≤ (inferInstance : MeasurableSpace Ω) := by
    -- proof
```

**Pros**:
- Simple
- No pollution
- Works in all contexts

**Cons**:
- Verbose if you need to reference the sub-σ-algebra many times
- Harder to read with long expressions

---

### Solution 2: Pin Ambient + Use `@` for Ambient Facts ⭐ RECOMMENDED

**When to use**: Default approach for most cases.

```lean
theorem test (Ω β : Type*) [MeasurableSpace Ω] [MeasurableSpace β]
    (Z : Ω → β) (hZ : Measurable Z) (B : Set β) (hB : MeasurableSet B) : ... := by

  -- ✅ STEP 0: PIN the ambient instance with a name
  let m0 : MeasurableSpace Ω := ‹MeasurableSpace Ω›

  -- ✅ STEP 1: Do ALL ambient work using m0 explicitly with @
  have hZ_m0 : @Measurable Ω β m0 _ Z := by simpa [m0] using hZ
  have hBpre : @MeasurableSet Ω m0 (Z ⁻¹' B) := hB.preimage hZ_m0
  have hCpre : @MeasurableSet Ω m0 (W ⁻¹' C) := hC.preimage hW_m0
  -- ... all other ambient facts

  -- ✅ STEP 2: NOW define local instances (safe!)
  let mSub : MeasurableSpace Ω := MeasurableSpace.comap Z m0

  -- ✅ STEP 3: Work with mSub
  have : @MeasurableSet Ω mSub s := ...
```

**Pros**:
- Robust to outer scope pollution
- Explicit control over which instance is used
- Works even when parent scopes have conflicting instances

**Cons**:
- Requires `@` notation for ambient facts
- More verbose than naive approach

**Critical insight**: Even if you "do ambient work first," if ANY outer scope has `let mOther : MeasurableSpace Ω`, your ambient work will pick that unless you explicitly pin with `m0` and use `@` notation.

**Why pin `m0`?** If you skip this and just do:
```lean
have hBpre : MeasurableSet (Z ⁻¹' B) := ...  -- ❌ Picks wrong instance!
```
Lean will pick a recently-defined instance from ANY scope (including outer scopes), not the ambient typeclass instance.

---

### Performance Optimization: Three-Tier Instance Strategy

**Problem:** Even with pinning `m0` and using `@`, calling mathlib lemmas that infer instances can cause **timeout errors** due to expensive type unification (500k+ heartbeats).

**Why it happens:** When you have `@MeasurableSet Ω m0 (Z ⁻¹' B)` but call a mathlib lemma expecting the ambient instance, Lean spends massive time reconciling `m0` with the inferred instance.

**Solution:** Maintain THREE versions of key facts:

```lean
theorem test : ... := by
  -- ✅ Tier 1: Pin the ambient instance
  let m0 : MeasurableSpace Ω := ‹MeasurableSpace Ω›

  -- ✅ Tier 2: m0 versions (for explicit @ notation)
  have hZ_m0 : @Measurable Ω β m0 _ Z := by simpa [m0] using hZ
  have hBpre_m0 : @MeasurableSet Ω m0 (Z ⁻¹' B) := hB.preimage hZ_m0
  have hCpre_m0 : @MeasurableSet Ω m0 (W ⁻¹' C) := hC.preimage hW_m0

  -- ✅ Tier 3: Ambient versions (for mathlib lemmas that infer instances)
  have hBpre : MeasurableSet (Z ⁻¹' B) := by simpa [m0] using hBpre_m0
  have hCpre : MeasurableSet (W ⁻¹' C) := by simpa [m0] using hCpre_m0

  -- Use the right version for each context:
  have integral1 := integral_indicator hBpre ...  -- Uses ambient version
  have explicit : @MeasurableSet Ω m0 s := ...    -- Uses m0 version
```

**Usage rules:**
- **Use `_m0` versions** when you need explicit `@` annotations or work with sub-instances
- **Use ambient versions** when calling mathlib lemmas that infer instances (`integral_indicator`, `setIntegral_condExp`, etc.)
- **Convert between them** with `simpa [m0] using ...`

**Why this works:**
1. **Definitional equality:** `m0 := ‹MeasurableSpace Ω›` means `m0` equals the ambient instance definitionally
2. **Cheap conversion:** `simpa [m0]` unfolds the definition quickly (not expensive unification)
3. **Avoids unification:** Mathlib lemmas get facts with the instance they expect, no search needed

**Performance impact:**
- **Before:** 500k+ heartbeats on unification → timeout errors
- **After:** Compiles within normal limits
- **Result:** Timeout errors eliminated ✅

**When to use this pattern:**
- Multiple instances in scope (e.g., `m0`, `mW`, `mZW`)
- Calling mathlib lemmas that infer instances
- Experiencing timeout errors during type checking

---

### Solution 3: Force with `@` Everywhere (Fallback When You Can't Pin)

**When to use**: When you can't pin `m0` at the start (e.g., instances defined in outer scope you can't change).

```lean
theorem test (Ω β : Type*) [inst : MeasurableSpace Ω] [MeasurableSpace β]
    (Z : Ω → β) (hZ : Measurable Z) (B : Set β) (hB : MeasurableSet B) : ... := by

  let mSub : MeasurableSpace Ω := MeasurableSpace.comap Z inferInstance

  -- ✅ Force ambient instance with @ notation
  have hBpre : @MeasurableSet Ω inst (Z ⁻¹' B) :=
    hB.preimage hZ  -- Type annotation on result is enough!

  -- For more complex cases, may need @ everywhere:
  have complex : @MeasurableSet Ω inst someset :=
    @MeasurableSet.inter Ω inst s1 s2 hs1 hs2
```

**Pros**:
- Precise control
- Works when other solutions don't

**Cons**:
- Verbose
- Error-prone (easy to forget `@` somewhere)
- May need type annotations on intermediate terms

**Helper Pattern** (from user's Pattern A):
```lean
-- Create conversion helpers
have measurable_congr {m₁ m₂ : MeasurableSpace Ω} (hm : m₁ = m₂) {f : Ω → β} :
    @Measurable Ω β m₁ _ f ↔ @Measurable Ω β m₂ _ f := by simp [hm]

-- Use .mpr/.mp to convert facts
have hZ_sub : @Measurable Ω β mSub _ Z := (measurable_congr some_eq).mpr hZ
```

---

### Solution 4: Use `abbrev` at Section Level (Best for Multiple Theorems)

**When to use**: When writing multiple related theorems that all need the same sub-σ-algebras.

```lean
section MySection
  variable (Ω β : Type*) [MeasurableSpace Ω] [MeasurableSpace β]
  variable (Z : Ω → β) (hZ : Measurable Z)

  -- ✅ Define once at section level
  abbrev mSub : MeasurableSpace Ω := MeasurableSpace.comap Z inferInstance

  theorem theorem1 (B : Set β) (hB : MeasurableSet B) : ... := by
    -- Can reference mSub, but STILL do ambient work first!
    have hBpre : MeasurableSet (Z ⁻¹' B) := hB.preimage hZ  -- ✅ Works!
    -- ... rest of proof

  theorem theorem2 : ... := by
    -- mSub available here too
end MySection
```

**Pros**:
- Share definitions across multiple theorems
- `abbrev` is definitionally transparent
- Less repetition

**Cons**:
- Only works at section/file level
- Still can't use in middle of proof
- Variables must be shared across all theorems in section

**⚠️ CRITICAL WARNING**: Even with section-level `abbrev`, you MUST:
1. Pin ambient instance: `let m0 : MeasurableSpace Ω := ‹MeasurableSpace Ω›`
2. Use `@` notation for ALL ambient facts in each theorem
3. The `abbrev` only reduces repetition - it does NOT prevent pollution once referenced!

---

## Recommended Approach

### For New Code:

1. **Default**: Use **Solution 2** (pin ambient + use `@`)
   - Most robust to outer scope pollution
   - Explicit control over instances
   - Works in nested contexts

2. **If alternative instance used rarely**: Use **Solution 1** (no local bindings)
   - Even simpler
   - Just write out the expression when needed

3. **For shared definitions**: Use **Solution 4** (section-level `abbrev`)
   - When multiple theorems need the same alternative instance
   - Still use Solution 2 pattern (pin + `@`) within each theorem

### For Fixing Existing Code:

1. **If you can add code at the start**: Use **Solution 2** (pin `m0` + use `@`)
   - Pin ambient at start: `let m0 : MeasurableSpace Ω := ‹MeasurableSpace Ω›`
   - Use `@` for all ambient facts

2. **If you can't modify the start**: Use **Solution 3** (force with `@` everywhere)
   - Name the ambient instance in signature: `[inst : MeasurableSpace Ω]`
   - Use `@MeasurableSet Ω inst ...` for every ambient fact
   - Create conversion helpers if needed

---

## Common Mistakes

### ❌ Mistake 1: Thinking `abbrev` prevents pollution
```lean
abbrev mSub := ...  -- at top level

theorem test : ... := by
  let m := mSub  -- ❌ The `let` still creates pollution!
```

**Fix**: Don't bind `abbrev` results to local `let` variables.

### ❌ Mistake 2: Mixing ambient and alternative instance work without `@`
```lean
theorem test : ... := by
  let mSub : MeasurableSpace Ω := ...

  have h1 : MeasurableSet s1 := ...  -- ❌ Uses mSub (probably wrong!)
  have h2 : something about mSub
  have h3 : MeasurableSet s2 := ...  -- ❌ Still uses mSub!
```

**Fix**: Pin ambient and use `@` notation:
```lean
theorem test : ... := by
  let m0 : MeasurableSpace Ω := ‹MeasurableSpace Ω›  -- ✅ Pin it!
  let mSub : MeasurableSpace Ω := ...

  have h1 : @MeasurableSet Ω m0 s1 := ...  -- ✅ Forces m0
  have h2 : @MeasurableSet Ω mSub s2 := ... -- ✅ Explicit about mSub
  have h3 : @MeasurableSet Ω m0 s3 := ...   -- ✅ Forces m0
```

### ❌ Mistake 3: Using `letI` for non-instance data
```lean
letI mSub : MeasurableSpace Ω := ...  -- ❌ Installs as THE instance!
have : MeasurableSet s := ...  -- Now EVERYTHING uses mSub
```

**Fix**: Only use `letI` when you actually want to replace the instance. For data, use plain `let` (but follow Solution 2 pattern).

### ❌ Mistake 4: Explicit parameter when section provides instance

**Problem:** When section has `variable [MeasurableSpace γ]`, adding explicit `{mγ : MeasurableSpace γ}` parameter creates duplicate instances.

```lean
-- ❌ WRONG: Duplicate instances
section
variable [MeasurableSpace γ]

lemma foo {mγ : MeasurableSpace γ}  -- Creates TWO instances!
    (hm : m ≤ mγ) := by
  sorry  -- Error shows "inst✝¹ mγ : MeasurableSpace γ"

-- ✅ CORRECT: Rely on section variable
section
variable [MeasurableSpace γ]

lemma foo (W : Ω → γ) (hW : Measurable W) := by
  set mW := MeasurableSpace.comap W (by infer_instance : MeasurableSpace γ)
  have hmW_le : mW ≤ _ := hW.comap_le  -- ✓ Infers section instance
```

**Use `(by infer_instance)` to reference the section's typeclass instance explicitly.**

### ❌ Mistake 5: Using `(by infer_instance)` in lemma signatures

**Problem:** Mixing instance synthesis `(by infer_instance)` with plain definitions creates elaboration mismatches that can't be resolved with `rw`, `simp`, `convert`, or `@` notation.

```lean
-- ❌ WRONG: Instance synthesis in signature
lemma foo (μ : Measure Ω) [IsProbabilityMeasure μ]
    (W : Ω → γ) (hCI : SomeProperty W) :
    μ[ ... | MeasurableSpace.comap W (by infer_instance) ] = ...

-- Caller context:
set mW := MeasurableSpace.comap W (by infer_instance : MeasurableSpace γ)
apply foo  -- ERROR: synthesized mW, inferred inst✝⁴ (distinct!)

-- ✅ CORRECT: Explicit parameter
lemma foo {Ω : Type*} {m₀ : MeasurableSpace Ω}  -- Explicit ambient
    {γ : Type*} [MeasurableSpace γ]
    {μ : Measure Ω} [IsProbabilityMeasure μ]     -- All instances first
    (W : Ω → γ) (hCI : SomeProperty W)           -- Plain parameters
    {m : MeasurableSpace Ω} (hm : m ≤ m₀) :      -- Explicit sub-σ-algebra
    μ[ ... | m ] = ...                           -- Use plain parameter

-- Caller context:
set mW := MeasurableSpace.comap W (by infer_instance : MeasurableSpace γ)
have hmW : mW ≤ _ := hW.comap_le
apply foo (m := mW) (hm := hmW)  -- ✓ Works
```

**General principle:** Avoid `(by infer_instance)` in signatures when the instance will be constructed differently by callers. Use explicit parameters instead.

---

## Quick Reference

| Situation | Solution | Complexity |
|-----------|----------|------------|
| Alternative instance used 1-2 times | Solution 1: No local binding | ⭐ Simple |
| Need both ambient and alternative instances | Solution 2: Pin `m0` + use `@` | ⭐⭐ Medium (RECOMMENDED) |
| Multiple theorems need same alternative | Solution 4: Section `abbrev` | ⭐⭐ Medium |
| Can't modify start of proof | Solution 3: Force with `@` everywhere | ⭐⭐⭐ Complex |

---

## Summary

- **`let`/`set` always create local constants that pollute instance inference** for ANY typeclass
- **`abbrev` only works at top-level, not in proofs**
- **Best practice**: Pin ambient instance (`let m0 := ‹...›`) + use `@` notation for ALL ambient facts
- **`@` notation is NOT optional**: Even if you do ambient work "first," outer scope pollution requires explicit `@`
- **Never use**: `letI` for data (only for actual instance replacement)
- **Lemma signatures**: Avoid `(by infer_instance)` in signatures when callers construct instances differently; use explicit parameters

The key insights:
1. **Instance pollution is about SCOPE, not ORDER**: If ANY outer scope has a conflicting instance, you're polluted
2. **Pin + `@` is the solution**: Pin the ambient instance and explicitly force it with `@` notation
3. **No magic syntax exists**: You can't avoid `@` notation when pollution exists anywhere in scope
4. **Performance optimization**: Use three-tier strategy (`_m0` versions + ambient versions) to avoid expensive unification when calling mathlib lemmas
5. **Elaboration vs definitional equality**: `(by infer_instance)` and `set m := ...` are definitionally equal but elaborator treats them as distinct

**This applies to all typeclasses:** While examples use `MeasurableSpace Ω`, the same patterns prevent pollution with `Metric α`, `LinearOrder β`, `Group G`, etc.
