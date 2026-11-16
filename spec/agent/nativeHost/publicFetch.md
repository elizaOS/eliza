# Public page fetch

The native host fetches a public HTTPS page on the agent's behalf: one
request, or a short chain of same-origin redirects. This spec owns address
admission, response bounds, redirect following and retained pages; what
the agent does with the text is its caller's.

## Story: Read a public web page without granting another action

> As a user, I want the agent to read only public pages on the site it was
> asked about, so that a fetch can never reach my network or carry my
> secrets, and reading a page grants it no other authority.

### A request connects only to a checked public address

A request needs an absolute HTTPS URL without credentials. A literal IP
must be public; a named host must resolve to at least one address, every
answer public and one of the requested family, and the connection uses
the answer that was checked. Requests carry no shared connection, no
cookies and no automatic redirects. A response is accepted only with a
status from 200 to 599, a body of at most 8 MiB and a successful decode;
anything else leaves no response. Every request is limited to ten seconds,
combined with the caller's cancellation signal, and the returned response
carries no cookie-setting or transport headers. The network classifier and the decoder
supply their verdicts.

```quint
type PublicFetchRequest = { urlParsed: bool, https: bool, credentialFree: bool, literalIp: bool,
  publicLiteral: bool, acceptedDns: bool, answerCount: int, allPublic: bool, hasFamilyMatch: bool }
pure val responseByteLimit = 8388608
pure def publicConnectAdmitted(request: PublicFetchRequest): bool =
  request.urlParsed and request.https and request.credentialFree and
  (if (request.literalIp) request.publicLiteral else
    request.acceptedDns and request.answerCount > 0 and request.allPublic and request.hasFamilyMatch)
pure def publicResponseAdmitted(receivedBytes: int, statusCode: int, decoded: bool, responseBuilt: bool): bool =
  receivedBytes >= 0 and receivedBytes <= responseByteLimit and statusCode >= 200 and statusCode <= 599 and decoded and responseBuilt
pure def lawCredentialedUrlCannotConnect(request: PublicFetchRequest): bool =
  not(request.credentialFree) implies not(publicConnectAdmitted(request))
pure def lawLargeTransportResponseRefused(receivedBytes: int, statusCode: int, decoded: bool, responseBuilt: bool): bool =
  receivedBytes > responseByteLimit implies not(publicResponseAdmitted(receivedBytes, statusCode, decoded, responseBuilt))
pure val publicHost: PublicFetchRequest = { urlParsed: true, https: true, credentialFree: true, literalIp: false,
  publicLiteral: false, acceptedDns: true, answerCount: 1, allPublic: true, hasFamilyMatch: true }
pure val requestValues = Set(publicHost, { ...publicHost, credentialFree: false }, { ...publicHost, allPublic: false },
  { ...publicHost, answerCount: 0 }, { ...publicHost, hasFamilyMatch: false }, { ...publicHost, literalIp: true, publicLiteral: true },
  { ...publicHost, literalIp: true, publicLiteral: false })
pure val receivedBytesValues = Set(0, 8388608, 8388609)
pure val statusCodeValues = Set(101, 200, 204, 301, 599, 600)
```

### Every hop stays on the current origin and carries no detected secret query

The host follows a link, and any redirects, itself: at most four
requests, each on the exact current HTTPS origin, without credentials and
without a query value the secret detector flags, and each checked again
before it connects. The final response must succeed with HTML of at most
400,000 characters. The text the caller receives is stripped of markup
and redacted; an unbroken run longer than 2,000 characters is replaced by
an omission marker, and text longer than 96,000 characters is cut there
with a marker that counts what was omitted, so complete and visibly
incomplete text stay distinct. A truncated excerpt cannot attest a task
outcome. A
fetched page never grants a browser action.

