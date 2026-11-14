# Parcel

## Story: Send a parcel

### A parcel is packed, shipped, then delivered or lost

Each stage carries only what is known at that stage.

```quint
type Parcel =
  | Packed({ weight: int, labels: Set[str] })
  | Shipped({ weight: int, labels: Set[str], hops: int })
  | Delivered({ signedBy: str })
  | Lost

pure val initial: Parcel = Packed({ weight: 1, labels: Set() })
pure val nameValues = Set("fragile", "urgent")
```

### Labels go on while it is packed

```quint
pure def canLabel(p: Parcel, name: str): bool = match p { | Packed(x) => name != "" | _ => false }
pure def label(p: Parcel, name: str): Parcel = match p {
  | Packed(x) => Packed({ ...x, labels: x.labels.union(Set(name)) })
  | _ => p
}
pure def sometimesTwoLabels(p: Parcel): bool = match p { | Packed(x) => x.labels.size() == 2 | _ => false }
```

### A packed parcel ships, and a shipped parcel moves hop by hop

```quint
pure def canShip(p: Parcel): bool = match p { | Packed(x) => true | _ => false }
pure def ship(p: Parcel): Parcel = match p {
  | Packed(x) => Shipped({ weight: x.weight, labels: x.labels, hops: 0 })
  | _ => p
}
pure def canHop(p: Parcel): bool = match p { | Shipped(x) => true | _ => false }
pure def hop(p: Parcel): Parcel = match p { | Shipped(x) => Shipped({ ...x, hops: x.hops + 1 }) | _ => p }
pure def alwaysHopsAreCounted(p: Parcel): bool = match p { | Shipped(x) => x.hops >= 0 | _ => true }
pure def stepAFragileParcelStaysFragile(before: Parcel, after: Parcel): bool =
  match before {
    | Packed(x) => x.labels.contains("fragile") implies (match after { | Packed(y) => y.labels.contains("fragile") | Shipped(y) => y.labels.contains("fragile") | _ => false })
    | _ => true
  }
```

### A shipped parcel is delivered against a signature, or lost

```quint
pure def canDeliver(p: Parcel, signedBy: str): bool = match p { | Shipped(x) => signedBy != "" | _ => false }
pure def deliver(p: Parcel, signedBy: str): Parcel = Delivered({ signedBy: signedBy })
pure def canLose(p: Parcel): bool = match p { | Shipped(x) => true | _ => false }
pure def lose(p: Parcel): Parcel = Lost
pure def sometimesDelivered(p: Parcel): bool = match p { | Delivered(x) => x.signedBy == "a" | _ => false }
pure def sometimesLost(p: Parcel): bool = match p { | Lost => true | _ => false }
```
