# Reviewed scan links

[Local OCR](../localOcr.md) supplies a scan's text, and [browser page
requests](../../os/index.md) govern the
external-link bridge. This spec governs which exact URLs the current scan offers and when
a click or completion can act on that review.

## Story: Review links in my scanned text and open the one I choose

> As the owner, I want links found in a scan to open only when I choose
> one, at exactly the address I reviewed.

### Only recognized explicit URL tokens enter the review list

Use a string of at most 100,000 UTF-16 units. A token starts a
string or follows whitespace or an opening delimiter in the scanner
pattern, begins with HTTP, HTTPS or `www.` case-insensitively, and
ends before whitespace, angle brackets, quotes or a backtick. Strip
trailing period, comma and semicolon and excess closing parentheses,
brackets or braces. An explicit scheme followed immediately by slash,
question mark or hash is refused. Reject a candidate over 2,048 units
or one containing backslash or ASCII control characters. Prepend
`https://` for the recognized `www.` form. The parsed address must be an
HTTP or HTTPS address with a hostname and empty username and password.
Show the first ten distinct serialized addresses in encounter order.
Invalid candidates stay in the editable text.

```quint
type ScanUrlFacts = { textString: bool, textUnits: int, explicitPrefix: bool, boundaryRecognized: bool,
  tokenUnits: int, badAuthorityStart: bool, invalidCharacter: bool,
  parsed: bool, permittedProtocol: bool, hostname: bool, hasCredentials: bool }
pure def admitsScanLink(urlFacts: ScanUrlFacts): bool =
  urlFacts.textString and urlFacts.textUnits >= 0 and urlFacts.textUnits <= 100000 and
  urlFacts.explicitPrefix and urlFacts.boundaryRecognized and urlFacts.tokenUnits > 0 and urlFacts.tokenUnits <= 2048 and
  not(urlFacts.badAuthorityStart or urlFacts.invalidCharacter) and urlFacts.parsed and urlFacts.permittedProtocol and
  urlFacts.hostname and not(urlFacts.hasCredentials)
pure def addScanLink(urls: List[str], address: str, urlFacts: ScanUrlFacts): List[str] =
  if (admitsScanLink(urlFacts) and address != "" and urls.length() < 10 and not(urls.includes(address)))
    urls.append(address)
  else urls
pure def lawScanKeepsOnlyOneCopy(urls: List[str], address: str, urlFacts: ScanUrlFacts): bool =
  urls.includes(address) implies addScanLink(urls,address,urlFacts) == urls
pure def lawScanLinkListStopsAtTen(urls: List[str], address: str, urlFacts: ScanUrlFacts): bool =
  urls.length() >= 10 implies addScanLink(urls,address,urlFacts) == urls
pure val cleanUrl: ScanUrlFacts = { textString: true, textUnits: 100, explicitPrefix: true, boundaryRecognized: true,
  tokenUnits: 25, badAuthorityStart: false, invalidCharacter: false, parsed: true, permittedProtocol: true,
  hostname: true, hasCredentials: false }
pure val urlFactsValues = Set(cleanUrl, { ...cleanUrl, textUnits: 100001 }, { ...cleanUrl, tokenUnits: 2049 },
  { ...cleanUrl, badAuthorityStart: true }, { ...cleanUrl, hasCredentials: true },
  { ...cleanUrl, explicitPrefix: false }, { ...cleanUrl, invalidCharacter: true }, { ...cleanUrl, parsed: false })
```

### An explicit click rechecks ownership and a late result cannot update edited text

The review rebuilds its link list and clears status when text updates.
It hides the list when empty. A click rechecks that the review is
active, no native request is already pending, and the displayed
exact address still occurs in the current normalized list. On web,
a valid link opens in a new context with no opener and no referrer.
On the device, the exact address goes to the device's external link
handler. Only one such request can be pending. Its result clears the
busy flag and is shown only when the review is still active and the text
is the one it was dispatched from. An edit clears the shown result while
the original request stays pending, and a dispatched handoff can settle
after closing.

```quint
type LinkStatus = NoLinkStatus | LinkOpening | LinkOpened | LinkFailed
type ScanLinkReview = { generation: int, flight: int, status: LinkStatus }
pure val initial: ScanLinkReview = { generation: 1, flight: 0, status: NoLinkStatus }
pure def canRefreshLinks(s: ScanLinkReview): bool = s.generation > 0
pure def refreshLinks(s: ScanLinkReview): ScanLinkReview = { ...s, generation: s.generation + 1, status: NoLinkStatus }
pure def allowsScanLinkClick(s: ScanLinkReview, active: bool, exactAddress: bool): bool =
  active and exactAddress and s.flight == 0
pure def canOpenNativeScanLink(s: ScanLinkReview, active: bool, exactAddress: bool): bool =
  allowsScanLinkClick(s,active,exactAddress)
pure def openNativeScanLink(s: ScanLinkReview, active: bool, exactAddress: bool): ScanLinkReview =
  { ...s, flight: s.generation, status: LinkOpening }
pure def canFinishNativeScanLink(s: ScanLinkReview, token: int): bool = token > 0 and token == s.flight
pure def finishNativeScanLink(s: ScanLinkReview, token: int, active: bool, opened: bool): ScanLinkReview =
  { ...s, flight: 0, status: if (active and token == s.generation) (if (opened) LinkOpened else LinkFailed) else s.status }
pure def alwaysScanLinkFlightInHistory(s: ScanLinkReview): bool =
  s.generation >= 1 and s.flight >= 0 and s.flight <= s.generation
pure def stepScanLinkRefreshKeepsPending(before: ScanLinkReview, via: str, after: ScanLinkReview): bool =
  via == "refreshLinks" implies after.flight == before.flight and after.status == NoLinkStatus
pure def stepOldLinkCompletionLeavesReview(before: ScanLinkReview, via: str, after: ScanLinkReview): bool =
  via == "finishNativeScanLink" and before.flight != before.generation implies after.status == before.status
pure def lawInactiveLinkIsRefused(s: ScanLinkReview, exactAddress: bool): bool =
  not(allowsScanLinkClick(s,false,exactAddress))
pure def sometimesShowsOpenedScanLink(s: ScanLinkReview): bool = s.status == LinkOpened
pure def sometimesEditedWhileLinkPending(s: ScanLinkReview): bool = s.flight > 0 and s.flight < s.generation
pure val tokenValues = Set(1, 2, 3, 4)
```
