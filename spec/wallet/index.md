# Wallet

The wallet gives the owner, and their agent while the owner has it on, one
wallet with an EVM and a Solana account: holdings, exact transfer quotes,
owner-reviewed execution and reconciliation. EVM and Solana adapters own
RPC and signing. The keys are made and sealed on the device, outside the
transaction model.

| Area | Specifications |
| --- | --- |
| Keys | [Custody](./custody.md) |
| Asking | [Requests](./requests.md) |
| Policy | [Policy](./policy.md) |

## Story: Preview an exact wallet operation before executing it

> As the owner, I want to inspect a quote or simulation freely and have
> a write sign only the economic request I confirmed.

### A review binds the complete immutable wallet operation

Preserve chain, backend, operation ID, source account, recipient, assets
and amounts exactly. The structured commitment covers the economic terms
including quote bounds and expiry, slippage, cross-chain destination,
governance calldata, pool, range, position or venue instructions where
present. The shell canonicalizes chain-native addresses without folding
case-sensitive Solana identifiers. Quote and simulation modes cannot sign.

```quint
type WalletActionKind = AssetTransfer | TokenSwap | BridgeTransfer | GovernanceWrite | TokenLaunch | OpenLiquidity | CloseLiquidity | RepositionLiquidity | LendAsset | WithdrawLoan | OpenPerpetual | ClosePerpetual | PredictionTrade | PayForService | RawWalletCall
type WalletIntentMode = WalletQuote | WalletSimulation | WalletExecution
type WalletFamily = EvmWallet | SolanaWallet
type WalletBackend = LocalSigner | StewardSigner
type WalletIntent = { intentId: str, commitment: str, account: str, chainId: str, family: WalletFamily, backend: WalletBackend, operation: WalletActionKind, intentMode: WalletIntentMode }
pure def validWalletIntent(intent: WalletIntent): bool =
  intent.intentId != "" and intent.commitment != "" and intent.account != "" and intent.chainId != ""
pure def walletNeedsReview(intent: WalletIntent): bool = intent.intentMode == WalletExecution
pure def lawSimulateWalletDoesNotRequireSigning(intent: WalletIntent): bool =
  intent.intentMode == WalletSimulation implies not(walletNeedsReview(intent))
```

### An approval and fresh quote belong to the same operation

A direct write needs approval through the authenticated wallet review for
that exact operation. Chat can quote, simulate, and reconcile transfers.
A quote used for a trade must have an observed timestamp no more than
60 seconds old. Unsupported amounts, an expired authorization window,
a disallowed recipient or asset, or a denied backend preflight prevent
dispatch. The shell passes verified approval, policy and time evidence
from its custody and does not accept it from the model caller.

