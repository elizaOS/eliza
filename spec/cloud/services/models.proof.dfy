// Proofs for spec/cloud/services/models.md.

// The generated filters, restated over ProofLib.Filter.
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
