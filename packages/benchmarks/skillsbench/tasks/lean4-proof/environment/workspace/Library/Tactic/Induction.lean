/-
Copyright (c) 2023 Heather Macbeth. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Authors: Heather Macbeth
-/
import Mathlib.Tactic.SolveByElim
import Mathlib.Tactic.Linarith

/-! # Specialized induction tactics

This file introduces macros for several standard induction principles, in forms optimized for
arithmetic proofs (`Nat.zero` and `Nat.succ` are renamed to `0` and `n + 1`, and `push_cast` is
called pre-emptively on all goals).
-/

@[elab_as_elim]
theorem Nat.induction {P : ℕ → Prop} (base_case : P 0)
    (inductive_step : ∀ k, (IH : P k) → P (k + 1)) : (∀ n, P n) :=
  Nat.rec base_case inductive_step

@[elab_as_elim]
def Nat.two_step_induction' {P : ℕ → Sort u} (base_case_0 : P 0) (base_case_1 : P 1)
    (inductive_step : ∀ (k : ℕ), (IH0 : P k) → (IH1 : P (k + 1)) → P (k + 1 + 1)) (a : ℕ) :
    P a :=
  Nat.two_step_induction base_case_0 base_case_1 inductive_step a

@[elab_as_elim]
def Nat.two_step_le_induction {s : ℕ} {P : ∀ (n : ℕ), s ≤ n → Sort u}
    (base_case_0 : P s (le_refl s)) (base_case_1 : P (s + 1) (Nat.le_succ s))
    (inductive_step : ∀ (k : ℕ) (hk : s ≤ k), (IH0 : P k hk) → (IH1 : P (k + 1) (le_step hk))
        → P (k + 1 + 1) (le_step (le_step hk)))
      (a : ℕ) (ha : s ≤ a) :
    P a ha := by
  have key : ∀ m : ℕ, P (s + m) (Nat.le_add_right _ _)
  · intro m
    induction' m using Nat.two_step_induction' with k IH1 IH2
    · exact base_case_0
    · exact base_case_1
    · exact inductive_step _ _ IH1 IH2
  convert key (a - s)
  rw [add_comm, ← Nat.eq_add_of_sub_eq ha]
  rfl

open Lean Parser Category Elab Tactic

open private getElimNameInfo generalizeTargets generalizeVars in evalInduction in
syntax (name := BasicInductionSyntax) "simple_induction " (casesTarget,+) (" with " (colGt binderIdent)+)? : tactic

macro_rules
| `(tactic| simple_induction $tgts,* $[with $withArg*]?) =>
    `(tactic| induction' $tgts,* using Nat.induction $[with $withArg*]? <;>
      push_cast (config := { decide := false }))

open private getElimNameInfo generalizeTargets generalizeVars in evalInduction in
syntax (name := StartingPointInductionSyntax) "induction_from_starting_point " (casesTarget,+) (" with " (colGt binderIdent)+)? : tactic

macro_rules
| `(tactic| induction_from_starting_point $tgts,* $[with $withArg*]?) =>
    `(tactic| induction' $tgts,* using Nat.le_induction $[with $withArg*]? <;>
      push_cast (config := { decide := false }))

open private getElimNameInfo generalizeTargets generalizeVars in evalInduction in
syntax (name := TwoStepInductionSyntax) "two_step_induction " (casesTarget,+) (" with " (colGt binderIdent)+)? : tactic

macro_rules
| `(tactic| two_step_induction $tgts,* $[with $withArg*]?) =>
    `(tactic| induction' $tgts,* using Nat.two_step_induction' $[with $withArg*]? <;>
      push_cast (config := { decide := false }) at *)

open private getElimNameInfo generalizeTargets generalizeVars in evalInduction in
syntax (name := TwoStepStartingPointInductionSyntax) "two_step_induction_from_starting_point " (casesTarget,+) (" with " (colGt binderIdent)+)? : tactic

macro_rules
| `(tactic| two_step_induction_from_starting_point $tgts,* $[with $withArg*]?) =>
    `(tactic| induction' $tgts,* using Nat.two_step_le_induction $[with $withArg*]?)
      -- push_cast (config := { decide := false }) at *)
      -- Hack: only used twice, in cases where `push_cast` causes problems, so omit that step


/-! # Additions to `decreasing_tactic` for well-founded recursion -/

@[default_instance] instance : SizeOf ℤ := ⟨Int.natAbs⟩

@[zify_simps] theorem cast_sizeOf (n : ℤ) : (sizeOf n : ℤ) = |n| := n.coe_natAbs

theorem Int.sizeOf_lt_sizeOf_iff (m n : ℤ) : sizeOf n < sizeOf m ↔ |n| < |m| := by zify

theorem abs_lt_abs_iff {α : Type _} [LinearOrderedAddCommGroup α] (a b : α) :
    |a| < |b| ↔ (-b < a ∧ a < b) ∨ (b < a ∧ a < -b) := by
  simp only [abs, Sup.sup]
  rw [lt_max_iff, max_lt_iff, max_lt_iff]
  apply or_congr
  · rw [and_comm, neg_lt]
  · rw [and_comm, neg_lt_neg_iff]

theorem lem1 (a : ℤ) {b : ℤ} (hb : 0 < b) : abs a < abs b ↔ -b < a ∧ a < b := by
  rw [abs_lt_abs_iff]
  constructor
  · intro h
    obtain ⟨h1, h2⟩ | ⟨h1, h2⟩ := h
    constructor <;> linarith
    constructor <;> linarith
  · intro h
    obtain ⟨h1, h2⟩ := h
    left
    constructor <;> linarith

theorem lem2 (a : ℤ) {b : ℤ} (hb : b < 0) : abs a < abs b ↔ b < a ∧ a < -b := by
  rw [abs_lt_abs_iff]
  constructor
  · intro h
    obtain ⟨h1, h2⟩ | ⟨h1, h2⟩ := h
    constructor <;> linarith
    constructor <;> linarith
  · intro h
    obtain ⟨h1, h2⟩ := h
    right
    constructor <;> linarith

open Lean Meta Elab Mathlib Tactic SolveByElim

register_label_attr decreasing

syntax "apply_decreasing_rules" : tactic

elab_rules : tactic |
    `(tactic| apply_decreasing_rules)  => do
  let cfg : SolveByElim.Config := { backtracking := false }
  liftMetaTactic fun g => solveByElim.processSyntax cfg false false [] [] #[mkIdent `decreasing] [g]

macro_rules
| `(tactic| decreasing_tactic) =>
  `(tactic| simp_wf ;
      simp [Int.sizeOf_lt_sizeOf_iff] ;
      (try rw [lem1 _ (by assumption)]) ;
      (try rw [lem2 _ (by assumption)]) ;
      (try constructor) <;>
      apply_decreasing_rules)

macro_rules
| `(tactic| decreasing_tactic) =>
  `(tactic| simp_wf ;
      simp only [Int.sizeOf_lt_sizeOf_iff, ←sq_lt_sq,  Nat.succ_eq_add_one] ;
      nlinarith)

theorem Int.fmod_nonneg_of_pos (a : ℤ) (hb : 0 < b) : 0 ≤ Int.fmod a b :=
  Int.fmod_eq_emod _ hb.le ▸ emod_nonneg _ hb.ne'
