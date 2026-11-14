# Stock

## Story: Count what is on the shelves

### Each product has a level, and a product never seen has none

```quint
type Stock = { levels: str -> int, known: List[str] }
pure val initial: Stock = { levels: Map(), known: List() }
pure val skuValues = Set("a", "b")

pure def level(s: Stock, sku: str): int = if (s.levels.keys().contains(sku)) s.levels.get(sku) else 0
```

### Goods are received and picked, and a level never goes below zero

```quint
pure def canReceive(s: Stock, sku: str, qty: int): bool = qty > 0
pure def receive(s: Stock, sku: str, qty: int): Stock =
  { levels: s.levels.put(sku, level(s, sku) + qty), known: if (s.known.includes(sku)) s.known else s.known.append(sku) }

pure def canPick(s: Stock, sku: str, qty: int): bool = qty > 0 and qty <= level(s, sku)
pure def pick(s: Stock, sku: str, qty: int): Stock = { ...s, levels: s.levels.put(sku, level(s, sku) - qty) }

pure def alwaysNoLevelIsNegative(s: Stock): bool = s.known.every(k => level(s, k) >= 0)
pure def sometimesAShelfIsEmptiedAgain(s: Stock): bool = s.known.length() == 2 and s.known.every(k => level(s, k) == 0)
```

### Stock is counted in boxes of four, rounding towards zero

```quint
pure def boxes(units: int): int = units / 4
pure def loose(units: int): int = units % 4
pure def lawBoxesAndLooseMakeTheWhole(units: int): bool = boxes(units) * 4 + loose(units) == units
pure val unitsValues = (-9).to(9)
```
