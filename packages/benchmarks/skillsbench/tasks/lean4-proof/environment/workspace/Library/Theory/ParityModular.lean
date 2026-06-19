/- Copyright (c) Heather Macbeth, 2023.  All rights reserved. -/
import Library.Theory.Parity
import Library.Theory.ModEq.Defs

theorem Int.odd_iff_modEq (n : ℤ) : Odd n ↔ n ≡ 1 [ZMOD 2] := by
  constructor <;> rintro ⟨k, hk⟩ <;> exact ⟨k, by linear_combination hk⟩

theorem Int.even_iff_modEq (n : ℤ) : Even n ↔ n ≡ 0 [ZMOD 2] := by
  constructor <;> rintro ⟨k, hk⟩ <;> exact ⟨k, by linear_combination hk⟩
