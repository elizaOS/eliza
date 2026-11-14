# Google Calendar link publication in the Alpha account panel

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` mounts
`GoogleConnectionsPanel` from `apps/app/src/main.tsx`. The shipping
Calendar Settings row opens it through `settings-adapter.ts:900`. The
source owners are `runtime/google-connection-ui.tsx:29–136,234–308`
and `runtime/google-connection-return.ts:2–8`.
[Google connection return](./managedGoogle.md) owns the OAuth trigger.
[Canonical Calendar sync control](./canonicalCalendarSync.md) owns the
control writes and sync readback after the panel calls the link helper.

## Story: Link Calendar using the Google account I have just verified

### Only the current account request can admit exact verified account rows

The Cloud binding includes the client object, environment, user,
organization, session and credential. A change in any coordinate, including
the client object alone, can retire a request. Opening from Calendar supplies
a fresh intent. Replacing only the intent aborts the previous link and
retains a verified account read for the same open panel. Closing aborts the
active request and removes the intent. Closing the modal also releases
phone inertness and restores focus. The mounted fixture checks the DOM
behavior.
A new account read owns its own controller, drops the verified rows and
clears the previous selection. A stale reply cannot adopt new rows or clear
a newer read's busy flag.

When a signed return names a Google connection, the first account
response is provisional until the exact connected grant is present.
The panel can display those returned rows while still withholding
verified admission. It waits 350 ms, with early abort, before a second
read and rechecks the request and captured return around the wait and
read. If the connection still does not appear, it reports
unverified. A successful read admits only the same row objects; when
the return named a grant, the continuation uses that grant's rows.
An accepted list reporting no connection is distinct from a failed
verification. The model takes exact row equivalence from the port.
Discovered by the proof: an open Calendar intent has a positive identity,
and ticket counters start at zero and then increase. This keeps a new
link ticket distinct from the zero marker for a settled link.

```quint
type AccountResult = NoConnection | CalendarReadOnly | CalendarWrite | AccountReadFailed
type LinkPhase = NoLink | CheckingAccess | WaitingHost | WaitingCalendar
type PanelNotice = QuietPanel | CheckingAccounts | AccountsVerified | AccountsUnverified | ConnectingCalendar | AccessUnavailable | AwaitingGoogle | SyncUnavailable | NeedsGrant | LinkReturned
pure val failedAccountRead: AccountResult = AccountReadFailed
pure val verifiedAccountsNotice: PanelNotice = AccountsVerified
type LinkPanel = { panelOpen: bool, authority: int, intent: int, scoped: bool, authorizing: bool, review: int,
  nextRead: int, readBusy: int, verifiedRead: int, grant: AccountResult, nextLink: int, linkBusy: int, linkPhase: LinkPhase,
  linkedReadBusy: int, notice: PanelNotice }
pure val initial: LinkPanel = { panelOpen: false, authority: 1, intent: 0, scoped: false, authorizing: false, review: 0,
  nextRead: 0, readBusy: 0, verifiedRead: 0, grant: AccountReadFailed, nextLink: 0, linkBusy: 0, linkPhase: NoLink,
  linkedReadBusy: 0, notice: QuietPanel }
pure def clearLinkWithAccountBusy(capturedReadBusy: int, s: LinkPanel): LinkPanel =
  { ...s, linkBusy: 0, linkPhase: NoLink, linkedReadBusy: 0, readBusy: capturedReadBusy }
pure def startAccountRead(ticket: int, s: LinkPanel): LinkPanel =
  { ...s, nextRead: ticket, readBusy: ticket, verifiedRead: 0, grant: AccountReadFailed, notice: CheckingAccounts }
pure def openCalendarPanel(s: LinkPanel): LinkPanel = {
  val opened = { ...clearLinkWithAccountBusy(s.readBusy, s), panelOpen: true, intent: s.intent + 1, scoped: true, authorizing: false, review: 0 }
  if (s.panelOpen) opened else startAccountRead(s.nextRead + 1, opened)
}
pure def canCloseCalendarPanel(s: LinkPanel): bool = s.panelOpen
pure def closeCalendarPanel(s: LinkPanel): LinkPanel =
  { ...clearLinkWithAccountBusy(s.readBusy, s), panelOpen: false, scoped: false, authorizing: false, review: 0, verifiedRead: 0 }
pure def replaceCloudBinding(s: LinkPanel): LinkPanel = {
  val replaced = { ...clearLinkWithAccountBusy(s.readBusy, s), authority: s.authority + 1, verifiedRead: 0, grant: failedAccountRead }
  if (s.panelOpen) startAccountRead(s.nextRead + 1, replaced) else replaced
}
pure def canReloadCalendarAccounts(s: LinkPanel): bool = s.panelOpen
pure def reloadCalendarAccounts(s: LinkPanel): LinkPanel = startAccountRead(s.nextRead + 1, s)
type AccountEvidence = { exactTicket: bool, exactOwner: bool, returnCurrent: bool, namedGrantMissing: bool, accountResult: AccountResult, willAutoLink: bool }
pure val accountVerified: AccountEvidence = { exactTicket: true, exactOwner: true, returnCurrent: true, namedGrantMissing: false, accountResult: CalendarWrite, willAutoLink: true }
pure val accountEvidenceValues = Set(accountVerified, { ...accountVerified, accountResult: CalendarReadOnly },
  { ...accountVerified, accountResult: AccountReadFailed }, { ...accountVerified, accountResult: NoConnection },
  { ...accountVerified, exactTicket: false }, { ...accountVerified, exactOwner: false },
  { ...accountVerified, returnCurrent: false }, { ...accountVerified, namedGrantMissing: true })
