# Chat models and their prices

A model is offered by the deployment profile (`id`, one `provider`, the
`upstreamModel` sent to it, whether it reads images, and its verified
maximum output tokens when configured) and priced by the
operator's price table in µUSD per 1,000 tokens for each side and for the
input a provider read from its prompt cache, with no fallback provider and
no alias. `./inference.md` quotes, admits and settles
with these definitions; reading the profile and the table is the shell's.

## Story: Price a model call before it runs

> As the cloud, I want every chat call priced from one reviewed table before
> it reaches a provider, so that no call runs that I cannot charge and no
> two calls with the same usage cost different amounts.

### A call may use only a model offered once with one valid price row, and one that reads images when the request carries an image

A price on either side must be more than 0 and at most 10,000,000 µUSD per
1,000 tokens. The cached-input price, charged for the prompt tokens a
provider read from its prompt cache, is from 0, for a provider that charges
nothing for a cache read, to the input price. An id that appears twice in
the profile or in the price table, or whose offer names no provider or no
upstream model, is unavailable. Anything else is refused
`400 model_unavailable` before admission.

```quint
import types.* from "../shared/types"
import numbers as Num from "../../core/numbers"
type OutputDefault = NoOutputDefault | OutputDefaultOf({ tokens: int })
type ProfiledModel = { id: str, provider: str, upstreamModel: str, vision: bool, defaultMaxTokens: OutputDefault }
type PriceRow = { modelId: str, inputPer1K: Micros, cachedInputPer1K: Micros, outputPer1K: Micros }
type Model = { id: str, provider: str, upstreamModel: str, vision: bool, defaultMaxTokens: OutputDefault, inputPer1K: Micros, cachedInputPer1K: Micros, outputPer1K: Micros }
type ModelChoice = Chosen({ model: Model }) | Unavailable
pure val maxPer1K: Micros = 10000000
pure val modelRefusal: Refusal = refuse(ModelUnavailable)
pure val noProfiledModel: ProfiledModel = { id: "", provider: "", upstreamModel: "", vision: false, defaultMaxTokens: NoOutputDefault }
pure val noPriceRow: PriceRow = { modelId: "", inputPer1K: 0, cachedInputPer1K: 0, outputPer1K: 0 }
pure def isValidPrice(per1K: Micros): bool = per1K > 0 and per1K <= maxPer1K
pure def isCachedPrice(cachedPer1K: Micros, per1K: Micros): bool = cachedPer1K >= 0 and cachedPer1K <= per1K
pure def isPricedRow(row: PriceRow): bool = isValidPrice(row.inputPer1K) and isValidPrice(row.outputPer1K) and isCachedPrice(row.cachedInputPer1K, row.inputPer1K)
pure def offersOf(profile: List[ProfiledModel], id: str): List[ProfiledModel] = profile.select(m => m.id == id)
pure def pricesOf(prices: List[PriceRow], id: str): List[PriceRow] = prices.select(r => r.modelId == id)
pure def offeredOnce(profile: List[ProfiledModel], id: str): bool = {
  val offers = offersOf(profile, id)
  val offer = offers.nthOr(0, noProfiledModel)
  offers.length() == 1 and offer.provider != "" and offer.upstreamModel != ""
}
pure def chooseModel(profile: List[ProfiledModel], prices: List[PriceRow], id: str, hasImage: bool): ModelChoice = {
  val offer = offersOf(profile, id).nthOr(0, noProfiledModel)
  val rows = pricesOf(prices, id)
  val row = rows.nthOr(0, noPriceRow)
  if (not(offeredOnce(profile, id)) or rows.length() != 1 or not(isPricedRow(row)) or (hasImage and not(offer.vision))) Unavailable
  else Chosen({ model: { id: offer.id, provider: offer.provider, upstreamModel: offer.upstreamModel, vision: offer.vision, defaultMaxTokens: offer.defaultMaxTokens, inputPer1K: row.inputPer1K, cachedInputPer1K: row.cachedInputPer1K, outputPer1K: row.outputPer1K } })
}
pure def isChosen(c: ModelChoice): bool = match c { | Chosen(x) => true | Unavailable => false }
pure val idValues = Set("m1", "m2", "m3")
pure val hasImageValues = Set(true, false)
pure val profileValues = Set(List(), List({ id: "m1", provider: "p1", upstreamModel: "u1", vision: true, defaultMaxTokens: OutputDefaultOf({ tokens: 4096 }) }), List({ id: "m1", provider: "p1", upstreamModel: "u1", vision: false, defaultMaxTokens: NoOutputDefault }, { id: "m2", provider: "p2", upstreamModel: "u2", vision: true, defaultMaxTokens: OutputDefaultOf({ tokens: 8192 }) }), List({ id: "m1", provider: "p1", upstreamModel: "u1", vision: false, defaultMaxTokens: NoOutputDefault }, { id: "m1", provider: "p2", upstreamModel: "u2", vision: true, defaultMaxTokens: NoOutputDefault }), List({ id: "m2", provider: "", upstreamModel: "u2", vision: true, defaultMaxTokens: NoOutputDefault }))
pure val pricesValues = Set(List(), List({ modelId: "m1", inputPer1K: 3, cachedInputPer1K: 0, outputPer1K: 15 }), List({ modelId: "m1", inputPer1K: 0, cachedInputPer1K: 0, outputPer1K: 15 }, { modelId: "m2", inputPer1K: 1, cachedInputPer1K: 1, outputPer1K: 2 }), List({ modelId: "m3", inputPer1K: 1, cachedInputPer1K: 1, outputPer1K: 1 }), List({ modelId: "m1", inputPer1K: 0, cachedInputPer1K: 0, outputPer1K: 15 }, { modelId: "m1", inputPer1K: 3, cachedInputPer1K: 3, outputPer1K: 15 }), List({ modelId: "m1", inputPer1K: 3, cachedInputPer1K: 4, outputPer1K: 15 }))
pure def lawChosenModelIsPricedAndFits(profile: List[ProfiledModel], prices: List[PriceRow], id: str, hasImage: bool): bool = {
  val choice = chooseModel(profile, prices, id, hasImage)
  match choice {
  | Chosen(x) => x.model.id == id and isValidPrice(x.model.inputPer1K) and isValidPrice(x.model.outputPer1K)
      and isCachedPrice(x.model.cachedInputPer1K, x.model.inputPer1K) and x.model.provider != "" and x.model.upstreamModel != "" and (hasImage implies x.model.vision)
      and offeredOnce(profile, id) and pricesOf(prices, id).length() == 1
  | Unavailable => true
  }
}
```

