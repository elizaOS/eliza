# Magic

Two counters, each broken by one magic amount that simulation never tries:
both `always` rules are false, simulation passes, and the proof must not call
either proved, whatever a proof file says (see selftest).

## Story: Count

### A counter

```quint
type C = { n: int, m: int }
pure val initial: C = { n: 0, m: 0 }
```

### Bump by a positive amount

```quint
pure def canBump(c: C, k: int): bool = k > 0 and k < 1000000000
pure def bump(c: C, k: int): C = { n: if (k == 777777) -1 else c.n + k, m: c.m + 1 }
```

### Mark by a positive amount

```quint
pure def canMark(c: C, k: int): bool = k > 0 and k < 1000000000
pure def mark(c: C, k: int): C = { n: c.n, m: if (k == 555555) -1 else c.m + k }
```

### The count is never negative

```quint
pure def alwaysNonNegative(c: C): bool = c.n >= 0
```

### The count of bumps is never negative

```quint
pure def alwaysBumpsNonNegative(c: C): bool = c.m >= 0
```

### Bumped at least once

```quint
pure def sometimesBumped(c: C): bool = c.m > 0
```
