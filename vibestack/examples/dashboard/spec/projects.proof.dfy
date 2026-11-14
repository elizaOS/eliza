// Proofs that each transition of projects.md keeps a sheet to one project, a
// key to one project and every project keyed and sheeted, that the admin
// screen never gives a project a channel another project has, and the law
// about which project a channel means.
//
// The two counting rules use Std.Collections.Seq.Filter. The bridges below
// restate the generated definitions with ProofLib.Filter, whose facts meet the
// generated terms, and then as "no two entries have the same sheet" (or key).
// Each transition is then argued on that plain form. Predicates passed to
// ProofLib.Filter are copied verbatim from gen/proof/projects/projects.dfy;
// the key functions given to DistinctBy are our own.

// ---- obligations ----

lemma connect_ensures(r: Registry, key: string, sheet: string, channel: string)
  ensures (inv(r) ==> canConnect(r, key, sheet, channel) ==> alwaysASheetHasOneProject(connect(r, key, sheet, channel)))
  ensures (inv(r) ==> canConnect(r, key, sheet, channel) ==> alwaysAKeyNamesOneProject(connect(r, key, sheet, channel)))
  ensures (inv(r) ==> canConnect(r, key, sheet, channel) ==> alwaysEveryProjectHasAKeyAndASheet(connect(r, key, sheet, channel)))
  ensures (inv(r) ==> canConnect(r, key, sheet, channel) ==> stepTheAdminScreenNeverSharesAChannel(r, connect(r, key, sheet, channel)))
{
  if inv(r) && canConnect(r, key, sheet, channel) {
    ConnectKeepsInv(r, key, sheet, channel);
    ConnectStep(r, key, sheet, channel);
  }
}

lemma disconnect_ensures(r: Registry, key: string)
  ensures (inv(r) ==> canDisconnect(r, key) ==> alwaysASheetHasOneProject(disconnect(r, key)))
  ensures (inv(r) ==> canDisconnect(r, key) ==> alwaysAKeyNamesOneProject(disconnect(r, key)))
  ensures (inv(r) ==> canDisconnect(r, key) ==> alwaysEveryProjectHasAKeyAndASheet(disconnect(r, key)))
  ensures (inv(r) ==> canDisconnect(r, key) ==> stepTheAdminScreenNeverSharesAChannel(r, disconnect(r, key)))
{
  if inv(r) {
    DisconnectKeepsInv(r, key);
    DisconnectStep(r, key);
  }
}

lemma setChannel_ensures(r: Registry, key: string, channel: string)
  ensures (inv(r) ==> canSetChannel(r, key, channel) ==> alwaysASheetHasOneProject(setChannel(r, key, channel)))
  ensures (inv(r) ==> canSetChannel(r, key, channel) ==> alwaysAKeyNamesOneProject(setChannel(r, key, channel)))
  ensures (inv(r) ==> canSetChannel(r, key, channel) ==> alwaysEveryProjectHasAKeyAndASheet(setChannel(r, key, channel)))
  ensures (inv(r) ==> canSetChannel(r, key, channel) ==> stepTheAdminScreenNeverSharesAChannel(r, setChannel(r, key, channel)))
{
  if inv(r) && canSetChannel(r, key, channel) {
    RechannelKeepsInv(r, setChannel(r, key, channel));
    SetChannelStep(r, key, channel);
  }
}

lemma handSetChannel_ensures(r: Registry, key: string, channel: string)
  ensures (inv(r) ==> canHandSetChannel(r, key, channel) ==> alwaysASheetHasOneProject(handSetChannel(r, key, channel)))
  ensures (inv(r) ==> canHandSetChannel(r, key, channel) ==> alwaysAKeyNamesOneProject(handSetChannel(r, key, channel)))
  ensures (inv(r) ==> canHandSetChannel(r, key, channel) ==> alwaysEveryProjectHasAKeyAndASheet(handSetChannel(r, key, channel)))
  ensures (inv(r) ==> canHandSetChannel(r, key, channel) ==> stepTheAdminScreenNeverSharesAChannel(r, handSetChannel(r, key, channel)))
{
  if inv(r) {
    RechannelKeepsInv(r, handSetChannel(r, key, channel));
  }
}