pure def canAcceptAccounts(s: LinkPanel): bool = s.readBusy > 0
pure def startOwnedLink(carriedReadTicket: int, s: LinkPanel): LinkPanel =
  { ...s, nextLink: s.nextLink + 1, linkBusy: s.nextLink + 1, linkPhase: CheckingAccess,
    linkedReadBusy: carriedReadTicket, notice: ConnectingCalendar }
pure def acceptAccounts(s: LinkPanel, accountEvidence: AccountEvidence): LinkPanel = {
  val verified = { ...s, verifiedRead: s.readBusy, grant: accountEvidence.accountResult, notice: verifiedAccountsNotice }
  if (not(accountEvidence.exactTicket)) s
  else if (not(s.panelOpen and accountEvidence.exactOwner and accountEvidence.returnCurrent)) { ...s, readBusy: 0 }
  else if (accountEvidence.accountResult == AccountReadFailed or accountEvidence.namedGrantMissing)
    { ...s, readBusy: 0, notice: AccountsUnverified }
  else if (s.authorizing and s.scoped and accountEvidence.willAutoLink and s.linkBusy == 0) startOwnedLink(s.readBusy, verified)
  else { ...verified, readBusy: 0 }
}
pure def panelBusy(s: LinkPanel): bool = s.readBusy > 0 or s.linkBusy > 0
pure def alwaysLinkTicketHasPhase(s: LinkPanel): bool = (s.linkBusy > 0) == (s.linkPhase != NoLink)
pure def alwaysPanelTicketsAreAllocated(s: LinkPanel): bool =
  s.intent >= 0 and (s.panelOpen implies s.intent > 0) and s.nextRead >= 0 and s.nextLink >= 0 and
    s.readBusy >= 0 and s.verifiedRead >= 0 and s.linkBusy >= 0 and s.linkedReadBusy >= 0
pure def alwaysVerifiedAccountsHaveReply(s: LinkPanel): bool =
  s.verifiedRead > 0 implies s.panelOpen and s.grant != AccountReadFailed
pure def sometimesVerifiedWithoutLink(s: LinkPanel): bool = s.verifiedRead > 0 and not(panelBusy(s))
pure val weight_openCalendarPanel = 1
pure val weight_replaceCloudBinding = 1
pure val weight_acceptAccounts = 7
```

### Current access admits the helper and stale completion clears only its own work

A manual Sync uses verified connected Calendar-write rows. Before native
or browser control, the panel captures the exact saved preference and
review receipt. Known-on is checked through persistence; off or
unreadable asks for the explicit Allow action. The allow action rechecks
the same intent, owner and account read before and after recapturing
preferences and uses the exact compare-and-set receipt. Storage and
its optional host publication are covered by the preference port. A
current Connect without a Calendar write grant asks Google for write
permission after this same access check and remembers authorization.
A verified subsequent read can carry its own busy token while its
auto-link proceeds. An unrelated account refresh can overlap a link.

The browser Cloud development stage also requires the exact
`residentGoogleCalendarAccess` credential and requested boolean echo
before calling the link helper. Admission failure ends authorization
and reports Sync unavailable only while that attempt is current.
Shipping Android does not call the browser Cloud host. The fixture
covers both origins using controlled ports.

After access succeeds, host/helper publication checks the exact link
controller, full Cloud authority, current Calendar intent and active
Calendar scope. Input row equality is checked at the initial admission
and again by access persistence before the helper starts. A later
independent account refresh does not by itself discard a current link
reply. A retired callback does not replace the notice, review or a
successor's busy flag. A needs-grant reply preserves the prior review
and authorization. Every other current result replaces the review,
including with no review, and ends authorization. Clearing an
auto-link's inherited account busy state checks that exact read ticket.

```quint
pure def canRequestCalendarAuthorization(s: LinkPanel): bool =
  s.panelOpen and s.scoped and s.verifiedRead > 0 and s.grant != CalendarWrite and not(panelBusy(s))
pure def requestCalendarAuthorization(s: LinkPanel, exactAccessSaved: bool): LinkPanel =
  if (exactAccessSaved) { ...s, authorizing: true, notice: AwaitingGoogle } else { ...s, notice: AccessUnavailable }
pure def canBeginCalendarLink(s: LinkPanel, exactRows: bool): bool =
  s.panelOpen and s.scoped and s.verifiedRead > 0 and s.grant == CalendarWrite and exactRows and not(panelBusy(s))
