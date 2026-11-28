# Google Workspace connections

- [OAuth connection lifecycle](./oauth.md)

## Story: Use only the Google account and permissions I connected

> As an owner, I can choose among connected Google accounts for Gmail, Calendar, Drive, Meet and Contacts, and remove a connection without leaving old requests authorized.

### A user-account request must match the owner, the explicit account, the current credential generation and all required scopes

The shell keeps OAuth tokens and refresh state with the account credential store. It parses the callback, verifies that it corresponds to the pending account flow and records the scope actually returned by Google. Managed Gmail and Calendar products continue to use their existing account and policy owners.

```quint
type GoogleScope = GmailRead | GmailWrite | CalendarRead | CalendarWrite | DriveRead | DriveWrite | MeetRead | ContactsRead
type WorkspaceAccount = { accountOwner: str, accountId: str, credentialEpoch: int, scopes: Set[GoogleScope], connected: bool }
type WorkspaceRequest = { callerId: str, requestedAccount: str, seenEpoch: int, permissions: Set[GoogleScope] }
pure def workspaceAllowed(account: WorkspaceAccount, request: WorkspaceRequest): bool =
  account.connected and request.callerId != "" and request.requestedAccount != "" and account.accountOwner == request.callerId and
  account.accountId == request.requestedAccount and account.credentialEpoch == request.seenEpoch and
  request.permissions.size() > 0 and request.permissions.subseteq(account.scopes)
pure def lawWorkspaceNeverUsesAnotherAccount(account: WorkspaceAccount, request: WorkspaceRequest): bool =
  workspaceAllowed(account, request) implies (account.accountOwner == request.callerId and account.accountId == request.requestedAccount)
pure def lawDisconnectedGoogleAccountCannotBeUsed(account: WorkspaceAccount, request: WorkspaceRequest): bool =
  not(account.connected) implies not(workspaceAllowed(account, request))
```

### Google Chat service-account messages use their configured installation and space

The connector accepts only a verified Google Chat delivery from a bound app installation and enabled space. OAuth workspace credentials are never passed to this transport.

```quint
type ChatBinding = { installation: str, allowedSpaces: Set[str] }
type ChatDelivery = { appId: str, spaceId: str, eventId: str }
pure def chatDeliveryAllowed(binding: ChatBinding, delivery: ChatDelivery, verified: bool): bool =
  verified and binding.installation == delivery.appId and binding.installation != "" and
  delivery.eventId != "" and binding.allowedSpaces.contains(delivery.spaceId)
pure def lawUnverifiedChatDeliveryIsRefused(binding: ChatBinding, delivery: ChatDelivery): bool =
  not(chatDeliveryAllowed(binding, delivery, false))
```

## Story: Send Gmail to the confirmed recipient

> As an owner, I can address an email by an exact address or by a contact with a confirmed address. Conflicting evidence is refused.

### A contact match supplies only its stored confirmed address

When direct address tokens occur in a contact-mode request, each must agree with the contact's stored address. The model never treats a model-shaped address as evidence of the owner's intent.

```quint
type MailboxClaim = DirectAddress | ConfirmedContact
type AddressDecision = ChosenAddress({ email: str }) | NoAddress | AddressConflict
pure def selectRecipient(claim: MailboxClaim, storedEmail: str, exactEmails: List[str]): AddressDecision =
  if (claim == ConfirmedContact)
    (if (storedEmail == "") NoAddress
     else if (exactEmails.every(address => address == storedEmail)) ChosenAddress({ email: storedEmail })
     else AddressConflict)
  else if (exactEmails.length() == 1 and exactEmails[0] != "") ChosenAddress({ email: exactEmails[0] })
  else if (exactEmails.length() > 1) AddressConflict else NoAddress
pure def lawMissingContactEmailCannotSend(exactEmails: List[str]): bool =
  selectRecipient(ConfirmedContact, "", exactEmails) == NoAddress
pure def lawContactCannotSendToConflictingAddress(storedEmail: str, exactEmails: List[str]): bool =
  (storedEmail != "" and exactEmails.some(address => address != storedEmail)) implies
  selectRecipient(ConfirmedContact, storedEmail, exactEmails) == AddressConflict
pure val accountValues = Set({ accountOwner: "owner", accountId: "work", credentialEpoch: 2, scopes: Set(GmailRead, CalendarRead), connected: true }, { accountOwner: "owner", accountId: "work", credentialEpoch: 3, scopes: Set(), connected: false })
pure val requestValues = Set({ callerId: "owner", requestedAccount: "work", seenEpoch: 2, permissions: Set(GmailRead) }, { callerId: "other", requestedAccount: "work", seenEpoch: 1, permissions: Set(DriveRead) })
pure val bindingValues = Set({ installation: "chat-app", allowedSpaces: Set("team") })
pure val deliveryValues = Set({ appId: "chat-app", spaceId: "team", eventId: "event-1" }, { appId: "other", spaceId: "team", eventId: "" })
```