```quint
type WalletPhase = WalletIdle | WalletPreview | AwaitingWalletApproval | ApprovedWallet | WalletSigning | WalletInFlight | WalletUncertain | WalletFinal | WalletDeclined
type WalletRun = { phase: WalletPhase, intent: WalletIntent, quoteUntil: int, operationRef: str }
pure val emptyWalletIntent: WalletIntent = { intentId: "", commitment: "", account: "", chainId: "", family: EvmWallet, backend: LocalSigner, operation: AssetTransfer, intentMode: WalletQuote }
pure val initial: WalletRun = { phase: WalletIdle, intent: emptyWalletIntent, quoteUntil: 0, operationRef: "" }
pure def freshWalletQuote(observedAt: int, wallTime: int): bool =
  observedAt > 0 and wallTime >= observedAt and wallTime - observedAt <= 60000
pure def canPrepareWallet(s: WalletRun, intent: WalletIntent, quoteUntil: int): bool =
  s.phase == WalletIdle and validWalletIntent(intent) and quoteUntil > 0
pure def prepareWallet(s: WalletRun, intent: WalletIntent, quoteUntil: int): WalletRun =
  { ...s, phase: if (walletNeedsReview(intent)) AwaitingWalletApproval else WalletPreview, intent: intent, quoteUntil: quoteUntil }
pure def canApproveWallet(s: WalletRun, intentId: str, commitment: str, wallTime: int, ownerConfirmed: bool): bool =
  s.phase == AwaitingWalletApproval and s.intent.intentId == intentId and s.intent.commitment == commitment and wallTime >= 0 and wallTime <= s.quoteUntil and ownerConfirmed
pure def approveWallet(s: WalletRun, intentId: str, commitment: str, wallTime: int, ownerConfirmed: bool): WalletRun =
  { ...s, phase: ApprovedWallet }
pure def canReserveWalletSigning(s: WalletRun, intentId: str, commitment: str, wallTime: int): bool =
  s.phase == ApprovedWallet and walletNeedsReview(s.intent) and s.intent.intentId == intentId and
    s.intent.commitment == commitment and wallTime >= 0 and wallTime <= s.quoteUntil
pure def reserveWalletSigning(s: WalletRun, intentId: str, commitment: str, wallTime: int): WalletRun =
  { ...s, phase: WalletSigning }
pure def canDispatchWallet(s: WalletRun, intentId: str, commitment: str, operationRef: str, wallTime: int, policyAllows: bool): bool =
  s.phase == WalletSigning and walletNeedsReview(s.intent) and s.intent.intentId == intentId and s.intent.commitment == commitment and
    operationRef != "" and wallTime >= 0 and wallTime <= s.quoteUntil and policyAllows
pure def dispatchWallet(s: WalletRun, intentId: str, commitment: str, operationRef: str, wallTime: int, policyAllows: bool): WalletRun =
  { ...s, phase: WalletInFlight, operationRef: operationRef }
pure def canDeclineWallet(s: WalletRun): bool = s.phase == AwaitingWalletApproval or s.phase == ApprovedWallet
pure def declineWallet(s: WalletRun): WalletRun = { ...s, phase: WalletDeclined }
pure def alwaysWalletPreviewNeverDispatches(s: WalletRun): bool =
  (s.phase == WalletSigning or s.phase == WalletInFlight or s.phase == WalletUncertain or s.phase == WalletFinal) implies s.intent.intentMode == WalletExecution
```

## Story: Recover the real outcome of an on-chain operation

> As the owner, I want a lost RPC reply reconciled with the original
> operation so that the wallet never invents a success or resends it.

### A submitted operation retains one durable binding through reconciliation

Persist a unique signing reservation for the approved operation before
signing. Persist its signed transaction identity before broadcast. Another
request with the same reservation may only observe it. An unsigned or
interrupted reservation does not authorize a new signing attempt. Chain
receipt settlement requires the exact original operation on the expected
chain and canonical finality. On EVM, the receipt block must be canonical
and at or below the chain's finalized block. An EVM broadcast is submitted
only when the RPC answers with the signed transaction's own hash, written
as the JSON-RPC schema writes a 32-byte hash: `0x` and 64 lowercase hex
digits. Any other answer, including none, null, a malformed or different
hash, or the same hash in other letter case, and any error or lost answer,
leaves the operation unresolved under the signed transaction's hash; it is
never reported failed and never signed or sent again.

```quint
pure def canMarkWalletUncertain(s: WalletRun, operationRef: str): bool =
  s.phase == WalletInFlight and s.operationRef == operationRef
pure def markWalletUncertain(s: WalletRun, operationRef: str): WalletRun = { ...s, phase: WalletUncertain }
pure def canSettleWallet(s: WalletRun, operationRef: str, chainId: str, commitment: str, receiptFinal: bool): bool =
  (s.phase == WalletInFlight or s.phase == WalletUncertain) and s.operationRef == operationRef and
    s.intent.chainId == chainId and s.intent.commitment == commitment and receiptFinal
pure def settleWallet(s: WalletRun, operationRef: str, chainId: str, commitment: str, receiptFinal: bool): WalletRun =
  { ...s, phase: WalletFinal }
pure def alwaysWalletOperationRefMatchesPhase(s: WalletRun): bool =
  (s.operationRef != "") iff (s.phase == WalletInFlight or s.phase == WalletUncertain or s.phase == WalletFinal)
pure def stepWalletOperationBindingNeverChanges(before: WalletRun, after: WalletRun): bool =
  before.operationRef != "" implies before.operationRef == after.operationRef and before.intent == after.intent
pure val intentValues = Set(
  { intentId: "op", commitment: "quote-a", account: "acct", chainId: "chain", family: EvmWallet, backend: LocalSigner, operation: AssetTransfer, intentMode: WalletExecution },
  { intentId: "op", commitment: "quote-a", account: "acct", chainId: "chain", family: SolanaWallet, backend: StewardSigner, operation: TokenSwap, intentMode: WalletSimulation })
pure val intentIdValues = Set("", "op", "other")
pure val commitmentValues = Set("quote-a", "quote-b")
pure val operationRefValues = Set("", "send-id", "other")
pure val chainIdValues = Set("chain", "other")
pure def sometimesWalletReconciles(s: WalletRun): bool = s.phase == WalletFinal
pure val eval_witness_sometimesWalletReconciles = (("prepareWallet", { intentId: "op", commitment: "quote-a", account: "acct", chainId: "chain", family: EvmWallet, backend: LocalSigner, operation: AssetTransfer, intentMode: WalletExecution }, 5), ("approveWallet", "op", "quote-a", 2, true), ("reserveWalletSigning", "op", "quote-a", 3), ("dispatchWallet", "op", "quote-a", "send-id", 3, true), ("markWalletUncertain", "send-id"), ("settleWallet", "send-id", "chain", "quote-a", true))
```

