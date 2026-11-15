# Browser address input

What a person types into an address bar is classified locally as a web
address to open, a search to run, or a rejection with its reason. This is
classification only: it is not permission to navigate and not a check of
the network address. A host keeps its own aliases, search provider, HTTPS
upgrade and error wording, and passes the protocol to assume when none is
typed.

The text is modeled as the facts the parser reads from it, in the order the
parser reads them. "Address-shaped" means the text names a scheme, a dotted
domain, a host with a numeric port or a bracketed IPv6 literal, or starts
with `//`.

## Story: Classify what the person typed

> As a person using a browser, I want what I type to open the address I
> meant or search for my words, and never to open a scheme or credentials I
> did not mean to send.

### Typed text is classified as an address, a search or a rejection

Blank text is rejected, and so is text holding a control character or a
backslash, before any URL normalization can hide it. A search operator such
as `site:` makes the text a search, as does text that is not
address-shaped; either is rejected instead when it holds an `@`. A host
with a numeric port is an address, never a scheme. Address-shaped text that
does not parse is rejected, except a bracketed literal that only looked
like IPv6, which is a search. A parsed address opens only with HTTP or
HTTPS and without a user name or password.

```quint
type AddressScheme = HttpScheme | HttpsScheme | OtherScheme
type DefaultProtocol = DefaultHttp | DefaultHttps
type AddressRejection = NoRejection | EmptyAddress | InvalidAddressInput | InvalidAddressUrl | AddressCredentials | UnsupportedScheme
type AddressKind = UrlAddress | SearchAddress | RejectedAddress
type AddressInput = { blank: bool, control: bool, searchOperator: bool, at: bool, hostPort: bool, schemeShaped: bool, scheme: AddressScheme, domain: bool, protocolRelative: bool, bracketed: bool, parses: bool, userInfo: bool }
type AddressResult = { addressKind: AddressKind, protocol: AddressScheme, reason: AddressRejection }
pure def explicitScheme(input: AddressInput): bool = not(input.hostPort) and input.schemeShaped
pure def addressShaped(input: AddressInput): bool = explicitScheme(input) or input.domain or input.hostPort or input.protocolRelative
pure def protocolFor(input: AddressInput, fallback: DefaultProtocol): AddressScheme =
  if (explicitScheme(input)) input.scheme else if (fallback == DefaultHttp) HttpScheme else HttpsScheme
pure def rejectAddress(reason: AddressRejection): AddressResult = { addressKind: RejectedAddress, protocol: OtherScheme, reason: reason }
pure val searchResult: AddressResult = { addressKind: SearchAddress, protocol: OtherScheme, reason: NoRejection }
pure def searchUnlessCredentials(input: AddressInput): AddressResult = if (input.at) rejectAddress(AddressCredentials) else searchResult
pure def classifyAddress(input: AddressInput, fallback: DefaultProtocol): AddressResult =
  if (input.blank) rejectAddress(EmptyAddress)
  else if (input.control) rejectAddress(InvalidAddressInput)
  else if (input.searchOperator or not(addressShaped(input))) searchUnlessCredentials(input)
  else if (not(input.parses)) (if (input.bracketed and not(explicitScheme(input)) and not(input.domain)) searchResult else rejectAddress(InvalidAddressUrl))
  else if (protocolFor(input, fallback) == OtherScheme) rejectAddress(UnsupportedScheme)
  else if (input.userInfo) rejectAddress(AddressCredentials)
  else { addressKind: UrlAddress, protocol: protocolFor(input, fallback), reason: NoRejection }
pure val plainWords: AddressInput = { blank: false, control: false, searchOperator: false, at: false, hostPort: false, schemeShaped: false, scheme: OtherScheme, domain: false, protocolRelative: false, bracketed: false, parses: false, userInfo: false }
pure val inputValues: Set[AddressInput] = List(
  plainWords,
  { ...plainWords, blank: true },
  { ...plainWords, control: true, domain: true },
  { ...plainWords, at: true },
  { ...plainWords, searchOperator: true, domain: true },
  { ...plainWords, domain: true, parses: true },
  { ...plainWords, domain: true, parses: true, userInfo: true, at: true },
  { ...plainWords, hostPort: true, schemeShaped: true, parses: true },
  { ...plainWords, schemeShaped: true, scheme: HttpsScheme, domain: true, parses: true },
  { ...plainWords, schemeShaped: true, scheme: OtherScheme, parses: true },
  { ...plainWords, protocolRelative: true, domain: true, parses: true },
  { ...plainWords, bracketed: true, hostPort: true },
  { ...plainWords, bracketed: true, hostPort: true, parses: true },
  { ...plainWords, domain: true }
).foldl(Set(), (acc, input) => acc.union(Set(input)))
```

### Only an HTTP or HTTPS address is ever opened

```quint
pure def lawOnlyWebAddressesOpen(input: AddressInput, fallback: DefaultProtocol): bool =
  classifyAddress(input, fallback).addressKind == UrlAddress implies
    (classifyAddress(input, fallback).protocol == HttpScheme or classifyAddress(input, fallback).protocol == HttpsScheme)
```

### A typed scheme other than HTTP or HTTPS never becomes an address

`javascript:`, `file:` and every other scheme the person types is refused
as an address, whatever protocol the host assumes by default.

```quint
pure def lawDisallowedSchemeNeverOpens(input: AddressInput, fallback: DefaultProtocol): bool =
  (explicitScheme(input) and input.scheme == OtherScheme) implies classifyAddress(input, fallback).addressKind != UrlAddress
```

### Credentials are never sent: an address with a user name never opens and a search never holds an `@`

A bracketed IPv6-shaped literal holds only hexadecimal digits, dots, colons
and percent signs, so it never holds an `@`.

```quint
pure def wellFormedAddressInput(input: AddressInput): bool = input.bracketed implies (not(input.at) and not(input.protocolRelative))
pure def lawCredentialsNeverOpen(input: AddressInput, fallback: DefaultProtocol): bool =
  input.userInfo implies classifyAddress(input, fallback).addressKind != UrlAddress
pure def lawSearchHoldsNoCredentials(input: AddressInput, fallback: DefaultProtocol): bool =
  (wellFormedAddressInput(input) and classifyAddress(input, fallback).addressKind == SearchAddress) implies not(input.at)
```

### An address typed without a scheme opens with the host's default protocol

```quint
pure def lawImplicitAddressUsesDefaultProtocol(input: AddressInput, fallback: DefaultProtocol): bool =
  (classifyAddress(input, fallback).addressKind == UrlAddress and not(explicitScheme(input))) implies
    classifyAddress(input, fallback).protocol == (if (fallback == DefaultHttp) HttpScheme else HttpsScheme)
```

### Blank text and text with control characters are rejected

```quint
pure def lawBlankIsRejected(input: AddressInput, fallback: DefaultProtocol): bool =
  input.blank implies classifyAddress(input, fallback).reason == EmptyAddress
pure def lawControlCharactersAreRejected(input: AddressInput, fallback: DefaultProtocol): bool =
  (input.control and not(input.blank)) implies classifyAddress(input, fallback).reason == InvalidAddressInput
```
