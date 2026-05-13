# Refactoring Long Proofs

Guide for breaking monolithic proofs into maintainable helper lemmas.

## When to Refactor

**Sweet spot:** Proofs between 60-200 lines benefit most from refactoring. Under 60 lines, overhead exceeds benefit. Over 200 lines, multiple refactorings needed.

**Refactor when:**
- Proof exceeds 100 lines (or 60+ with repetitive structure)
- Multiple conceptually distinct steps
- Intermediate results would be useful elsewhere
- Hard to understand/maintain
- Repeated patterns (especially lhs/rhs with near-identical proofs)
- Large preliminary calculations (50+ line `have` statements)
- Property bundling opportunities (multiple properties proven separately, used together)
- **Elaboration timeouts from nested lemma applications** (see [performance-optimization.md](performance-optimization.md) Pattern 2)

**Don't refactor when:**
- Proof is short and linear (< 50 lines, no repetition)
- No natural intermediate milestones
- Extraction would require too many parameters
- **Proof is already well-factored** (see signs below)

**Signs of a well-factored proof (skip these):**
- **Clear section comments** delineate logical steps (e.g., "-- Step 1: Establish bounds", "-- Step 2: Apply induction")
- **Natural linear flow** without tangents or backtracking
- **Core mathematical argument dominates** (e.g., induction structure, case analysis, algebraic manipulation is the bulk)
- **No large extractable blocks** - all `have` statements are short (< 20 lines) or inherently tied to the main flow
- **Readable without refactoring** - you can follow the proof logic by reading comments and goals

**Example of already-clean proof:**
```lean
theorem foo : Result := by
  -- Step 1: Base case
  have base : P 0 := by simp

  -- Step 2: Inductive step
  suffices ∀ n, P n → P (n + 1) by
    intro n; induction n <;> assumption

  -- Main induction argument (this IS the proof)
  intro n hn
  cases n with
  | zero => exact base
  | succ n' =>
    have ih := hn n' (Nat.lt_succ_self n')
    calc P (n' + 1) = ... := by ...
                  _ = ... := by ih

  -- Conclusion follows immediately
  exact result
```

**Why not refactor:** The induction structure IS the content. Extracting pieces would obscure the mathematical flow. Comments already clarify structure.

---

---

## Refactoring Decision Tree

```
Is the proof 60-200 lines? (sweet spot for refactoring)
├─ Yes: Look for natural boundaries (use lean_goal at 4-5 key points)
│   ├─ Repetitive structure (lhs/rhs, symmetric args, or repeated case splits)?
│   │   └─ Extract common pattern to helper (Pattern 1.3)
│   ├─ Single large case split (30+ lines proving reusable fact)?
│   │   └─ Extract even if not repeated (Pattern 1.3 - single large case split)
│   ├─ Multiple properties proven separately, used together?
│   │   └─ Bundle with ∧, use obtain (Pattern 1.5)
│   ├─ Mixes multiple mathematical domains (combinatorics + analysis)?
│   │   └─ Extract each domain's logic separately (Pattern 1.2)
│   ├─ Starts with 50+ line preliminary calculation?
│   │   └─ Extract preliminary fact to helper (Pattern 1.1)
│   ├─ Same 5-10 line notation conversion repeated?
│   │   └─ Extract conversion helper (Pattern 1.6)
│   ├─ Found witness extraction (choose/obtain)?
│   │   └─ Extract to helper (Pattern 1.4 - clear input/output contract)
│   ├─ Found arithmetic bounds?
│   │   ├─ Can extract without `let` bindings? → Extract to private helper (Pattern 3.1)
│   │   └─ Uses complex `let` bindings? → Consider inlining (Pattern 2.3)
│   ├─ Found permutation construction?
│   │   └─ Reusable pattern? → Extract (ensure parameter clarity, Pattern 2.1)
│   ├─ Found "all equal, pick one" pattern?
│   │   ├─ Equality proof → Extract to helper (Pattern 2.4 - mathematical content)
│   │   └─ Choice of representative → Keep in main (proof engineering)
│   └─ Found measure manipulations?
│       └─ Uses `let` bindings? → Prefer inlining (Pattern 3.4 - definitional issues)
├─ > 200 lines? → Multiple refactorings needed (start with largest prelims, Pattern 1.1)
└─ < 60 lines? → Probably fine as-is (unless heavily repetitive)

When extracting:
1. Make helper `private` if proof-specific (Pattern 3.1: use regular -- comments, not /-- -/)
2. **Generic is better** (Pattern 2.1): Remove proof-specific constraints
   - Relax equality to inequality (n = 42 → 1 ≤ n)
   - Weaken hypotheses to minimum needed
   - Broaden types when possible
3. Avoid `let` bindings in helper signatures (Pattern 2.3):
   - Option A: Use explicit parameters with equality proofs (param + hparam : param = expr)
   - Option B: Inline the proof if measure theory manipulation (Pattern 3.4)
4. If omega fails, add explicit intermediate steps (Pattern 3.3: use calc)
5. Prefix unused but required parameters with underscore (Pattern 3.2: _hS)
6. Add structural comments that explain "why", not "what" (Pattern 4.2)
7. Isolate hypothesis usage—extract with minimal assumptions first (Pattern 2.2)
8. Document what the helper proves and why (Pattern 6.1, 6.2, 6.3)
9. Test compilation after each extraction (Pattern 5.1: lean_diagnostic_messages)
10. Check goal states at 4-5 key points to find natural boundaries (Pattern 5.2)

After refactoring:
11. Use meaningful names (Pattern 4.1: variance_formula, not step1 - unless no better alternative)
```

