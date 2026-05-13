/-
Copyright (c) 2023 Heather Macbeth. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Authors: Heather Macbeth
-/
import Mathlib.Tactic.Abel
import Mathlib.Tactic.Linarith
import Mathlib.Tactic.NormNum

/-! # Addarith tactic

The tactic `addarith` proves certain linear (in)equality goals over a commutative linear ordered
ring, by combining a specified set of linear (in)equality hypotheses.

This tactic is a deliberately weakened version of the Mathlib tactic `linarith`.
-/

open Lean Elab Tactic
open Parser Tactic Syntax

syntax (name := addarith) "addarith" (" [" term,* "]")? : tactic

open Elab.Tactic Parser.Tactic
open Mathlib Tactic Abel

def addarithDischarger : TacticM Unit := do
  try evalTactic (← `(tactic| simp (config := { decide := false }) only [one_mul, neg_mul])) catch _ => pure ()
  abelNFTarget {}
  try evalTactic (← `(tactic| push_cast (config := { decide := false }) [zsmul_eq_mul])) catch _ => pure ()
  try evalTactic (← `(tactic| norm_num1)) catch _ => pure ()

/--
`addarith` attempts to use specified linear (in)equality hypotheses to prove a linear (in)equality
goal.  It can add and subtract terms from both sides of hypotheses, add them together or subtract
them, and compare numerals.  It cannot rescale hypotheses (i.e., multiply through by a factor).

An example:
```lean
example {a b : ℤ} (h : a = 10 - b) : a + b ≤ 12 := by addarith [h]
```
-/
elab_rules : tactic | `(tactic| addarith $[[$args,*]]?) => withMainContext do
  (liftMetaFinishingTactic <|
    Linarith.linarith true
      (← ((args.map (TSepArray.getElems)).getD {}).mapM (elabTerm ·.raw none)).toList
      { discharger := addarithDischarger })
  <|> throwError "addarith failed to prove this"

-- while we're at it, this turns off the succeed-with-noise behaviour of `ring_nf` with `ring`
macro_rules | `(tactic| ring) => `(tactic| ring_nf)
