# Lean 4 Phrasebook: Mathematical English to Lean

This guide translates common mathematical proof phrases into their Lean 4 equivalents, helping you think in natural mathematical language while writing formal proofs.

**Inspiration:** This phrasebook is inspired by [Terence Tao's Lean Phrasebook](https://docs.google.com/spreadsheets/d/1Gsn5al4hlpNc_xKoXdU6XGmMyLiX4q-LFesFVsMlANo/edit?pli=1&gid=0#gid=0), reorganized by proof pattern with additional context and explanations.

**Validation:** Patterns in this guide are based on Tao's phrasebook (which was created for Lean 4) and follow current Lean 4 syntax. While most patterns should work with modern mathlib, specific lemma names may evolve. When in doubt, use `exact?` or `apply?` to find current mathlib lemmas.

---

## Quick Reference by Situation

### You want to...

- **Introduce assumptions**: `intro`, `rintro`, `by_cases`
- **Use hypothesis**: `exact`, `apply`, `rw`, `simp [h]`
- **Split goal**: `constructor`, `refine ⟨?_, ?_⟩`, `left`/`right`
- **Split hypothesis**: `rcases`, `obtain`, `cases`
- **Add intermediate fact**: `have`, `obtain`
- **Change perspective**: `suffices`, `convert`, `change`
- **Prove by contradiction**: `by_contra`, `contrapose!`
- **Chain equalities**: `calc`, `rw [h₁, h₂]`
- **Simplify**: `simp`, `ring`, `field_simp`, `norm_num`
- **Explore options**: `exact?`, `apply?`, `simp?`
- **Manage goals**: `swap`, `rotate`, `all_goals`

**See also:** [tactics-reference.md](tactics-reference.md) for comprehensive tactic documentation.

---

## Table of Contents

- [Forward Reasoning](#forward-reasoning)
- [Backward Reasoning](#backward-reasoning)
- [Case Analysis](#case-analysis)
- [Rewriting and Simplification](#rewriting-and-simplification)
- [Equational Reasoning](#equational-reasoning)
- [Working with Quantifiers](#working-with-quantifiers)
- [Working with Connectives](#working-with-connectives)
- [Contradiction and Contrapositive](#contradiction-and-contrapositive)
- [Inequalities and Ordering](#inequalities-and-ordering)
- [Set Theory](#set-theory)
- [Extensionality](#extensionality)
- [Algebraic Reasoning](#algebraic-reasoning)
- [Goal Management](#goal-management)
- [Advanced Patterns](#advanced-patterns)

---

## Forward Reasoning

Building up facts from what you know.

### Stating Intermediate Claims

**"Observe that A holds because of reason r"**
```lean
have h : A := by r
```
- Can omit `h` - result becomes `this` by default
- If `r` is one-liner: `have h : A := r`

**"We claim that A holds. [proof]"**
```lean
have h : A := by
  <proof of A>
```

**"Observe that X equals Y by definition"**
```lean
have : X = Y := rfl
```
- Alternative: `have : X = Y := by rfl`

**"From hypothesis h, applying f gives us B"**
```lean
have hB : B := f h
```

### Using Hypotheses

**"The claim follows from hypothesis h"**
```lean
assumption
-- or: exact h
```

**"This follows by definition"**
```lean
rfl
```

**"This follows from reason r"**
```lean
exact r
-- Explore: exact?
```

### Replacing Hypotheses

**"By f, we replace hypothesis A with B"**
```lean
replace h := f h
```

**"We replace hypothesis A with B using this argument"**
```lean
replace h : B := by <proof>
```

### Discarding Hypotheses

**"Hypothesis h is no longer needed"**
```lean
clear h
```

**"We only need hypotheses A and B going forward"**
```lean
clear_except hA hB
```

---

## Backward Reasoning

Working from the goal backwards.

### Reducing the Goal

**"By A, it suffices to show..."**
```lean
apply A
```

**"It suffices to show B [proof of B], then we get our goal [proof using B]"**
```lean
suffices h : B by
  <proof of goal using h>
<proof of B>
```
- Alternative: `have h : A; swap` to prove A later

**"Suppose P holds [arguments]. In summary, P implies Q."**
```lean
have hPQ (hP : P) : Q := by
  <arguments reaching conclusion>
  exact hQ
```
- Use `?Q` if you want Lean to infer the conclusion type

**"Later we'll prove A. Assuming it for now..."**
```lean
suffices h : A from
  <proof assuming h>
<proof of A>
```

**"We conjecture that A holds"**
```lean
theorem A_conj : A := by sorry
-- Inside proofs: have h : A := by sorry
```

### Converting Goals

**"We reduce to showing B [proof it suffices], now show B [proof of B]"**
```lean
suffices B by
  <proof original goal given B>
<proof of B>
```
- If B is very close to goal, try `convert` tactic
- If B is definitionally equal, use `change`

**"We need to show A'"**
```lean
show A'
```
- Finds matching goal among multiple goals
- Moves it to front of goal queue

**"By definition, the goal rewrites as A'"**
```lean
change A'
```
- Also works for hypotheses: `change A' at h`

---

## Case Analysis

Breaking proofs into separate cases.

### Disjunction (Or)

**"Hypothesis h says A or B. We split into cases."**
```lean
rcases h with hA | hB
<proof using hA>
<proof using hB>
```

**"It suffices to prove A [to get A ∨ B]"**
```lean
left    -- or: Or.inl
```

**"It suffices to prove B [to get A ∨ B]"**
```lean
right   -- or: Or.inr
```

### Boolean Dichotomy

**"We split into cases depending on whether A holds."**
```lean
by_cases h : A
<proof assuming h : A>
<proof assuming h : ¬A>
```
- Alternative using law of excluded middle:
```lean
rcases em A with hA | hnA
```

### Inductive Types

**"We split cases on natural number n: base case n=0, step case n=m+1."**
```lean
rcases n with _ | m
<proof for n = 0>
<proof for n = m+1, with m available>
```
- Works for any inductive type

**"We perform induction on n."**
```lean
induction' n with n ih
<proof of base case>
<proof of inductive step, with ih : P n available>
```

### Pattern Matching

**"We divide into cases n=0, n=1, and n≥2."**
```lean
match n with
| 0 => <proof for 0>
| 1 => <proof for 1>
| n+2 => <proof for n+2>
```

---

## Rewriting and Simplification

Transforming expressions using equalities.

### Basic Rewriting

**"We rewrite the goal using hypothesis h"**
```lean
rw [h]
```
- Reverse direction: `rw [← h]`
- Multiple rewrites: `rw [h₁, h₂, h₃]`
- Close proof if rewrite produces assumption: `rwa [h]`

**"We rewrite using A (which holds by r)"**
```lean
rw [show A by r]
-- Alternative: rw [(by r : A)]
```

**"We replace X by Y, using proof r that they're equal"**
```lean
rw [show X = Y by r]
```

**"Applying f to both sides of h : X = Y"**
```lean
apply_fun f at h    -- produces h : f X = f Y
```
- Alternative: `replace h := congr_arg f h`
- Alternative: `replace h := by congrm (f $h)`
- For adding 1 to both sides: `congrm (1 + $h)`

**"We need associativity before rewriting"**
```lean
assoc_rw [h]
```

**"Rewrite at position n only"**
```lean
nth_rewrite n [h]
```

### Simplification

**"We simplify using hypothesis h"**
```lean
simp [h]
```
- Multiple simplifications: `simp [h₁, h₂, ...]`
- More targeted: `simp only [hypotheses]`
- Explore options: `simp?`
- Simplify to assumption: `simpa`

**"We simplify hypothesis A"**
```lean
simp at h
```
- Works with `[hypotheses]`, `simp only`, etc.
- Can use wildcard: `simp at *`

**"By definition, this rewrites as"**
```lean
dsimp
```
- More restrictive than `simp` - only definitional equalities

**"Expanding all definitions"**
```lean
unfold
```
- For specific definition: `unfold foo`
- Also works on hypotheses: `unfold at h`
- Only definitional: `dunfold`

### Field Operations

**"In a field, we simplify by clearing denominators"**
```lean
field_simp [hypotheses]
```
- Often followed by `ring`
- Automatically finds non-zero denominators or creates goals
- Works on hypotheses: `field_simp [hypotheses] at h`

---

## Equational Reasoning

Chains of equalities and inequalities.

### Calculation Chains

**"We compute: x = y (by r₁), = z (by r₂), = w (by r₃)"**
```lean
calc x = y := by r₁
   _ = z := by r₂
   _ = w := by r₃
```
- Also handles chained inequalities: `≤`, `<`, etc.
- `gcongr` is useful for inequality steps

**"We rewrite using the algebraic identity (proven inline)"**
```lean
rw [show ∀ x : ℝ, ∀ y : ℝ, (x+y)*(x-y) = x*x - y*y by intros; ring]
```

---

## Working with Quantifiers

Universal and existential quantification.

### Universal Introduction

**"Assume A implies B. Thus suppose A holds."**
```lean
intro hA
```
- Can omit name - becomes `this`
- For complex patterns: `rintro` with pattern matching

**"Let x be an element of X."**
```lean
intro x hx    -- for goal: ∀ x ∈ X, P x
```

### Universal Elimination

**"Since a ∈ X and ∀ x ∈ X, P(x) holds, we have P(a)"**
```lean
have hPa := h a ha
```
- Can use `h a ha` directly anywhere instead of naming it
- Can also use `specialize h a ha` (but this replaces h)

### Existential Introduction

**"We take x to equal a [to prove ∃ x, P x]"**
```lean
use a
```

### Existential Elimination

**"By hypothesis, there exists x satisfying A(x)"**
```lean
rcases h with ⟨x, hAx⟩
-- Alternative: obtain ⟨x, hAx⟩ := h
```

**"From nonempty set A, we arbitrarily select element x"**
```lean
obtain ⟨x⟩ := h    -- where h : Nonempty A
```

**"Using choice, we select a canonical element from A"**
```lean
let x := h.some          -- where h : Nonempty A
-- Alternatives: x := h.arbitrary
--               x := Classical.choice h
```

---

## Working with Connectives

Conjunction, disjunction, and equivalence.

### Conjunction (And)

**"To prove A ∧ B, we prove each in turn."**
```lean
constructor
<proof of A>
<proof of B>
```
- For more than two: `refine ⟨?_, ?_, ?_, ?_⟩`

**"By hypothesis h : A ∧ B, we have both A and B"**
```lean
rcases h with ⟨hA, hB⟩
-- Alternative: obtain ⟨hA, hB⟩ := h
```
- Can also use projections: `h.1` and `h.2`
- Multiple conjuncts: `obtain ⟨hA, hB, hC, hD⟩ := h`

**"An intro followed by rcases can be merged"**
```lean
rintro ⟨hA, hB⟩    -- instead of: intro h; rcases h with ⟨hA, hB⟩
```

### Equivalence (Iff)

**"To prove A ↔ B, we prove both directions."**
```lean
constructor
<proof of A → B>
<proof of B → A>
```

---

## Contradiction and Contrapositive

Proof by contradiction and contrapositive.

### Contradiction

**"We seek a contradiction"**
```lean
exfalso
```

**"But this is absurd [given h : A and nh : ¬A]"**
```lean
absurd h nh
```
- Can derive A or ¬A directly using `show A by r` to save steps

**"Given A and ¬A, this gives the required contradiction"**
```lean
contradiction
```

**"Suppose for contradiction that A fails [to prove A]"**
```lean
by_contra nh
```

**"Suppose for contradiction that A holds [to prove ¬A]"**
```lean
intro hA
```

**"Suppose Y < X [to prove X ≤ Y by contradiction]"**
```lean
by_contra h
simp at h
```

### Contrapositive

**"Taking contrapositives, it suffices to show ¬A implies ¬B"**
```lean
contrapose! h    -- where h : B, goal is A
-- Result: h : ¬A, goal is ¬B
```

---

## Inequalities and Ordering

Working with partial orders and inequalities.

### Basic Transitions

**"Given h : X ≤ Z, to prove X ≤ Y it suffices to show Z ≤ Y"**
```lean
apply h.trans
-- Alternative: apply le_trans h
```

**"Given h : X ≤ Z, to prove X < Y it suffices to show Z < Y"**
```lean
apply h.trans_lt
```

**"Given h : Z ≤ Y, to prove X ≤ Y it suffices to show X ≤ Z"**
```lean
apply le_trans _ h
```

**"Given h : X ≤ X' and h' : Y' ≤ Y, to prove X ≤ Y suffices to show X' ≤ Y'"**
```lean
apply le_trans _ (le_trans h _)
```

### Rewrites with Inequalities

**"Given h : X = Z, to prove X ≤ Y suffices to show Z ≤ Y"**
```lean
rw [h]
```

**"Given h : Z = Y, to prove X ≤ Y suffices to show X ≤ Z"**
```lean
rw [← h]
```

### Antisymmetry

**"To prove x = y, show x ≤ y and y ≤ x"**
```lean
apply le_antisymm
```

### Order Isomorphisms

**"To prove X ≤ Y, suffices to show f(X) ≤ f(Y) where f is order iso"**
```lean
apply_fun f
```

### Algebraic Manipulations

**"To prove X ≤ Y, suffices to show X + Z ≤ Y + Z"**
```lean
rw [← add_le_add_right]
```
- Many variants: `add_le_add_left`, `sub_le_sub_right`, etc.

**"To prove X ≤ Y, suffices to show X·Z ≤ Y·Z (with Z > 0)"**
```lean
apply mul_le_mul_right
```

### Congruence for Inequalities

**"To prove x + y ≤ x' + y', show x ≤ x' and y ≤ y'"**
```lean
gcongr
```
- Works well with `calc` blocks
- For sums/products with indices: `gcongr with i hi`

**"Given h : X' ≤ Y', to prove X ≤ Y show X = X' and Y = Y'"**
```lean
convert h using 1
```
- Works for many relations beyond `≤`
- Can adjust conversion depth: `using 2`, etc.

### Positivity

**"This expression is clearly positive from hypotheses"**
```lean
positivity
```
- Works for goals: `x > 0` or `x ≥ 0`

---

## Set Theory

Working with sets, subsets, and set operations.

### Subset Proofs

**"To prove X ⊆ Y: let x ∈ X, show x ∈ Y"**
```lean
intro x hx
```

**"To prove X = Y: show X ⊆ Y and Y ⊆ X"**
```lean
apply Set.Subset.antisymm
```

### Set Operations

**"x ∈ X ∪ Y means x ∈ X or x ∈ Y"**
```lean
-- Intro: left (or right)
-- Elim: rcases h with hX | hY
rintro hX | hY
```

**"x ∈ X ∩ Y means x ∈ X and x ∈ Y"**
```lean
rintro ⟨hX, hY⟩
```

## Extensionality

Proving equality by extensionality.

### Function Extensionality

**"To prove f = g, show f(x) = g(x) for all x"**
```lean
ext x
```

### Set Extensionality

**"To prove S = T, show x ∈ S ↔ x ∈ T for all x"**
```lean
ext x
```

### Congruence

**"Given f(x) = f(y), to prove goal it suffices to show x = y"**
```lean
congr
```
- Sometimes `congr!` works better
- Control depth: `congr 1`, `congr 2`, etc.
- More precise: `congrm`

**"To prove Finset.sum X f = Finset.sum X g, show f(x) = g(x) for all x ∈ X"**
```lean
apply Finset.sum_congr rfl
```
- If summing over different sets Y: replace `rfl` with proof X = Y

---

## Algebraic Reasoning

Automatic tactics for algebra.

### Ring Theory

**"This follows from ring axioms"**
```lean
ring
```

**"This follows from the laws of linear inequalities"**
```lean
linarith
```

### Logical Tautologies

**"This follows by logical tautology"**
```lean
tauto
```

### Numerical Verification

**"Which can be verified numerically"**
```lean
norm_num
```

### Type Casting

**"Expression is the same whether x is viewed as ℕ or ℝ"**
```lean
norm_cast
```

### Rearranging Terms

**"Move all a terms left, all b terms right"**
```lean
move_add [← a, b]
```
- For products: `move_mul [← a, b]`

---

## Goal Management

Managing multiple goals and proof structure.

### Goal Manipulation

**"We prove the latter goal first"**
```lean
swap
```
- Also: `swap n`, `rotate`, `rotate n`

**"We establish all these goals by the same argument"**
```lean
all_goals { <tactics> }
```
- Use `try { <tactics> }` for goals where some might fail
- Drop braces for single tactic: `all_goals tactic`

### Negation Manipulation

**"Pushing negation through quantifiers"**
```lean
push_neg
```

### Symmetry

**"To prove X = Y, we rewrite as Y = X"**
```lean
symm
```

---

## Advanced Patterns

More sophisticated proof techniques.

### Without Loss of Generality

**"Without loss of generality, assume P"**
```lean
wlog h : P
<proof assuming ¬P and that goal holds given P>
<proof assuming P>
```
- Can generalize variables: `wlog h : P generalizing ...`

### Abbreviations and Definitions

**"Let X denote the quantity Y"**
```lean
let X := Y
```

**"We abbreviate expression Y as X"**
```lean
set X := Y
```
- Actively replaces all Y with X
- Track equality: `set X := Y with h` gives `h : X = Y`
- Make X independent variable: `generalize : Y = X` or `generalize h : Y = X`

### Automation Tactics

**"One is tempted to try..."**
```lean
apply?
```

**"To conclude, one could try"**
```lean
exact?
```

### Filter Reasoning

**"For ∀ᶠ x in f, Q x given ∀ᶠ x in f, P x: show Q x when P x holds"**
```lean
filter_upwards [h]
```
- Can combine multiple filter hypotheses: `filter_upwards [h, h']`

### Conditional Expressions

**"For goal involving (if A then x else y), split cases"**
```lean
split
<proof if A is true>
<proof if A is false>
```

---

## Proof Architecture Patterns

Organizing complex proofs.

### Delayed Proofs

**"We claim A [use it], later we prove A"**
```lean
have h : A
swap
<use h>
<prove h>
```

### Proof Summaries

**"We perform the following argument [details]. In summary, P holds."**
```lean
have hP : ?P := by
  -- (arguments reaching conclusion)
  exact hP
```

**"Let n be a natural number [arguments]. In summary, P(n) holds for all n."**
```lean
have hP (n : ℕ) : ?P := by
  -- (arguments using n)
  exact hP
```

---

## See Also

- [tactics-reference.md](tactics-reference.md) - Comprehensive tactic documentation
- [domain-patterns.md](domain-patterns.md) - Domain-specific proof patterns
- [mathlib-guide.md](mathlib-guide.md) - Finding and using mathlib lemmas

---

**Attribution:** This phrasebook is inspired by and based on patterns from [Terence Tao's Lean Phrasebook](https://docs.google.com/spreadsheets/d/1Gsn5al4hlpNc_xKoXdU6XGmMyLiX4q-LFesFVsMlANo/edit?pli=1&gid=0#gid=0), reorganized thematically with additional explanations and context.
