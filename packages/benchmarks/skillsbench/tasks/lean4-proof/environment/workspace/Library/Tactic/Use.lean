/-
Copyright (c) 2023 Heather Macbeth. All rights reserved. -/
import Mathlib.Tactic.Use

/-!
In this file we redefine the mathlib `use` tactic so that it does not attempt to
resolve the goals produced by `rfl` (at the "reducible" level).  (That is, we
redefine it to have the behaviour of the mathlib `existsi` tactic.)  We do this
because of a feature/bug in Lean core whereby all equalities of concrete natural
numbers are reducibly defeq. (See https://github.com/leanprover/lean4/issues/1994.)
-/

macro_rules | `(tactic| use $es,*) => `(tactic|refine ⟨$es,*, ?_⟩)