### `prices set` accepts only a valid price for a model the profile offers once, and replaces that model's row

Another row is refused `400 invalid_request`. `prices set` takes
`--cached-input-per-1k` for a provider that prices a cache read apart; a row
that names none charges a cache read at the input price. `prices check` reports the
number of mismatches: profiled models a text call cannot use, plus rows
whose id the profile does not offer once (one entry for the id, naming a
provider and an upstream model). The same command also runs the payment
catalog check that `../deployment.md` owns.

```quint
pure def usableForText(profile: List[ProfiledModel], prices: List[PriceRow], m: ProfiledModel): bool = isChosen(chooseModel(profile, prices, m.id, false))
pure def priceRowAccepted(profile: List[ProfiledModel], row: PriceRow): bool = isPricedRow(row) and offeredOnce(profile, row.modelId)
pure def setPrice(prices: List[PriceRow], row: PriceRow): List[PriceRow] = prices.select(r => r.modelId != row.modelId).append(row)
pure def priceMismatches(profile: List[ProfiledModel], prices: List[PriceRow]): int =
  profile.select(m => not(usableForText(profile, prices, m))).length() + prices.select(r => not(offeredOnce(profile, r.modelId))).length()
pure val rowValues = Set({ modelId: "m1", inputPer1K: 3, cachedInputPer1K: 0, outputPer1K: 15 }, { modelId: "m2", inputPer1K: 0, cachedInputPer1K: 0, outputPer1K: 2 }, { modelId: "m3", inputPer1K: 1, cachedInputPer1K: 1, outputPer1K: 1 }, { modelId: "m1", inputPer1K: 3, cachedInputPer1K: 4, outputPer1K: 15 })
pure def lawAcceptedPriceMakesTheModelUsable(profile: List[ProfiledModel], prices: List[PriceRow], row: PriceRow): bool =
  priceRowAccepted(profile, row) implies isChosen(chooseModel(profile, setPrice(prices, row), row.modelId, false))
type CachedPriceAsk = SameAsInput | CachedPriceOf({ price: Micros })
pure def namedRow(modelId: str, inputPer1K: Micros, cachedAsk: CachedPriceAsk, outputPer1K: Micros): PriceRow = {
  val cachedPer1K = match cachedAsk { | SameAsInput => inputPer1K | CachedPriceOf(x) => x.price }
  { modelId: modelId, inputPer1K: inputPer1K, cachedInputPer1K: cachedPer1K, outputPer1K: outputPer1K }
}
pure def lawARowThatNamesNoCachedPriceChargesTheInputPrice(modelId: str, inputPer1K: Micros, outputPer1K: Micros): bool =
  namedRow(modelId, inputPer1K, SameAsInput, outputPer1K).cachedInputPer1K == inputPer1K
```

