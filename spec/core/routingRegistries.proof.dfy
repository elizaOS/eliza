lemma LocalizedProviderRoutingCounts(s: RoutingRegistries)
  ensures alwaysLocalizedSlotUnique(s) ==
    (forall entry :: entry in s.localized ==> |ProofLib.Filter((other: LocalizedProvider) => other.runtime == entry.runtime, s.localized)| == 1)
{}

lemma DirectRouteRoutingCounts(s: RoutingRegistries)
  ensures alwaysDirectIdsUniquePerRuntime(s) ==
    (forall entry :: entry in s.direct ==> |ProofLib.Filter((other: DirectRoute) => other.runtime == entry.runtime && other.id == entry.id, s.direct)| == 1)
{}

lemma registerLocalized_ensures(s: RoutingRegistries, runtimeId: int, reference: int)
  ensures (inv(s) ==> canRegisterLocalized(s, runtimeId, reference) ==> alwaysLocalizedSlotUnique(registerLocalized(s, runtimeId, reference)))
  ensures (inv(s) ==> canRegisterLocalized(s, runtimeId, reference) ==> alwaysDirectIdsUniquePerRuntime(registerLocalized(s, runtimeId, reference)))
{
  if inv(s) && canRegisterLocalized(s, runtimeId, reference) {
    var added := LocalizedProvider(runtimeId, reference);
    var after := registerLocalized(s, runtimeId, reference);
    var matching := (row: LocalizedProvider) => row.runtime == added.runtime;
    LocalizedProviderRoutingCounts(s);
    LocalizedProviderRoutingCounts(after);
    if exists row :: row in s.localized && matching(row) {
      assert |after.localized| == |s.localized|;
      forall index | 0 <= index < |s.localized|
        ensures after.localized[index].runtime == s.localized[index].runtime

      {
        assert after.localized[index] == (if s.localized[index].runtime == added.runtime then added else s.localized[index]);
      }
      forall entry | entry in after.localized
        ensures |ProofLib.Filter((other: LocalizedProvider) => other.runtime == entry.runtime, after.localized)| == 1
      {
        var index :| 0 <= index < |after.localized| && after.localized[index] == entry;
        assert s.localized[index] in s.localized;
        var key := (other: LocalizedProvider) => other.runtime == entry.runtime;
        assert |ProofLib.Filter((other: LocalizedProvider) => other.runtime == s.localized[index].runtime, s.localized)| == 1;
        ProofLib.FilterLengthPointwise(key, key, s.localized, after.localized);
      }
    } else {
      assert after.localized == s.localized + [added];
      forall entry | entry in after.localized
        ensures |ProofLib.Filter((other: LocalizedProvider) => other.runtime == entry.runtime, after.localized)| == 1
      {
        var key := (other: LocalizedProvider) => other.runtime == entry.runtime;
        ProofLib.FilterAppend(key, s.localized, added);
        if entry == added {
          ProofLib.FilterNone(matching, s.localized);
        } else {
          assert entry in s.localized;
          assert !matching(entry);
        }
      }
    }
  }
}

lemma registerDirectRoute_ensures(s: RoutingRegistries, route: DirectRoute)
  ensures (inv(s) ==> canRegisterDirectRoute(s, route) ==> alwaysLocalizedSlotUnique(registerDirectRoute(s, route)))
  ensures (inv(s) ==> canRegisterDirectRoute(s, route) ==> alwaysDirectIdsUniquePerRuntime(registerDirectRoute(s, route)))
{
  if inv(s) && canRegisterDirectRoute(s, route) {
    var added := route;
    var after := registerDirectRoute(s, route);
    var matching := (row: DirectRoute) => row.runtime == added.runtime && row.id == added.id;
    DirectRouteRoutingCounts(s);
    DirectRouteRoutingCounts(after);
    if exists row :: row in s.direct && matching(row) {
      assert |after.direct| == |s.direct|;
      forall index | 0 <= index < |s.direct|
        ensures after.direct[index].runtime == s.direct[index].runtime
        ensures after.direct[index].id == s.direct[index].id
      {
        assert after.direct[index] == (if s.direct[index].runtime == added.runtime && s.direct[index].id == added.id then added else s.direct[index]);
      }
      forall entry | entry in after.direct
        ensures |ProofLib.Filter((other: DirectRoute) => other.runtime == entry.runtime && other.id == entry.id, after.direct)| == 1
      {
        var index :| 0 <= index < |after.direct| && after.direct[index] == entry;
        assert s.direct[index] in s.direct;
        var key := (other: DirectRoute) => other.runtime == entry.runtime && other.id == entry.id;
        assert |ProofLib.Filter((other: DirectRoute) => other.runtime == s.direct[index].runtime && other.id == s.direct[index].id, s.direct)| == 1;
        ProofLib.FilterLengthPointwise(key, key, s.direct, after.direct);
      }
    } else {
      assert after.direct == s.direct + [added];
      forall entry | entry in after.direct
        ensures |ProofLib.Filter((other: DirectRoute) => other.runtime == entry.runtime && other.id == entry.id, after.direct)| == 1
      {
        var key := (other: DirectRoute) => other.runtime == entry.runtime && other.id == entry.id;
        ProofLib.FilterAppend(key, s.direct, added);
        if entry == added {
          ProofLib.FilterNone(matching, s.direct);
        } else {
          assert entry in s.direct;
          assert !matching(entry);
        }
      }
    }
  }
}

lemma resetDirectRoutes_ensures(s: RoutingRegistries, runtimeId: int)
  ensures (inv(s) ==> canResetDirectRoutes(s, runtimeId) ==> alwaysLocalizedSlotUnique(resetDirectRoutes(s, runtimeId)))
  ensures (inv(s) ==> canResetDirectRoutes(s, runtimeId) ==> alwaysDirectIdsUniquePerRuntime(resetDirectRoutes(s, runtimeId)))
{
  if inv(s) && canResetDirectRoutes(s, runtimeId) {
    var kept := (row: DirectRoute) => row.runtime != runtimeId;
    var after := resetDirectRoutes(s, runtimeId);
    assert after.direct == ProofLib.Filter(kept, s.direct);
    DirectRouteRoutingCounts(s);
    DirectRouteRoutingCounts(after);
    forall entry | entry in after.direct
      ensures |ProofLib.Filter((other: DirectRoute) => other.runtime == entry.runtime && other.id == entry.id, after.direct)| == 1
    {
      var key := (other: DirectRoute) => other.runtime == entry.runtime && other.id == entry.id;
      ProofLib.FilterMember(kept, s.direct, entry);
      ProofLib.FilterOfFilterShorter(kept, key, s.direct);
      ProofLib.FilterMember(key, after.direct, entry);
    }
  }
}
