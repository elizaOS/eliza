# Highest

A library whose law needs induction over a fold: Dafny does not prove it
without help, and does with highest.proof.dfy.

## Running maximum

### The highest of a list is at least where it starts

```quint
pure def highest(xs: List[int], start: int): int = xs.foldl(start, (top, x) => if (x > top) x else top)
pure def lawTheHighestIsAtLeastTheStart(xs: List[int], start: int): bool = highest(xs, start) >= start
```
