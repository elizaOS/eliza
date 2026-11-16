# Remote agent pairing link

A self-hosted agent pairs with a phone through a link, shown as a QR code
or opened as a deep link, of the form
`<scheme>://remote/agent-pair?v=1&url=<origin>&code=<code>&instance=<id>`.
It carries the agent's HTTPS origin, a one-time pairing code and the agent
process that issued the code, and never a bearer token. This contract
builds and reads that link. The pairing exchange itself, the code's
lifetime and the session it mints are the
[cloud's remote pairing](../cloud/remotePairing.md).

A link and its embedded origin are modeled as the facts the parser checks:
the outer scheme, host and path, anything else on the outer URL, how many
times each query field appears, and whether the origin is a bare HTTPS
origin. The code matches the producer's character set and group count after it
is trimmed and upper-cased, and the instance is a UUID compared in lower
case.

## Story: Pair my phone with the agent I chose

> As an owner pairing a phone with my own agent, I want the phone to
> connect only to the origin and agent process the link names, and never
> to receive a credential through the link.

### A link is read only when it is exactly the canonical link

The link is at most 2048 characters, has the client's scheme, host
`remote` and path `/agent-pair`, nothing else on the outer URL (no user
name, port or fragment), version 1, and each of the four fields exactly
once with no other field, so a bearer token or a repeated field makes it
unreadable. Its origin is a bare HTTPS origin: no user name, path, query or
fragment. Anything else is not a pairing link. A readable link is not
trust: before it pairs, the phone applies its own trust decision to the
origin and checks that the agent's public status names the same process
instance as the link.

```quint
type PairingOriginInput = { https: bool, originUserInfo: bool, originQuery: bool, originFragment: bool, pathless: bool }
pure def pairingOriginValid(origin: PairingOriginInput): bool =
  origin.https and not(origin.originUserInfo) and not(origin.originQuery) and not(origin.originFragment) and origin.pathless
pure val bareOrigin: PairingOriginInput = { https: true, originUserInfo: false, originQuery: false, originFragment: false, pathless: true }
pure val originValues: Set[PairingOriginInput] = List(
  bareOrigin, { ...bareOrigin, https: false }, { ...bareOrigin, originUserInfo: true }, { ...bareOrigin, pathless: false }, { ...bareOrigin, originQuery: true }
).foldl(Set(), (acc, o) => acc.union(Set(o)))
pure val pairingMaxLength = 2048
pure val pairingVersion = 1
type PairingFields = { versionCount: int, urlCount: int, codeCount: int, instanceCount: int, otherCount: int }
type PairingLink = { linkLength: int, schemeMatches: bool, hostIsRemote: bool, pathIsPair: bool, outerExtras: bool, fields: PairingFields, version: int, origin: PairingOriginInput, codeValid: bool, instanceValid: bool }
pure val canonicalFields: PairingFields = { versionCount: 1, urlCount: 1, codeCount: 1, instanceCount: 1, otherCount: 0 }
pure def pairingLinkAccepted(link: PairingLink): bool =
  link.linkLength > 0 and link.linkLength <= pairingMaxLength and link.schemeMatches and link.hostIsRemote and link.pathIsPair and
  not(link.outerExtras) and link.fields == canonicalFields and link.version == pairingVersion and
  pairingOriginValid(link.origin) and link.codeValid and link.instanceValid
pure val canonicalLink: PairingLink = { linkLength: 160, schemeMatches: true, hostIsRemote: true, pathIsPair: true, outerExtras: false, fields: canonicalFields, version: 1, origin: bareOrigin, codeValid: true, instanceValid: true }
pure val linkValues: Set[PairingLink] = List(
  canonicalLink,
  { ...canonicalLink, fields: { ...canonicalFields, otherCount: 1 } },
  { ...canonicalLink, fields: { ...canonicalFields, codeCount: 2 } },
  { ...canonicalLink, version: 2 },
  { ...canonicalLink, outerExtras: true },
  { ...canonicalLink, origin: { ...bareOrigin, https: false } },
  { ...canonicalLink, linkLength: 2049 },
  { ...canonicalLink, codeValid: false }
).foldl(Set(), (acc, l) => acc.union(Set(l)))
pure def pairingAllowed(link: PairingLink, originTrusted: bool, statusInstanceMatches: bool): bool =
  pairingLinkAccepted(link) and originTrusted and statusInstanceMatches
pure def lawExtraFieldIsRefused(link: PairingLink): bool =
  link.fields.otherCount > 0 implies not(pairingLinkAccepted(link))
pure def lawRepeatedFieldIsRefused(link: PairingLink): bool =
  (link.fields.versionCount > 1 or link.fields.urlCount > 1 or link.fields.codeCount > 1 or link.fields.instanceCount > 1) implies not(pairingLinkAccepted(link))
```

### A built link reads back as the same origin, code and instance

The agent builds a link only from a bare HTTPS origin, a valid code and a
valid instance, and such a link is always read back.

```quint
pure def buildPairingLink(origin: PairingOriginInput, codeValid: bool, instanceValid: bool, linkLength: int): PairingLink =
  { ...canonicalLink, origin: origin, codeValid: codeValid, instanceValid: instanceValid, linkLength: linkLength }
pure def pairingLinkBuildable(origin: PairingOriginInput, codeValid: bool, instanceValid: bool): bool = pairingOriginValid(origin) and codeValid and instanceValid
pure val linkLengthValues = Set(0, 160, 2048, 2049)
pure def lawBuiltLinkReadsBack(origin: PairingOriginInput, codeValid: bool, instanceValid: bool, linkLength: int): bool =
  (pairingLinkBuildable(origin, codeValid, instanceValid) and linkLength > 0 and linkLength <= pairingMaxLength) implies
    pairingLinkAccepted(buildPairingLink(origin, codeValid, instanceValid, linkLength))
```
