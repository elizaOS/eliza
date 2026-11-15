# Ops

Every operator a spec may use (AGENTS.md, "Supported Quint"), each at least
once: the selftest holds this file to the translator's own list.

## Numbers and truth

### Arithmetic goes towards zero, and a divisor is tested first

```quint
pure def arithmetic(a: int, b: int): int = if (b != 0) (a + b) * (a - b) / b + a % b else -a
pure def comparisons(a: int, b: int): bool = (a < b or a <= b) and (a > b implies a >= b) iff not(a == -1)
```

## Lists

### A list is read where it holds something

```quint
pure def positive(n: int): bool = n > 0
pure def double(n: int): int = n * 2
pure def firstOr(xs: List[int], d: int): int = if (xs.length() > 0) xs.head() else d
pure def secondOr(xs: List[int], d: int): int = if (xs.length() > 1) xs.nth(1) else d
pure def rest(xs: List[int]): List[int] = if (xs.length() > 0) xs.tail() else List()
pure def lawTheRestIsNoLonger(xs: List[int]): bool = rest(xs).length() <= xs.length()
```

### Lists are joined, filtered, folded and asked about their members

```quint
pure def joined(xs: List[int], ys: List[int]): List[int] = xs.concat(ys).append(0).select(x => x >= 0)
pure def total(xs: List[int]): int = xs.foldl(0, (sum, x) => sum + x)
pure def named(xs: List[int]): bool = xs.every(positive) or xs.some(positive) or xs.listMap(double).includes(4)
pure def written(xs: List[int]): bool = xs.every(x => x > 0) or xs.some(x => x > 0) or xs.listMap(x => x * 2).includes(4)
pure def shifted(xs: List[int], i: int): List[int] = xs.removeAt(i).append(xs.nthOr(i, -1))
```

## Sets

### Sets are combined and asked about their members

```quint
pure val low: Set[int] = Set(-1, 0)
pure def combined(a: Set[int], b: Set[int]): Set[int] = a.union(b).intersect(a).exclude(low).filter(x => x > 1).map(x => x / 2)
pure def compared(a: Set[int], b: Set[int]): bool = a.subseteq(b) and a.forall(x => b.contains(x)) and b.exists(x => x.in(a)) and a.size() <= b.size()
```

## Tables, records and variants

### A table is asked about one key

```quint
pure def table(k: int): int -> int = Map(1 -> 1).put(k, 2).set(1, 3)
pure def held(k: int, other: int): int =
  val m = table(k)
  if (m.keys().contains(other)) m.get(other) + m.getOr(2, 0) else 0
```

### A record is built and updated, and a variant matched

```quint
type Kind = Small | Large
type Item = { n: int, kind: Kind }
type Parcel = Packed({ weight: int }) | Lost
pure val pValues = Set(Lost, Packed({ weight: 1 }))
pure def made(n: int): Item = { n: n, kind: if (n > 3) Large else Small }
pure def grown(n: int): Item = { ...made(n), n: made(n).n + 1 }
pure def heavier(p: Parcel): Parcel = match p { | Packed(x) => Packed({ ...x, weight: x.weight + 1 }) | Lost => Packed({ weight: 0 }) }
```
