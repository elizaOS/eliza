/- Copyright (c) Heather Macbeth, 2022.  All rights reserved. -/
import Mathlib.Tactic.IntervalCases
import Library.Theory.Division

def Int.Even (n : ℤ) : Prop :=
  ∃ k, n = 2 * k

def Int.Odd (n : ℤ) : Prop :=
  ∃ k, n = 2 * k + 1

theorem Int.even_or_odd (n : ℤ) : Int.Even n ∨ Int.Odd n := by
  obtain ⟨q, r, h, h', hn⟩ := n.exists_quotient_remainder 2 (by norm_num1)
  refine' exists_or.mp ⟨q, _⟩
  interval_cases r <;> simp [hn]

theorem Int.odd_iff_not_even (n : ℤ) : Odd n ↔ ¬ Even n := by
  constructor
  · intro ⟨k, hk⟩ ⟨l, hl⟩
    have : (2:ℤ) ∣ 1 := ⟨l - k, by linear_combination hl - hk⟩
    have : ¬ ((2:ℤ) ∣ 1) := by decide
    contradiction
  · intro h
    obtain h1 | h2 := Int.even_or_odd n
    · contradiction
    · apply h2

theorem Int.even_iff_not_odd (n : ℤ) : Even n ↔ ¬ Odd n := by
  constructor
  · intro ⟨k, hk⟩ ⟨l, hl⟩
    have : (2:ℤ) ∣ 1 := ⟨k - l, by linear_combination hk - hl⟩
    have : ¬ ((2:ℤ) ∣ 1) := by decide
    contradiction
  · intro h
    obtain h1 | h2 := Int.even_or_odd n
    · apply h1
    · contradiction

def Nat.Even (n : ℕ) : Prop :=
  ∃ k, n = 2 * k

def Nat.Odd (n : ℕ) : Prop :=
  ∃ k, n = 2 * k + 1

theorem Nat.even_or_odd (n : ℕ) : Nat.Even n ∨ Nat.Odd n := by
  obtain ⟨q, r, h, hn⟩ := n.exists_quotient_remainder 2 (by norm_num1)
  refine' exists_or.mp ⟨q, _⟩
  interval_cases r <;> simp [hn]

theorem Nat.odd_iff_not_even (n : ℕ) : Odd n ↔ ¬ Even n := by
  constructor
  · intro ⟨k, hk⟩ ⟨l, hl⟩
    zify at hk hl
    have : (2:ℤ) ∣ 1 := ⟨l - k, by linear_combination hl - hk⟩
    have : ¬ ((2:ℤ) ∣ 1) := by decide
    contradiction
  · intro h
    obtain h1 | h2 := Nat.even_or_odd n
    · contradiction
    · apply h2

theorem Nat.even_iff_not_odd (n : ℕ) : Even n ↔ ¬ Odd n := by
  constructor
  · intro ⟨k, hk⟩ ⟨l, hl⟩
    zify at hk hl
    have : (2:ℤ) ∣ 1 := ⟨k - l, by linear_combination hk - hl⟩
    have : ¬ ((2:ℤ) ∣ 1) := by decide
    contradiction
  · intro h
    obtain h1 | h2 := Nat.even_or_odd n
    · apply h1
    · contradiction
