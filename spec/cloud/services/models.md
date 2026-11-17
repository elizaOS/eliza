# Chat models and their prices

A model is offered by the deployment profile (`id`, one `provider`, the
`upstreamModel` sent to it and whether it reads images) and priced by the
operator's price table in µUSD per 1,000 tokens for each side, with no
fallback provider and no alias. `./inference.md` quotes, admits and settles
with these definitions; reading the profile and the table is the shell's.

## Story: Price a model call before it runs

> As the cloud, I want every chat call priced from one reviewed table before
> it reaches a provider, so that no call runs that I cannot charge and no
> two calls with the same usage cost different amounts.

### A call may use only a model the profile offers once and the operator priced once

A price on either side must be more than 0 and at most 10,000,000 µUSD per
1,000 tokens. An id that appears twice in the profile or in the price table
is unavailable. A request with an image content part needs a model that
reads images. Anything else is refused `400 model_unavailable` before
admission.

```quint
import types.* from "../shared/types"
type ProfiledModel = { id: str, provider: str, upstreamModel: str, vision: bool }
type PriceRow = { modelId: str, inputPer1K: Micros, outputPer1K: Micros }
type Model = { id: str, provider: str, upstreamModel: str, vision: bool, inputPer1K: Micros, outputPer1K: Micros }
type ModelChoice = Chosen({ model: Model }) | Unavailable
pure val maxPer1K: Micros = 10000000
pure val modelRefusal: Refusal = refuse(ModelUnavailable)
pure def isValidPrice(per1K: Micros): bool = per1K > 0 and per1K <= maxPer1K
pure def isPricedRow(row: PriceRow): bool = isValidPrice(row.inputPer1K) and isValidPrice(row.outputPer1K)
pure def offersOf(profile: List[ProfiledModel], id: str): List[ProfiledModel] = profile.select(m => m.id == id)
pure def pricesOf(prices: List[PriceRow], id: str): List[PriceRow] = prices.select(r => r.modelId == id)
pure def chooseModel(profile: List[ProfiledModel], prices: List[PriceRow], id: str, hasImage: bool): ModelChoice = {
  val offers = offersOf(profile, id)
  val rows = pricesOf(prices, id)
  val offer = offers.nthOr(0, { id: "", provider: "", upstreamModel: "", vision: false })
  val row = rows.nthOr(0, { modelId: "", inputPer1K: 0, outputPer1K: 0 })
  if (offers.length() != 1 or rows.length() != 1 or not(isPricedRow(row)) or (hasImage and not(offer.vision))) Unavailable
  else Chosen({ model: { id: offer.id, provider: offer.provider, upstreamModel: offer.upstreamModel, vision: offer.vision, inputPer1K: row.inputPer1K, outputPer1K: row.outputPer1K } })
}
pure def isChosen(c: ModelChoice): bool = match c { | Chosen(x) => true | Unavailable => false }
pure val idValues = Set("m1", "m2", "m3")
pure val profileValues = Set(List(), List({ id: "m1", provider: "p1", upstreamModel: "u1", vision: true }), List({ id: "m1", provider: "p1", upstreamModel: "u1", vision: false }, { id: "m2", provider: "p2", upstreamModel: "u2", vision: true }), List({ id: "m1", provider: "p1", upstreamModel: "u1", vision: false }, { id: "m1", provider: "p2", upstreamModel: "u2", vision: true }))
pure val pricesValues = Set(List(), List({ modelId: "m1", inputPer1K: 3, outputPer1K: 15 }), List({ modelId: "m1", inputPer1K: 0, outputPer1K: 15 }, { modelId: "m2", inputPer1K: 1, outputPer1K: 2 }), List({ modelId: "m3", inputPer1K: 1, outputPer1K: 1 }), List({ modelId: "m1", inputPer1K: 0, outputPer1K: 15 }, { modelId: "m1", inputPer1K: 3, outputPer1K: 15 }))
```

### `prices set` accepts only a valid price for a model the profile offers once, and replaces that model's row

Another row is refused `400 invalid_request`. `prices check` reports as
mismatches each profiled model a text call cannot use and each row whose id
the profile does not offer once; with none, every profiled model is listed.