## Story: Enforce exact spend limits when making a payment

> As the owner, I want a wallet payment to respect my per-request and
> daily limits without rounding large chain amounts.

### A chain amount compares exactly at every digit

Decode decimal atomic units as canonical most-significant-first digit
lists. Zero is the single zero digit. All other amounts start with a
nonzero digit. Compare lengths first and then the first differing digit.
The shell converts using integers and never sends JavaScript floating
point amounts through a signing boundary. Native EVM signing supports
Ethereum mainnet, Sepolia, and loopback development chains 1337 and 31337.
On these paths only legacy and EIP-1559 transactions may sign, using the
gas limit and price ceiling as the maximum native fee.

```quint
pure def validAtomicAmount(digits: List[int]): bool =
  digits.length() > 0 and digits.every(digit => 0 <= digit and digit <= 9) and
    (digits.length() == 1 or digits.nthOr(0, 0) != 0)
type AtomicCompare = { offset: int, ordering: int }
pure def compareAtomicDigit(comparison: AtomicCompare, digit: int, right: List[int]): AtomicCompare = {
  val peer = right.nthOr(comparison.offset, 0)
  { offset: comparison.offset + 1, ordering: if (comparison.ordering != 0) comparison.ordering else if (digit < peer) -1 else if (digit > peer) 1 else 0 }
}
pure def compareSameWidthAtomic(left: List[int], right: List[int]): int =
  left.foldl({ offset: 0, ordering: 0 }, (comparison, digit) => compareAtomicDigit(comparison, digit, right)).ordering
pure def atMostAtomic(left: List[int], right: List[int]): bool =
  validAtomicAmount(left) and validAtomicAmount(right) and
    (left.length() < right.length() or (left.length() == right.length() and compareSameWidthAtomic(left, right) <= 0))
pure def lawLongerAtomicAmountIsNeverSmaller(left: List[int], right: List[int]): bool =
  left.length() > right.length() implies not(atMostAtomic(left, right))
```

### The payment must fit each budget before it spends

Payments use an exact amount, scoped service and asset. Reservations count
against global and service daily limits until settled or conclusively
released. The shell atomically computes the remaining room from committed
and in-flight reservations inside one transaction or the on-chain
policy boundary. Compare that room, both per-request caps, and the amount
without converting to floating point. An unresolved submission keeps
its reservation.