---

## Pattern Quick Reference

**When refactoring, ask yourself:**

1. **Identify opportunities** (Pattern 1): What signals extraction?
   - 50+ line preliminary? → 1.1
   - Mixing domains? → 1.2
   - Repetitive structure (lhs/rhs, symmetric args, large case splits)? → 1.3
   - Witness extraction? → 1.4
   - Properties always together? → 1.5
   - Recurring conversion? → 1.6

2. **Design helpers** (Pattern 2): How to make them reusable?
   - Generalize constraints → 2.1
   - Minimize assumptions → 2.2
   - Avoid let bindings → 2.3
   - Separate math from engineering → 2.4

3. **Follow conventions** (Pattern 3): Lean-specific rules?
   - Private? Use `--` not `/-- -/` → 3.1
   - Unused param? Add `_` prefix → 3.2
   - Omega failing? Add intermediate steps → 3.3
   - Measure theory? Watch definitional equality → 3.4

4. **Structure main proof** (Pattern 4): After extraction?
   - Named steps with comments → 4.1
   - Explain "why" not "what" → 4.2

5. **Safe workflow** (Pattern 5): How to refactor safely?
   - Test after each extraction → 5.1
   - Check goals at 4-5 points → 5.2
   - One at a time → 5.3
   - Use LSP for fast feedback → 5.4

6. **Document** (Pattern 6): What to explain?
   - What it proves → 6.1
   - Why it's true → 6.2
   - How it's used → 6.3

---
## LSP-Based Refactoring Workflow

**Strategy:** Use `lean_goal` (from Lean LSP MCP) to inspect proof state at different locations, then subdivide at natural breakpoints where intermediate goals are clean and reusable.

### Step 1: Survey the Proof

Walk through the proof checking goals at 4-5 key points:

```python
# Check goals at 4-5 key locations in the long proof
lean_goal(file, line=15)   # After initial setup
lean_goal(file, line=45)   # After first major step
lean_goal(file, line=78)   # After second major step
lean_goal(file, line=120)  # After third major step
lean_goal(file, line=155)  # Near end
```

**What to look for:**
- Clean, self-contained intermediate goals
- Natural mathematical milestones
- Points where context significantly changes
- Repetitive structure (same proof pattern for lhs/rhs)

### Step 2: Identify Extraction Points

Look for locations where:
- **Goal is clean:** Self-contained statement with clear meaning
- **Dependencies are local:** Depends only on earlier hypotheses (no forward references)
- **Useful elsewhere:** Goal would be reusable in other contexts
- **Natural meaning:** Intermediate state has clear mathematical interpretation

**Good breakpoints:**
- After establishing key inequalities or bounds
- After case splits (before/after `by_cases`)
- After measurability/integrability proofs
- Where intermediate result has a clear name
- After computing/simplifying expressions
- Before/after applying major lemmas

**Bad breakpoints:**
- Mid-calculation (no clear intermediate goal)
- Where helper would need 10+ parameters
- Where context is too tangled to separate cleanly
- In the middle of a `calc` chain
- Where goal depends on later bindings

