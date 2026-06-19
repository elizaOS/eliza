/- Copyright (c) Mario Carneiro, 2023. -/
import Mathlib.Init.Data.Int.Order
import Mathlib.Init.Data.Nat.Lemmas

macro "le_or_succ_le" a:term:arg n:num  : term =>
  `(show $a ≤ $n ∨ $(Lean.quote (n.getNat+1)) ≤ $a from le_or_lt ..)
