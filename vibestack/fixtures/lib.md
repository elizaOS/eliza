# Lib

## Sums

### The total of a list

```quint
pure def total(xs: List[int]): int = xs.foldl(0, (acc, x) => acc + x)
pure def lawTheTotalOfOneNumberIsItself(n: int): bool = total(List()) == 0 and total(List(n)) == n
```
