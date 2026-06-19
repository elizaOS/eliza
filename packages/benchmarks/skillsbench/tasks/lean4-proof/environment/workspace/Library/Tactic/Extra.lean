/- Copyright (c) Heather Macbeth, 2023.  All rights reserved. -/
import Library.Theory.ModEq.Lemmas
import Library.Tactic.Extra.Attr
import Mathlib.Tactic.Positivity

/- # `extra` tactic

A tactic which proves goals such as
`example (m n : ℝ) (hn : 10 ≤ n) : m + 68 * n ^ 2 ≥ m`

-/

-- See https://leanprover.zulipchat.com/#narrow/stream/270676-lean4/topic/hygiene.20question.3F/near/313556764
set_option hygiene false in
/-- A thin wrapper for `aesop`, which adds the `extra` rule set. -/
macro (name := extra) "extra" : tactic =>
  `(tactic
    | first
    | focus (aesop (rule_sets [extra, -default]) (simp_options := { enabled := false }); done)
    | fail "out of scope: extra proves relations between a LHS and a RHS differing by some neutral quantity for the relation")

lemma IneqExtra.neg_le_sub_self_of_nonneg [LinearOrderedAddCommGroup G] {a b : G} (h : 0 ≤ a) :
    -b ≤ a - b := by
  rw [sub_eq_add_neg]
  apply le_add_of_nonneg_left h

attribute [aesop safe (rule_sets [extra]) apply]
  le_add_of_nonneg_right le_add_of_nonneg_left
  lt_add_of_pos_right lt_add_of_pos_left
  IneqExtra.neg_le_sub_self_of_nonneg
  add_le_add_left add_le_add_right add_lt_add_left add_lt_add_right
  sub_le_sub_left sub_le_sub_right sub_lt_sub_left sub_lt_sub_right
  le_refl

attribute [aesop safe (rule_sets [extra]) apply]
  Int.modEq_fac_zero Int.modEq_fac_zero' Int.modEq_zero_fac Int.modEq_zero_fac'
  Int.modEq_add_fac_self Int.modEq_add_fac_self' Int.modEq_add_fac_self'' Int.modEq_add_fac_self'''
  Int.modEq_sub_fac_self Int.modEq_sub_fac_self' Int.modEq_sub_fac_self'' Int.modEq_sub_fac_self'''
  Int.modEq_add_fac_self_symm Int.modEq_add_fac_self_symm' Int.modEq_add_fac_self_symm'' Int.modEq_add_fac_self_symm'''
  Int.modEq_sub_fac_self_symm Int.modEq_sub_fac_self_symm' Int.modEq_sub_fac_self_symm'' Int.modEq_sub_fac_self_symm'''
  Int.ModEq.add_right Int.ModEq.add_left
  Int.ModEq.sub_right Int.ModEq.sub_left
  Int.ModEq.refl

def extra.Positivity : Lean.Elab.Tactic.TacticM Unit :=
Lean.Elab.Tactic.liftMetaTactic fun g => do Mathlib.Meta.Positivity.positivity g; pure []

attribute [aesop safe (rule_sets [extra]) tactic] extra.Positivity