```quint
type HopFacts = { allowedAddress: bool, exactOrigin: bool, hasSecretQuery: bool, parentAborted: bool }
type HopFollow = ReadPageHtml | FollowLocation | RefuseResponse
pure val hopLimit = 4
pure val htmlLimit = 400000
pure val requestTimeoutMs = 10000
pure val runLimit = 2000
pure val textLimit = 96000
type PageText = { units: int, omitted: int }
pure def boundedText(normalizedUnits: int): PageText =
  if (normalizedUnits > textLimit) { units: textLimit, omitted: normalizedUnits - textLimit } else { units: normalizedUnits, omitted: 0 }
pure def lawTextBoundedAndCountsOmission(normalizedUnits: int): bool = {
  val text = boundedText(normalizedUnits)
  normalizedUnits >= 0 implies text.units <= textLimit and text.units + text.omitted == normalizedUnits and (text.omitted > 0 iff normalizedUnits > textLimit)
}
pure val normalizedUnitsValues = Set(0, 96000, 96001, 400000)
pure def admitsHop(hopsUsed: int, hopFacts: HopFacts): bool =
  hopsUsed >= 0 and hopsUsed < hopLimit and hopFacts.allowedAddress and hopFacts.exactOrigin and
  not(hopFacts.hasSecretQuery or hopFacts.parentAborted)
pure def responseNext(hopsUsed: int, redirectStatus: bool, hasLocation: bool, locationParsed: bool,
  httpOk: bool, htmlContent: bool, htmlUnits: int): HopFollow =
  if (redirectStatus and hasLocation)
    (if (hopsUsed < hopLimit and locationParsed) FollowLocation else RefuseResponse)
  else if (httpOk and htmlContent and htmlUnits >= 0 and htmlUnits <= htmlLimit) ReadPageHtml
  else RefuseResponse
pure def lawFourthRedirectCannotFetchMore(redirectStatus: bool, hasLocation: bool, locationParsed: bool,
  httpOk: bool, htmlContent: bool, htmlUnits: int): bool =
  responseNext(hopLimit, redirectStatus, hasLocation, locationParsed, httpOk, htmlContent, htmlUnits) != FollowLocation
pure val sameSiteHop: HopFacts = { allowedAddress: true, exactOrigin: true, hasSecretQuery: false, parentAborted: false }
pure val hopFactsValues = Set(sameSiteHop, { ...sameSiteHop, exactOrigin: false },
  { ...sameSiteHop, hasSecretQuery: true }, { ...sameSiteHop, parentAborted: true }, { ...sameSiteHop, allowedAddress: false })
pure val hopsUsedValues = Set(-1, 0, 1, 3, 4)
pure val htmlUnitsValues = Set(0, 1, 400000, 400001)
```

## Story: Reuse a fetched page only for the same link while it is fresh

> As a user, a page kept from an earlier visit is used again only for the
> same link, and only while it is fresh.

### A retained page is reused only for its exact link, and a sweep keeps only fresh pages

A page is retained only from an admitted fetch, keyed by the exact link it
was fetched for, and reused for that link while it is younger than
fourteen days. A sweep drops pages at that age and keeps at most the fifty
newest. Every page a sweep keeps is still usable for its own link, and no
page is ever used for another link. A retained page grants no step and
changes no task.

```quint
pure val retainedTtlMs = 1209600000
pure val retainedLimit = 50
pure def retainedUsable(hasText: bool, exactLink: bool, ageMs: int): bool = hasText and exactLink and ageMs >= 0 and ageMs < retainedTtlMs
pure def keptOnSweep(ageMs: int, newestRank: int): bool = ageMs >= 0 and ageMs < retainedTtlMs and newestRank >= 0 and newestRank < retainedLimit
pure def lawSweepKeepsOnlyUsablePages(hasText: bool, exactLink: bool, ageMs: int, newestRank: int): bool =
  (keptOnSweep(ageMs, newestRank) and hasText implies retainedUsable(hasText, true, ageMs)) and not(retainedUsable(hasText, false, ageMs))
pure val ageMsValues = Set(-1, 0, 1209599999, 1209600000, 1209600001)
pure val newestRankValues = Set(0, 49, 50)
```
