# Card

## Story: Pay with a saved card

> As a person, I want my card typed only into the payment page, and nothing
> but a hint of it ever shown.

### The card number is secret, and so is what is typed

```quint
type SecretCard = str
type Effect = Shown({ text: str }) | Typed({ card: SecretCard })
type Wallet = { card: SecretCard, out: List[Effect] }
pure val initial: Wallet = { card: "", out: List() }
```

### A card can be saved

```quint
pure def save(w: Wallet, card: SecretCard): Wallet = { ...w, card: card }
```

### The card is typed into the payment page

```quint
pure def pay(w: Wallet): Wallet = { ...w, out: w.out.append(Typed({ card: w.card })) }
```

### Only whether a card is saved is shown

```quint
pure def declassifyNone(c: SecretCard): bool = c == ""
pure def hint(w: Wallet): Wallet =
  { ...w, out: w.out.append(Shown({ text: if (declassifyNone(w.card)) "none" else "saved" })) }
pure def sometimesShown(w: Wallet): bool = w.out.length() > 1
```
