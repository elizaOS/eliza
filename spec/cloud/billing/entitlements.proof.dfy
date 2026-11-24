lemma lawOnlyTheHighestServingGrantGivesAPlan_ensures(subscription: cloud__billing__subscriptions_Subscription, grants: seq<HeldGrant>, now: int)
  ensures (lawOnlyTheHighestServingGrantGivesAPlan(subscription, grants, now) == true)
{
  ServingGrantFold(grants, now, noHeldGrant);
}

lemma ServingGrantFold(grants: seq<HeldGrant>, now: int, init: HeldGrant)
  ensures var best := Std.Collections.Seq.FoldLeft((best: HeldGrant, g: HeldGrant) => (if (grantServes(g, now) && (cloud__billing__plans_rankOf(g.planKey) > cloud__billing__plans_rankOf(best.planKey))) then g else best), init, grants);
    (best == init || (best in grants && grantServes(best, now)))
    && cloud__billing__plans_rankOf(best.planKey) >= cloud__billing__plans_rankOf(init.planKey)
    && (forall g :: g in grants && grantServes(g, now) ==> cloud__billing__plans_rankOf(g.planKey) <= cloud__billing__plans_rankOf(best.planKey))
  decreases |grants|
{
  if |grants| > 0 {
    var step := (best: HeldGrant, g: HeldGrant) => (if (grantServes(g, now) && (cloud__billing__plans_rankOf(g.planKey) > cloud__billing__plans_rankOf(best.planKey))) then g else best);
    ServingGrantFold(grants[1..], now, step(init, grants[0]));
    assert grants == [grants[0]] + grants[1..];
  }
}
