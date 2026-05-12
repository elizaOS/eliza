/- Copyright (c) Heather Macbeth, 2023.  All rights reserved. -/

/-! # `inductive_type` tactic

A tactic which proves equality and disequality statements in a finite type.
-/
syntax (name := FiniteInductiveType) "inductive_type" : tactic

macro_rules
  | `(tactic| inductive_type) =>
    `(tactic
      | first
      | exact fun h => nomatch h
      | exact rfl
      | fail "out of scope: inductive_type proves (correct) equalities and disequalities in a finite inductive type")
