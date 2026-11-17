# Chat models and their prices

The models a chat completion may name, and what a call to one costs. A model
is offered by the deployment profile (`id`, one `provider`, the
`upstreamModel` sent to it and whether it reads images) and priced by the
operator's price table (`elizaos-cloud prices set`, the `model_prices` rows),
in µUSD per 1,000 tokens for each side. There is no fallback provider and no
alias. Sources are develop `packages/cloud/shared/src/lib/services/ai-pricing/`
(`lookup.ts`, `dimensions.ts`: markup 1.2 on each side, zero tokens cost
nothing, a price of zero or less is refused) and
`packages/cloud/sdk/src/browser-contracts/markup.ts:24,31`.
`./inference.md` quotes, admits and settles with these
definitions; reading the profile and the table is the shell's.

## Story: Price a model call before it runs

> As the cloud, I want every chat call priced from one reviewed table before
> it reaches a provider, so that no call runs that I cannot charge and no
> two calls with the same usage cost different amounts.

### A call may use only a model the profile offers and the operator priced

A price on either side must be more than 0 and at most 10,000,000 µUSD per
1,000 tokens; a row outside that is unpriced. A request with an image content
part needs a model that reads images. Anything else is refused
`400 model_unavailable` before admission.

```quint
import types.* from "../shared/types"
type ProfiledModel = { id: str, provider: str, upstreamModel: str, vision: bool }
type PriceRow = { modelId: str, inputPer1K: Micros, outputPer1K: Micros }
type Model = { id: str, provider: str, upstreamModel: str, vision: bool, inputPer1K: Micros, outputPer1K: Micros }
type ModelChoice = Chosen({ model: Model }) | Unavailable
pure val maxPer1K: Micros = 10000000
pure val noProfiledModel: ProfiledModel = { id: "", provider: "", upstreamModel: "", vision: false }
pure val noPriceRow: PriceRow = { modelId: "", inputPer1K: 0, outputPer1K: 0 }
pure val modelRefusal: Refusal = refuse(ModelUnavailable)
pure def isValidPrice(per1K: Micros): bool = per1K > 0 and per1K <= maxPer1K
pure def isPricedRow(row: PriceRow): bool = isValidPrice(row.inputPer1K) and isValidPrice(row.outputPer1K)
pure def offersOf(profile: List[ProfiledModel], id: str): List[ProfiledModel] = profile.select(m => m.id == id)
pure def pricesOf(prices: List[PriceRow], id: str): List[PriceRow] = prices.select(r => r.modelId == id and isPricedRow(r))
pure def chooseModel(profile: List[ProfiledModel], prices: List[PriceRow], id: str, hasImage: bool): ModelChoice = {
  val offer = offersOf(profile, id).nthOr(0, noProfiledModel)
  val row = pricesOf(prices, id).nthOr(0, noPriceRow)
  if (offersOf(profile, id).length() == 0 or pricesOf(prices, id).length() == 0 or (hasImage and not(offer.vision))) Unavailable
  else Chosen({ model: { id: offer.id, provider: offer.provider, upstreamModel: offer.upstreamModel, vision: offer.vision, inputPer1K: row.inputPer1K, outputPer1K: row.outputPer1K } })
}
pure def isChosen(c: ModelChoice): bool = match c { | Chosen(x) => true | Unavailable => false }
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

### A side has at most 2,000,000 tokens, so every price stays a safe integer

A quote with a larger side is refused `400 invalid_request`
(`./inference.md` builds the quote).

```quint
pure val maxTokensPerSide: int = 2000000
pure val maxSafeInteger: int = 9007199254740991
pure val tokenBoundRefusal: Refusal = refuse(InvalidRequest)
pure def sideInBound(tokens: int): bool = tokens >= 0 and tokens <= maxTokensPerSide
pure def countsInBound(c: TokenCounts): bool = sideInBound(c.inputTokens) and sideInBound(c.outputTokens)
pure def lawPriceArithmeticIsSafe(tokens: int, per1K: Micros): bool = (sideInBound(tokens) and isValidPrice(per1K)) implies tokens * per1K * markupPercent + costDivisor / 2 <= maxSafeInteger
```

### More tokens never cost less

```quint
pure val fewerValues = Set(0, 1, 833, 834, 2000000)
pure val moreValues = Set(0, 1, 834, 1000, 2000000)
pure def lawCostMonotoneInTokens(fewer: int, more: int, per1K: Micros): bool = (0 <= fewer and fewer <= more and isValidPrice(per1K)) implies sideCost(fewer, per1K) <= sideCost(more, per1K)
```

### Cached prompt tokens are charged at the input price and reasoning tokens as output

The shell reads the provider's `usage`: `prompt_tokens` with
`prompt_tokens_details.cached_tokens`, and `completion_tokens` with
`completion_tokens_details.reasoning_tokens`. A detail is a part of its total
and never lowers it; a detail larger than its total raises the total to it.

```quint
type ProviderUsage = { promptTokens: int, cachedTokens: int, completionTokens: int, reasoningTokens: int }
pure def billedCounts(u: ProviderUsage): TokenCounts = { inputTokens: if (u.cachedTokens > u.promptTokens) u.cachedTokens else u.promptTokens, outputTokens: if (u.reasoningTokens > u.completionTokens) u.reasoningTokens else u.completionTokens }
```

## Story: Learn which models my key can call

> As the developer of an agent's cloud provider, I want one list of the
> models I can call, answered only to a live credential, so that I can check
> my key and my configured models with one request.

`GET /api/v1/models` is a KeyOrSession route (`../identity/requestAuth`); a
refused credential answers `401` there and the list is never shown. The answer
is `{object: "list", data: [{id, object: "model", owned_by}]}` in profile
order, `owned_by` being the model's provider.

### The list shows exactly the models a text call can use

```quint
type ModelListing = { id: str, ownedBy: str }
pure def listModels(profile: List[ProfiledModel], prices: List[PriceRow]): List[ModelListing] = profile.select(m => pricesOf(prices, m.id).length() > 0).listMap(m => { id: m.id, ownedBy: m.provider })
pure val idValues = Set("m1", "m2", "m3")
pure val profileValues = Set(List(), List({ id: "m1", provider: "p1", upstreamModel: "u1", vision: true }), List({ id: "m1", provider: "p1", upstreamModel: "u1", vision: false }, { id: "m2", provider: "p2", upstreamModel: "u2", vision: true }))
pure val pricesValues = Set(List(), List({ modelId: "m1", inputPer1K: 3, outputPer1K: 15 }), List({ modelId: "m1", inputPer1K: 0, outputPer1K: 15 }, { modelId: "m2", inputPer1K: 1, outputPer1K: 2 }), List({ modelId: "m3", inputPer1K: 1, outputPer1K: 1 }))
pure def lawListedExactlyWhenUsable(profile: List[ProfiledModel], prices: List[PriceRow], id: str): bool = listModels(profile, prices).some(l => l.id == id) iff isChosen(chooseModel(profile, prices, id, false))
```
