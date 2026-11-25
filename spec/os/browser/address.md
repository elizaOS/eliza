# Browser address

What a person types into an address bar is classified on the device as a
web address to open, words to search for, or a refusal with one of five
reasons. Classification is not permission to navigate and not a check of
the network address: the host keeps its own aliases, search provider, HTTPS
upgrade and wording, and passes the protocol to assume when none is typed.
The same file defines the one web-address test that saving, reading,
protection and page commands share.

The shell reads the facts below from the trimmed text with the patterns of
`packages/os-bridges/src/browser/address.ts` and the platform URL parser, in this order;
the spec decides what the facts mean. "Address-shaped" text names a
scheme, a dotted domain, a host with a numeric port or a bracketed IPv6
literal, or starts with `//`. No top-level-domain list is consulted.

## Story: Classify what I typed

> As a person using a browser, I want what I type to open the address I
> meant or search for my words, so that I never open a scheme or send
> credentials I did not mean to.

### Typed text is an address to open, words to search for, or a refusal with its reason

Blank text is refused, then text holding a control character or a
backslash, before URL normalization can hide it. A search operator such as
`site:`, or text that is not address-shaped, is a search. A host with a
numeric port is an address, never a scheme. Address-shaped text the parser
refuses is refused, except a bracketed literal that only looked like IPv6,
which is a search. A parsed address opens only with HTTP or HTTPS and
without a user name or password; one typed without a scheme opens with the
caller's default protocol.

```quint
type WebScheme = HttpScheme | HttpsScheme | OtherScheme
type DefaultProtocol = DefaultHttp | DefaultHttps
type AddressRefusal = EmptyAddress | InvalidAddressInput | InvalidAddressUrl | AddressCredentials | UnsupportedProtocol
type AddressFacts = { text: str, blank: bool, hasControl: bool, searchOperator: bool, hasAt: bool, hostPort: bool,
  schemeShaped: bool, typedScheme: WebScheme, dottedDomain: bool, protocolRelative: bool, bracketed: bool,
  parses: bool, userInfo: bool, href: str }
type AddressInput = AddressUrl({ href: str, scheme: WebScheme }) | AddressSearch({ query: str }) | AddressRejected({ reason: AddressRefusal })
pure def explicitScheme(facts: AddressFacts): bool = not(facts.hostPort) and facts.schemeShaped
pure def addressShaped(facts: AddressFacts): bool =
  explicitScheme(facts) or facts.dottedDomain or facts.hostPort or facts.protocolRelative
pure def defaultScheme(fallback: DefaultProtocol): WebScheme = if (fallback == DefaultHttp) HttpScheme else HttpsScheme
pure def schemeFor(facts: AddressFacts, fallback: DefaultProtocol): WebScheme =
  if (explicitScheme(facts)) facts.typedScheme else defaultScheme(fallback)
pure def searchFor(facts: AddressFacts): AddressInput =
  if (facts.hasAt) AddressRejected({ reason: AddressCredentials }) else AddressSearch({ query: facts.text })
pure def classifyAddress(facts: AddressFacts, fallback: DefaultProtocol): AddressInput =
  if (facts.blank) AddressRejected({ reason: EmptyAddress })
  else if (facts.hasControl) AddressRejected({ reason: InvalidAddressInput })
  else if (facts.searchOperator or not(addressShaped(facts))) searchFor(facts)
  else if (not(facts.parses))
    (if (facts.bracketed and not(explicitScheme(facts)) and not(facts.dottedDomain)) searchFor(facts)
     else AddressRejected({ reason: InvalidAddressUrl }))
  else if (schemeFor(facts, fallback) == OtherScheme) AddressRejected({ reason: UnsupportedProtocol })
  else if (facts.userInfo) AddressRejected({ reason: AddressCredentials })
  else AddressUrl({ href: facts.href, scheme: schemeFor(facts, fallback) })
pure def opensWith(result: AddressInput, scheme: WebScheme): bool = match result { | AddressUrl(u) => u.scheme == scheme | _ => false }
pure def opensAddress(result: AddressInput): bool = opensWith(result, HttpScheme) or opensWith(result, HttpsScheme) or opensWith(result, OtherScheme)
pure def isSearch(result: AddressInput): bool = match result { | AddressSearch(q) => true | _ => false }
pure def refusedFor(result: AddressInput, reason: AddressRefusal): bool = match result { | AddressRejected(r) => r.reason == reason | _ => false }
pure val plainWords: AddressFacts = { text: "dinner at eight", blank: false, hasControl: false, searchOperator: false, hasAt: false,
  hostPort: false, schemeShaped: false, typedScheme: OtherScheme, dottedDomain: false, protocolRelative: false, bracketed: false,
  parses: false, userInfo: false, href: "" }
pure val webDomain: AddressFacts = { ...plainWords, text: "example.test", dottedDomain: true, parses: true, href: "https://example.test/" }
pure val factsValues: Set[AddressFacts] = List(
  plainWords,
  { ...plainWords, text: "", blank: true },
  { ...webDomain, hasControl: true },
  { ...plainWords, hasAt: true },
  { ...webDomain, searchOperator: true, schemeShaped: true },
  webDomain,
  { ...webDomain, hasAt: true, userInfo: true },
  { ...webDomain, schemeShaped: true, typedScheme: HttpScheme },
  { ...plainWords, schemeShaped: true, typedScheme: OtherScheme, parses: true },
  { ...plainWords, hostPort: true, schemeShaped: true, parses: true, href: "http://localhost:3000/" },
  { ...webDomain, protocolRelative: true },
  { ...plainWords, bracketed: true, hostPort: true },
  { ...plainWords, bracketed: true, hostPort: true, hasAt: true },
  { ...plainWords, bracketed: true, hostPort: true, parses: true, href: "http://[::1]/" },
  { ...webDomain, parses: false }
).foldl(Set(), (acc, f) => acc.union(Set(f)))
```