```quint
pure val priceRefusal: Refusal = refuse(InvalidRequest)
pure def priceRowAccepted(profile: List[ProfiledModel], row: PriceRow): bool = isPricedRow(row) and offersOf(profile, row.modelId).length() == 1
pure def setPrice(prices: List[PriceRow], row: PriceRow): List[PriceRow] = prices.select(r => r.modelId != row.modelId).append(row)
pure def priceMismatches(profile: List[ProfiledModel], prices: List[PriceRow]): int =
  profile.select(m => not(isChosen(chooseModel(profile, prices, m.id, false)))).length() + prices.select(r => offersOf(profile, r.modelId).length() != 1).length()
pure val rowValues = Set({ modelId: "m1", inputPer1K: 3, outputPer1K: 15 }, { modelId: "m2", inputPer1K: 0, outputPer1K: 2 }, { modelId: "m3", inputPer1K: 1, outputPer1K: 1 })
pure def lawSetPriceLeavesOneRow(prices: List[PriceRow], row: PriceRow): bool = pricesOf(setPrice(prices, row), row.modelId).length() == 1
pure def lawAcceptedPriceMakesTheModelUsable(profile: List[ProfiledModel], prices: List[PriceRow], row: PriceRow): bool =
  priceRowAccepted(profile, row) implies isChosen(chooseModel(profile, setPrice(prices, row), row.modelId, false))
```

### Each side costs its tokens at its price plus 20 percent, rounded half up to a whole micro-dollar

`tokens × per1K × 120 / 100,000`: 1,000 tokens per price unit and 120 percent.
Input and output are priced and rounded separately and then added.

```quint
pure val markupPercent: int = 120
pure val costDivisor: int = 100000
pure def sideCost(tokens: int, per1K: Micros): Micros = (tokens * per1K * markupPercent + costDivisor / 2) / costDivisor
type TokenCounts = { inputTokens: int, outputTokens: int }
pure def callCost(m: Model, c: TokenCounts): Micros = sideCost(c.inputTokens, m.inputPer1K) + sideCost(c.outputTokens, m.outputPer1K)
pure val tokensValues = Set(0, 1, 4, 833, 834, 1000, 2000000)
pure val per1KValues = Set(1, 3, 1000, 10000000)
pure def lawRoundingWithinHalfMicro(tokens: int, per1K: Micros): bool = {
  val exact = tokens * per1K * markupPercent
  val charged = sideCost(tokens, per1K) * costDivisor
  isValidPrice(per1K) and tokens >= 0 implies (exact - costDivisor / 2 < charged and charged <= exact + costDivisor / 2)
}
```

### A side has at most 2,000,000 tokens, so every call's price stays a safe integer

A quote with a larger side is refused `400 invalid_request`
(`./inference.md` builds the quote).

```quint
pure val maxTokensPerSide: int = 2000000
pure val maxSafeInteger: int = 9007199254740991
pure val tokenBoundRefusal: Refusal = refuse(InvalidRequest)
pure def sideInBound(tokens: int): bool = tokens >= 0 and tokens <= maxTokensPerSide
pure def countsInBound(c: TokenCounts): bool = sideInBound(c.inputTokens) and sideInBound(c.outputTokens)
pure def lawPriceArithmeticIsSafe(tokens: int, per1K: Micros): bool = (sideInBound(tokens) and isValidPrice(per1K)) implies tokens * per1K * markupPercent + costDivisor / 2 <= maxSafeInteger
pure val mValues = Set({ id: "m1", provider: "p1", upstreamModel: "u1", vision: false, inputPer1K: 10000000, outputPer1K: 10000000 }, { id: "m2", provider: "p2", upstreamModel: "u2", vision: true, inputPer1K: 3, outputPer1K: 15 })
pure val countsValues = Set({ inputTokens: 0, outputTokens: 0 }, { inputTokens: 2000000, outputTokens: 2000000 }, { inputTokens: 834, outputTokens: 1 })
pure def lawCallCostIsSafe(m: Model, counts: TokenCounts): bool =
  (countsInBound(counts) and isValidPrice(m.inputPer1K) and isValidPrice(m.outputPer1K)) implies (callCost(m, counts) >= 0 and callCost(m, counts) <= maxSafeInteger)
```

### More tokens never cost less