### Step 3: Extract Helper Lemma

```lean
-- BEFORE: Monolithic proof
theorem big_result : Conclusion := by
  intro x hx
  have h1 : IntermediateGoal1 := by
    [30 lines of tactics...]
  have h2 : IntermediateGoal2 := by
    [40 lines of tactics...]
  [30 more lines...]

-- AFTER: Extracted helpers
lemma helper1 (x : α) (hx : Property x) : IntermediateGoal1 := by
  [30 lines - extracted from h1]

lemma helper2 (x : α) (h1 : IntermediateGoal1) : IntermediateGoal2 := by
  [40 lines - extracted from h2]

theorem big_result : Conclusion := by
  intro x hx
  have h1 := helper1 x hx
  have h2 := helper2 x h1
  [30 lines - much clearer now]
```

### Step 4: Verify with LSP

After each extraction:
```python
lean_diagnostic_messages(file)  # Check for errors
lean_goal(file, line)           # Confirm goals match
```

**Verify extraction is correct:**
```python
# Original line number where `have h1 : ...` was
lean_goal(file, line=old_h1_line)
# → Should match helper1's conclusion

# New line number after extraction
lean_goal(file, line=new_h1_line)
# → Should show `h1 : IntermediateGoal1` available
```

---

## Non-LSP Refactoring (Manual)

If you don't have LSP access, use this manual workflow:

### Step 1: Read and Understand

Read through the proof identifying conceptual sections:
- What is the proof trying to establish?
- What are the major steps?
- Are there repeated patterns?

### Step 2: Mark Candidates

Add comments marking potential extraction points:
```lean
theorem big_result : ... := by
  intro x hx
  -- Candidate 1: Establish boundedness
  have h1 : ... := by
    ...
  -- Candidate 2: Prove measurability
  have h2 : ... := by
    ...
```

### Step 3: Extract One at a Time

Extract one helper at a time, compile after each:
1. Copy `have` proof to new lemma
2. Identify required parameters
3. Replace original with `have h := helper args`
4. `lake build` to verify
5. Commit if successful

### Step 4: Iterate

Repeat until proof is manageable.

---

## Naming Extracted Helpers

**Good names describe what the lemma establishes:**
- `bounded_by_integral` - establishes bound
- `measurable_composition` - proves measurability
- `convergence_ae` - proves a.e. convergence

**Avoid vague names:**
- `helper1`, `aux_lemma` - meaningless
- `part_one`, `step_2` - based on structure, not content
- `temp`, `tmp` - should be permanent

**Mathlib-style conventions:**
- Use snake_case
- Include key concepts: `integral`, `measure`, `continuous`, etc.
- Add context if needed: `of_`, `_of`, `_iff`

---

## Real Refactoring Example

**Context:** 63-line monolithic proof about exchangeable measures with strict monotone functions.

**Step 1: Identify natural boundaries**

Using `lean_goal` at different points revealed:
- Line 15: After establishing `hk_bound : ∀ i, k i < n` (clean arithmetic result)
- Line 35: After constructing permutation (conceptually distinct)
- Line 50: After projection proof (measure theory manipulation)

**Step 2: Extract arithmetic helper**

Found this embedded calculation:
```lean
have hk_bound : ∀ i : Fin (m' + 1), k i < n := by
  intro i
  simp only [n]
  have : k i ≤ k ⟨m', Nat.lt_succ_self m'⟩ := by
    apply StrictMono.monotone hk_mono
    exact Fin.le_last i
  omega
```

Extracted to:
```lean
/-- Strictly monotone functions satisfy k(i) ≤ k(last) for all i -/
private lemma strictMono_all_lt_succ_last {m : ℕ} (k : Fin m → ℕ)
    (hk : StrictMono k) (i : Fin m) (last : Fin m)
    (h_last : ∀ j, j ≤ last) :
    k i ≤ k last := by
  apply StrictMono.monotone hk
  exact h_last i
```

**Result:** Main proof now just calls helper, much clearer.

**Step 3: Verify with LSP**

```python
lean_diagnostic_messages(file)  # No errors ✓
lean_goal(file, line=15)        # Shows helper available ✓
```

**Final structure:**
- Original: 63 lines monolithic
- Refactored: 45 lines main + 33 lines helpers = 78 lines total
- **Success:** Much clearer structure, each piece testable independently

