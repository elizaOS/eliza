# Vault

## Domain

### A vault

```quint
type Actor = Owner | Guest
type Vault = { open: bool, label: str, ticks: int }
pure val initial: Vault = { open: false, label: "", ticks: 0 }
```

## Story: Open

### Only the owner opens the vault

```quint
pure def canOpen(v: Vault, by: Actor): bool = by == Owner and not(v.open)
pure def open(v: Vault, by: Actor): Vault = { ...v, open: true }
```

### Anyone closes it

```quint
pure def close(v: Vault): Vault = { ...v, open: false }
```

### Only the owner labels it, with any label

```quint
pure def canRelabel(v: Vault, by: Actor): bool = by == Owner
pure def relabel(v: Vault, label: str, by: Actor): Vault = { ...v, label: label }
```

### The vault opens only when the owner opens it

```quint
pure def stepOpensOnlyByOpen(before: Vault, via: str, after: Vault): bool =
  (after.open and not(before.open)) implies via == "open"
```

### The vault can be opened

```quint
pure def sometimesOpen(v: Vault): bool = v.open
```

## Story: Wait

### Time passes

```quint
pure def tick(v: Vault): Vault = { ...v, ticks: v.ticks + 1 }
```

### Much time can pass

Thirty ticks take longer than the shortest traces the simulator tries.

```quint
pure def sometimesLate(v: Vault): bool = v.ticks >= 30
```
