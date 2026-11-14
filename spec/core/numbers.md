# Canonical numeric inputs

Source `utils/number-parsing.ts` distinguishes absent canonical integers, invalid text and parsed values. Plain positive/nonnegative parsers additionally preserve their optional finite fallback. Float helpers retain JavaScript finite-number and flooring behavior. The following model defines canonical unsigned decimal parsing over the exact digit sequence exposed by the string boundary, including bounds and optional clamping.

## Story: Reject malformed numeric boundary data explicitly

As an API consumer, I want an absent optional number distinguishable from an invalid one.

### Canonical integers reject signs leading zeroes padding fractions and unsafe values

Whitespace-only input is absent. Nonempty padded input is invalid. A nonempty canonical decimal starts with a nonzero digit unless it is exactly zero. The value must fit a safe integer. Bad configured bounds raise RangeError. Out-of-range valid digits either clamp or return invalid according to the caller option.

```quint
type IntegerResult = MissingInteger | InvalidInteger | BoundsError | ParsedInteger({ value: int })
type DecimalAccumulation = { value: int, valid: bool }
pure val maxSafeInteger = 9007199254740991
pure def appendDigit(a: DecimalAccumulation, digit: int): DecimalAccumulation = if (not(a.valid) or digit < 0 or digit > 9 or a.value > (maxSafeInteger - digit) / 10) { value: a.value, valid: false } else { value: a.value * 10 + digit, valid: true }
pure def canonicalDecimal(digits: List[int], blank: bool, padded: bool, malformed: bool, minimum: int, maximum: int, clamp: bool): IntegerResult = {
  val accumulation = digits.foldl({ value: 0, valid: true }, (a, digit) => appendDigit(a, digit))
  if (blank) MissingInteger
  else if (padded or malformed or digits.length() == 0 or not(accumulation.valid)) InvalidInteger
  else if (digits.length() > 1 and digits.nthOr(0, 0) == 0) InvalidInteger
  else if (minimum > maximum or minimum < -maxSafeInteger or maximum > maxSafeInteger) BoundsError
  else if (clamp) ParsedInteger({ value: if (accumulation.value < minimum) minimum else if (accumulation.value > maximum) maximum else accumulation.value })
  else if (accumulation.value < minimum or accumulation.value > maximum) InvalidInteger
  else ParsedInteger({ value: accumulation.value })
}
pure def integerIsMissing(result: IntegerResult): bool = match result { MissingInteger => true | _ => false }
pure def integerIsInvalid(result: IntegerResult): bool = match result { InvalidInteger => true | _ => false }
pure def integerIsZero(result: IntegerResult): bool = match result { ParsedInteger(data) => data.value == 0 | _ => false }
pure def lawBlankNumberIsMissing(digits: List[int], minimum: int, maximum: int): bool = integerIsMissing(canonicalDecimal(digits, true, false, false, minimum, maximum, false))
pure def lawPaddedNumberIsInvalid(digits: List[int], minimum: int, maximum: int): bool = integerIsInvalid(canonicalDecimal(digits, false, true, false, minimum, maximum, false))
pure def lawLeadingZeroIsInvalid(tailDigit: int): bool = integerIsInvalid(canonicalDecimal(List(0, tailDigit), false, false, false, 0, maxSafeInteger, false))
pure def lawDecimalZeroAccepted(maximum: int): bool = (maximum >= 0 and maximum <= maxSafeInteger) implies integerIsZero(canonicalDecimal(List(0), false, false, false, 0, maximum, false))
```