// One claimant is an entry, so it has a key, and it is every claimant.
lemma lawAnAnswerIsTheOnlyClaimant_ensures(r: Registry, channel: string)
  ensures (lawAnAnswerIsTheOnlyClaimant(r, channel) == true)
{
  var c := claimants(r, channel);
  if |c| == 1 {
    ClaimantsFilter(r, channel);
    ProofLib.FilterMember((e: Entry) => ((channel != "") && (e.channel == channel)), r.entries, c[0]);
    assert c[0] in r.entries;
  }
}

// ---- bridges from the generated definitions to ProofLib.Filter ----

lemma SheetsFilter(r: Registry)
  ensures alwaysASheetHasOneProject(r) == !(exists a :: a in r.entries && !(|ProofLib.Filter((b: Entry) => (b.sheet == a.sheet), r.entries)| == 1))
{
}

lemma KeysFilter(r: Registry)
  ensures alwaysAKeyNamesOneProject(r) == !(exists a :: a in r.entries && !(|ProofLib.Filter((b: Entry) => (b.key == a.key), r.entries)| == 1))
{
}

lemma DisconnectFilter(r: Registry, key: string)
  ensures disconnect(r, key).entries == ProofLib.Filter((e: Entry) => (e.key != key), r.entries)
{
}

lemma ClaimantsFilter(r: Registry, channel: string)
  ensures claimants(r, channel) == ProofLib.Filter((e: Entry) => ((channel != "") && (e.channel == channel)), r.entries)
{
}

// ---- the rules in plain form ----

lemma SheetsBridge(r: Registry)
  ensures alwaysASheetHasOneProject(r) <==> ProofLib.DistinctBy(r.entries, (e: Entry) => e.sheet)
{
  var xs := r.entries;
  SheetsFilter(r);
  forall i | 0 <= i < |xs|
    ensures |ProofLib.Filter((b: Entry) => (b.sheet == xs[i].sheet), xs)| == 1 <==> forall j :: 0 <= j < |xs| && j != i ==> xs[j].sheet != xs[i].sheet
  {
    var a := xs[i];
    ProofLib.FilterCountOneIffUnique((b: Entry) => (b.sheet == a.sheet), xs, (e: Entry) => e.sheet, i);
  }
}

lemma KeysBridge(r: Registry)
  ensures alwaysAKeyNamesOneProject(r) <==> ProofLib.DistinctBy(r.entries, (e: Entry) => e.key)
{
  var xs := r.entries;
  KeysFilter(r);
  forall i | 0 <= i < |xs|
    ensures |ProofLib.Filter((b: Entry) => (b.key == xs[i].key), xs)| == 1 <==> forall j :: 0 <= j < |xs| && j != i ==> xs[j].key != xs[i].key
  {
    var a := xs[i];
    ProofLib.FilterCountOneIffUnique((b: Entry) => (b.key == a.key), xs, (e: Entry) => e.key, i);
  }
}

lemma InvBridge(r: Registry)
  ensures inv(r) <==> (ProofLib.DistinctBy(r.entries, (e: Entry) => e.sheet) && ProofLib.DistinctBy(r.entries, (e: Entry) => e.key)
    && (forall e :: e in r.entries ==> e.key != "" && e.sheet != ""))
{
  SheetsBridge(r);
  KeysBridge(r);
}

lemma DisconnectKeeps(r: Registry, key: string, x: Entry)
  ensures x in disconnect(r, key).entries <==> x in r.entries && x.key != key
{
  DisconnectFilter(r, key);
  ProofLib.FilterMember((e: Entry) => (e.key != key), r.entries, x);
}

// ---- the step rule, transition by transition ----

