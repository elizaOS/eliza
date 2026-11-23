lemma RequestedScopeFilter(asked: seq<GoogleCapability>, s: GoogleScope)
  ensures (s in requestedScopes(asked)) ==
    (s in ProofLib.Filter((s: GoogleScope) => (exists k :: k in (asked + [typed0_cloud__services__google__connection(GoogleCapability.BasicIdentity)]) && (s in scopesFor(k))), allScopes))
{}

lemma RequestedScopeMembership(asked: seq<GoogleCapability>, s: GoogleScope)
  ensures s in requestedScopes(asked) <==> (s in allScopes &&
    (exists k :: k in asked + [BasicIdentity] && s in scopesFor(k)))
{
  RequestedScopeFilter(asked, s);
  ProofLib.FilterMember((s: GoogleScope) => (exists k :: k in (asked + [typed0_cloud__services__google__connection(GoogleCapability.BasicIdentity)]) && (s in scopesFor(k))), allScopes, s);
}

lemma CapabilityMembership(scopes: seq<GoogleScope>, k: GoogleCapability)
  ensures k in capabilitiesOf(scopes) <==> grantsCapability(scopes, k)
{
  assert k in allCapabilities;
  assert capabilitiesOf(scopes) == ProofLib.Filter((k: GoogleCapability) => grantsCapability(scopes, k), allCapabilities);
  ProofLib.FilterMember((k: GoogleCapability) => grantsCapability(scopes, k), allCapabilities, k);
}

lemma RequestedScopeGrants(asked: seq<GoogleCapability>, k: GoogleCapability)
  requires k in asked
  ensures grantsCapability(requestedScopes(asked), k)
{
  var s := scopesFor(k)[0];
  assert s in allScopes && s in scopesFor(k);
  assert k in asked + [BasicIdentity];
  RequestedScopeMembership(asked, s);
  assert s in requestedScopes(asked);
}

lemma lawEveryAskedCapabilityIsGrantedByItsScopes_ensures(asked: seq<GoogleCapability>)
  ensures (lawEveryAskedCapabilityIsGrantedByItsScopes(asked) == true)
{
  forall k | k in asked ensures k in capabilitiesOf(requestedScopes(asked)) {
    RequestedScopeGrants(asked, k);
    CapabilityMembership(requestedScopes(asked), k);
  }
}

lemma lawStrongerAccessImpliesWeaker_ensures(scopes: seq<GoogleScope>)
  ensures (lawStrongerAccessImpliesWeaker(scopes) == true)
{
  CapabilityMembership(scopes, CalendarWrite);
  CapabilityMembership(scopes, CalendarRead);
  CapabilityMembership(scopes, GmailManage);
  CapabilityMembership(scopes, GmailMailbox);
  CapabilityMembership(scopes, GmailTriage);
  CapabilityMembership(scopes, GmailDrafts);
  if grantsCapability(scopes, CalendarWrite) {
    assert ScopeCalendarEvents in scopes || ScopeCalendar in scopes;
  }
  if grantsCapability(scopes, GmailMailbox) {
    assert ScopeGmailModify in scopes;
  }
}

lemma FilterTwiceKeepsLength<T>(rows: seq<T>, first: T -> bool, second: T -> bool, combined: T -> bool)
  requires forall row :: row in rows ==> combined(row) == (first(row) && second(row))
  ensures |ProofLib.Filter(second, ProofLib.Filter(first, rows))| == |ProofLib.Filter(combined, rows)|
  decreases |rows|
{
  if |rows| == 0 {
    ProofLib.FilterNil(first, rows);
    ProofLib.FilterNil(second, []);
    ProofLib.FilterNil(combined, rows);
  } else {
    var tail := rows[1..];
    var row := rows[0];
    assert row in rows;
    assert combined(row) == (first(row) && second(row));
    forall value | value in tail ensures combined(value) == (first(value) && second(value)) {
      assert value in rows;
    }
    FilterTwiceKeepsLength(tail, first, second, combined);
    ProofLib.FilterCons(first, rows);
    ProofLib.FilterCons(combined, rows);
    var held := ProofLib.Filter(first, rows);
    var heldTail := ProofLib.Filter(first, tail);
    if first(row) {
      assert held == [row] + heldTail && held[0] == row && held[1..] == heldTail;
      ProofLib.FilterCons(second, held);
      assert |ProofLib.Filter(second, held)| ==
        (if second(row) then 1 else 0) + |ProofLib.Filter(second, heldTail)|;
    } else {
      assert held == heldTail && !combined(row);
    }
    assert |ProofLib.Filter(combined, rows)| ==
      (if combined(row) then 1 else 0) + |ProofLib.Filter(combined, tail)|;
  }
}