**Key insight:** Success measured by clarity, not brevity.

---

## Refactoring Patterns

**6 high-level patterns** cover all refactoring scenarios. Each contains specific sub-patterns you can apply directly.

---

### Pattern 1: Identify Extraction Opportunities

**What to look for:** These signals indicate a helper should be extracted.

#### 1.1. Large Preliminary Calculations

**Trigger:** Proof starts with 50+ line `have` statement before the main argument.

**Example:**
```lean
theorem main_result ... := by
  -- 51 lines proving preliminary bound
  have hAux : ∑ i, |p i - q i| ≤ 2 := by
    [massive calculation]
  -- Main argument obscured above
  calc ...
```

**Action:** Extract to `private lemma preliminary_bound ...`

**Why:** Preliminary fact has independent mathematical interest, makes main proof immediately visible, enables testing the preliminary calculation separately.

#### 1.2. Domain Separation

**Trigger:** Proof mixes independent mathematical domains (combinatorics + functional analysis, algebra + topology).

**Example:** 130-line proof mixing finite probability distributions (combinatorics) with L² bounds (functional analysis).

**Action:** Extract each domain's logic into separate helpers.

**Why:** Each helper uses only tools from its domain, main theorem reads at correct abstraction level, helpers highly reusable.

#### 1.3. Repetitive Structure (lhs/rhs and Case Splits)

**Trigger:** Nearly identical proofs for both sides of equation, symmetric arguments, or multiple cases with same structure.

**Basic pattern (literal repetition):**
```lean
-- Symmetric sides of equation
have hlhs : P lhs := by [20 lines]
have hrhs : P rhs := by [20 lines, nearly identical!]

-- Symmetric objects/arguments (P and Q, left and right, forward and backward)
have hP : Property P := by [14 lines]
have hQ : Property Q := by [14 lines, exact duplicate!]
```

**Action:** Extract `private lemma has_property_P (expr : α) : P expr`

**Single large case split (even if not repeated):**

Even a SINGLE 30+ line case split should be extracted if it proves a standalone mathematical fact.

**Trigger:** One large case analysis (30+ lines) that proves a reusable identity.

**Example:**
```lean
-- Before: 37-line case split inline
have h := by
  by_cases hY : ω ∈ Y ⁻¹' A <;> by_cases hZ : ω ∈ Z ⁻¹' B
  · -- 9 lines for case 1
    ...
  · -- 9 lines for case 2
    ...
  · -- 9 lines for case 3
    ...
  · -- 9 lines for case 4
    ...

-- After: Clean one-liner
have h := prod_indicators_eq_indicator_intersection X k B
```

**When to extract single case splits:** The case analysis proves a fact that:
- Could be stated as a standalone lemma with clear mathematical meaning
- Doesn't depend on specific context of the current proof
- Would be reusable in other proofs

**Advanced pattern (abstract structural repetition):**

When the same case-split structure appears multiple times for slightly different goals, extract the shared structure. The key is recognizing that the *proof pattern* is the same even if the specific goals differ.

**Example: Same 4-case structure for different goals**
```lean
-- First occurrence: proving product of indicators = single indicator for A×B
have h1 : (A.indicator 1 * B.indicator 1) x = (A ×ˢ B).indicator 1 x := by
  by_cases ha : x ∈ A <;> by_cases hb : x ∈ B
  · -- Case 1: x ∈ A, x ∈ B → both sides = 1
    simp [ha, hb]
  · -- Case 2: x ∈ A, x ∉ B → both sides = 0
    simp [ha, hb]
  · -- Case 3: x ∉ A, x ∈ B → both sides = 0
    simp [ha, hb]
  · -- Case 4: x ∉ A, x ∉ B → both sides = 0
    simp [ha, hb]

-- Second occurrence: proving intersection of preimages for indicators
have h2 : (f⁻¹'A.indicator 1 * g⁻¹'B.indicator 1) x = (f⁻¹'A ∩ g⁻¹'B).indicator 1 x := by
  by_cases ha : x ∈ f⁻¹'A <;> by_cases hb : x ∈ g⁻¹'B
  · -- Same 4-case structure!
    simp [ha, hb]
  · simp [ha, hb]
  · simp [ha, hb]
  · simp [ha, hb]
```

