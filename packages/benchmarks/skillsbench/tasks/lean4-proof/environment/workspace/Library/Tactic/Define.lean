import Mathlib.Data.Set.Basic
import Library.Tactic.Define.Attr

attribute [default_instance] Set.instSingletonSet
attribute [default_instance] Set.instEmptyCollectionSet

@[simp] theorem Set.singleton_def' (a : α) : ({a} : Set α) = {b | b = a} := rfl

attribute [set_simps] ne_eq iff_false false_iff true_iff iff_true
  imp_false true_imp_iff not_false_iff false_imp_iff imp_true_iff
  or_false false_or and_false false_and or_true true_or and_true true_and
  Set.mem_setOf_eq Set.subset_def Set.ext_iff Set.singleton_def' Set.mem_insert_iff
  Set.mem_union Set.mem_inter_iff Set.mem_compl_iff Set.mem_empty_iff_false Set.mem_univ

open Lean.TSyntax.Compat

macro_rules
| `(tactic| dsimp [$t,*] $[$loc:location]?) =>
  `(tactic| simp (config := { decide := false }) only [$t,*, set_simps] $(loc)?)

macro_rules
| `(tactic| dsimp $[$loc:location]?) =>
  `(tactic| simp (config := { decide := false }) only [set_simps] $[$loc]?)

attribute [aesop safe apply] Set.ext