lemma ActiveCountMatchesLaw(rows: seq<GrantView>, organization: string)
  ensures lawNoGrantIsGuessedAmongSeveral(rows, organization) ==
    (|ProofLib.Filter((r: GrantView) => ((r.owner == organization) && r.status.Active?), rows)| > 1 ==>
      selectGrant(rows, organization, Side.OwnerSide, GrantChoice.AnyGrant) == typed3_cloud__services__google__connection(SelectionRefused(SelectionFault.SeveralActiveGrants)))
{}

lemma GrantSelectionMatchesFilters(rows: seq<GrantView>, organization: string, side: Side, choice: GrantChoice)
  ensures selectGrant(rows, organization, side, choice) ==
    (var held := ProofLib.Filter((r: GrantView) => ((r.owner == organization) && (!r.status.Pending?)), rows);
     var active := ProofLib.Filter((r: GrantView) => r.status.Active?, held);
     var newest := Std.Collections.Seq.FoldLeft((acc: string, r: GrantView) => (if (acc == "") then r.grantId else acc), "", held);
     if (!side.OwnerSide?) then SelectionRefused(SelectionFault.SideNotOwner)
     else if choice.NamedGrant? then
       if (exists r :: r in held && (r.grantId == choice.grantId)) then SelectedGrant(choice.grantId)
       else SelectionRefused(SelectionFault.GrantUnknown)
     else if |active| > 1 then SelectionRefused(SelectionFault.SeveralActiveGrants)
     else if |active| == 1 then SelectedGrant(Std.Collections.Seq.FoldLeft((acc: string, r: GrantView) => r.grantId, "", active))
     else if newest != "" then SelectedGrant(newest)
     else Selection.NoGrantHeld)
{}

lemma lawNoGrantIsGuessedAmongSeveral_ensures(rows: seq<GrantView>, organization: string)
  ensures (lawNoGrantIsGuessedAmongSeveral(rows, organization) == true)
{
  var held := (r: GrantView) => ((r.owner == organization) && (!r.status.Pending?));
  var active := (r: GrantView) => r.status.Active?;
  var belongs := (r: GrantView) => ((r.owner == organization) && r.status.Active?);
  FilterTwiceKeepsLength(rows, held, active, belongs);
  ActiveCountMatchesLaw(rows, organization);
  GrantSelectionMatchesFilters(rows, organization, Side.OwnerSide, GrantChoice.AnyGrant);
}

lemma FirstNonemptyGrantComesFromRows(rows: seq<GrantView>)
  ensures var selected := Std.Collections.Seq.FoldLeft((acc: string, r: GrantView) => (if acc == "" then r.grantId else acc), "", rows);
    selected != "" ==> exists r :: r in rows && r.grantId == selected
  decreases |rows|
{
  if |rows| == 0 {
    assert rows == [];
  } else {
    var prefix := rows[..|rows|-1];
    var last := rows[|rows|-1];
    assert rows == prefix + [last];
    FirstNonemptyGrantComesFromRows(prefix);
    ProofLib.FoldLeftAppend((acc: string, r: GrantView) => (if acc == "" then r.grantId else acc), "", prefix, last);
  }
}

lemma lawASelectedGrantIsTheCallersConnection_ensures(rows: seq<GrantView>, organization: string, side: Side, choice: GrantChoice)
  ensures (lawASelectedGrantIsTheCallersConnection(rows, organization, side, choice) == true)
{
  var heldFilter := (r: GrantView) => ((r.owner == organization) && (!r.status.Pending?));
  var activeFilter := (r: GrantView) => r.status.Active?;
  var held := ProofLib.Filter(heldFilter, rows);
  var active := ProofLib.Filter(activeFilter, held);
  GrantSelectionMatchesFilters(rows, organization, side, choice);
  var selected := selectGrant(rows, organization, side, choice);
  if selected.SelectedGrant? {
    if choice.NamedGrant? {
      var picked :| picked in held && picked.grantId == choice.grantId;
      ProofLib.FilterMember(heldFilter, rows, picked);
    } else if |active| == 1 {
      assert active == [active[0]];
      ProofLib.FoldLeftAppend((acc: string, r: GrantView) => r.grantId, "", [], active[0]);
      assert selected.grantId == active[0].grantId;
      ProofLib.FilterMember(activeFilter, held, active[0]);
      ProofLib.FilterMember(heldFilter, rows, active[0]);
    } else {
      var newest := Std.Collections.Seq.FoldLeft((acc: string, r: GrantView) => (if (acc == "") then r.grantId else acc), "", held);
      assert selected.grantId == newest && newest != "";
      FirstNonemptyGrantComesFromRows(held);
      var picked :| picked in held && picked.grantId == selected.grantId;
      ProofLib.FilterMember(heldFilter, rows, picked);
    }
  }
}
