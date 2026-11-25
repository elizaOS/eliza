# Wallet requests

A transfer is asked for before it is reviewed. The owner asks from the
wallet screen; the agent asks from a conversation. Either way the request
waits here until the owner opens its review and decides it.

## Story: Let the agent ask, and decide myself

> As the owner, I want a transfer my agent proposes to wait for my own
> decision on the wallet screen, so that nothing said in a conversation
> can move my money.

### A request waits with the exact terms it was asked with

A request names the wallet family, the asset with the symbol its chain
gave when it was asked, the recipient and the amount in the asset's own
units. Its number is issued once and never reused. The
desk holds at most eight waiting requests, so an agent cannot bury the
owner's own. Waiting changes nothing about a request: the review the owner
later opens is of these terms and no others.

```quint
import wallet as W from "./index"
type Asker = OwnerAsks | AgentAsks
type TransferRequest = { id: int, family: W::WalletFamily, assetId: str, symbol: str, recipient: str, amount: str, asker: Asker }
type Desk = { waiting: List[TransferRequest], issued: int }
pure val initial: Desk = { waiting: List(), issued: 0 }
pure val deskRoom = 8
pure def isWaiting(d: Desk, id: int): bool = d.waiting.some(request => request.id == id)
pure def canAsk(d: Desk, family: W::WalletFamily, assetId: str, symbol: str, recipient: str, amount: str, asker: Asker): bool =
  d.waiting.length() < deskRoom and assetId != "" and symbol != "" and recipient != "" and amount != ""
pure def ask(d: Desk, family: W::WalletFamily, assetId: str, symbol: str, recipient: str, amount: str, asker: Asker): Desk =
  { waiting: d.waiting.append({ id: d.issued + 1, family: family, assetId: assetId, symbol: symbol, recipient: recipient, amount: amount, asker: asker }), issued: d.issued + 1 }
pure val assetIdValues = Set("", "native")
pure val symbolValues = Set("", "ETH")
pure val recipientValues = Set("", "0xB2")
pure val amountValues = Set("", "1.5")
pure val idValues = Set(0, 1, 2, 3)
pure def alwaysEveryWaitingRequestWasIssued(d: Desk): bool =
  d.issued >= 0 and d.waiting.every(request => request.id >= 1 and request.id <= d.issued)
pure def alwaysTheDeskHasRoomForEight(d: Desk): bool = d.waiting.length() <= deskRoom
pure def alwaysWaitingTermsAreComplete(d: Desk): bool =
  d.waiting.every(request => request.assetId != "" and request.symbol != "" and request.recipient != "" and request.amount != "")
pure def stepAWaitingRequestKeepsItsTerms(before: Desk, after: Desk): bool =
  before.waiting.every(request => not(isWaiting(after, request.id)) or after.waiting.includes(request))
pure def sometimesARequestWaits(d: Desk): bool = d.waiting.length() > 0
```

### Only the owner's decision takes a request off the desk

The owner approves or declines in the authenticated wallet review. An
approval leaves the desk only once its operation holds a signing
reservation, so a request is never lost between the desk and the journal.
The agent can ask and can read what waits; it cannot approve, decline or
withdraw, and no conversation turn decides a request.

```quint
pure def canDecideRequest(d: Desk, id: int, ownerDecided: bool): bool = ownerDecided and isWaiting(d, id)
pure def decideRequest(d: Desk, id: int, ownerDecided: bool): Desk = { ...d, waiting: d.waiting.select(request => request.id != id) }
pure def stepOnlyADecisionRemovesARequest(before: Desk, via: str, after: Desk): bool =
  before.waiting.every(request => isWaiting(after, request.id) or via == "decideRequest")
pure def stepNumbersAreNeverReused(before: Desk, after: Desk): bool = after.issued >= before.issued
pure def sometimesADecidedRequestLeaves(d: Desk): bool = d.issued > 0 and d.waiting.length() == 0
pure val eval_witness_sometimesADecidedRequestLeaves = (("ask", W::EvmWallet, "native", "ETH", "0xB2", "1.5", OwnerAsks), ("decideRequest", 1, true))
```