### Blank text and text with a control character or backslash are refused before anything else

```quint
pure def lawUnreadableTextIsRefusedFirst(facts: AddressFacts, fallback: DefaultProtocol): bool = {
  val result = classifyAddress(facts, fallback)
  (facts.blank implies refusedFor(result, EmptyAddress)) and
    ((facts.hasControl and not(facts.blank)) implies refusedFor(result, InvalidAddressInput))
}
```

### Only an HTTP or HTTPS address that parsed without credentials is ever opened

`javascript:`, `file:` and every other typed scheme is refused, whatever
protocol the host assumes, and so is an address with a user name or
password.

```quint
pure def lawOnlyWebAddressesOpen(facts: AddressFacts, fallback: DefaultProtocol): bool = {
  val result = classifyAddress(facts, fallback)
  opensAddress(result) implies
    (not(opensWith(result, OtherScheme)) and facts.parses and not(facts.userInfo) and not(facts.hasControl))
}
pure def lawTypedOtherSchemeNeverOpens(facts: AddressFacts, fallback: DefaultProtocol): bool =
  (explicitScheme(facts) and facts.typedScheme == OtherScheme) implies not(opensAddress(classifyAddress(facts, fallback)))
```

### An address typed without a scheme opens with the caller's default protocol

`localhost:3000`, `nas:8080` and `[::1]:8080` are hosts with a port, so
the text before the colon is never read as a scheme.

```quint
pure def lawImplicitAddressUsesDefaultProtocol(facts: AddressFacts, fallback: DefaultProtocol): bool = {
  val result = classifyAddress(facts, fallback)
  (opensAddress(result) and not(explicitScheme(facts))) implies opensWith(result, defaultScheme(fallback))
}
pure def lawHostWithPortOpens(facts: AddressFacts, fallback: DefaultProtocol): bool =
  (facts.hostPort and facts.parses and not(facts.userInfo) and not(facts.blank) and not(facts.hasControl) and not(facts.searchOperator))
    implies opensWith(classifyAddress(facts, fallback), defaultScheme(fallback))
```

### A search never carries an at sign to the search provider

Text holding `@` that would be searched is refused as credentials, on
every path to a search, so a user name and password typed by mistake never
reach the search provider.

```quint
pure def lawSearchHoldsNoAt(facts: AddressFacts, fallback: DefaultProtocol): bool =
  isSearch(classifyAddress(facts, fallback)) implies not(facts.hasAt)
```

## Story: Share only plain web addresses

> As a person browsing, I want only plain web addresses saved, read, checked
> or driven, so that a local file, a script or my credentials never leave
> the page through the browser's own features.

### A web address is HTTP or HTTPS with a valid host, no credentials, clean text and at most 8,192 units

The shell reads only the scheme and authority, as the native origin
parser does: clean text has no control character, whitespace, DEL or
backslash; a valid host is a server host with a port of at most 65,535.
A secure web address is a web address over HTTPS. Callers add their own
tighter bounds.

```quint
type WebAddress = { href: str, units: int, cleanText: bool, scheme: WebScheme, validHost: bool, userInfo: bool }
pure val webAddressUnitsLimit = 8192
pure def isWebAddress(address: WebAddress): bool =
  address.units > 0 and address.units <= webAddressUnitsLimit and address.cleanText and address.validHost and
    not(address.userInfo) and address.scheme != OtherScheme
pure def isSecureWebAddress(address: WebAddress): bool = isWebAddress(address) and address.scheme == HttpsScheme
pure val secureAddress: WebAddress = { href: "https://example.test/", units: 21, cleanText: true, scheme: HttpsScheme, validHost: true, userInfo: false }
pure val addressValues: Set[WebAddress] = List(
  secureAddress,
  { ...secureAddress, href: "http://example.test/", units: 20, scheme: HttpScheme },
  { ...secureAddress, href: "https://user@example.test/", units: 26, userInfo: true },
  { ...secureAddress, units: 8193 },
  { ...secureAddress, cleanText: false },
  { ...secureAddress, validHost: false },
  { ...secureAddress, href: "file:///local", units: 13, scheme: OtherScheme }
).foldl(Set(), (acc, a) => acc.union(Set(a)))
```
