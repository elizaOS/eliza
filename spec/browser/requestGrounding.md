# Browser request grounding

The browser opens a destination only when the current message grounds it.
The device's [browser tab document](../os/browser/tabHost/reading.md#a-visible-commit-must-come-from-the-current-tab)
owns which visits commit; this spec owns admission from the current message.

## Story: Open a destination stated in this message

> As the person, I want the browser to open only a destination I wrote in this
> message, and never one I said not to open.

### A negated destination cannot be authorized by a proposal

A whole-message strict command can bypass model judgment. A recognized
direct question, everyday command, or bare address can be offered through
the direct client route. A URL mention supplies grounding evidence for a
model proposal without authorizing automatic navigation. A refused or
negated occurrence vetoes the host even if another occurrence asks to open
it, including host spellings that are recognized as words but refused as
URLs. A proposed HTTPS destination must have the same normalized host
and port as an admitted user-written candidate. Address, path and query
evidence select among the user's candidates. Exact href wins, then the
same authored path and query, then a bare address of the same hostname,
then a bare address with equivalent leading-www normalization. Result
spelling always comes from the selected user address. A bare host cannot
grant a model-invented path. Typed file-extension-like suffixes require
the producer's affirmative web signal.

```quint
type GroundedAddress = { authoredHref: str, qualifies: bool, rank: int }
pure val noGroundedAddress: GroundedAddress = { authoredHref: "", qualifies: false, rank: 0 }
pure def candidatesAtRank(rank: int, candidates: List[GroundedAddress]): List[GroundedAddress] =
  candidates.select(c => c.qualifies and c.rank == rank)
pure def orderedDestination(candidates: List[GroundedAddress]): GroundedAddress =
  candidatesAtRank(1, candidates).concat(candidatesAtRank(2, candidates)).concat(candidatesAtRank(3, candidates)).concat(candidatesAtRank(4, candidates)).nthOr(0, noGroundedAddress)
pure def groundProposedDestination(readable: bool, https: bool, vetoed: bool, candidates: List[GroundedAddress]): str =
  if (readable and https and not(vetoed)) orderedDestination(candidates).authoredHref else ""
pure def directDestination(readable: bool, classifiedDirect: bool, directHref: str): str =
  if (readable and classifiedDirect) directHref else ""
pure val candidatesValues = Set(
  List(),
  List({ authoredHref: "https://example.com/", qualifies: true, rank: 3 }),
  List({ authoredHref: "https://example.com/first", qualifies: true, rank: 2 }, { authoredHref: "https://example.com/second", qualifies: true, rank: 1 })
)
pure def lawNegationVetoesGrounding(readable: bool, https: bool, candidates: List[GroundedAddress]): bool =
  groundProposedDestination(readable, https, true, candidates) == ""
pure def lawMentionDoesNotEnableDirect(readable: bool, directHref: str): bool =
  directDestination(readable, false, directHref) == ""
pure def lawGroundingPreservesAuthoredSpelling(readable: bool, https: bool, vetoed: bool, candidates: List[GroundedAddress]): bool = {
  val result = groundProposedDestination(readable, https, vetoed, candidates)
  result != "" implies candidates.some(c => c.qualifies and c.authoredHref == result)
}
```

### A page link opens only as an exact link of the page my message carried, and only after my review

Besides an address the owner typed, a proposed destination may be one of
the links of the Browser page the owner's current message carried, bound to
that message's observation: the non-sensitive Browser view selecting that
tab at that revision. The proposed address, read as an HTTPS address with
its fragment dropped, must equal one of those links exactly, and the
destination is the page's own spelling of it. A typed address wins over a
link, a host the owner refused opens through no link, and a message with
no such page grounds no link. A page link is never a direct request: it is
offered unbound to the message, so the owner reviews it on the phone.

```quint
pure def pageLinkDestination(readable: bool, https: bool, vetoed: bool, candidates: List[GroundedAddress], pageLinks: List[str], proposedLink: str): str = {
  val typed = groundProposedDestination(readable, https, vetoed, candidates)
  if (typed != "") typed
  else if (readable and https and not(vetoed) and pageLinks.includes(proposedLink)) proposedLink
  else ""
}
pure val pageLinksValues = Set(List(), List("https://one.example/story"), List("https://one.example/story", "https://two.example/post?id=2"))
pure val proposedLinkValues = Set("https://one.example/story", "https://two.example/post?id=3", "")
pure def lawARefusedHostOpensNoPageLink(readable: bool, https: bool, candidates: List[GroundedAddress], pageLinks: List[str], proposedLink: str): bool =
  pageLinkDestination(readable, https, true, candidates, pageLinks, proposedLink) == ""
pure def lawAPageLinkIsOneOfThePagesLinks(readable: bool, https: bool, vetoed: bool, candidates: List[GroundedAddress], pageLinks: List[str], proposedLink: str): bool = {
  val result = pageLinkDestination(readable, https, vetoed, candidates, pageLinks, proposedLink)
  (result != "" and groundProposedDestination(readable, https, vetoed, candidates) == "") implies pageLinks.includes(result)
}
pure def lawWithoutAPageOnlyTypedAddressesGround(readable: bool, https: bool, vetoed: bool, candidates: List[GroundedAddress], proposedLink: str): bool =
  pageLinkDestination(readable, https, vetoed, candidates, List(), proposedLink) == groundProposedDestination(readable, https, vetoed, candidates)
```

### An address the model proposes for a site my message does not name opens only after my review

