/- Copyright (c) Heather Macbeth, 2023.  All rights reserved. -/
import Library.Theory.Division

/-- Two integers are congruent modulo `n`, if their difference is a multiple of `n`. -/
def Int.ModEq (n a b : ℤ) : Prop := n ∣ a - b

notation:50 a " ≡ " b " [ZMOD " n "]" => Int.ModEq n a b