pure def beginCalendarLink(s: LinkPanel, exactRows: bool): LinkPanel = startOwnedLink(0, s)
pure def canChangeCalendarScope(s: LinkPanel, nextCurrent: bool): bool = s.panelOpen and s.scoped != nextCurrent
pure def changeCalendarScope(s: LinkPanel, nextCurrent: bool): LinkPanel = { ...s, scoped: nextCurrent }
pure def accountBusyAfterLink(s: LinkPanel): int = if (s.linkedReadBusy == s.readBusy) 0 else s.readBusy
type AccessEvidence = { exactLink: bool, exactRead: bool, accessSaved: bool, needsBrowserHost: bool }
pure val goodAccess: AccessEvidence = { exactLink: true, exactRead: true, accessSaved: true, needsBrowserHost: false }
pure val accessEvidenceValues = Set(goodAccess, { ...goodAccess, needsBrowserHost: true },
  { ...goodAccess, exactLink: false }, { ...goodAccess, exactRead: false }, { ...goodAccess, accessSaved: false })
pure def canObserveLinkAccess(s: LinkPanel): bool = s.linkPhase == CheckingAccess
pure def observeLinkAccess(s: LinkPanel, accessEvidence: AccessEvidence): LinkPanel =
  if (not(accessEvidence.exactLink)) s
  else if (not(s.scoped)) clearLinkWithAccountBusy(accountBusyAfterLink(s), s)
  else if (not(accessEvidence.exactRead and accessEvidence.accessSaved)) { ...clearLinkWithAccountBusy(accountBusyAfterLink(s), s), notice: AccessUnavailable }
  else { ...s, linkPhase: if (accessEvidence.needsBrowserHost and s.grant == CalendarWrite) WaitingHost else WaitingCalendar }
type HostOutcome = HostStaleReply | HostApproved | HostDenied
pure def canObserveCalendarHost(s: LinkPanel): bool = s.linkPhase == WaitingHost
pure def observeCalendarHost(s: LinkPanel, hostOutcome: HostOutcome): LinkPanel =
  if (hostOutcome == HostStaleReply) s
  else if (not(s.scoped)) clearLinkWithAccountBusy(accountBusyAfterLink(s), s)
  else if (hostOutcome == HostDenied) { ...clearLinkWithAccountBusy(accountBusyAfterLink(s), s), authorizing: false, notice: SyncUnavailable }
  else { ...s, linkPhase: WaitingCalendar }
type CalendarReply = StaleCalendarReply | ReplyNeedsGrant | ReplyWithoutReview | ReplyWithReview
pure def canPublishCalendarLink(s: LinkPanel): bool = s.linkPhase == WaitingCalendar
pure def publishCalendarLink(s: LinkPanel, calendarReply: CalendarReply): LinkPanel =
  if (calendarReply == StaleCalendarReply) s
  else if (not(s.scoped)) clearLinkWithAccountBusy(accountBusyAfterLink(s), s)
  else if (calendarReply == ReplyNeedsGrant) { ...clearLinkWithAccountBusy(accountBusyAfterLink(s), s), notice: NeedsGrant }
  else { ...clearLinkWithAccountBusy(accountBusyAfterLink(s), s), review: if (calendarReply == ReplyWithReview) s.linkBusy else 0,
    authorizing: false, notice: LinkReturned }
pure def alwaysLinkBelongsToOpenPanel(s: LinkPanel): bool =
  s.linkBusy > 0 implies s.panelOpen and s.intent > 0
pure def stepCalendarLinkCannotInstallAccountRows(before: LinkPanel, via: str, after: LinkPanel): bool =
  via == "publishCalendarLink" implies before.verifiedRead == after.verifiedRead and before.grant == after.grant
pure def stepScopeCannotInventReview(before: LinkPanel, via: str, after: LinkPanel): bool =
  via == "changeCalendarScope" implies before.review == after.review
pure def stepLinkKeepsNewerAccountRead(before: LinkPanel, via: str, after: LinkPanel): bool =
  (via == "observeLinkAccess" or via == "observeCalendarHost" or via == "publishCalendarLink") and
    before.readBusy != before.linkedReadBusy implies after.readBusy == before.readBusy
pure def stepNeedsGrantKeepsReview(before: LinkPanel, via: str, after: LinkPanel): bool =
  via == "publishCalendarLink" and after.notice == NeedsGrant implies after.review == before.review
pure def sometimesLinkHasReview(s: LinkPanel): bool = s.review > 0
pure def sometimesIndependentAccountAndLinkBusy(s: LinkPanel): bool =
  s.readBusy > 0 and s.linkBusy > 0 and s.readBusy != s.linkedReadBusy
pure val weight_beginCalendarLink = 5
pure val weight_observeLinkAccess = 6
pure val weight_publishCalendarLink = 6
```

The pinned mounted Chromium fixture
`test/quint-google-calendar-link-publication.test.mjs` captures owner
and client replacement, independent busy tickets, stale host approval
and refusal, scope loss, retired intent, readback, superseding review
and focus cleanup. It uses the real panel and synthetic account, access,
host and link ports. The source provider's live authorization and
Calendar effects remain separate evidence.
