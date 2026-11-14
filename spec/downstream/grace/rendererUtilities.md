# Renderer values, local storage and text controls

Grace directly imports the pinned Eliza utilities `json-storage.ts`,
`value-formatting.ts` and `text-control-editing.ts` under
`packages/ui/src/utils`. This library gives their pure boundary
decisions. Locale formatting, DOM identity and browser storage remain
external services.

## Story: Restore only validated local renderer data

### Missing, invalid and unreadable data return the caller's fallback

The caller owns the key, schema and fallback. Reading resolves storage
inside the guarded call, parses JSON and calls its schema validator.
A missing value, resolver or I/O failure, JSON error or validator
failure uses the explicit fallback. These renderer caches may use that
fallback by design. They do not own task results. Writing returns false
if serialization fails or yields undefined, or storage cannot accept
the value. Remove returns false if storage cannot remove it.

```quint
type StorageReadFacts = { readWorked: bool, present: bool, parsed: bool, schemaValid: bool }
type StorageReadChoice = UseStored | UseFallback
pure def chooseStored(facts: StorageReadFacts): StorageReadChoice =
  if (facts.readWorked and facts.present and facts.parsed and facts.schemaValid) UseStored else UseFallback
pure def storageWriteWorked(encoded: bool, portAccepted: bool): bool = encoded and portAccepted
pure def lawInvalidLocalValueUsesFallback(facts: StorageReadFacts): bool =
  not(facts.schemaValid) implies chooseStored(facts) == UseFallback
pure def lawLocalWriteNeedsEncodedValue(portAccepted: bool): bool = not(storageWriteWorked(false, portAccepted))
pure val validRead: StorageReadFacts = { readWorked: true, present: true, parsed: true, schemaValid: true }
pure val factsValues = Set(validRead, { ...validRead, present: false }, { ...validRead, parsed: false },
  { ...validRead, schemaValid: false }, { ...validRead, readWorked: false })
```

## Story: Display the original minor currency units

### The selected formatter's currency exponent agrees with the amount

The exact safe integer minor amount may be negative. The currency
must be supported by the runtime and use the three-letter uppercase
syntax. An explicit exponent has to equal the formatter's exponent.
The shell passes an exact decimal string to Intl, preserving every
minor unit rather than converting through floating point. ISO days
must parse and round-trip as canonical calendar days, and a range
is inclusive and ordered.

```quint
type MoneyDisplay = { amountMinor: int, currencyShape: bool, currencySupported: bool, scalePresent: bool, suppliedScale: int, formatterScale: int }
pure def admitsCurrency(x: MoneyDisplay): bool =
  x.amountMinor >= -9007199254740991 and x.amountMinor <= 9007199254740991 and
  x.currencyShape and x.currencySupported and (not(x.scalePresent) or x.suppliedScale == x.formatterScale)
pure def orderedCalendarRange(startCanonical: bool, endCanonical: bool, startDay: int, endDay: int): bool =
  startCanonical and endCanonical and startDay <= endDay
pure def lawWrongCurrencyScaleIsRejected(x: MoneyDisplay): bool =
  x.scalePresent and x.suppliedScale != x.formatterScale implies not(admitsCurrency(x))
pure def lawReversedCalendarRangeIsRejected(startCanonical: bool, endCanonical: bool, startDay: int, endDay: int): bool =
  startDay > endDay implies not(orderedCalendarRange(startCanonical, endCanonical, startDay, endDay))
pure val displayMoney: MoneyDisplay = { amountMinor: 45, currencyShape: true, currencySupported: true, scalePresent: true, suppliedScale: 2, formatterScale: 2 }
pure val xValues = Set(displayMoney, { ...displayMoney, amountMinor: -45 },
  { ...displayMoney, suppliedScale: 3 }, { ...displayMoney, currencySupported: false })
```

## Story: Edit a keyboard field only while it is editable

### Insert respects the UTF-16 limit and backspace consumes a code point

The native realm determines input and textarea identity. An edit needs a
connected, enabled and writable text control. The selection uses UTF-16
positions. A collapsed Backspace removes the preceding code point, with
width zero at the start, one for a single unit, or two for a surrogate
pair. Noncollapsed Backspace removes the selected units. Insertion is
refused when the proposed length exceeds maxLength. The shell applies
the native value setter, dispatches a bubbling input event and attempts
to place the caret. Missing setter is a typed runtime failure, and an
unsupported selection range on an email input leaves the edit applied.

```quint
type TextEdit = { realmControl: bool, connected: bool, writable: bool, insertion: bool, originalUnits: int, selectionStart: int, selectionEnd: int, precedingWidth: int, insertedUnits: int, maxUnits: int }
pure def editFrom(edit: TextEdit): int =
  if (edit.insertion or edit.selectionStart != edit.selectionEnd) edit.selectionStart
  else edit.selectionStart - edit.precedingWidth
pure def admitsTextEdit(edit: TextEdit): bool =
  edit.realmControl and edit.connected and edit.writable and edit.originalUnits >= 0 and
  edit.selectionStart >= 0 and edit.selectionEnd >= edit.selectionStart and edit.selectionEnd <= edit.originalUnits and
  edit.precedingWidth >= 0 and edit.precedingWidth <= 2 and edit.precedingWidth <= edit.selectionStart and
  edit.insertedUnits >= 0 and
  (not(edit.insertion) or edit.maxUnits < 0 or edit.originalUnits - (edit.selectionEnd - edit.selectionStart) + edit.insertedUnits <= edit.maxUnits)
pure def lawInsertionRespectsMaxLength(edit: TextEdit): bool =
  admitsTextEdit(edit) and edit.insertion and edit.maxUnits >= 0 implies
  edit.originalUnits - (edit.selectionEnd - edit.selectionStart) + edit.insertedUnits <= edit.maxUnits
pure def lawBackspaceDoesNotMoveBeforeStart(edit: TextEdit): bool =
  admitsTextEdit(edit) and not(edit.insertion) implies editFrom(edit) >= 0
pure val insertionEdit: TextEdit = { realmControl: true, connected: true, writable: true, insertion: true, originalUnits: 4, selectionStart: 2, selectionEnd: 2, precedingWidth: 2, insertedUnits: 1, maxUnits: 5 }
pure val editValues = Set(insertionEdit, { ...insertionEdit, maxUnits: 4 },
  { ...insertionEdit, insertion: false }, { ...insertionEdit, connected: false })
```
