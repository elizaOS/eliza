# Public website help retrieval and retained evidence

Grace `48b43b9ca6ade7b72c6488f92bee6d4a3ddcf154` uses the pinned
Eliza `7743504b7c936a764b3938a44cad918808b621df`
`packages/host/native-host/public-fetch.mjs` from `website-guide-planner.ts`
and `website-planner.ts`. AlphaPhone's Eliza pin retains the same
producer blob. This contract follows Grace's guide from the selected
help link through public address admission and current inference.
[Website guidance](./websiteGuide.md) owns the resulting instruction.

## Story: Read help from the current public website without granting another action

### A request connects only to a checked public address

The shared producer parses an absolute HTTPS URL without a username
or password. A literal IP must pass the pinned address classifier.
A named host is resolved for the connection itself. It needs a
nonempty answer and every answer must be a valid public address.
The result honors the requested address family and the scalar or
list lookup form. The pinned network classifier owns the IP
ranges and transition-address treatment. The effect uses the
same resolver answer it checked and refuses an empty family
selection. The request uses TLS, no shared connection agent,
no ambient cookie container and no automatic redirect follow.
The guide supplies only its HTML request header. The generic helper
passes through explicitly supplied headers, method, body, and
caller cancellation, so those inputs are not a credential filter.

The shared transport limits received bytes to 8 MiB.
Supported compressed bodies pass through a bounded decoder
before building the returned response. The pin sets the decoder
output limit to 8 MiB plus one byte. It strips cookie-setting and
transport headers. A malformed URL, unadmitted address, failed
resolve, unrecognized HTTP status or decoding failure leaves no
accepted response. The model receives the network classifier and
codec verdicts rather than duplicating address parsing.

```quint
type PublicFetchRequest = { urlParsed: bool, https: bool, credentialFree: bool, literalIp: bool,
  publicLiteral: bool, acceptedDns: bool, answerCount: int, allPublic: bool, hasFamilyMatch: bool }
pure def publicConnectAdmitted(request: PublicFetchRequest): bool =
  request.urlParsed and request.https and request.credentialFree and
  (if (request.literalIp) request.publicLiteral else
    request.acceptedDns and request.answerCount > 0 and request.allPublic and request.hasFamilyMatch)
pure def publicResponseAdmitted(receivedBytes: int, statusCode: int, decoded: bool, responseBuilt: bool): bool =
  receivedBytes >= 0 and receivedBytes <= 8388608 and statusCode >= 200 and statusCode <= 599 and decoded and responseBuilt
pure def lawNamedConnectionNeedsAllPublic(request: PublicFetchRequest): bool =
  not(request.literalIp) and publicConnectAdmitted(request) implies
    request.acceptedDns and request.answerCount > 0 and request.allPublic and request.hasFamilyMatch
pure def lawCredentialedUrlCannotConnect(request: PublicFetchRequest): bool =
  not(request.credentialFree) implies not(publicConnectAdmitted(request))
pure def lawLargeTransportResponseRefused(receivedBytes: int, statusCode: int, decoded: bool, responseBuilt: bool): bool =
  receivedBytes > 8388608 implies not(publicResponseAdmitted(receivedBytes,statusCode,decoded,responseBuilt))
pure val publicHost: PublicFetchRequest = { urlParsed:true,https:true,credentialFree:true,literalIp:false,
  publicLiteral:false,acceptedDns:true,answerCount:1,allPublic:true,hasFamilyMatch:true }
pure val requestValues = Set(publicHost,{ ...publicHost,credentialFree:false },{ ...publicHost,allPublic:false },
  { ...publicHost,answerCount:0 },{ ...publicHost,hasFamilyMatch:false },{ ...publicHost,literalIp:true,publicLiteral:true },
  { ...publicHost,literalIp:true,publicLiteral:false })
pure val receivedBytesValues = Set(0,8388608,8388609)
pure val statusCodeValues = Set(101,200,204,301,599,600)
```

### Every help hop stays on the current origin and carries no detected secret query

A needs-help plan can select its observed reference with a link,
or the first observed help, FAQ, support, payment or questions link.
Every fetch attempt requires the exact current HTTPS origin, no URL
credentials and no query value selected by the secret detector. The
guide follows redirects itself for four total requests. A resolved next
target is checked again before connecting. A missing redirect location
ends the chain and the final response still needs success and HTML.
The caller's signal is combined with a ten-second limit per request.
An injected transport requires a preliminary public-name check and is
used in controlled scenarios. The production transport checks the actual
connection address.