### Each side costs its tokens at its price plus 20 percent, rounded half up to a whole micro-dollar

`tokens × per1K × 120 / 100,000`: 1,000 tokens per price unit and 120 percent.
Input and output are priced and rounded separately and then added. The
input side is the tokens the provider did not read from its prompt cache at
the input price plus the tokens it did at the cached-input price, rounded
once, so a call with no cache read, and a cache read priced as input, cost
what the whole prompt costs at the input price, and a cache read priced at 0
costs nothing.

```quint
pure val markupPercent: int = 120
pure val costDivisor: int = 100000
pure def sideCost(tokens: int, per1K: Micros): Micros = (tokens * per1K * markupPercent + costDivisor / 2) / costDivisor
pure def inputCost(tokens: int, cachedTokens: int, per1K: Micros, cachedPer1K: Micros): Micros =
  ((tokens * per1K + cachedTokens * cachedPer1K) * markupPercent + costDivisor / 2) / costDivisor
type TokenCounts = { inputTokens: int, cachedTokens: int, outputTokens: int }
pure def callCost(m: Model, c: TokenCounts): Micros = inputCost(c.inputTokens, c.cachedTokens, m.inputPer1K, m.cachedInputPer1K) + sideCost(c.outputTokens, m.outputPer1K)
pure val cachedTokensValues = Set(0, 1, 834, 2000000)
pure val cachedPer1KValues = Set(0, 1, 3, 1000)
pure def lawInputWithNoCacheReadCostsItsSide(tokens: int, per1K: Micros, cachedPer1K: Micros): bool = inputCost(tokens, 0, per1K, cachedPer1K) == sideCost(tokens, per1K)
pure def lawAFreeCacheReadCostsNothing(tokens: int, cachedTokens: int, per1K: Micros): bool = inputCost(tokens, cachedTokens, per1K, 0) == sideCost(tokens, per1K)
pure def lawACacheReadAtTheInputPriceCostsTheWholePrompt(tokens: int, cachedTokens: int, per1K: Micros): bool =
  inputCost(tokens, cachedTokens, per1K, per1K) == sideCost(tokens + cachedTokens, per1K)
pure val tokensValues = Set(0, 1, 4, 833, 834, 1000, 2000000)
pure val per1KValues = Set(1, 3, 1000, 10000000)
pure def lawRoundingWithinHalfMicro(tokens: int, per1K: Micros): bool = {
  val exact = tokens * per1K * markupPercent
  val charged = sideCost(tokens, per1K) * costDivisor
  val inDomain = isValidPrice(per1K) and tokens >= 0
  inDomain implies (exact - costDivisor / 2 < charged and charged <= exact + costDivisor / 2)
}
```

### A side has at most 2,000,000 tokens, so every side's price arithmetic stays a safe integer

A quote with a larger side is refused `400 invalid_request` by
`./inference.md`, which builds the quote.

```quint
pure val maxTokensPerSide: int = 2000000
pure def sideInBound(tokens: int): bool = tokens >= 0 and tokens <= maxTokensPerSide
pure def countsInBound(c: TokenCounts): bool = sideInBound(c.inputTokens) and sideInBound(c.cachedTokens) and sideInBound(c.outputTokens)
pure def lawPriceArithmeticIsSafe(tokens: int, per1K: Micros): bool = (sideInBound(tokens) and isValidPrice(per1K)) implies tokens * per1K * markupPercent + costDivisor / 2 <= Num::maxSafeInteger
pure def lawInputArithmeticIsSafe(tokens: int, cachedTokens: int, per1K: Micros, cachedPer1K: Micros): bool =
  (sideInBound(tokens) and sideInBound(cachedTokens) and isValidPrice(per1K) and isCachedPrice(cachedPer1K, per1K)) implies
    (tokens * per1K + cachedTokens * cachedPer1K) * markupPercent + costDivisor / 2 <= Num::maxSafeInteger
```

### More tokens never cost less

The same holds of the input side when either part of the prompt grows: the
tokens read from the prompt cache or the rest.

```quint
pure val fewerValues = Set(0, 1, 833, 834, 2000000)
pure val moreValues = Set(0, 1, 834, 1000, 2000000)
pure def lawCostMonotoneInTokens(fewer: int, more: int, per1K: Micros): bool = (0 <= fewer and fewer <= more and isValidPrice(per1K)) implies sideCost(fewer, per1K) <= sideCost(more, per1K)
pure val fewerCachedValues = Set(0, 1, 834)
pure val moreCachedValues = Set(0, 834, 2000000)
pure def lawInputCostMonotoneInTokens(fewer: int, more: int, fewerCached: int, moreCached: int, per1K: Micros, cachedPer1K: Micros): bool =
  (0 <= fewer and fewer <= more and 0 <= fewerCached and fewerCached <= moreCached and isValidPrice(per1K) and isCachedPrice(cachedPer1K, per1K)) implies
    inputCost(fewer, fewerCached, per1K, cachedPer1K) <= inputCost(more, moreCached, per1K, cachedPer1K)
```