// The new project's channel was free: no other project has it.
lemma ConnectStep(r: Registry, key: string, sheet: string, channel: string)
  requires canConnect(r, key, sheet, channel)
  ensures stepTheAdminScreenNeverSharesAChannel(r, connect(r, key, sheet, channel))
{
  var after := connect(r, key, sheet, channel);
  forall i | 0 <= i < |after.entries|
    ensures var a := after.entries[i]; a.channel == "" || (exists b :: b in r.entries && b.key == a.key && b.channel == a.channel) || (forall b :: b in after.entries ==> b.key == a.key || b.channel != a.channel)
  {
    if i < |r.entries| {
      assert after.entries[i] == r.entries[i] && r.entries[i] in r.entries;
    } else {
      forall b | b in r.entries
        ensures b.key != key && (channel == "" || b.channel != channel)
      {
      }
    }
  }
}

// Every project left was there before, with its channel.
lemma DisconnectStep(r: Registry, key: string)
  ensures stepTheAdminScreenNeverSharesAChannel(r, disconnect(r, key))
{
  var after := disconnect(r, key);
  forall i | 0 <= i < |after.entries|
    ensures var a := after.entries[i]; exists b :: b in r.entries && b.key == a.key && b.channel == a.channel
  {
    DisconnectKeeps(r, key, after.entries[i]);
  }
}

// The project whose channel changed took a free one; every other project kept its own.
lemma SetChannelStep(r: Registry, key: string, channel: string)
  requires canSetChannel(r, key, channel)
  ensures stepTheAdminScreenNeverSharesAChannel(r, setChannel(r, key, channel))
{
  var after := setChannel(r, key, channel);
  forall i | 0 <= i < |after.entries|
    ensures var a := after.entries[i]; a.channel == "" || (exists b :: b in r.entries && b.key == a.key && b.channel == a.channel) || (forall b :: b in after.entries ==> b.key == a.key || b.channel != a.channel)
  {
    if r.entries[i].key == key && channel != "" {
      forall b | b in after.entries
        ensures b.key == key || b.channel != channel
      {
        var j :| 0 <= j < |after.entries| && after.entries[j] == b;
        assert r.entries[j] in r.entries;
      }
    } else if r.entries[i].key != key {
      assert after.entries[i] == r.entries[i] && r.entries[i] in r.entries;
    }
  }
}

// ---- the always rules, transition by transition ----

lemma ConnectKeepsInv(r: Registry, key: string, sheet: string, channel: string)
  requires inv(r) && canConnect(r, key, sheet, channel)
  ensures inv(connect(r, key, sheet, channel))
{
  var after := connect(r, key, sheet, channel);
  InvBridge(r);
  InvBridge(after);
  assert forall i :: 0 <= i < |r.entries| ==> r.entries[i] in r.entries;
}

lemma DisconnectKeepsInv(r: Registry, key: string)
  requires inv(r)
  ensures inv(disconnect(r, key))
{
  InvBridge(r);
  InvBridge(disconnect(r, key));
  DisconnectFilter(r, key);
  ProofLib.FilterKeepsDistinctBy((e: Entry) => (e.key != key), r.entries, (e: Entry) => e.sheet);
  ProofLib.FilterKeepsDistinctBy((e: Entry) => (e.key != key), r.entries, (e: Entry) => e.key);
  forall x | x in disconnect(r, key).entries
    ensures x in r.entries
  {
    DisconnectKeeps(r, key, x);
  }
}

lemma RechannelKeepsInv(r: Registry, after: Registry)
  requires inv(r)
  requires |after.entries| == |r.entries|
  requires forall i :: 0 <= i < |r.entries| ==> after.entries[i].key == r.entries[i].key && after.entries[i].sheet == r.entries[i].sheet
  ensures inv(after)
{
  InvBridge(r);
  InvBridge(after);
  forall x | x in after.entries
    ensures x.key != "" && x.sheet != ""
  {
    var i :| 0 <= i < |after.entries| && after.entries[i] == x;
    assert r.entries[i] in r.entries;
  }
}
