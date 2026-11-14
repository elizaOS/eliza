# Alpha reviewed scan links

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` uses
`apps/app/src/prototype/scan-link-review.ts` and Eliza's
`plugins/plugin-files/src/documents/scan-links.ts` at
`c518127a025ab173874af9c7d304f26b25213b0d`.
[Local OCR](./localOcr.md) supplies its starting text, and
[native browser handoff](../mobileBrowser.md) governs the bridge.
This contract governs which exact URLs the current scan offers and
when a click or completion can act on that review.

## Story: Review links in my scanned text and open the one I choose

### Only recognized explicit URL tokens enter the review list

Use a string of at most 100,000 UTF-16 units. A token starts a
string or follows whitespace or an opening delimiter in the scanner
pattern, begins with HTTP, HTTPS or `www.` case-insensitively, and
ends before whitespace, angle brackets, quotes or a backtick. Strip
trailing period, comma and semicolon and excess closing parentheses,
brackets or braces. An explicit scheme followed immediately by slash,
question mark or hash is refused. Reject a candidate over 2,048 units
or one containing backslash or ASCII control characters. Prepend
`https://` for the recognized `www.` form. The URL codec must supply an
HTTP or HTTPS address with a hostname and empty username and password.
Show the first ten distinct serialized addresses in encounter order.
Invalid candidates stay in the editable text. The exact delimiter
pattern, balanced punctuation and WHATWG URL serialization belong to
the codec port.

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
On native, prevent the browser default and send the exact address
to DailyApps. Only one native request can be pending. Receive its
status or rejection, clear the busy flag, and publish feedback only
when the review is still active and the generation matches dispatch.
An edit can clear the visual status while the original request stays
busy. A dispatched handoff can settle after closing. This
model takes current review activity and parsed exact membership as
caller observations.

```quint
type ScanLinkReview = { generation: int, flight: int, status: str }
pure val initial: ScanLinkReview = { generation: 1, flight: 0, status: "" }
pure def canRefreshLinks(s: ScanLinkReview): bool = s.generation > 0
pure def refreshLinks(s: ScanLinkReview): ScanLinkReview = { ...s, generation: s.generation + 1, status: "" }
pure def allowsScanLinkClick(s: ScanLinkReview, active: bool, exactAddress: bool): bool =
  active and exactAddress and s.flight == 0
pure def canOpenNativeScanLink(s: ScanLinkReview, active: bool, exactAddress: bool): bool =
  allowsScanLinkClick(s,active,exactAddress)
pure def openNativeScanLink(s: ScanLinkReview, active: bool, exactAddress: bool): ScanLinkReview =
  { ...s, flight: s.generation, status: "opening" }
pure def canFinishNativeScanLink(s: ScanLinkReview, token: int): bool = token > 0 and token == s.flight
pure def finishNativeScanLink(s: ScanLinkReview, token: int, active: bool, opened: bool): ScanLinkReview =
  { ...s, flight: 0, status: if (active and token == s.generation) (if (opened) "opened" else "failed") else s.status }
pure def alwaysScanLinkFlightInHistory(s: ScanLinkReview): bool =
  s.generation >= 1 and s.flight >= 0 and s.flight <= s.generation
pure def stepScanLinkRefreshKeepsPending(before: ScanLinkReview, via: str, after: ScanLinkReview): bool =
  via == "refreshLinks" implies after.flight == before.flight and after.status == ""
pure def stepOldLinkCompletionLeavesReview(before: ScanLinkReview, via: str, after: ScanLinkReview): bool =
  via == "finishNativeScanLink" and before.flight != before.generation implies after.status == before.status
pure def lawInactiveLinkIsRefused(s: ScanLinkReview, exactAddress: bool): bool =
  not(allowsScanLinkClick(s,false,exactAddress))
pure def sometimesShowsOpenedScanLink(s: ScanLinkReview): bool = s.status == "opened"
pure def sometimesEditedWhileLinkPending(s: ScanLinkReview): bool = s.flight > 0 and s.flight < s.generation
pure val tokenValues = Set(1, 2, 3, 4)
```

Pinned `test/browser/scan-links.spec.ts` exercises edited current text,
an explicit native Open, blocked input, and distinct normalized
destinations in order. Native handler receipt and device browser
selection follow the linked browser handoff.