### Each billed side is the larger of a usage total and its detail, capped at 2,000,000 tokens; a negative count makes the usage unreadable

The shell reads the provider's `usage`: `prompt_tokens` with
`prompt_tokens_details.cached_tokens`, and `completion_tokens` with
`completion_tokens_details.reasoning_tokens`. The billed prompt is split
into the tokens the provider read from its prompt cache, charged at the
model's cached-input price, and the rest, charged at the input price;
reasoning tokens are charged as output. An absent detail counts 0; an
absent total counts 0 when the other total is present. A `usage` that is
absent or has neither total is no usage, and a count that is not a whole
number (checked in the Effect Schema) or is negative makes the usage
unreadable; `./inference.md` settles both as a call that finished without
usage, at the quote. A capped call (`usageCapped`) is billed at the bound
and logged as an error through the structured logger
(`@elizaos/core`).

```quint
type ProviderUsage = { promptTokens: int, cachedTokens: int, completionTokens: int, reasoningTokens: int }
type BilledUsage = Reported({ counts: TokenCounts }) | Unreadable
pure def larger(a: int, b: int): int = if (a > b) a else b
pure def billedSide(total: int, detail: int): int = if (larger(total, detail) > maxTokensPerSide) maxTokensPerSide else larger(total, detail)
pure def usageCapped(u: ProviderUsage): bool =
  if (larger(u.promptTokens, u.cachedTokens) > maxTokensPerSide) true else larger(u.completionTokens, u.reasoningTokens) > maxTokensPerSide
pure def billedUsage(u: ProviderUsage): BilledUsage = {
  val billedPrompt = billedSide(u.promptTokens, u.cachedTokens)
  val billedCached = billedSide(u.cachedTokens, 0)
  if (u.promptTokens < 0 or u.cachedTokens < 0 or u.completionTokens < 0 or u.reasoningTokens < 0) Unreadable
  else Reported({ counts: { inputTokens: billedPrompt - billedCached, cachedTokens: billedCached, outputTokens: billedSide(u.completionTokens, u.reasoningTokens) } })
}
pure val uValues = Set({ promptTokens: 10, cachedTokens: 4, completionTokens: 3, reasoningTokens: 5 }, { promptTokens: -10, cachedTokens: -20, completionTokens: 0, reasoningTokens: 0 }, { promptTokens: 3000000, cachedTokens: 0, completionTokens: 1, reasoningTokens: 0 }, { promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0 })
pure def lawBilledUsageCoversEveryReportedToken(u: ProviderUsage): bool = {
  val billed = billedUsage(u)
  match billed {
  | Reported(r) => countsInBound(r.counts)
      and (usageCapped(u) or (r.counts.inputTokens + r.counts.cachedTokens >= u.promptTokens and r.counts.cachedTokens == u.cachedTokens
        and r.counts.outputTokens >= u.completionTokens and r.counts.outputTokens >= u.reasoningTokens))
      and (usageCapped(u) implies (r.counts.inputTokens + r.counts.cachedTokens == maxTokensPerSide or r.counts.outputTokens == maxTokensPerSide))
  | Unreadable => u.promptTokens < 0 or u.cachedTokens < 0 or u.completionTokens < 0 or u.reasoningTokens < 0
  }
}
```

## Story: Learn which models my key can call

> As the developer of an agent's cloud provider, I want one list of the
> models I can call, answered only to a live credential, so that I can check
> my key and my configured models with one request.

`GET /api/v1/models` answers a live credential with
`{object: "list", data: [{id, object: "model", owned_by}]}` in profile order,
`owned_by` being the model's provider, never from a shared cache.

### The list shows exactly the models a text call can use, each once

```quint
type ModelListing = { id: str, ownedBy: str }
pure def listModels(profile: List[ProfiledModel], prices: List[PriceRow]): List[ModelListing] =
  profile.select(m => usableForText(profile, prices, m)).listMap(m => { id: m.id, ownedBy: m.provider })
pure def lawListingIsExactlyTheUsableModels(profile: List[ProfiledModel], prices: List[PriceRow], id: str): bool =
  listModels(profile, prices).select(l => l.id == id).length() == (if (isChosen(chooseModel(profile, prices, id, false))) 1 else 0)
```
