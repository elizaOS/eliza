/- Copyright (c) Heather Macbeth, 2023.  All rights reserved. -/
import Mathlib.Algebra.GroupPower.Order
import Mathlib.Tactic.Positivity

open Lean

syntax (name := cancelDischarger) "cancel_discharger " : tactic
syntax (name := cancelAux) "cancel_aux " term " at " term : tactic
syntax (name := cancel) "cancel " term " at " term : tactic

macro_rules | `(tactic| cancel_discharger) => `(tactic | positivity)
macro_rules
| `(tactic| cancel_discharger) =>`(tactic | fail "cancel failed, could not verify the following side condition:")

/-! ### powers -/
macro_rules
| `(tactic| cancel_aux $a at $h) =>
  let h := h.raw.getId
  `(tactic | replace $(mkIdent h):ident := lt_of_pow_lt_pow (n := $a) (by cancel_discharger) $(mkIdent h))
macro_rules
| `(tactic| cancel_aux $a at $h) =>
  let h := h.raw.getId
  `(tactic | replace $(mkIdent h):ident := le_of_pow_le_pow (n := $a) (by cancel_discharger) (by cancel_discharger) $(mkIdent h))
macro_rules
| `(tactic| cancel_aux $a at $h) =>
  let h := h.raw.getId
  `(tactic | replace $(mkIdent h):ident := pow_eq_zero (n := $a) $(mkIdent h))


/-! ### multiplication, LHS and RHS -/
macro_rules
| `(tactic| cancel_aux $a at $h) =>
  let h := h.raw.getId
  `(tactic | replace $(mkIdent h):ident := mul_left_cancel₀ (a := $a) (by cancel_discharger) $(mkIdent h))
macro_rules
| `(tactic| cancel_aux $a at $h) =>
  let h := h.raw.getId
  `(tactic | replace $(mkIdent h):ident := mul_right_cancel₀ (b := $a) (by cancel_discharger) $(mkIdent h))
macro_rules
| `(tactic| cancel_aux $a at $h) =>
  let h := h.raw.getId
  `(tactic | replace $(mkIdent h):ident := le_of_mul_le_mul_left (a := $a) $(mkIdent h) (by cancel_discharger))
macro_rules
| `(tactic| cancel_aux $a at $h) =>
  let h := h.raw.getId
  `(tactic | replace $(mkIdent h):ident := le_of_mul_le_mul_right (a := $a) $(mkIdent h) (by cancel_discharger))
macro_rules
| `(tactic| cancel_aux $a at $h) =>
  let h := h.raw.getId
  `(tactic | replace $(mkIdent h):ident := lt_of_mul_lt_mul_left (a := $a) $(mkIdent h) (by cancel_discharger))
macro_rules
| `(tactic| cancel_aux $a at $h) =>
  let h := h.raw.getId
  `(tactic | replace $(mkIdent h):ident := lt_of_mul_lt_mul_right (a := $a) $(mkIdent h) (by cancel_discharger))

/-! ### multiplication, just LHS -/
macro_rules
| `(tactic| cancel_aux $a at $h) =>
  let h := h.raw.getId
  `(tactic | replace $(mkIdent h):ident := pos_of_mul_pos_right (a := $a) $(mkIdent h) (by cancel_discharger))
macro_rules
| `(tactic| cancel_aux $a at $h) =>
  let h := h.raw.getId
  `(tactic | replace $(mkIdent h):ident := pos_of_mul_pos_left (b := $a) $(mkIdent h) (by cancel_discharger))
macro_rules
| `(tactic| cancel_aux $a at $h) =>
  let h := h.raw.getId
  `(tactic | replace $(mkIdent h):ident := nonneg_of_mul_nonneg_right (a := $a) $(mkIdent h) (by cancel_discharger))
macro_rules
| `(tactic| cancel_aux $a at $h) =>
  let h := h.raw.getId
  `(tactic | replace $(mkIdent h):ident := nonneg_of_mul_nonneg_left (b := $a) $(mkIdent h) (by cancel_discharger))

-- TODO to trigger this needs some `guard_hyp` in the `cancel_aux` implementations
elab_rules : tactic
  | `(tactic| cancel $a at $h) => do
  let goals ← Elab.Tactic.getGoals
  let goalsMsg := MessageData.joinSep (goals.map MessageData.ofGoal) m!"\n\n"
  throwError "cancel failed: no '{a}' to cancel\n{goalsMsg}"

-- TODO build in a `try change 1 ≤ _ at h` to upgrade the `0 < _` result in the case of Nat
macro_rules | `(tactic| cancel $a at $h) => `(tactic| cancel_aux $a at $h; try apply $h)
