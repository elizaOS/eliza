# Mathlib Integration Guide

This reference provides comprehensive guidance for finding, importing, and using mathlib lemmas effectively.

## Philosophy: Search Before Prove

**DON'T:** Spend hours proving something mathlib already has
**DO:** Invest time in thorough searching first

Mathlib contains over 100,000 theorems. The probability that your "obvious lemma" is already there is high.

## Quick Reference Workflow

```
1. Understand what you need mathematically
2. Identify keywords and type signature
3. Search using multiple strategies:
   - File organization (ls, find)
   - Keyword search (grep)
   - Naming conventions (grep with patterns)
4. Use Read tool to examine candidate files
5. Verify with #check
6. Import and use
7. If not found, search alternative phrasings
8. If still not found, prove it yourself (and consider contributing!)
```

This search workflow saves hours compared to reproving existing lemmas!

## Finding Existing Lemmas

### In-Editor Search (For Human Users)

**VS Code with Lean extension:**
```
Ctrl+T (Cmd+T on Mac) - Search by symbol name
```

**Note:** This is for human users working in VS Code, not available to AI assistants.

**Tactic-based search:**
```lean
example : goal := by
  exact?  -- Suggests mathlib lemmas that directly prove the goal
  apply?  -- Suggests lemmas that could apply
  rw?     -- Suggests rewrite lemmas
```

### Command-Line Search (For AI Assistants and Power Users)

**Basic file search:**
```bash
# Find files containing specific patterns
find .lake/packages/mathlib -name "*.lean" -exec grep -l "pattern1\|pattern2" {} \; | head -10

# Search with line numbers (for using Read tool)
grep -n "lemma.*keyword" path/to/file.lean | head -15

# Case-insensitive search
grep -in "keyword" path/to/file.lean

# Search for theorem OR lemma definitions
grep -n "theorem\|lemma" path/to/file.lean | grep "keyword"
```

**Example workflow:**
```bash
# Step 1: Identify keywords
# Looking for: "continuous functions preserve compact sets"
# Keywords: continuous, compact, preimage

# Step 2: Find relevant files
find .lake/packages/mathlib -name "*.lean" -exec grep -l "continuous.*compact\|compact.*continuous" {} \; | head -10
# Might return: Mathlib/Topology/Compactness.lean

# Step 3: Use Read tool to examine file
# Read: .lake/packages/mathlib/Mathlib/Topology/Compactness.lean

# Step 4: Search for specific lemmas with line numbers
grep -n "continuous.*isCompact\|isCompact.*continuous" .lake/packages/mathlib/Mathlib/Topology/Compactness.lean

# Step 5: Import and use
import Mathlib.Topology.Compactness
#check Continuous.isCompact_preimage
```

## Search Strategies

### Strategy 1: Keyword-Based

**Use domain keywords:**
```bash
# Measure theory: measure, integrable, measurable, ae (almost everywhere)
find .lake/packages/mathlib -name "*.lean" -exec grep -l "integrable.*measurable" {} \;

# Topology: continuous, compact, open, closed
find .lake/packages/mathlib -name "*.lean" -exec grep -l "continuous.*compact" {} \;

# Algebra: ring, ideal, homomorphism
find .lake/packages/mathlib -name "*.lean" -exec grep -l "ring.*ideal" {} \;
```

**Include alternative spellings:**
```bash
# Sometimes capitalized, sometimes not
grep -i "KEYWORD" file.lean  # Case-insensitive

# Sometimes abbreviated
# "probability measure" might be "probMeasure" or "IsProbabilityMeasure"
grep "prob.*[Mm]easure\|[Mm]easure.*prob" file.lean
```

### Strategy 2: Type-Based

**Search by type signature:**
```bash
# Looking for: (α → β) → (List α → List β)
# Search for "map" in List files
grep -n "map" .lake/packages/mathlib/Mathlib/Data/List/Basic.lean
```

**Use pattern matching:**
```bash
# Find all lemmas about indicators
grep -n "lemma.*indicator" .lake/packages/mathlib/Mathlib/MeasureTheory/Function/Indicator.lean
```

### Strategy 3: Type Signature-Based (Loogle's Killer Feature)

**When to use:** You know what types should go in and out, but don't know the exact name.

**Key insight:** Loogle's type pattern search is extremely powerful - use `?a`, `?b` as type variables to search by function signature.

**Successful patterns:**
```bash
# Find map function on lists: (?a -> ?b) -> List ?a -> List ?b
# Returns: List.map, List.mapIdx, etc.

# Find function composition: (?a -> ?b) -> (?b -> ?c) -> ?a -> ?c
# Returns: Function.comp and related

# Find property transformers: Continuous ?f -> Measurable ?f
# Finds lemmas about continuity implying measurability
```

**Type pattern syntax:**
- `?a`, `?b`, `?c` - Type variables (can match any type)
- `_` - Wildcard for any term
- `->` - Function arrow
- `|-` - Turnstile (for conclusions)

**Examples that work well:**

