/- Copyright (c) Heather Macbeth, 2023.  All rights reserved. -/
import Mathlib.Tactic.Choose

open Function

def Inverse (f : X → Y) (g : Y → X) : Prop := g ∘ f = id ∧ f ∘ g = id

theorem bijective_iff_exists_inverse (f : X → Y) :
    Bijective f ↔ ∃ g : Y → X, Inverse f g := by
  constructor
  · rintro ⟨h_inj, h_surj⟩
    choose g hg using h_surj
    refine ⟨g, ?_, funext hg⟩
    funext x
    exact h_inj (hg _)
  · rintro ⟨g, hgf, hfg⟩
    constructor
    · intro x1 x2 hx
      have H : (g ∘ f) x1 = (g ∘ f) x2 := by simp [hx]
      simpa only [hgf] using H
    · intro y
      refine ⟨g y, ?_⟩
      simpa using congr_fun hfg y

theorem surjective_of_intertwining {f : X → ℕ} {x0 : X} (h0 : f x0 = 0) {i : X → X}
    (hi : ∀ x, f (i x) = f x + 1) :
    Function.Surjective f
  | 0 => ⟨x0, h0⟩
  | k + 1 => by
    obtain ⟨x, hx⟩ := surjective_of_intertwining h0 hi k
    refine ⟨i x, ?_⟩
    simp [hi, hx]
