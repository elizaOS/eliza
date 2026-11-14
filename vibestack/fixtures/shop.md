# Shop

## Story: Fill a cart

### A cart holds lines

```quint
import lib.* from "./lib"
type Line = { sku: str, qty: int, tags: List[str] }
type Cart = { lines: List[Line], count: int }
pure val initial: Cart = { lines: List(), count: 0 }
pure val skuValues = Set("a", "b")
pure def canAdd(c: Cart, sku: str, qty: int): bool = qty > 0 and not(c.lines.some(l => l.sku == sku))
pure def add(c: Cart, sku: str, qty: int): Cart =
  { lines: c.lines.append({ sku: sku, qty: qty, tags: List(sku) }), count: c.count + 1 }
pure def remove(c: Cart, sku: str): Cart = { lines: c.lines.select(l => l.sku != sku), count: c.count }
pure def alwaysQuantitiesArePositive(c: Cart): bool = c.lines.every(l => l.qty > 0)
pure def alwaysEveryTagNamesALine(c: Cart): bool = c.lines.every(l => l.tags.some(t => c.lines.some(m => m.sku == t)))
pure def alwaysTheTotalIsNotNegative(c: Cart): bool = total(c.lines.listMap(l => l.qty)) >= 0
pure def stepTheCountNeverGoesDown(before: Cart, after: Cart): bool = after.count >= before.count
pure def sometimesTwoLines(c: Cart): bool = c.lines.length() == 2
```