```bash
# Unknown: What's the function to transform lists?
# Known: Takes (a -> b) and List a, returns List b
lean_loogle "(?a -> ?b) -> List ?a -> List ?b"
# Result: List.map ✅

# Unknown: How to compose measurable functions?
# Known: Two measurable functions compose
lean_loogle "Measurable ?f -> Measurable ?g -> Measurable (?g ∘ ?f)"
# Result: Measurable.comp ✅

# Unknown: What proves probability measures preserve properties?
# Known: Need statement about IsProbabilityMeasure and maps
lean_loogle "IsProbabilityMeasure ?μ -> IsProbabilityMeasure (Measure.map ?f ?μ)"
# Result: Specific pushforward preservation lemmas ✅
```

**Important caveat - Simple name searches often fail:**

```bash
# ❌ These DON'T work well
lean_loogle "Measure.map"          # No results (not a type pattern)
lean_loogle "IsProbabilityMeasure" # No results (searches declarations)

# ✅ Use type patterns instead
lean_loogle "Measure ?X -> (?X -> ?Y) -> Measure ?Y"  # Finds Measure.map
lean_loogle "IsProbabilityMeasure ?μ -> ?property"     # Finds related lemmas
```

**Why simple names fail:** Loogle searches by *type structure*, not text matching. For text/name searches, use `leansearch` instead.

**Decision tree:**

```
Know what you're looking for?
├─ Know exact name? → Use grep or lean_local_search
├─ Know concept/description? → Use leansearch (natural language)
└─ Know input/output types? → Use loogle (type patterns) ✅
```

### Strategy 4: Name Convention-Based (For Grep Search)

Mathlib follows consistent naming conventions - useful for grep, not loogle:

**Implications:** `conclusion_of_hypothesis`
```lean
continuous_of_isOpen_preimage  -- Continuous if all preimages of open sets are open
injective_of_leftInverse       -- Injective if has left inverse
```

**Equivalences:** `property_iff_characterization`
```lean
injective_iff_leftInverse      -- Injective ↔ has left inverse
compact_iff_finite_subcover    -- Compact ↔ finite subcover property
```

**Properties:** `structure_property_property`
```lean
Continuous.isCompact_preimage  -- Continuous functions preserve compactness
Measurable.comp                -- Composition of measurable functions
```

**Combining:** `operation_structure_structure`
```lean
add_comm                       -- Addition is commutative
mul_assoc                      -- Multiplication is associative
integral_add                   -- Integral is additive
```

**Search using these patterns (grep, not loogle):**
```bash
# Looking for: "conditional expectation of sum equals sum of conditional expectations"
# Convention: "condExp_add" or "add_condExp"
grep -n "condExp.*add\|add.*condExp" .lake/packages/mathlib/Mathlib/MeasureTheory/**/*.lean

# Looking for: "measure of union"
# Convention: "measure_union"
grep -n "measure_union" .lake/packages/mathlib/Mathlib/MeasureTheory/**/*.lean
```

### Strategy 5: File Organization-Based

Mathlib is organized hierarchically:

```
Mathlib/
├── Algebra/
│   ├── Ring/          -- Ring theory
│   ├── Group/         -- Group theory
│   └── Field/         -- Field theory
├── Topology/
│   ├── Basic.lean     -- Core definitions
│   ├── Compactness.lean
│   └── MetricSpace/   -- Metric spaces
├── Analysis/
│   ├── Calculus/
│   └── SpecialFunctions/
├── MeasureTheory/
│   ├── Measure/       -- Measures
│   ├── Integral/      -- Integration
│   └── Function/
│       ├── ConditionalExpectation.lean
│       └── Indicator.lean
├── Probability/
│   ├── Independence.lean
│   ├── ProbabilityMassFunction/
│   └── ConditionalProbability.lean
└── Data/
    ├── List/          -- Lists
    ├── Finset/        -- Finite sets
    └── Real/          -- Real numbers
```

**Navigate by topic:**
```bash
# For measure theory lemmas:
ls .lake/packages/mathlib/Mathlib/MeasureTheory/

# For conditional expectation specifically:
ls .lake/packages/mathlib/Mathlib/MeasureTheory/Function/

# Read the file:
Read .lake/packages/mathlib/Mathlib/MeasureTheory/Function/ConditionalExpectation.lean
```

## Pro Tips for Effective Searching

### Tip 1: Use OR Patterns

```bash
# Multiple alternatives
grep "pattern1\|pattern2\|pattern3" file.lean

# Example: Find continuity proofs
grep "continuous.*of\|of.*continuous" file.lean
```

### Tip 2: Limit Results

```bash
# Show only first 10 results
find ... | head -10
grep ... | head -15

# This prevents overwhelming output
```

### Tip 3: Combine Strategies

```bash
# Step 1: Find relevant file (organization-based)
ls .lake/packages/mathlib/Mathlib/Topology/

# Step 2: Search within file (keyword-based)
grep -n "compact" .lake/packages/mathlib/Mathlib/Topology/Compactness.lean

# Step 3: Filter by naming convention
grep -n "compact.*of\|of.*compact" .lake/packages/mathlib/Mathlib/Topology/Compactness.lean
```