```quint
type RemainingSpendRoom = { globalRequest: List[int], serviceRequest: List[int], globalDay: List[int], serviceDay: List[int] }
pure def walletPaymentFits(digits: List[int], room: RemainingSpendRoom): bool =
  digits != List(0) and atMostAtomic(digits, room.globalRequest) and atMostAtomic(digits, room.serviceRequest) and
    atMostAtomic(digits, room.globalDay) and atMostAtomic(digits, room.serviceDay)
pure val roomValues: Set[RemainingSpendRoom] = Set(
  { globalRequest: List(5, 0), serviceRequest: List(5, 0), globalDay: List(1, 0, 0), serviceDay: List(2, 5) },
  { globalRequest: List(5, 0), serviceRequest: List(5, 0), globalDay: List(0), serviceDay: List(0) },
  { globalRequest: List(0, 1), serviceRequest: List(5, 0), globalDay: List(1, 0, 0), serviceDay: List(2, 5) })
pure val digitsValues = Set(List(), List(0), List(1, 0), List(2, 5), List(2, 6), List(1, 0, 0))
pure def lawWalletPaymentRespectsGlobalDay(digits: List[int], room: RemainingSpendRoom): bool =
  walletPaymentFits(digits, room) implies atMostAtomic(digits, room.globalDay)
pure def autonomousWalletTradeAllowed(todayCount: int, policyAllows: bool, quoteObservedAt: int, wallTime: int): bool =
  todayCount >= 0 and todayCount < 25 and policyAllows and freshWalletQuote(quoteObservedAt, wallTime)
pure val todayCountValues = Set(-1, 0, 1, 24, 25, 26)
pure def lawAutonomousWalletDailyTradeCap(todayCount: int, policyAllows: bool, quoteObservedAt: int, wallTime: int): bool =
  todayCount >= 25 implies not(autonomousWalletTradeAllowed(todayCount, policyAllows, quoteObservedAt, wallTime))
```

## Story: Inspect wallet holdings and venue quotes before making changes

> As the owner, I want to see which chain, account and asset a holding or
> quote belongs to without creating a transaction.

### Inventory and venue observations retain their chain and account scope

A portfolio query may include holdings, token metadata, NFTs, positions,
and protocol balances. Observations from an old account or an unrequested
chain stay out of the result. Polling RPCs, venue APIs, and market feeds
does not authorize a transaction.

```quint
type WalletReadKind = ReadBalances | ReadTokenMetadata | ReadNfts | ReadPositions | ReadMarket
type WalletReadScope = { ownerAccount: str, chains: List[str], readKind: WalletReadKind }
type WalletReadObservation = { sourceAccount: str, onChain: str, observedKind: WalletReadKind, assetId: str }
pure def walletObservationMatches(scope: WalletReadScope, observation: WalletReadObservation): bool =
  scope.ownerAccount != "" and scope.ownerAccount == observation.sourceAccount and scope.chains.includes(observation.onChain) and
    scope.readKind == observation.observedKind and observation.assetId != ""
pure val scopeValues: Set[WalletReadScope] = Set(
  { ownerAccount: "acct", chains: List("chain"), readKind: ReadBalances },
  { ownerAccount: "acct", chains: List("chain", "other"), readKind: ReadMarket },
  { ownerAccount: "", chains: List(), readKind: ReadBalances })
pure val observationValues: Set[WalletReadObservation] = Set(
  { sourceAccount: "acct", onChain: "chain", observedKind: ReadBalances, assetId: "native" },
  { sourceAccount: "other", onChain: "chain", observedKind: ReadBalances, assetId: "native" },
  { sourceAccount: "acct", onChain: "other", observedKind: ReadMarket, assetId: "token" })
pure def lawOtherWalletIsNotInInventory(scope: WalletReadScope, observation: WalletReadObservation): bool =
  scope.ownerAccount != observation.sourceAccount implies not(walletObservationMatches(scope, observation))
```

### A route quote answers the current amount and destination

The chain adapter binds the offered venue and constraints to the complete
route request. A visible quote cannot come from a different intent,
account, operation, destination, or revision of the route constraints.

```quint
type WalletMarketQuote = { quotedIntent: WalletIntent, venueId: str, observedAt: int }
pure def walletQuoteMatches(intent: WalletIntent, quote: WalletMarketQuote, wallTime: int): bool =
  validWalletIntent(intent) and quote.quotedIntent == intent and quote.venueId != "" and freshWalletQuote(quote.observedAt, wallTime)
pure val quoteValues: Set[WalletMarketQuote] = Set(
  { quotedIntent: { intentId: "op", commitment: "quote-a", account: "acct", chainId: "chain", family: EvmWallet, backend: LocalSigner, operation: AssetTransfer, intentMode: WalletExecution }, venueId: "chain", observedAt: 1 },
  { quotedIntent: emptyWalletIntent, venueId: "", observedAt: 0 })
pure def lawChangedIntentNeedsAnotherWalletQuote(intent: WalletIntent, quote: WalletMarketQuote, wallTime: int): bool =
  quote.quotedIntent != intent implies not(walletQuoteMatches(intent, quote, wallTime))
```
