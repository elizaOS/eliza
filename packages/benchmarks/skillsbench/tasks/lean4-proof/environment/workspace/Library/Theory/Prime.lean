/- Copyright (c) Heather Macbeth, 2023.  All rights reserved. -/
import Mathlib.Tactic.IntervalCases
import Mathlib.Tactic.Linarith
import Mathlib.Tactic.LinearCombination
import Mathlib.Tactic.Positivity

def Prime (p : ℕ) : Prop :=
  2 ≤ p ∧ ∀ m : ℕ, m ∣ p → m = 1 ∨ m = p

theorem prime_test {p : ℕ} (hp : 2 ≤ p) (H : ∀ m : ℕ, 1 < m → m < p → ¬m ∣ p) : Prime p := by
  refine ⟨hp, fun m hmp => ?_⟩
  have hp' : 0 < p := by positivity
  obtain hm | hm_left := eq_or_lt_of_le (id (Nat.pos_of_dvd_of_pos hmp hp') : 1 ≤ m)
  · left
    exact hm.symm
  obtain hm' | hm_right := eq_or_lt_of_le (Nat.le_of_dvd hp' hmp)
  · right
    exact hm'
  have : ¬m ∣ p := H m hm_left hm_right
  contradiction

lemma better_prime_test {p : ℕ} (hp : 2 ≤ p)  (T : ℕ) (hTp : p < T ^ 2)
    (H : ∀ (m : ℕ), 1 < m → m < T → ¬ (m ∣ p)) :
    Prime p := by
  apply prime_test hp
  intro m hm1 hmp
  obtain hmT | hmT := lt_or_le m T
  · exact H m hm1 hmT
  rintro ⟨l, hl⟩
  apply H l
  · apply lt_of_mul_lt_mul_left (a := m)
    linarith
    positivity
  · apply lt_of_mul_lt_mul_left (a := T)
    calc T * l ≤ m * l := mul_le_mul_right' hmT l
      _ < T ^ 2 := by linarith
      _ = T * T := by linarith
    positivity
  · use m
    linarith

lemma not_prime_one : ¬ Prime 1 := by
  rintro ⟨h, _⟩
  norm_num1 at h

lemma prime_two : Prime 2 := by
  apply prime_test
  · norm_num
  intro m hm1 hm2
  interval_cases m

lemma not_prime {p : ℕ} (k l : ℕ) (hk1 : k ≠ 1) (hkp : k ≠ p) (hkl : p = k * l) : ¬(Prime p) := by
  rintro ⟨_, hfact⟩
  obtain hk1' | hkp' := hfact k ⟨_, hkl⟩
  · exact hk1 hk1'
  · exact hkp hkp'

theorem exists_factor_of_not_prime {p : ℕ} (hp : ¬ Prime p) (hp2 : 2 ≤ p) :
    ∃ m, 2 ≤ m ∧ m < p ∧ m ∣ p := by
  have H : ¬ _ := hp ∘ prime_test hp2
  push_neg at H
  exact H

theorem exists_prime_factor {n : ℕ} (hn2 : 2 ≤ n) : ∃ p : ℕ, Prime p ∧ p ∣ n := by
  by_cases hn : Prime n
  . refine ⟨n, hn, 1, ?_⟩
    ring
  . obtain ⟨m, hmn, _, ⟨x, hx⟩⟩ := exists_factor_of_not_prime hn hn2
    obtain ⟨p, hp, y, hy⟩ := exists_prime_factor hmn
    refine ⟨p, hp, x * y, ?_⟩
    zify at *
    linear_combination hx + x * hy