**Extract the abstract pattern:**
```lean
-- Captures: product of indicators = indicator of combined set
private lemma indicator_mul_eq_indicator {α : Type*} (s t : Set α) (x : α) :
    s.indicator (1 : α → ℝ) x * t.indicator 1 x = (s ∩ t).indicator 1 x := by
  by_cases hs : x ∈ s <;> by_cases ht : x ∈ t <;> simp [hs, ht]

-- Now both uses become one-liners
have h1 := indicator_mul_eq_indicator A B x
have h2 := indicator_mul_eq_indicator (f⁻¹'A) (g⁻¹'B) x
```

**Why this works:**
- The mathematical structure (4-case split on membership) is identical
- Only the specific sets differ (A×B vs A∩B, direct sets vs preimages)
- Helper captures the abstract pattern, works for any sets
- Main theorem reads at higher level of abstraction

**Recognition pattern:** If you find yourself writing the same `by_cases` structure multiple times with the same number of cases and similar reasoning in each case, even if the goals look different on the surface, there's likely an abstract pattern to extract.

**Summary rules:**
- **Literal repetition**: Copy-paste with only variable names changed (lhs/rhs, P/Q) → extract
- **Single large case split**: 30+ line case analysis proving reusable fact → extract even if not repeated
- **Abstract structural repetition**: Same case-split structure for different goals → extract abstract pattern
- **Why:** Write logic once, changes apply automatically, helpers reusable, main proof reads at higher abstraction level

#### 1.4. Witness Extraction

**Trigger:** `choose` or multiple `obtain` extracting witnesses from existentials.

**Example:**
```lean
have : ∀ i, ∃ T, MeasurableSet T ∧ s = f ⁻¹' T := by [proof]
choose T hTmeas hspre using this
```

**Action:** Extract `obtain ⟨T, hTmeas, hspre⟩ := witnesses_helper ...`

**Why:** Clear input/output contract (hypotheses → witnesses), helper testable independently, construction logic reusable.

#### 1.5. Property Bundling

**Trigger:** Multiple related properties proven separately but always used together.

**Example:**
```lean
have h1 : Property1 x := by [proof]
have h2 : Property2 x := by [proof]
have h3 : Property3 x := by [proof]
exact final_lemma h1 h2 h3  -- Always used together
```

**Action:** Bundle with `∧`, extract `obtain ⟨h1, h2, h3⟩ := bundle_properties x`

**When to bundle:** Properties share hypotheses, always proven together, conceptually related.

**When NOT:** Different hypotheses, sometimes used independently.

#### 1.6. Notation Conversions

**Trigger:** Same 5-10 line conversion between notations repeated multiple times.

**Common conversions:**
- Set builder ↔ pi notation: `{x | ∀ i, x i ∈ s i}` ↔ `Set.univ.pi s`
- Measure ↔ integral: `μ s` ↔ `∫⁻ x, s.indicator 1 ∂μ`
- Preimage ↔ set comprehension

**Action:** Extract conversion helper with clear purpose.

**Why:** Conversion written once, main proof focuses on mathematics not notation.

---

### Pattern 2: Design Reusable Helpers

**How to extract:** Make helpers generic and broadly applicable.

#### 2.1. Generic is Better

**Principle:** Remove proof-specific constraints when extracting.

**Techniques:**
1. **Relax equality to inequality:** `n = 42` → `1 ≤ n`
2. **Remove specific values:** Use parameters instead of constants
3. **Weaken hypotheses:** Use only what's needed in proof
4. **Broaden types:** `Fin 10` → `Fin n` if bound doesn't matter

**Example:**
```lean
-- ❌ Too specific
private lemma helper (n : ℕ) (hn : n = 42) : Property n

-- ✅ Generic
private lemma helper (n : ℕ) (hn : 1 ≤ n) : Property n
```

**Balance:** Don't over-generalize to 10+ parameters.

#### 2.2. Isolate Hypothesis Usage

**Principle:** Extract helpers with minimal assumptions for maximum reusability.

**Example:** In a proof using surjectivity, only ONE helper needs it - others work without.

**Practice:**
- Extract helper with minimal assumptions first
- Build specialized helpers on top
- Creates reusability hierarchy

#### 2.3. Avoid Let Bindings in Helper Signatures