The owner may name a site without typing its address ("take me to the New
York Times site"), and the model may then propose the address it knows for
it. A proposed address that neither the owner's message nor the page it
carried grounds (above) is still offered when it is a valid web address:
HTTPS, every label well formed, a top-level domain IANA lists, and no port.
It is always offered unbound to the message, so the owner reviews it on the
phone before it loads. This holds only for a host the owner's message does
not name at all, typed, spoken or split across words: an address whose host
the message names is decided by the owner's words as above, so a host the
owner refused, or an open they took back, is never offered. A message that
cannot be read offers nothing, and an address that is not valid is refused
as before. Whether the words ask for a site at all
is the model's to judge; the card is the owner's check.

```quint
pure def proposedDestination(linked: str, readable: bool, validAddress: bool, hostNamed: bool, proposedAddress: str): str =
  if (linked != "") linked else if (readable and validAddress and not(hostNamed)) proposedAddress else ""
pure val linkedValues = Set("", "https://one.example/story")
pure val proposedAddressValues = Set("", "https://news.example/")
pure def lawAHostMyMessageNamesIsDecidedByMyWords(readable: bool, validAddress: bool, proposedAddress: str): bool =
  proposedDestination("", readable, validAddress, true, proposedAddress) == ""
pure def lawAnInvalidAddressIsNeverProposed(readable: bool, hostNamed: bool, proposedAddress: str): bool =
  proposedDestination("", readable, false, hostNamed, proposedAddress) == ""
pure def lawAnUnreadableMessageProposesNoUnstatedAddress(validAddress: bool, hostNamed: bool, proposedAddress: str): bool =
  proposedDestination("", false, validAddress, hostNamed, proposedAddress) == ""
```

### An open runs without my review only when my whole message asked to open that address

A grounded open is bound to the owner's current message only when that
whole message is a direct request to open exactly that address: the strict
command, a polite question, an everyday command or the bare address. An
address the owner only mentioned, one whose dots they spoke as words, and
a link of the page their message carried are grounding evidence alone: such
an open is offered unbound to the message, so the owner reviews it on the
phone before it loads, as is an address the model proposed that the message
does not state (above).

```quint
pure def openBound(pageLink: bool, wholeMessageOpen: bool): bool = not(pageLink) and wholeMessageOpen
pure def lawAPageLinkIsAlwaysReviewed(wholeMessageOpen: bool): bool = not(openBound(true, wholeMessageOpen))
pure def lawOnlyMyWholeMessageOpenIsBound(pageLink: bool, wholeMessageOpen: bool): bool = openBound(pageLink, wholeMessageOpen) implies wholeMessageOpen
```

### A closing mark that could belong to the address leaves the open for my review

In an open command or request, a period, comma, exclamation or question
mark that ends the message after a bare host is the sentence's, and the message still
opens that host: "Open Reddit.com!" opens reddit.com. After a typed path,
query or fragment the mark may be the address's own: where the address
differs with and without it, as in "open nytimes.com/section/world.", the
message is not a direct request to open it. A message that is the address
alone is a direct request only as typed: a closing mark that changes it, as
in "example.com?!", or leaves no address, as in "example.com.", makes it no
direct request either. The address such a message grounds is offered
unbound to the message, so the owner reviews it before it loads. A mark
that leaves the address the same, such as an empty query, keeps the
whole-message open.

```quint
pure def closingMarkIsProse(addressAlone: bool, afterTypedPath: bool, markChangesAddress: bool): bool =
  not(markChangesAddress and (addressAlone or afterTypedPath))
pure def lawAMarkAfterABareHostInACommandIsProse(markChangesAddress: bool): bool = closingMarkIsProse(false, false, markChangesAddress)
pure def lawAMarkThatChangesATypedPathOpensNothingDirectly(readable: bool, addressAlone: bool, directHref: str): bool =
  directDestination(readable, closingMarkIsProse(addressAlone, true, true), directHref) == ""
pure def lawAMarkThatChangesAnAddressAloneOpensNothingDirectly(readable: bool, afterTypedPath: bool, directHref: str): bool =
  directDestination(readable, closingMarkIsProse(true, afterTypedPath, true), directHref) == ""
pure def lawAMarkThatLeavesTheAddressKeepsTheOpen(addressAlone: bool, afterTypedPath: bool): bool = closingMarkIsProse(addressAlone, afterTypedPath, false)
```

### An address opens in a tab of its own only when the model asked for one and the phone has one, and an empty tab stays empty

Whether the owner wants an address in a new tab is the model's to read: it
asks for one with the open's own new-tab argument, and the tool tells it to
open an address with an open, never with an empty tab. An open goes to a
tab of its own only on a phone that negotiated `browser.open-new-tab.v1`
and only when the model asked for one; anywhere else the phone opens it as
it always has. No reading of the owner's words moves an open to a new tab
or turns a proposed empty tab into an open: an empty tab, private or not,
is the empty tab that was proposed.

```quint
type Placement = { proposedNewTab: bool, newTabNegotiated: bool }
pure def opensInNewTab(placement: Placement): bool = placement.newTabNegotiated and placement.proposedNewTab
pure val placementValues = Set({ proposedNewTab: true, newTabNegotiated: true }, { proposedNewTab: true, newTabNegotiated: false },
  { proposedNewTab: false, newTabNegotiated: true }, { proposedNewTab: false, newTabNegotiated: false })
pure def lawATabOfItsOwnNeedsItsCapability(placement: Placement): bool = opensInNewTab(placement) implies placement.newTabNegotiated
pure def lawOnlyTheModelsRequestOpensANewTab(placement: Placement): bool = opensInNewTab(placement) implies placement.proposedNewTab
pure def lawTheModelsNewTabOpensWhereThePhoneHasOne(placement: Placement): bool =
  (placement.newTabNegotiated and placement.proposedNewTab) implies opensInNewTab(placement)
```