```quint
pure val fewerValues = Set(0, 1, 833, 834, 2000000)
pure val moreValues = Set(0, 1, 834, 1000, 2000000)
pure def lawCostMonotoneInTokens(fewer: int, more: int, per1K: Micros): bool = (0 <= fewer and fewer <= more and isValidPrice(per1K)) implies sideCost(fewer, per1K) <= sideCost(more, per1K)
```

### Billed usage counts every prompt and completion token, cached and reasoning ones included, up to the side bound, or is unreadable

The shell reads the provider's `usage`: `prompt_tokens` with
`prompt_tokens_details.cached_tokens`, and `completion_tokens` with
`completion_tokens_details.reasoning_tokens`. A detail is a part of its total
and never lowers it; a detail larger than its total raises the total to it.
Cached tokens are charged at the input price, reasoning tokens as output. A
negative count makes the report unreadable, and `./inference.md` settles it
as a call that finished without usage. A side above 2,000,000 tokens is
billed at 2,000,000 and reported through `runtime.reportError`.

```quint
type ProviderUsage = { promptTokens: int, cachedTokens: int, completionTokens: int, reasoningTokens: int }
type BilledUsage = Reported({ counts: TokenCounts }) | Unreadable
pure def billedSide(total: int, detail: int): int = {
  val side = if (detail > total) detail else total
  if (side > maxTokensPerSide) maxTokensPerSide else side
}
pure def billedUsage(u: ProviderUsage): BilledUsage =
  if (u.promptTokens < 0 or u.cachedTokens < 0 or u.completionTokens < 0 or u.reasoningTokens < 0) Unreadable
  else Reported({ counts: { inputTokens: billedSide(u.promptTokens, u.cachedTokens), outputTokens: billedSide(u.completionTokens, u.reasoningTokens) } })
pure val uValues = Set({ promptTokens: 10, cachedTokens: 4, completionTokens: 3, reasoningTokens: 5 }, { promptTokens: -10, cachedTokens: -20, completionTokens: 0, reasoningTokens: 0 }, { promptTokens: 3000000, cachedTokens: 0, completionTokens: 1, reasoningTokens: 0 }, { promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0 })
pure def lawBilledUsageCoversEveryReportedToken(u: ProviderUsage): bool = {
  val billed = billedUsage(u)
  match billed {
  | Reported(r) => countsInBound(r.counts)
      and (r.counts.inputTokens >= u.promptTokens or r.counts.inputTokens == maxTokensPerSide)
      and (r.counts.inputTokens >= u.cachedTokens or r.counts.inputTokens == maxTokensPerSide)
      and (r.counts.outputTokens >= u.completionTokens or r.counts.outputTokens == maxTokensPerSide)
      and (r.counts.outputTokens >= u.reasoningTokens or r.counts.outputTokens == maxTokensPerSide)
  | Unreadable => u.promptTokens < 0 or u.cachedTokens < 0 or u.completionTokens < 0 or u.reasoningTokens < 0
  }
}
```

## Story: Learn which models my key can call

> As the developer of an agent's cloud provider, I want one list of the
> models I can call, answered only to a live credential, so that I can check
> my key and my configured models with one request.

`GET /api/v1/models` is a KeyOrSession route (`../identity/requestAuth`) of
the `inference` capability. A refused credential answers `401` first; with
`inference` off, an authenticated request answers `404
capability_unavailable` (`../deployment`). Otherwise the answer is
`{object: "list", data: [{id, object: "model", owned_by}]}` in profile order,
`owned_by` being the model's provider, possibly empty, sent with
`Cache-Control: private, no-store` so that no shared cache answers for a
revoked key.

### The list shows exactly the models a text call can use, each once

```quint
type ModelListing = { id: str, ownedBy: str }
pure def listModels(profile: List[ProfiledModel], prices: List[PriceRow]): List[ModelListing] =
  profile.select(m => isChosen(chooseModel(profile, prices, m.id, false))).listMap(m => { id: m.id, ownedBy: m.provider })
pure def lawListedIdsAreUnique(profile: List[ProfiledModel], prices: List[PriceRow], id: str): bool =
  listModels(profile, prices).select(l => l.id == id).length() <= 1
pure def lawNoMismatchListsEveryModel(profile: List[ProfiledModel], prices: List[PriceRow]): bool =
  priceMismatches(profile, prices) == 0 implies listModels(profile, prices).length() == profile.length()
```
