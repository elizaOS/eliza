/- Copyright (c) Heather Macbeth, 2023.  All rights reserved. -/
import Mathlib.Tactic.LinearCombination
import Library.Tactic.Induction

open Int

@[decreasing] theorem lower_bound_fmod1 (a b : ℤ) (h1 : 0 < b) : -b < fmod a b := by
  have H : 0 ≤ fmod a b := fmod_nonneg_of_pos _ h1
  linarith

@[decreasing] theorem lower_bound_fmod2 (a b : ℤ) (h1 : b < 0) : b < fmod a (-b) := by
  have H : 0 ≤ fmod a (-b)
  · apply fmod_nonneg_of_pos
    linarith
  linarith

@[decreasing] theorem upper_bound_fmod2 (a b : ℤ) (h1 : b < 0) : fmod a (-b) < -b := by
  apply fmod_lt_of_pos
  linarith

attribute [decreasing] fmod_lt_of_pos

def gcd (a b : ℤ) : ℤ :=
  if 0 < b then
    gcd b (fmod a b)
  else if b < 0 then
    gcd b (fmod a (-b))
  else if 0 ≤ a then
    a
  else
    -a
termination_by _ a b => b

theorem gcd_nonneg (a b : ℤ) : 0 ≤ _root_.gcd a b := by
  rw [_root_.gcd]
  split_ifs with h1 h2 ha
  · apply gcd_nonneg
  · apply gcd_nonneg
  · apply ha
  · linarith
termination_by _ a b => b

mutual
theorem gcd_dvd_right (a b : ℤ) : _root_.gcd a b ∣ b := by
  rw [_root_.gcd]
  split_ifs with h1 h2
  · exact gcd_dvd_left b (fmod a b)
  · exact gcd_dvd_left b (fmod a (-b))
  · use 0
    linarith
  · use 0
    linarith

theorem gcd_dvd_left (a b : ℤ) : _root_.gcd a b ∣ a := by
  rw [_root_.gcd]
  split_ifs with h1 h2
  · obtain ⟨k, hk⟩ := gcd_dvd_left b (fmod a b)
    obtain ⟨l, hl⟩ := gcd_dvd_right b (fmod a b)
    have H : fmod a b + b * fdiv a b = a := fmod_add_fdiv a b
    use l + k * fdiv a b
    linear_combination fdiv a b * hk + hl - H
  · obtain ⟨k, hk⟩ := gcd_dvd_left b (fmod a (-b))
    obtain ⟨l, hl⟩ := gcd_dvd_right b (fmod a (-b))
    have H := fmod_add_fdiv a (-b)
    use l - k * fdiv a (-b)
    linear_combination - fdiv a (-b) * hk + hl - H
  · use 1
    ring
  · use -1
    ring

end
termination_by gcd_dvd_right a b => b ; gcd_dvd_left a b => b

namespace Bezout
mutual

def L (a b : ℤ) : ℤ :=
  if 0 < b then
    R b (fmod a b)
  else if b < 0 then
    R b (fmod a (-b))
  else if 0 ≤ a then
    1
  else
    -1

def R (a b : ℤ) : ℤ :=
  if 0 < b then
    L b (fmod a b) - (fdiv a b) * R b (fmod a b)
  else if b < 0 then
    L b (fmod a (-b)) + (fdiv a (-b)) * R b (fmod a (-b))
  else
    0

end
termination_by L a b => b ; R a b => b

theorem L_mul_add_R_mul (a b : ℤ) : L a b * a + R a b * b = _root_.gcd a b := by
  rw [R, L, _root_.gcd]
  split_ifs with h1 h2 <;> push_neg at *
  · have IH := L_mul_add_R_mul b (fmod a b)
    have h : fmod a b + b * fdiv a b = a := fmod_add_fdiv a b
    linear_combination IH - R b (fmod a b) * h
  · have IH := L_mul_add_R_mul b (fmod a (-b))
    have h : fmod a (-b) + (-b) * fdiv a (-b) = a := fmod_add_fdiv a (-b)
    linear_combination IH - R b (fmod a (-b)) * h
  · ring
  · ring
termination_by L_mul_add_R_mul a b => b

end Bezout
open Bezout

theorem bezout (a b : ℤ) : ∃ x y : ℤ, x * a + y * b = _root_.gcd a b := ⟨_, _, L_mul_add_R_mul _ _⟩
