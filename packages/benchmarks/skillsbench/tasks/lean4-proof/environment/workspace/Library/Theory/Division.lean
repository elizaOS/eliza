/- Copyright (c) Heather Macbeth, 2022.  All rights reserved. -/
import Mathlib.Data.Int.Basic
import Mathlib.Tactic.LinearCombination
import Mathlib.Tactic.Linarith

-- slightly less concrete form of the division algorithm than mathlib's
theorem Int.existsUnique_quotient_remainder' (a b : ℤ) (h : 0 < b) :
    ∃! r : ℤ, 0 ≤ r ∧ r < b ∧ ∃ q : ℤ, r + b * q = a := by
  suffices ∃! r : ℤ, ∃ q : ℤ, r + b * q = a ∧ 0 ≤ r ∧ r < b by
    convert this
    tauto
  simp_rw [← Int.ediv_emod_unique h]
  aesop

theorem Nat.existsUnique_quotient_remainder' (a b : ℕ) (h : 0 < b) :
    ∃! r : ℕ, r < b ∧ ∃ q : ℕ, r + b * q = a := by
  suffices ∃! r : ℕ, ∃ q : ℕ, r + b * q = a ∧ r < b by
    convert this
    tauto
  simp_rw [← Nat.div_mod_unique h]
  aesop

/-- The division algorithm. -/
theorem Int.existsUnique_quotient_remainder (a b : ℤ) (h : 0 < b) :
    ∃! r : ℤ, 0 ≤ r ∧ r < b ∧ ∃ q : ℤ, a = b * q + r := by
  convert a.existsUnique_quotient_remainder' b h using 1
  funext r
  congr
  funext q
  rw [add_comm]
  exact IsSymmOp.symm_op a (r + b * q)

/-- The division algorithm. -/
theorem Nat.existsUnique_quotient_remainder (a b : ℕ) (h : 0 < b) :
    ∃! r : ℕ, r < b ∧ ∃ q : ℕ, a = b * q + r := by
  convert a.existsUnique_quotient_remainder' b h using 1
  funext r
  congr
  funext q
  rw [add_comm]
  exact IsSymmOp.symm_op a (r + b * q)

/-- The division algorithm, weak form. -/
theorem Int.exists_quotient_remainder (a b : ℤ) (h : 0 < b) :
    ∃ q r : ℤ, 0 ≤ r ∧ r < b ∧ a = b * q + r := by
  obtain ⟨r, ⟨h₁, h₂, q, h₃⟩, -⟩ := Int.existsUnique_quotient_remainder a b h
  exact ⟨q, r, h₁, h₂, h₃⟩

/-- The division algorithm, weak form. -/
theorem Nat.exists_quotient_remainder (a b : ℕ) (h : 0 < b) :
    ∃ q r : ℕ, r < b ∧ a = b * q + r := by
  obtain ⟨r, ⟨h₁, q, h₂⟩, -⟩ := Nat.existsUnique_quotient_remainder a b h
  exact ⟨q, r, h₁, h₂⟩

/-- Criterion for an integer not to divide another. -/
theorem Int.not_dvd_of_exists_lt_and_lt (a b : ℤ)
    (h : ∃ q, b * q < a ∧ a < b * (q + 1)) : ¬b ∣ a := by
  rintro ⟨q₀, rfl⟩
  obtain ⟨q, hq₁, hq₂⟩ := h
  have hb : 0 < b := by linarith
  have h₁ : q + 1 ≤ q₀ := lt_of_mul_lt_mul_left hq₁ hb.le
  have h₂ : q₀ + 1 ≤ q + 1 := lt_of_mul_lt_mul_left hq₂ hb.le
  linarith

/-- Criterion for a natural number not to divide another. -/
theorem Nat.not_dvd_of_exists_lt_and_lt (a b : ℕ)
    (h : ∃ q, b * q < a ∧ a < b * (q + 1)) : ¬b ∣ a := by
  rintro ⟨q₀, rfl⟩
  obtain ⟨q, hq₁, hq₂⟩ := h
  have hb : 0 < b := by linarith
  have h₁ : q + 1 ≤ q₀ := lt_of_mul_lt_mul_left hq₁ hb.le
  have h₂ : q₀ + 1 ≤ q + 1 := lt_of_mul_lt_mul_left hq₂ hb.le
  linarith