### Tip 4: Check Related Files

```bash
# If you find a relevant file, check nearby files
ls -la $(dirname path/to/relevant/file.lean)

# Example:
ls -la .lake/packages/mathlib/Mathlib/MeasureTheory/Function/
# Might reveal: ConditionalExpectation.lean, Indicator.lean, etc.
```

### Tip 5: Use `#check` After Finding

```lean
-- Verify the lemma does what you think
#check Continuous.isCompact_preimage
-- Output shows full type signature

-- Check with all implicit arguments visible
#check @Continuous.isCompact_preimage
-- Shows what you need to provide
```

## Importing Correctly

### Prefer Specific Imports

```lean
-- ✅ Good: Specific imports
import Mathlib.Data.Real.Basic
import Mathlib.Topology.MetricSpace.Basic
import Mathlib.MeasureTheory.Integral.Lebesgue

-- ❌ Bad: Overly broad
import Mathlib  -- Imports everything, slow build
```

### Import Order

```lean
-- 1. Mathlib imports first
import Mathlib.Data.Real.Basic
import Mathlib.Topology.Basic

-- 2. Then your project imports
import MyProject.Utils
import MyProject.Lemmas

-- 3. Tactic imports when needed
import Mathlib.Tactic.Linarith
import Mathlib.Tactic.Ring
```

### Common Imports by Domain

**Analysis:**
```lean
import Mathlib.Analysis.Calculus.Deriv.Basic
import Mathlib.Analysis.SpecialFunctions.Exp
import Mathlib.Topology.MetricSpace.Basic
```

**Measure Theory:**
```lean
import Mathlib.MeasureTheory.Measure.MeasureSpace
import Mathlib.MeasureTheory.Integral.Lebesgue
import Mathlib.MeasureTheory.Function.ConditionalExpectation
```

**Probability:**
```lean
import Mathlib.Probability.ProbabilityMassFunction.Basic
import Mathlib.Probability.Independence
import Mathlib.Probability.ConditionalProbability
```

**Algebra:**
```lean
import Mathlib.Algebra.Ring.Basic
import Mathlib.Algebra.Field.Basic
import Mathlib.RingTheory.Ideal.Basic
```

**Topology:**
```lean
import Mathlib.Topology.Basic
import Mathlib.Topology.Compactness
import Mathlib.Topology.ContinuousFunction.Basic
```

### Missing Tactic Imports

When you see "unknown identifier 'ring'":

```lean
import Mathlib.Tactic.Ring          -- ring, ring_nf
import Mathlib.Tactic.Linarith      -- linarith, nlinarith
import Mathlib.Tactic.FieldSimp     -- field_simp
import Mathlib.Tactic.Continuity    -- continuity
import Mathlib.Tactic.Measurability -- measurability
import Mathlib.Tactic.Positivity    -- positivity
import Mathlib.Tactic.FunProp       -- fun_prop (Lean 4.13+)
```

## Verifying Lemmas Work

### Quick Checks

```lean
-- 1. Check type
#check my_lemma
-- Output: my_lemma : ∀ x, P x → Q x

-- 2. Try to apply
example (h : P x) : Q x := by
  exact my_lemma h

-- 3. Check with all implicit args
#check @my_lemma
-- Shows what needs to be provided
```

### Testing in isolation

```lean
-- Create a test example
example : goal := by
  have h := my_lemma  -- See if it compiles
  sorry

-- If it works here, use in main proof
```

## When Mathlib Doesn't Have It

### Before giving up:

1. **Try alternative phrasings**
   - "continuous preimage compact" → "compact preimage continuous"
   - "integral sum" → "sum integral"

2. **Check if it's a special case**
   - Maybe mathlib has more general version
   - Check class hierarchy: `Continuous` vs `ContinuousOn`

3. **Look for building blocks**
   - Mathlib might have pieces you can combine
   - Example: No direct `condExp_indicator` but has `condExp_const` + `condExp_mul`

4. **Ask on Zulip**
   - Lean Zulip: https://leanprover.zulipchat.com/
   - Channel: #mathlib
   - Format: "Is there a lemma for X?"

### If truly missing:

```lean
-- Clearly mark as needing mathlib
-- TODO: Should be in mathlib, check if there's a PR
lemma my_helper_should_be_in_mathlib : ... := by
  sorry
```

## Naming Your Own Lemmas (Mathlib Style)

Follow conventions for future mathlib contributions:

```lean
-- ✅ Good names
lemma integrable_of_bounded_measurable : ...  -- Conclusion of hypotheses
lemma measure_union_le : ...                  -- Clear action
lemma condExp_add : ...                       -- Operation on structure

-- ❌ Bad names
lemma my_helper_1 : ...                       -- Meaningless
lemma the_thing_I_need : ...                  -- Not descriptive
lemma authors_lemma : ...                      -- Not about content
```