**Problem:** Let bindings create definitional inequality - helper's `let proj` ≠ main's `let proj` even if syntactically identical.

**Solutions:**
- **Option A:** Explicit parameters with equality proofs
  ```lean
  private lemma helper (μX : Measure α) (hμX : μX = pathLaw μ X) ...
  -- Call site: helper μX rfl  -- ✓ Unifies perfectly
  ```
- **Option B:** Inline the proof (for measure theory manipulations)

**Why:** Definitional inequality causes rewrite failures even with identical-looking expressions.

#### 2.4. "All Equal, Pick One" Pattern

**Pattern:** "All things are equal, so pick one canonical representative."

**Structure:**
1. **Mathematical content** (all candidates equal) → Extract to helper
2. **Proof engineering** (choice of which to use) → Keep in main
3. Use equality from helper → Main proof

**Why separate:** Equality proof has mathematical content worth reusing. Choice is arbitrary proof engineering.

---

### Pattern 3: Lean-Specific Conventions

**Code quality:** Follow Lean syntax and style conventions.

#### 3.1. Private Lemmas Use Regular Comments

**Rule:** `private` declarations use `--` comments, not `/-- -/` doc comments.

```lean
-- ✅ Correct
-- Helper for extracting witnesses
private lemma helper ...

-- ❌ Wrong
/-- Helper for extracting witnesses -/  -- Error: unexpected token '/--'
private lemma helper ...
```

**Why:** Doc comments are for public API. Private declarations don't appear in generated docs.

#### 3.2. Unused Parameters Need Underscore

**Rule:** Intentionally unused parameters get underscore prefix.

```lean
-- Parameter needed in type signature but unused in proof
∀ n (S : Set (Fin n → α)) (_hS : MeasurableSet S), ...
```

**Why:** Signals "intentionally unused" to linter. Parameter required in signature but proof doesn't explicitly reference it.

#### 3.3. Omega Limitations

**Problem:** `omega` fails on arithmetic goals that seem obvious.

**Solution:** Provide intermediate steps with `calc` or explicit equalities as hypotheses.

**Example:**
```lean
-- ❌ Fails
have : m ≤ k last + 1 := by omega

-- ✅ Works
have (h_last_eq : last.val + 1 = m) : m ≤ k last + 1 := by
  calc m = last.val + 1 := h_last_eq.symm
       _ ≤ k last + 1 := Nat.add_le_add_right h_mono 1
```

#### 3.4. Measure Theory Requires Exact Alignment

**Problem:** Measure theory lemmas sensitive to definitional equality. `Measure.map` compositions must align exactly.

**Solution:** For measure manipulations with `let` bindings, prefer inlining over extraction (definitional inequality issues).

---

### Pattern 4: Structure the Main Proof

**After extraction:** Reorganize main proof for clarity.

#### 4.1. Named Steps with Comments

**Pattern:** Use semantically meaningful names for intermediate results. Only use generic names like `step1`, `step2` when there's no better alternative and the results are private to this proof.

**Prefer meaningful names:**
```lean
theorem main_result ... := by
  -- Variance formula: E(∑cᵢξᵢ)² = E(∑cᵢ(ξᵢ-m))² using ∑cⱼ = 0
  have variance_formula : ... := by ...

  -- Covariance expansion: = ∑ᵢⱼ cᵢcⱼ cov(ξᵢ, ξⱼ)
  have covariance_expansion : ... := by ...

  -- Final: Combine steps
  calc ...
```

**When meaningful names aren't obvious, use generic sequence:**
```lean
theorem main_result ... := by
  -- Step 1: E(∑cᵢξᵢ)² = E(∑cᵢ(ξᵢ-m))² using ∑cⱼ = 0
  have step1 : ... := by ...

  -- Step 2: = ∑ᵢⱼ cᵢcⱼ cov(ξᵢ, ξⱼ) by expanding square
  have step2 : ... := by ...

  -- Final: Combine steps
  calc ...
```

**Use `step1`, `step2` only when:**
- Results are private to this proof (not extracted as helpers)
- Used sequentially in a linear chain
- No clear mathematical names suggest themselves
- Proof is exploratory and may be refactored later

**Benefits:** Meaningful names aid comprehension, generic names show sequencing. Reads like textbook proof either way, mathematical narrative clear, easy to locate issues.

#### 4.2. Structural Comments Explain "Why"

