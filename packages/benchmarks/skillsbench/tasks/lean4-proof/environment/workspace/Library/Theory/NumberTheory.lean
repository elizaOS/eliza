/- Copyright (c) Heather Macbeth, 2023.  All rights reserved. -/
import Library.Theory.Parity

/-! # Assorted number theory lemmas from earlier needed in section 7.3 (square root of 2) -/

-- from Section 2.3
theorem sq_ne_two (n : ℤ) : n ^ 2 ≠ 2 := by
  intro hn
  obtain ⟨hn1, hn2⟩ : -2 < n ∧ n < 2
  · apply abs_lt_of_sq_lt_sq'
    · linarith
    · norm_num
  interval_cases n <;> norm_num at hn

-- from Section 6.1
theorem Nat.Odd.pow {a : ℕ} (ha : Nat.Odd a) (n : ℕ) : Nat.Odd (a ^ n) := by
  induction' n with k IH
  · use 0
    change a ^ 0 = _
    ring
  · obtain ⟨x, hx⟩ := ha
    obtain ⟨y, hy⟩ := IH
    use 2 * x * y + x + y
    rw [pow_succ, hy, hx]
    ring

-- from Section 6.1
theorem Nat.even_of_pow_even {a n : ℕ} (ha : Nat.Even (a ^ n)) : Nat.Even a := by
  rw [even_iff_not_odd] at *
  intro h
  have : Odd (a ^ n) := Odd.pow h n
  contradiction
