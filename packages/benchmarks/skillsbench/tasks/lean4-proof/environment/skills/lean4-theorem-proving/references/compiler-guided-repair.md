# Compiler-Guided Proof Repair - Quick Reference

**Core insight:** Use Lean's compiler feedback to drive iterative repair with small, budgeted LLM calls instead of blind best-of-N sampling.

**Key principle:** Generate → Compile → Diagnose → Fix → Verify (tight loop, K=1)

**Inspired by:** APOLLO (https://arxiv.org/abs/2505.05758)

---

## Philosophy

**Traditional Approach (Blind Sampling):**
```
Generate 100 proof attempts → Test all → Pick best
❌ Wasteful: Most attempts fail identically
❌ No learning: Same error repeated many times
❌ Expensive: Large model × high K
```

**Compiler-Guided Approach:**
```
Generate attempt → Lean error → Route to specific fix → Retry (max 24 attempts)
✅ Efficient: Error-driven action selection
✅ Adaptive: Different fix strategies per error type
✅ Economical: Small K (often K=1), fast model first, escalate only when needed
✅ Learning: Log attempts, avoid repeating dead ends
```

**Key wins:**
- **Low sampling budgets** (K=1 or K=3) with compiler guidance beat high-K blind sampling
- **Multi-stage approach** (fast model → escalate to strong model) optimizes cost/quality
- **Solver cascade** (try automation before resampling) handles many cases mechanically
- **Early stopping** (bail after 3 identical errors) prevents runaway costs

---

## Quick Start

**Repair entire file:**
```
/lean4-theorem-proving:repair-file MyProof.lean
```

**Repair specific goal:**
```
/lean4-theorem-proving:repair-goal MyProof.lean 42
```

**Interactive with confirmations:**
```
/lean4-theorem-proving:repair-interactive MyProof.lean
```

---

## API Discovery Workflow

**Core principle:** Search before guessing. LeanFinder + LSP tools prevent 80% of API-related errors.

### The "LeanFinder First" Rule

Before writing ANY Lean API call:

1. **Search with natural language** (`lean_leanfinder`):
   ```python
   lean_leanfinder(query="Lp space membership predicate measure theory")
   # → Finds: MemLp (not Memℒp, not memLp)
   ```

2. **Confirm locally** (`lean_local_search`):
   ```python
   lean_local_search("MemLp", limit=5)
   # → Verify it exists in your imports
   ```

3. **Check signature** (`lean_hover_info`):
   ```python
   lean_hover_info(file, line, col)
   # → See: MemLp f p μ (expects ENNReal, not ℝ!)
   ```

4. **THEN write the code**

**Why this matters:**
- Mathematical notation ≠ Lean API names (ℒp → MemLp, not Memℒp)
- Type signatures have subtle requirements (ENNReal.ofReal 2 vs 2)
- Field vs function matters (x.foo vs Foo.bar x)

### Example: Lp Space API Discovery

**❌ Wrong (guessing from math notation):**
```lean
theorem foo (f g : α → ℝ) (h : f =ᵐ[μ] g) : f ∈ Memℒp 2 μ := by
  exact h.memLp  -- Multiple errors: Memℒp doesn't exist, memLp is not a field, 2 has wrong type
```

**✅ Correct (LeanFinder → hover → verify):**
```lean
theorem foo (f g : α → ℝ) (hf : MemLp f (ENNReal.ofReal 2) μ) (h : f =ᵐ[μ] g) :
    MemLp g (ENNReal.ofReal 2) μ := by
  exact MemLp.ae_eq hf h.symm  -- Correct API name, correct type, correct direction
```

**How LeanFinder helped:**
1. Query: "Lp space membership predicate" → Found `MemLp` (not `Memℒp`)
2. Hover on `MemLp` → Saw signature expects `ENNReal` for p parameter
3. Local search: "ae_eq" → Found `MemLp.ae_eq` takes `f =ᵐ[μ] g` (not `g =ᵐ[μ] f`)

---

## Core Workflow

### 1. Compile → Extract Error
```bash
lake build FILE.lean 2> errors.txt
python3 scripts/parseLeanErrors.py errors.txt > context.json
```

Extracts: error type, location, goal state, local context, code snippet

### 2. Try Solver Cascade (many simple cases, free!)
```bash
python3 scripts/solverCascade.py context.json FILE.lean
```

Tries in order: `rfl → simp → ring → linarith → nlinarith → omega → exact? → apply? → aesop`

If any succeeds → apply diff, recompile

### 3. Agent Repair (if cascade fails)

**Stage 1 (Haiku, fast):** First 6 attempts
- Model: `haiku`, thinking OFF
- Temperature: 0.2, K=1
- Budget: ~2s per attempt
- Strategy: Quick, obvious fixes

**Stage 2 (Opus, precise):** After Stage 1 exhausted or complex errors
- Model: `opus`, thinking ON
- Temperature: 0.1, K=1
- Budget: ~10s per attempt
- Strategy: Strategic thinking, global context

**Escalation triggers:**
- Same error 3 times in Stage 1
- Error types: `synth_instance`, `recursion_depth`, `timeout`
- Stage 1 attempts exhausted

### 4. Apply Patch → Recompile

```bash
git apply patch.diff
lake build FILE.lean
```

If success → done! If fail → next iteration (max 24 attempts)

---

## Repair Strategies by Error Type

### type_mismatch

**Strategies:**
1. `convert _ using N` (N = unification depth 1-3)
2. Explicit type annotation: `(expr : TargetType)`
3. `refine` with placeholders
4. `rw` to align types
5. Intermediate `have` with correct type

**Example:**
```diff
-  exact h
+  convert continuous_of_measurable h using 2
+  simp
```

### unsolved_goals

**Strategies:**
1. Try automation: `simp?`, `apply?`, `exact?`, `aesop`
2. By goal shape:
   - Equality → `rfl`, `ring`, `linarith`
   - ∀ → `intro`
   - ∃ → `use` or `refine ⟨_, _⟩`
   - → → `intro` then conclusion
3. Search mathlib for lemma
4. Break down: `constructor`, `cases`, `induction`

**Example:**
```diff
-  sorry
+  intro x
+  apply lemma_from_mathlib
+  exact h
```

### unknown_ident

**Strategies:**
1. **Use LeanFinder FIRST:** `lean_leanfinder(query="natural language description of what you want")`
2. Check for ASCII vs Unicode naming (ℒp → MemLp, not Memℒp)
3. Search locally: `lean_local_search("ident", limit=10)`
4. Add namespace: `open Foo` or `open scoped Bar`
5. Add import: `import Mathlib.Foo.Bar`
6. Check for typo

**Example:**
```diff
+import Mathlib.Topology.Instances.Real
 ...
-  continuous_real
+  Real.continuous
```

**Why LeanFinder first:**
- Mathematical notation ≠ API names (use natural language instead)
- Finds correct spelling and namespace immediately
- Much faster than trial-and-error with imports

### synth_implicit / synth_instance

**Strategies:**
1. Provide instance: `haveI : Instance := ...`
2. Local instance: `letI : Instance := ...`
3. Open scope: `open scoped Topology`
4. Reorder arguments (instances before regular params)

**Example:**
```diff
+  haveI : MeasurableSpace β := inferInstance
   apply theorem_needing_instance
```

### sorry_present

**Strategies:**
1. Search mathlib (many already exist)
2. Automated solvers (cascade handles this)
3. Compositional proof from mathlib lemmas
4. Break into subgoals

### timeout / recursion_depth

**Strategies:**
1. Narrow `simp`: `simp only [lem1, lem2]` not `simp [*]`
2. Clear unused: `clear h1 h2`
3. Replace `decide` with `native_decide`
4. Provide instances explicitly
5. Revert then re-intro in better order

**Example:**
```diff
-  simp [*]
+  simp only [foo_lemma, bar_lemma]
```

---

## Common Pitfalls

### Pitfall 1: Type Coercion Assumptions (ENNReal vs ℝ)

**The trap:** In Lean 4, `2` and `ENNReal.ofReal 2` are not interchangeable, even though mathematically they represent the same value.

**❌ What fails:**
```lean
-- Lp spaces expect ENNReal for the p parameter
theorem bar (f : α → ℝ) : MemLp f 2 μ := by  -- ❌ Type mismatch: expected ENNReal, got ℕ
  ...
```

**✅ What works:**
```lean
theorem bar (f : α → ℝ) : MemLp f (ENNReal.ofReal 2) μ := by  -- ✓ Correct type
  ...
```

**How to catch this:**
1. Use `lean_goal` to see expected type
2. Check API signature with `lean_hover_info`
3. Look for `ENNReal`, `ℝ≥0∞`, or `ℝ≥0` in type signature

**General pattern:** Measure theory APIs often expect:
- `ENNReal` (ℝ≥0∞) for measures, Lp norms
- `ℝ≥0` (NNReal) for nonnegative reals
- `ℝ` for signed reals

Don't assume automatic coercion—check the signature!

### Pitfall 2: Field Access vs Function Call

**The trap:** Coming from other languages, `x.foo` and `Foo.bar x` seem equivalent, but in Lean they're different.

**❌ What fails:**
```lean
theorem baz (f : α → ℝ) (hf : MemLp f p μ) : Prop := by
  have := hf.memLp  -- ❌ Invalid field 'memLp', type MemLp doesn't have a field named memLp
  ...
```

**✅ What works:**
```lean
theorem baz (f g : α → ℝ) (hf : MemLp f p μ) (h : f =ᵐ[μ] g) : MemLp g p μ := by
  exact MemLp.ae_eq hf h.symm  -- ✓ Function call, not field access
  ...
```

**How to catch this:**
1. Error message: "Invalid field 'X'" → It's a function, not a field
2. Use `lean_hover_info` on the identifier to see if it's a field or function
3. Use `lean_local_search` to find the correct namespace (e.g., `MemLp.ae_eq` not `hf.ae_eq`)

**Rule of thumb:**
- Fields: Data stored in a structure (e.g., `point.x`, `σ.carrier`)
- Functions: Operations on types (e.g., `MemLp.ae_eq`, `Continuous.comp`)

### Pitfall 3: Almost Everywhere Equality Direction

**The trap:** `=ᵐ[μ]` has directionality. Lemmas expect specific order.

**❌ What fails:**
```lean
theorem qux (hf : MemLp f p μ) (h : g =ᵐ[μ] f) : MemLp g p μ := by
  exact MemLp.ae_eq hf h  -- ❌ Type mismatch: expected f =ᵐ[μ] g, got g =ᵐ[μ] f
```

**✅ What works:**
```lean
theorem qux (hf : MemLp f p μ) (h : g =ᵐ[μ] f) : MemLp g p μ := by
  exact MemLp.ae_eq hf h.symm  -- ✓ Reverse with .symm
```

**How to catch this:**
1. Error: "Type mismatch" with `EventuallyEq` → Check direction
2. Use `lean_goal` to see expected `f =ᵐ[μ] g` vs actual `g =ᵐ[μ] f`
3. Use `.symm` to reverse direction

**General pattern:** Many equivalence relations have `.symm`:
- `=ᵐ[μ]` (EventuallyEq)
- `≈` (equivalence)
- `↔` (iff)
- `=` (equality - though usually inferred)

### Pitfall 4: ASCII vs Unicode Naming

**The trap:** Mathematical notation uses Unicode (ℒp), but Lean APIs use ASCII (MemLp).

**❌ What fails:**
```lean
import Mathlib.MeasureTheory.Function.LpSpace

theorem foo : Memℒp f p μ := by  -- ❌ Unknown identifier 'Memℒp'
  ...
```

**✅ What works:**
```lean
import Mathlib.MeasureTheory.Function.LpSpace

theorem foo : MemLp f p μ := by  -- ✓ ASCII name
  ...
```

**How to catch this:**
1. Error: "Unknown identifier" with Unicode → Try ASCII equivalent
2. Use `lean_leanfinder` with natural language: "Lp space membership"
3. Check mathlib documentation for canonical names

**Common translations:**
- ℒp → MemLp (Lp space membership)
- ∞ → infinity or top (⊤)
- ≥0 → NNReal or ENNReal
- ∫ → integral

---

## Error Pattern Recognition

**Quick diagnosis guide:** Match error message to likely cause and fix strategy.

### "Invalid field 'X'"
**Likely cause:** Trying to use function call syntax on a type that doesn't have that field.

**Fix strategy:**
1. Use `lean_hover_info` to check if it's a function
2. Change `x.foo` to `Foo.bar x`
3. Use `lean_local_search` to find correct namespace

**Example:**
```diff
-  have := hf.memLp
+  have := MemLp.ae_eq hf h
```

### "Type mismatch: expected ENNReal, got ℕ" (or ℝ)
**Likely cause:** Missing `ENNReal.ofReal` or `ENNReal.ofNat` coercion.

**Fix strategy:**
1. Check if API expects `ENNReal` (use `lean_hover_info`)
2. Wrap numeric literals: `2` → `ENNReal.ofReal 2`
3. For variables: `p` → `ENNReal.ofReal p` (if p : ℝ)

**Example:**
```diff
-  theorem bar : MemLp f 2 μ := by
+  theorem bar : MemLp f (ENNReal.ofReal 2) μ := by
```

### "Application type mismatch" with EventuallyEq
**Likely cause:** Wrong direction for `=ᵐ[μ]` argument.

**Fix strategy:**
1. Use `lean_goal` to see expected direction
2. Add `.symm` to reverse: `h.symm`
3. Check lemma signature with `lean_hover_info`

**Example:**
```diff
-  exact MemLp.ae_eq hf h
+  exact MemLp.ae_eq hf h.symm
```

### "Unknown identifier 'X'"
**Likely cause:** Unicode name, missing import, or wrong namespace.

**Fix strategy:**
1. **Try LeanFinder FIRST:** `lean_leanfinder(query="natural language description")`
2. Check for ASCII equivalent (Memℒp → MemLp)
3. Search locally: `lean_local_search("X")`
4. Add import if found externally
5. Check for typo

**Example:**
```diff
-  exact Memℒp.ae_eq
+  exact MemLp.ae_eq  -- ASCII, not Unicode
```

### "Failed to synthesize instance"
**Likely cause:** Missing type class instance in context.

**Fix strategy:**
1. Add instance: `haveI : Instance := inferInstance`
2. Or: `letI : Instance := ...`
3. Check import: may need `import Mathlib.X.Y`
4. Reorder parameters (instances before regular params)

**Example:**
```diff
+  haveI : MeasurableSpace α := inferInstance
   apply theorem_needing_instance
```

---

## Key Success Factors

### Low Sampling Budgets
- K=1 per attempt (not K=100)
- Strong compiler feedback guides next attempt
- Efficient iteration to success

### Solver-First Strategy
- Many errors solved by automation
- Zero LLM cost for simple cases
- Only escalate to agent when needed

### Multi-Stage Escalation
- Fast model (Haiku) for most cases
- Strong model (Sonnet) only when needed
- Cost-effective repair process

### Early Stopping
- Bail after 3 identical errors
- Prevents runaway costs
- Max 24 attempts total

### Structured Logging
- Every attempt logged to `.repair/attempts.ndjson`
- Track: error hash, stage, solver success, elapsed time
- Learn successful patterns over time

---

## Expected Outcomes

Success improves over time as structured logging enables learning from repair attempts.

**Efficiency benefits:**
- Solver cascade handles many simple cases mechanically (zero LLM cost)
- Multi-stage escalation: fast model first, strong model only when needed
- Early stopping prevents runaway attempts on intractable errors
- Low sampling budget (K=1) with strong compiler feedback

**Cost optimization:**
- Solver cascade: Free (automated tactics)
- Stage 1 (Haiku): Low cost, handles most common cases
- Stage 2 (Sonnet): Higher cost, reserved for complex cases
- Much more cost-effective than blind best-of-N sampling

---

## Tools Reference

**Error parsing:**
```bash
python3 scripts/parseLeanErrors.py errors.txt
```

**Solver cascade:**
```bash
python3 scripts/solverCascade.py context.json FILE.lean
```

**Repair loop orchestrator:**
```bash
scripts/repairLoop.sh FILE.lean [max-attempts] [stage2-threshold]
```

**Slash commands:**
- `/lean4-theorem-proving:repair-file FILE.lean` - Full file repair
- `/lean4-theorem-proving:repair-goal FILE.lean LINE` - Specific goal
- `/lean4-theorem-proving:repair-interactive FILE.lean` - With confirmations

**Mathlib search:**
```bash
bash .claude/tools/lean4/search_mathlib.sh "query" [name|content]
bash .claude/tools/lean4/smart_search.sh "query" --source=all
```

---

## Common Patterns

### Pattern 1: Type Mismatch with convert

**Before:**
```lean
theorem foo (h : Measurable f) : Continuous f := by
  exact h  -- ❌ type mismatch
```

**After:**
```lean
theorem foo (h : Measurable f) : Continuous f := by
  convert continuous_of_measurable h using 2
  simp
```

### Pattern 2: Missing Instance with haveI

**Before:**
```lean
theorem bar : Property := by
  apply lemma  -- ❌ failed to synthesize instance
```

**After:**
```lean
theorem bar : Property := by
  haveI : MeasurableSpace α := inferInstance
  apply lemma
```

### Pattern 3: Unknown Identifier → Import

**Before:**
```lean
theorem baz : Result := by
  exact Continuous.comp  -- ❌ unknown identifier
```

**After:**
```lean
import Mathlib.Topology.Basic

theorem baz : Result := by
  exact Continuous.comp
```

### Pattern 4: Unsolved Goal → Automation

**Before:**
```lean
theorem qux : a + b = b + a := by
  sorry  -- ❌
```

**After:**
```lean
theorem qux : a + b = b + a := by
  ring  -- ✓ (found by solver cascade)
```

---

## Best Practices

### 1. Build After Every Fix (Most Important!)

**Rule:** Build after EVERY 1-2 fixes, not after "a batch of fixes."

**Why:**
- One error at a time is faster than five errors at once
- Immediate feedback prevents cascading errors
- Errors compound—fixing one may introduce another
- Fast iteration loop beats careful batch processing

**Anti-pattern:**
```bash
# ❌ BAD: Make many changes, then build
fix error 1
fix error 2
fix error 3
lake build  # Now you have errors from all three fixes mixing together!
```

**Better pattern:**
```bash
# ✅ GOOD: Build after each fix
fix error 1 && lake build  # See result immediately
fix error 2 && lake build  # Isolate issues
fix error 3 && lake build  # Clean feedback
```

**With LSP (even better):**
```python
# After each edit, immediate verification:
lean_diagnostic_messages(file_path)
lean_goal(file_path, line)
```

### 2. LeanFinder First, Always

Before writing ANY API call:
1. `lean_leanfinder(query="natural language")`
2. `lean_local_search("result")`
3. `lean_hover_info` to check signature
4. THEN write code

**Prevents:** Wrong API names, wrong type signatures, wrong argument order.

### 3. Start with Solver Cascade

Always try automated solvers before LLM. Many cases succeed with zero cost.

### 4. Search Mathlib First

Many proofs already exist. Use search tools before generating novel proofs.

### 5. Minimal Diffs

Change only 1-5 lines. Preserve existing proof structure and style.

### 6. Trust the Loop

Don't overthink individual attempts. The loop will iterate. Fast attempts beat perfect attempts.

### 7. Learn from Logs

Review `.repair/attempts.ndjson` to see what strategies worked. Build intuition over time.

---

## Integration with lean4-memories

Repair attempts can feed into memory system:

**Store successful patterns:**
```
errorType: type_mismatch
goal: Continuous f
solution: convert continuous_of_measurable _ using 2
success: true
```

**Retrieve similar cases:**
```
When I see "Continuous" goal with "Measurable" hypothesis,
try: convert continuous_of_measurable
```

**Learn project-specific patterns:**
Track which error types are common in your codebase and which fixes work best.

---

## Troubleshooting

**Repair loop stuck on same error:**
- Check if error is truly at fault line
- Try `/repair-interactive` to see what's being attempted
- Review `.repair/attempts.ndjson` for patterns
- May need manual intervention

**Agent generates wrong fixes:**
- Stage 1 optimizes for speed → may miss context
- Escalate to Stage 2 for better understanding
- Or use `/repair-interactive` to guide manually

**Solver cascade too aggressive:**
- Some proofs need structure, not automation
- Use `/repair-goal` for focused attention
- Or fix manually and continue

**Cost concerns:**
- Solver cascade is free (use it!)
- Stage 1 (Haiku) very low cost
- Early stopping prevents runaway costs
- Much more cost-effective than blind sampling

---

*Compiler-guided repair inspired by APOLLO (https://arxiv.org/abs/2505.05758)*
*Word count: ~1100*
