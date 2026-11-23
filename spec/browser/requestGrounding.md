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

### An open runs without my review only when my whole message asked to open that address

A grounded open is bound to the owner's current message only when that
whole message is a direct request to open exactly that address: the strict
command, a polite question, an everyday command or the bare address. An
address the owner only mentioned, one whose dots they spoke as words, and
a link of the page their message carried are grounding evidence alone: such
an open is offered unbound to the message, so the owner reviews it on the
phone before it loads.

```quint
pure def openBound(pageLink: bool, wholeMessageOpen: bool): bool = not(pageLink) and wholeMessageOpen
pure def lawAPageLinkIsAlwaysReviewed(wholeMessageOpen: bool): bool = not(openBound(true, wholeMessageOpen))
pure def lawOnlyMyWholeMessageOpenIsBound(pageLink: bool, wholeMessageOpen: bool): bool = openBound(pageLink, wholeMessageOpen) implies wholeMessageOpen
```

### An address I asked to open in a new tab opens there, never as an empty tab, and in a tab of its own only where the phone has one

When the owner's whole message asks to open an address in a new tab,
written as an address or with its dots spoken as words, the empty tab is not
offered for that message: the address opens as an open, grounded as any
proposed address is. An empty tab proposed for any other message, private
or not, stays the empty tab it was asked for. An open goes to a tab of its
own only on a phone that negotiated `browser.open-new-tab.v1`, and there
when the model asked for one or the owner's whole message, with the address
written as one, opened that same address in a new tab; anywhere else the
phone opens it as it always has.

```quint
type Placement = { proposedNewTab: bool, ownerAskedNewTab: bool, ownerAddressIsDestination: bool, newTabNegotiated: bool }
pure def opensInNewTab(placement: Placement): bool =
  placement.newTabNegotiated and (placement.proposedNewTab or (placement.ownerAskedNewTab and placement.ownerAddressIsDestination))
pure def emptyTabOffered(tabsNegotiated: bool, ownerOpensAddressInNewTab: bool): bool = tabsNegotiated and not(ownerOpensAddressInNewTab)
pure val askedPlacement: Placement = { proposedNewTab: false, ownerAskedNewTab: true, ownerAddressIsDestination: true, newTabNegotiated: true }
pure val placementValues = Set(askedPlacement, { ...askedPlacement, newTabNegotiated: false }, { ...askedPlacement, ownerAskedNewTab: false },
  { ...askedPlacement, ownerAddressIsDestination: false }, { ...askedPlacement, ownerAskedNewTab: false, proposedNewTab: true },
  { ...askedPlacement, ownerAskedNewTab: false, proposedNewTab: true, newTabNegotiated: false })
pure def lawAnAddressAskedInANewTabIsNeverAnEmptyTab(tabsNegotiated: bool): bool = not(emptyTabOffered(tabsNegotiated, true))
pure def lawATabOfItsOwnNeedsItsCapability(placement: Placement): bool = opensInNewTab(placement) implies placement.newTabNegotiated
pure def lawMyNewTabOpensWhereThePhoneHasOne(placement: Placement): bool =
  (placement.newTabNegotiated and placement.ownerAskedNewTab and placement.ownerAddressIsDestination) implies opensInNewTab(placement)
```