The source removes script, style and noscript content, then strips
markup and decodes the supported common entities. It throws 413 above
400,000 UTF-16 units of HTML and submits the permitted redacted text to
the planner. The pin replaces unbroken runs above 2,000 with an omission
marker and caps normalized text at 96,000 units with an explicit
omission marker and count. Preserve the distinction between complete
and visibly incomplete source text. The replacement can reject material
that fails its full-source admission. A truncated help excerpt cannot
attest a task outcome. Fetch failure in the
outer guide keeps the needs-help path. If it still lacks a target,
it shows the observed link as a person step. Help evidence never grants
a browser action.

```quint
type HelpHopFacts = { allowedAddress: bool, exactOrigin: bool, hasSecretQuery: bool, parentAborted: bool }
type HelpFollow = ReadHelpHtml | FollowHelpLocation | RefuseHelpResponse
pure def admitsHelpHop(hopsUsed: int, hopFacts: HelpHopFacts): bool =
  hopsUsed >= 0 and hopsUsed < 4 and hopFacts.allowedAddress and hopFacts.exactOrigin and
  not(hopFacts.hasSecretQuery or hopFacts.parentAborted)
pure def helpResponseNext(hopsUsed: int, redirectStatus: bool, hasLocation: bool, locationParsed: bool,
  httpOk: bool, htmlContent: bool, htmlUnits: int): HelpFollow =
  if (redirectStatus and hasLocation)
    (if (hopsUsed < 4 and locationParsed) FollowHelpLocation else RefuseHelpResponse)
  else if (httpOk and htmlContent and htmlUnits >= 0 and htmlUnits <= 400000) ReadHelpHtml
  else RefuseHelpResponse
pure def lawHelpCannotCrossOrigin(hopsUsed: int, hopFacts: HelpHopFacts): bool =
  admitsHelpHop(hopsUsed,hopFacts) implies hopFacts.exactOrigin and not(hopFacts.hasSecretQuery)
pure def lawFourthRedirectCannotFetchMore(redirectStatus: bool, hasLocation: bool, locationParsed: bool,
  httpOk: bool, htmlContent: bool, htmlUnits: int): bool =
  helpResponseNext(4,redirectStatus,hasLocation,locationParsed,httpOk,htmlContent,htmlUnits) != FollowHelpLocation
pure val sameSiteHelp: HelpHopFacts = {allowedAddress:true,exactOrigin:true,hasSecretQuery:false,parentAborted:false}
pure val hopFactsValues = Set(sameSiteHelp,{ ...sameSiteHelp,exactOrigin:false },
  { ...sameSiteHelp,hasSecretQuery:true },{ ...sameSiteHelp,parentAborted:true },{ ...sameSiteHelp,allowedAddress:false })
pure val hopsUsedValues = Set(-1,0,1,3,4)
pure val htmlUnitsValues = Set(0,1,400000,400001)
```

## Story: Use retained public help only for the same observed link

### The retained entry is exact, redacted and expires independently of task results

The planner looks up help after a needs-help decision by exact observed
href. A nonempty in-memory entry is reused through the exact 14-day
boundary. A disk-load or save sweep removes entries at that boundary and
keeps at most 50 help entries in descending observed time. Invalid
file decoding or a different version starts an empty cache. Production
uses the account's existing task-key codec. Cache failures do not grant
a step or change the user's task. A retained help entry is produced only
from the admitted origin and response path. The pinned reuse path keys
by href and does not re-fetch to recheck the origin. A cache hit supplies
guidance evidence and the guide validates the resulting plan against its
current page. The model represents the known-good retained entry, not
vault sealing or legacy bytes.

```quint
pure val helpTtlMs = 1209600000
pure def helpUsableInMemory(hasText: bool, exactHref: bool, ageMs: int): bool =
  hasText and exactHref and ageMs <= helpTtlMs
pure def helpRetainedOnSweep(ageMs: int, newestRank: int): bool =
  ageMs < helpTtlMs and newestRank >= 0 and newestRank < 50
pure def lawOtherHelpHrefNeverReused(hasText: bool, ageMs: int): bool =
  not(helpUsableInMemory(hasText,false,ageMs))
pure def lawExpiredHelpNotRetained(ageMs: int, newestRank: int): bool =
  ageMs >= helpTtlMs implies not(helpRetainedOnSweep(ageMs,newestRank))
pure val ageMsValues = Set(-1,0,1209599999,1209600000,1209600001)
pure val newestRankValues = Set(0,49,50)
```
