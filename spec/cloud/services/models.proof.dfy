lemma ModelsPricesOfFilter(prices: seq<PriceRow>, id: string)
  ensures pricesOf(prices, id) == ProofLib.Filter((r: PriceRow) => (r.modelId == id), prices)
{
}

lemma ModelsOffersOfFilter(profile: seq<ProfiledModel>, id: string)
  ensures offersOf(profile, id) == ProofLib.Filter((m: ProfiledModel) => (m.id == id), profile)
{
}

lemma ModelsSetPriceFilter(prices: seq<PriceRow>, row: PriceRow)
  ensures setPrice(prices, row) == ProofLib.Filter((r: PriceRow) => (r.modelId != row.modelId), prices) + [row]
{
}

lemma ModelsListingFilter(profile: seq<ProfiledModel>, prices: seq<PriceRow>)
  ensures |listModels(profile, prices)| == |ProofLib.Filter((m: ProfiledModel) => usableForText(profile, prices, m), profile)|
  ensures forall i :: 0 <= i < |listModels(profile, prices)| ==> listModels(profile, prices)[i].id == ProofLib.Filter((m: ProfiledModel) => usableForText(profile, prices, m), profile)[i].id
{
}

lemma ModelsListingLawFilter(profile: seq<ProfiledModel>, prices: seq<PriceRow>, id: string)
  ensures lawListingIsExactlyTheUsableModels(profile, prices, id) == (|ProofLib.Filter((l: ModelListing) => (l.id == id), listModels(profile, prices))| == (if isChosen(chooseModel(profile, prices, id, false)) then 1 else 0))
{
}

lemma lawAcceptedPriceMakesTheModelUsable_ensures(profile: seq<ProfiledModel>, prices: seq<PriceRow>, row: PriceRow)
  ensures (lawAcceptedPriceMakesTheModelUsable(profile, prices, row) == true)
{
  if priceRowAccepted(profile, row) {
    var id := row.modelId;
    var neq := (r: PriceRow) => (r.modelId != row.modelId);
    var eq := (r: PriceRow) => (r.modelId == id);
    var kept := ProofLib.Filter(neq, prices);
    var after := setPrice(prices, row);
    ModelsSetPriceFilter(prices, row);
    assert after == kept + [row];
    ModelsPricesOfFilter(after, id);
    assert pricesOf(after, id) == ProofLib.Filter(eq, kept + [row]);
    ProofLib.FilterAppend(eq, kept, row);
    forall i | 0 <= i < |kept| ensures !eq(kept[i]) {
      ProofLib.FilterMember(neq, prices, kept[i]);
    }
    ProofLib.FilterNone(eq, kept);
    assert ProofLib.Filter(eq, kept) == [];
    assert pricesOf(after, id) == [row];
    assert isPricedRow(row);
    assert offeredOnce(profile, id);
  }
}

lemma lawListingIsExactlyTheUsableModels_ensures(profile: seq<ProfiledModel>, prices: seq<PriceRow>, id: string)
  ensures (lawListingIsExactlyTheUsableModels(profile, prices, id) == true)
{
  var usable := (m: ProfiledModel) => usableForText(profile, prices, m);
  var idEq := (m: ProfiledModel) => (m.id == id);
  var lEq := (l: ModelListing) => (l.id == id);
  var s := ProofLib.Filter(usable, profile);
  var listed := listModels(profile, prices);
  var c := isChosen(chooseModel(profile, prices, id, false));
  ModelsListingLawFilter(profile, prices, id);
  ModelsListingFilter(profile, prices);
  ProofLib.FilterLengthPointwise(lEq, idEq, listed, s);
  assert |ProofLib.Filter(lEq, listed)| == |ProofLib.Filter(idEq, s)|;
  if c {
    ModelsOffersOfFilter(profile, id);
    var offers := ProofLib.Filter(idEq, profile);
    assert |offers| == 1;
    ProofLib.FilterOfFilterLength(usable, idEq, idEq, profile);
    assert |ProofLib.Filter(idEq, s)| <= 1;
    var o := offers[0];
    ProofLib.FilterMember(idEq, profile, o);
    assert o in profile && o.id == id;
    assert usable(o);
    ProofLib.FilterMember(usable, profile, o);
    ProofLib.FilterMember(idEq, s, o);
    assert o in ProofLib.Filter(idEq, s);
    assert |ProofLib.Filter(idEq, s)| == 1;
  } else {
    forall i | 0 <= i < |s| ensures !idEq(s[i]) {
      ProofLib.FilterMember(usable, profile, s[i]);
    }
    ProofLib.FilterNone(idEq, s);
  }
}

lemma lawCostMonotoneInTokens_ensures(fewer: int, more: int, per1K: int)
  ensures (lawCostMonotoneInTokens(fewer, more, per1K) == true)
{
  if 0 <= fewer <= more && isValidPrice(per1K) {
    var half := quotient_cloud__services__models(costDivisor, 2);
    assert half == 50000 by { reveal JSFloorDiv, MathAbs; }
    var low := fewer * per1K * markupPercent + half;
    var high := more * per1K * markupPercent + half;
    assert fewer * per1K <= more * per1K by { MulLeft(fewer, more, per1K); }
    assert 0 <= fewer * per1K by { MulLeft(0, fewer, per1K); }
    assert 0 <= low <= high;
    assert sideCost(fewer, per1K) == low / costDivisor;
    assert sideCost(more, per1K) == high / costDivisor;
    CostQuotientMonotone(low, high, costDivisor);
  }
}

lemma MulLeft(a: int, b: int, c: int)
  requires a <= b && c >= 0
  ensures a * c <= b * c
{
  assert (b - a) * c >= 0;
}

lemma CostQuotientMonotone(smaller: int, larger: int, divisor: int)
  requires 0 <= smaller <= larger && divisor > 0
  ensures smaller / divisor <= larger / divisor
{
  var q1 := smaller / divisor;
  var q2 := larger / divisor;
  assert smaller == divisor * q1 + smaller % divisor;
  assert larger == divisor * q2 + larger % divisor;
  if q1 > q2 {
    assert divisor * q1 >= divisor * (q2 + 1);
    assert false;
  }
}

lemma lawInputArithmeticIsSafe_ensures(tokens: int, cachedTokens: int, per1K: int, cachedPer1K: int)
  ensures (lawInputArithmeticIsSafe(tokens, cachedTokens, per1K, cachedPer1K) == true)
{
  if sideInBound(tokens) && sideInBound(cachedTokens) && isValidPrice(per1K) && isCachedPrice(cachedPer1K, per1K) {
    assert quotient_cloud__services__models(costDivisor, 2) == 50000 by { reveal JSFloorDiv, MathAbs; }
    MulLeft(tokens, maxTokensPerSide, per1K);
    MulLeft(per1K, maxPer1K, maxTokensPerSide);
    MulLeft(cachedTokens, maxTokensPerSide, cachedPer1K);
    MulLeft(cachedPer1K, maxPer1K, maxTokensPerSide);
  }
}
