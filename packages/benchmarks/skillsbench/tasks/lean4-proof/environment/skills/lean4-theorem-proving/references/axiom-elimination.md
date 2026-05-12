# Axiom Elimination Reference

Quick reference for systematically eliminating custom axioms from Lean 4 proofs.

## Standard vs Custom Axioms

**Standard mathlib axioms (ACCEPTABLE):**
- `Classical.choice` (axiom of choice)
- `propext` (propositional extensionality)
- `quot.sound` / `Quot.sound` (quotient soundness)

**Custom axioms (MUST ELIMINATE):**
- Any `axiom` declarations in your code
- Dependencies on unproven theorems

## Verification

**Check axiom usage:**
```bash
bash .claude/tools/lean4/check_axioms.sh FILE.lean
```

**For individual theorems:**
```bash
lake env lean --run <<EOF
#print axioms theoremName
EOF
```

## Elimination Workflow

### Phase 1: Audit Current State

1. Run axiom checker on all files
2. List all custom axioms with locations
3. Identify dependencies (which theorems use which axioms)
4. Prioritize by impact (eliminate high-usage axioms first)

### Phase 2: Document Elimination Plan

For each axiom, document:
```lean
axiom helper_theorem : P
-- TODO: Eliminate axiom
-- Strategy: [search pattern OR proof technique]
-- Required lemmas: [mathlib lemmas needed]
-- Difficulty: [easy/medium/hard]
-- Priority: [high/medium/low - based on usage count]
-- Est. time: [time estimate]
```

### Phase 3: Search Mathlib Exhaustively

**60% of axioms already exist as theorems in mathlib!**

**Search by name:**
```bash
bash .claude/tools/lean4/search_mathlib.sh "axiom_name_pattern" name
```

**Search by type/description:**
```bash
bash .claude/tools/lean4/smart_search.sh "property description" --source=leansearch
```

**Search by type pattern:**
```bash
bash .claude/tools/lean4/smart_search.sh "type signature pattern" --source=loogle
```

### Phase 4: Eliminate Axioms

**Five common patterns:**

**Pattern 1: "It's in mathlib" (60%)**
- Search finds existing theorem
- Replace `axiom` with `theorem` and import
- Replace body with `:= mathlib_lemma`

**Pattern 2: "Compositional proof" (30%)**
- Combine 2-3 existing mathlib lemmas
- Prove using standard tactics
- Replace axiom with actual proof

**Pattern 3: "Needs domain expertise" (9%)**
- Break into smaller lemmas
- Prove components using mathlib
- Combine for final result

**Pattern 4: "Actually false" (1%)**
- Original axiom too strong
- Weaken to provable version
- Update dependent theorems

**Pattern 5: "Placeholder for sorry" (common during development)**
- Convert `axiom` to `theorem` with `sorry`
- Fill using sorry-filling workflow
- See sorry-filling.md

## Elimination Strategies by Type

### Simple Lemmas
```lean
-- Before
axiom simple_fact : A → B

-- After (search mathlib)
import Mathlib.Data.Foo
theorem simple_fact : A → B := mathlib_existing_lemma
```

### Compositional Proofs
```lean
-- Before
axiom complex_fact : Big_Statement

-- After (prove from components)
theorem complex_fact : Big_Statement := by
  have h1 := mathlib_lemma_1
  have h2 := mathlib_lemma_2
  exact combine h1 h2
```

### Structural Refactors
```lean
-- Before
axiom infrastructure : Property

-- After (add structure)
-- 1. Introduce helper lemmas
private lemma helper1 : SubProperty := by ...
private lemma helper2 : AnotherSubProperty := by ...

-- 2. Combine for main result
theorem infrastructure : Property := by
  apply helper1
  exact helper2
```

## Handling Dependencies

**If axiom A depends on axiom B:**
1. Eliminate B first (bottom-up approach)
2. Document dependency chain
3. Verify elimination doesn't break A
4. Then eliminate A

**Dependency tracking:**
```bash
# Find what uses an axiom
bash .claude/tools/lean4/find_usages.sh axiom_name
```

## Progress Tracking

After each elimination:
```bash
# Verify axiom count decreased
bash .claude/tools/lean4/check_axioms.sh FILE.lean

# Compare before/after
echo "Before: N custom axioms"
echo "After: M custom axioms"
echo "Eliminated: $((N - M))"
```

**Expected elimination rate:**
- Easy axioms: 2-3 per hour
- Medium axioms: 1-2 per day
- Hard axioms: 2-5 days each

## Migration Plan Template

**For large axiom elimination work:**

```markdown
## Axiom Elimination Plan

Total custom axioms: N
Target: 0 custom axioms

### Phase 1: Low-hanging fruit (Est: X days)
- [ ] axiom_1 (type: mathlib_search)
- [ ] axiom_2 (type: simple_composition)
- [ ] axiom_3 (type: mathlib_search)

### Phase 2: Medium difficulty (Est: Y days)
- [ ] axiom_4 (type: structural_refactor)
- [ ] axiom_5 (type: domain_expertise)

### Phase 3: Hard cases (Est: Z days)
- [ ] axiom_6 (type: needs_deep_refactor)

Estimated total: X+Y+Z days
```

## Common Pitfalls

❌ **Don't:**
- Add new axioms while eliminating old ones
- Skip mathlib search (60% hit rate!)
- Eliminate without testing dependents
- Give up after first search failure
- Use stronger axiom to replace weaker one

✅ **Do:**
- Search thoroughly (multiple strategies)
- Test with `lake build` after each elimination
- Track progress (axiom count trending down)
- Document hard cases for future work
- Prove shims for backward compatibility

## When to Keep Axioms

**Rare acceptable cases (WITH user approval):**
1. Foundational axioms for new domain (e.g., new mathematical structure)
2. Interface with external systems (FFI, oracles)
3. Temporary scaffolding with CLEAR timeline

**Requires:**
- Explicit user approval
- Documented elimination plan
- Timeline for removal
- Not acceptable for mathlib contributions

## Integration with Subagents

**lean4-axiom-eliminator agent can:**
- Search mathlib exhaustively for each axiom
- Try multiple proof strategies
- Generate elimination patches
- Track progress across batch

**Use for:**
- Projects with 10+ axioms
- Systematic cleanup work
- When you need to focus on other tasks

**Keep human for:**
- Novel mathematical insights
- Design decisions
- Hard cases needing creativity

## Output Expectations

**Sonnet agents with thinking enabled:**
- Outline plan FIRST (bullet points)
- Show search results
- Propose elimination strategy
- Apply in small batches
- Report progress after each batch
- Total output: ~2000-3000 tokens per axiom
