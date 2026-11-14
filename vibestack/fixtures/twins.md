# Twins

Two counters that move together. Nothing states that they are equal, so the
transition cannot be proved to keep either rule; the second rule follows from
the first, and a prover that assumes the first while checking the second
would call it proved.

## Story: Count in step

### Both counters stay small

```quint
type Pair = { a: int, b: int }
pure val initial: Pair = { a: 0, b: 0 }
pure def canBump(p: Pair): bool = p.a < 3
pure def bump(p: Pair): Pair = { a: p.a + 1, b: p.b + 1 }
pure def alwaysBIsAtMostThree(p: Pair): bool = p.b <= 3
pure def alwaysBIsAtMostThreeOrNinetyNine(p: Pair): bool = p.b <= 3 or p.b == 99
pure def sometimesThree(p: Pair): bool = p.b == 3
```
