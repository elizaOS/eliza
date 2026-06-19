/-
Copyright (c) 2023 Heather Macbeth. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Authors: Heather Macbeth
-/
import Library.Tactic.Rel.Attr
import Mathlib.Tactic.SolveByElim
import Mathlib.Tactic.GCongr.Core

/-! # Extension to the `rel` tactic for the relation `↔`

The Mathlib `rel` and `gcongr` tactics don't work for the relation `↔` because the congruence lemmas
for `∃`, `∀` and `→` can't be tagged `@[gcongr]`.  (It is possible to write a suitable variant for
`∃` but apparently not for the others.)  So this is a quick-and-dirty implementation in that
setting.
-/


open Lean Elab Tactic
open Mathlib Tactic

syntax (name := IffRelSyntax) "iff_rel" " [" term,* "] " : tactic

elab_rules : tactic | `(tactic| iff_rel [$t,*]) => do
  liftMetaTactic <| fun g =>
    let cfg : SolveByElim.Config := { backtracking := false, maxDepth := 50 }
    SolveByElim.solveByElim.processSyntax
      cfg true false t.getElems.toList [] #[mkIdent `iff_rules] [g]

-- not sure where to hang error message
-- | throwError  "cannot prove this by 'substituting' the listed relationships"

macro_rules | `(tactic| rel [$t,*]) => `(tactic| (repeat (intros; iff_rel [$t,*])); done)

attribute [iff_rules]
  Iff.refl
  not_congr
  and_congr_left and_congr_right and_congr
  or_congr_left or_congr_right or_congr
  imp_congr
  iff_congr
  exists_congr forall_congr'