**Good comments:**
- Explain mathematical goal (not Lean syntax)
- Highlight where key hypotheses are used
- Make proof understandable from comments alone

**Examples:**
```lean
-- ✅ Good: Explains proof strategy
-- Extract witnesses Tᵢ such that s = f ⁻¹' Tᵢ for each i

-- ❌ Bad: Describes what code does
-- Choose the witnesses Tᵢ along with measurability
```

---

### Pattern 5: Safe Refactoring Workflow

**Process:** Refactor incrementally with continuous verification.

#### 5.1. Test After Every Extraction

**Rule:** Build after EACH extraction, not in batches.

**With LSP (fast):**
```python
# After each edit
lean_diagnostic_messages(file_path)
lean_goal(file_path, line)
```

**Without LSP:**
```bash
lake build FILE.lean  # After each extraction
```

**Why:** Errors compound. One error at a time is faster than five mixed together.

#### 5.2. Examine Goal States at Key Points

**Strategy:** Use `lean_goal` at 4-5 strategic locations (not every line).

```python
lean_goal(file, line=15)   # After initial setup
lean_goal(file, line=45)   # After first major step
lean_goal(file, line=78)   # After second major step
lean_goal(file, line=120)  # After third major step
lean_goal(file, line=155)  # Near end
```

**What to look for:**
- Clean, self-contained intermediate goals
- Natural mathematical milestones
- Points where context significantly changes
- Repetitive structure (same pattern for lhs/rhs)

#### 5.3. One Helper at a Time

**Workflow:**
1. Extract one helper
2. Verify with `lean_diagnostic_messages`
3. Update main theorem
4. Verify again
5. Commit if successful
6. Repeat

**Don't:** Make multiple changes then check - errors compound!

#### 5.4. LSP Works Even When Build Fails

**Observation:** `lean_diagnostic_messages` works even when `lake build` fails due to dependency issues.

**Why useful:** Verify refactoring locally using LSP at file/module level, don't wait for full project build.

---

### Pattern 6: Document Helpers

**Every helper should explain:**

#### 6.1. What It Proves

In mathematical terms, what does this lemma establish?

```lean
-- For a strictly monotone function k : Fin m → ℕ, we have m ≤ k(m-1) + 1
private lemma strictMono_length_le_max_succ ...
```

#### 6.2. Why It's True

Key insight or technique used.

```lean
-- This uses the fact that strictly monotone functions satisfy i ≤ k(i) for all i
```

#### 6.3. How It's Used

If not obvious from context.

```lean
-- Used to bound the domain length in the permutation construction
```

**Full example:**
```lean
/--
Helper lemma: The length of the domain is bounded by the maximum value plus one.

For a strictly monotone function `k : Fin m → ℕ`, we have `m ≤ k(m-1) + 1`.
This uses the fact that strictly monotone functions satisfy `i ≤ k(i)` for all `i`.
-/
private lemma strictMono_length_le_max_succ ...
```

---


## Benefits of Refactoring

**Maintainability:**
- Easier to understand small proofs
- Easier to modify without breaking
- Clear dependencies between lemmas

**Reusability:**
- Helper lemmas useful in other contexts
- Avoid reproving same intermediate results
- Build library of project-specific lemmas

**Testing:**
- Test helpers independently
- Isolate errors to specific lemmas
- Faster compilation (smaller units)

**Collaboration:**
- Easier to review small lemmas
- Clear boundaries for parallel work
- Better documentation opportunities

---

## Anti-Patterns

**❌ Over-refactoring:**
- Creating helpers used only once
- Extracting every `have` statement
- Too many small lemmas (harder to navigate)

**❌ Under-refactoring:**
- 500+ line proofs
- Multiple independent results in one theorem
- Repeated code instead of shared helpers

**❌ Poor parameter choices:**
- Extracting with 15+ parameters
- Including unnecessary generality
- Making helpers too specific to one use case

**✅ Good balance:**
- Extract when reusable or conceptually distinct
- Aim for 20-80 line helpers
- Parameters capture essential dependencies only

---

## See Also

- [lean-lsp-tools-api.md](lean-lsp-tools-api.md) - LSP tools for goal inspection
- [proof-golfing.md](proof-golfing.md) - Simplifying proofs after compilation
- [mathlib-style.md](mathlib-style.md) - Naming conventions
