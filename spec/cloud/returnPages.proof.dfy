lemma EntriesAtFilter(r: cloud__nativeClients__registry_Registration, url: cloud__nativeClients__registry_ReturnUrl)
  ensures cloud__nativeClients__registry_entriesAt(r, url) == ((var s_map := ProofLib.Filter((p: cloud__nativeClients__registry_ReturnPurpose) => cloud__nativeClients__registry_hasReturn(r, p, url), [cloud__nativeClients__registry_typed0_cloud__nativeClients__registry(cloud__nativeClients__registry_ReturnPurpose.SignInPurpose), cloud__nativeClients__registry_typed0_cloud__nativeClients__registry(cloud__nativeClients__registry_ReturnPurpose.BillingPurpose), cloud__nativeClients__registry_typed0_cloud__nativeClients__registry(cloud__nativeClients__registry_ReturnPurpose.ConnectPurpose)]); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var p := s_map[i_map]; cloud__nativeClients__registry_ReturnEntry(r, p))))
{}

lemma ReturnsAtFilter(registry: seq<cloud__nativeClients__registry_Registration>, served: cloud__deployment_Environment, url: cloud__nativeClients__registry_ReturnUrl)
  ensures cloud__nativeClients__registry_returnsAt(registry, served, url) == (Std.Collections.Seq.FoldLeft((acc: seq<cloud__nativeClients__registry_ReturnEntry>, r: cloud__nativeClients__registry_Registration) => (acc + cloud__nativeClients__registry_entriesAt(r, url)), [], ProofLib.Filter((r: cloud__nativeClients__registry_Registration) => (r.enabled && (r.environment == served)), registry)))
{}

lemma RegistryValidFilter(registry: seq<cloud__nativeClients__registry_Registration>, served: cloud__deployment_Environment)
  ensures cloud__nativeClients__registry_registryValid(registry, served) == (!((exists a :: a in registry && !((((a.environment == served) && cloud__nativeClients__registry_registrationValid(a)) && (|ProofLib.Filter((b: cloud__nativeClients__registry_Registration) => !(cloud__nativeClients__registry_sharesNothing(a, b)), registry)| == 1))))))
{}

lemma RegistrationValidFilter(r: cloud__nativeClients__registry_Registration)
  ensures cloud__nativeClients__registry_registrationValid(r) == ((((((((((r.clientId != "") && (r.displayName != "")) && (r.androidPackage != "")) && (|r.certFingerprints| >= 1)) && (|r.certFingerprints| <= cloud__nativeClients__registry_maxCertFingerprints)) && !((exists f :: f in r.certFingerprints && !((|ProofLib.Filter((g: string) => (g == f), r.certFingerprints)| == 1))))) && (r.credentialTtl >= cloud__nativeClients__registry_minCredentialTtl)) && (r.credentialTtl <= cloud__nativeClients__registry_maxCredentialTtl)) && !((exists u :: u in cloud__nativeClients__registry_returnsOf(r) && !((|ProofLib.Filter((v: cloud__nativeClients__registry_ReturnUrl) => (v == u), cloud__nativeClients__registry_returnsOf(r))| == 1))))))
{}

lemma BillingForwardFilter(params: ReturnParams)
  ensures forwarded(BillingPage, params) == (named("session_id", params.sessionIdParam) + (var s_map := ProofLib.Filter((t: string) => (t in billingResults), textOf(params.resultParam)); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var t := s_map[i_map]; Forwarded("result", t))))
{}

lemma NamedParamShape(name: string, value: ParamValue)
  ensures named(name, value) == (if value.WellFormed? then [Forwarded(name, value.text)] else [])
  ensures forall f :: f in named(name, value) ==> f.name == name && textOf(value) == [f.value]
{}

lemma BillingForwardShape(params: ReturnParams)
  ensures forwarded(BillingPage, params) == named("session_id", params.sessionIdParam) +
    (if params.resultParam.WellFormed? && params.resultParam.text in billingResults then
      [Forwarded("result", params.resultParam.text)] else [])
{
  BillingForwardFilter(params);
  var p := (t: string) => (t in billingResults);
  var values := textOf(params.resultParam);
  if params.resultParam.WellFormed? {
    ProofLib.FilterCons(p, values);
    ProofLib.FilterNil(p, []);
  } else {
    ProofLib.FilterNil(p, values);
  }
}

lemma ConnectForwardShape(params: ReturnParams)
  ensures var sent := connectForwarded(params);
    sent == [] ||
    (params.stateParam.WellFormed? && params.resultParam.WellFormed? &&
      (if params.resultParam.text == "connected" then
        params.connectionIdParam.WellFormed? &&
        sent == [Forwarded("state", params.stateParam.text), Forwarded("result", "connected"), Forwarded("connectionId", params.connectionIdParam.text)]
      else sent == [Forwarded("state", params.stateParam.text), Forwarded("result", params.resultParam.text)]))
{
  NamedParamShape("state", params.stateParam);
  NamedParamShape("result", params.resultParam);
  NamedParamShape("connectionId", params.connectionIdParam);
  if params.resultParam.WellFormed? {
    ProofLib.FoldLeftAppend((acc: string, t: string) => t, "", [], params.resultParam.text);
  }
}

lemma lawForwardsOnlyWellFormedValuesOrTheFixedError_ensures(purpose: PagePurpose, params: ReturnParams)
  ensures (lawForwardsOnlyWellFormedValuesOrTheFixedError(purpose, params) == true)
{
  match purpose
  case SignInPage => NamedParamShape("state", params.stateParam);
  case ConnectPage => ConnectForwardShape(params);
  case BillingPage =>
    NamedParamShape("session_id", params.sessionIdParam);
    BillingForwardShape(params);
  case ConnectedPage =>
}

lemma lawConnectForwardsAWholeResultOrNothing_ensures(params: ReturnParams)
  ensures (lawConnectForwardsAWholeResultOrNothing(params) == true)
{
  ConnectForwardShape(params);
}

lemma ReturnAnswerFold(row: cloud__deployment_EnvironmentProfile, registry: seq<cloud__nativeClients__registry_Registration>, served: cloud__deployment_Environment, url: cloud__nativeClients__registry_ReturnUrl)
  ensures returnAnswer(row, registry, served, url) ==
    (var local_0 := cloud__nativeClients__registry_returnsAt(registry, served, url);
      if ((url.origin != row.web) || (|local_0| != 1)) then notFoundAnswer
      else Std.Collections.Seq.FoldLeft((acc: PageAnswer, e: cloud__nativeClients__registry_ReturnEntry) => Shows(returnPage(row, e, url)), notFoundAnswer, local_0))
{}

lemma ReadableReturnAnswer(row: cloud__deployment_EnvironmentProfile, registry: seq<cloud__nativeClients__registry_Registration>, served: cloud__deployment_Environment, url: cloud__nativeClients__registry_ReturnUrl)
  ensures returnAnswer(row, registry, served, url) ==
    (var entries := cloud__nativeClients__registry_returnsAt(registry, served, url);
      if url.origin == row.web && |entries| == 1 then Shows(returnPage(row, entries[0], url)) else notFoundAnswer)
{
  ReturnAnswerFold(row, registry, served, url);
  var entries := cloud__nativeClients__registry_returnsAt(registry, served, url);
  if url.origin == row.web && |entries| == 1 {
    var show := (acc: PageAnswer, e: cloud__nativeClients__registry_ReturnEntry) => Shows(returnPage(row, e, url));
    assert entries == [] + [entries[0]];
    ProofLib.FoldLeftAppend(show, notFoundAnswer, [], entries[0]);
    assert Std.Collections.Seq.FoldLeft(show, notFoundAnswer, []) == notFoundAnswer;
    assert Std.Collections.Seq.FoldLeft(show, notFoundAnswer, entries) == Shows(returnPage(row, entries[0], url));
    assert returnAnswer(row, registry, served, url) == Shows(returnPage(row, entries[0], url));
  }
}

lemma lawOnlyAnUnreadableRegistryIsRetryable_ensures(row: cloud__deployment_EnvironmentProfile, registry: seq<cloud__nativeClients__registry_Registration>, readable: bool, served: cloud__deployment_Environment, url: cloud__nativeClients__registry_ReturnUrl, reported: string)
  ensures (lawOnlyAnUnreadableRegistryIsRetryable(row, registry, readable, served, url, reported) == true)
{
  if readable && !isPayerUrl(row, url) {
    ReadableReturnAnswer(row, registry, served, url);
  }
}

lemma EntryTargetsRegistration(r: cloud__nativeClients__registry_Registration, url: cloud__nativeClients__registry_ReturnUrl, e: cloud__nativeClients__registry_ReturnEntry)
  requires e in cloud__nativeClients__registry_entriesAt(r, url)
  ensures e.registration == r && url in cloud__nativeClients__registry_returnsOf(r)
{
  var p := (p: cloud__nativeClients__registry_ReturnPurpose) => cloud__nativeClients__registry_hasReturn(r, p, url);
  var purposes := [cloud__nativeClients__registry_typed0_cloud__nativeClients__registry(cloud__nativeClients__registry_ReturnPurpose.SignInPurpose), cloud__nativeClients__registry_typed0_cloud__nativeClients__registry(cloud__nativeClients__registry_ReturnPurpose.BillingPurpose), cloud__nativeClients__registry_typed0_cloud__nativeClients__registry(cloud__nativeClients__registry_ReturnPurpose.ConnectPurpose)];
  EntriesAtFilter(r, url);
  var matching := ProofLib.Filter(p, purposes);
  var entries := cloud__nativeClients__registry_entriesAt(r, url);
  assert entries == seq(|matching|, i requires 0 <= i < |matching| => cloud__nativeClients__registry_ReturnEntry(r, matching[i]));
  var i :| 0 <= i < |entries| && entries[i] == e;
  assert e == cloud__nativeClients__registry_ReturnEntry(r, matching[i]);
  ProofLib.FilterMember(p, purposes, matching[i]);
}

lemma ReturnEntryComesFromRows(rows: seq<cloud__nativeClients__registry_Registration>, url: cloud__nativeClients__registry_ReturnUrl, entry: cloud__nativeClients__registry_ReturnEntry)
  requires entry in Std.Collections.Seq.FoldLeft(
    (acc: seq<cloud__nativeClients__registry_ReturnEntry>, r: cloud__nativeClients__registry_Registration) => (acc + cloud__nativeClients__registry_entriesAt(r, url)), [], rows)
  ensures entry.registration in rows && url in cloud__nativeClients__registry_returnsOf(entry.registration)
  decreases |rows|
{
  var add := (acc: seq<cloud__nativeClients__registry_ReturnEntry>, r: cloud__nativeClients__registry_Registration) => (acc + cloud__nativeClients__registry_entriesAt(r, url));
  assert |rows| > 0;
  var prefix := rows[..|rows|-1];
  var last := rows[|rows|-1];
  assert rows == prefix + [last];
  ProofLib.FoldLeftAppend(add, [], prefix, last);
  if entry in cloud__nativeClients__registry_entriesAt(last, url) {
    EntryTargetsRegistration(last, url, entry);
  } else {
    ReturnEntryComesFromRows(prefix, url, entry);
  }
}

lemma ReturnEntryIsRegistered(registry: seq<cloud__nativeClients__registry_Registration>, served: cloud__deployment_Environment, url: cloud__nativeClients__registry_ReturnUrl, e: cloud__nativeClients__registry_ReturnEntry)
  requires e in cloud__nativeClients__registry_returnsAt(registry, served, url)
  ensures e.registration in registry && e.registration.enabled && e.registration.environment == served
  ensures url in cloud__nativeClients__registry_returnsOf(e.registration)
{
  ReturnsAtFilter(registry, served, url);
  var enabled := (r: cloud__nativeClients__registry_Registration) => (r.enabled && (r.environment == served));
  var active := ProofLib.Filter(enabled, registry);
  ReturnEntryComesFromRows(active, url, e);
  ProofLib.FilterMember(enabled, registry, e.registration);
}

lemma lawAReturnPageOpensItsOwnApp_ensures(row: cloud__deployment_EnvironmentProfile, registry: seq<cloud__nativeClients__registry_Registration>, served: cloud__deployment_Environment, url: cloud__nativeClients__registry_ReturnUrl, reported: string)
  ensures (lawAReturnPageOpensItsOwnApp(row, registry, served, url, reported) == true)
{
  if !isPayerUrl(row, url) {
    ReadableReturnAnswer(row, registry, served, url);
    var entries := cloud__nativeClients__registry_returnsAt(registry, served, url);
    if url.origin == row.web && |entries| == 1 {
      ReturnEntryIsRegistered(registry, served, url, entries[0]);
    }
  }
}

lemma ReturnPurposeCount(r: cloud__nativeClients__registry_Registration, url: cloud__nativeClients__registry_ReturnUrl)
  ensures (|cloud__nativeClients__registry_entriesAt(r, url)| > 0) <==> url in cloud__nativeClients__registry_returnsOf(r)
  ensures cloud__nativeClients__registry_registrationValid(r) ==> |cloud__nativeClients__registry_entriesAt(r, url)| <= 1
{
  EntriesAtFilter(r, url);
  var matches := (p: cloud__nativeClients__registry_ReturnPurpose) => cloud__nativeClients__registry_hasReturn(r, p, url);
  var signIn := cloud__nativeClients__registry_typed0_cloud__nativeClients__registry(cloud__nativeClients__registry_ReturnPurpose.SignInPurpose);
  var billing := cloud__nativeClients__registry_typed0_cloud__nativeClients__registry(cloud__nativeClients__registry_ReturnPurpose.BillingPurpose);
  var connect := cloud__nativeClients__registry_typed0_cloud__nativeClients__registry(cloud__nativeClients__registry_ReturnPurpose.ConnectPurpose);
  var purposes := [signIn, billing, connect];
  var found := ProofLib.Filter(matches, purposes);
  var entries := cloud__nativeClients__registry_entriesAt(r, url);
  var urls := cloud__nativeClients__registry_returnsOf(r);
  assert |entries| == |found|;
  if |entries| > 0 {
    assert entries[0] in entries;
    EntryTargetsRegistration(r, url, entries[0]);
  }
  if url in urls {
    var matching := if r.signInReturn == url then signIn else if r.billingReturn == url then billing else connect;
    assert matching in purposes && matches(matching);
    ProofLib.FilterMember(matches, purposes, matching);
    assert |found| > 0;
  }
  if cloud__nativeClients__registry_registrationValid(r) && |entries| > 1 {
    RegistrationValidFilter(r);
    var key := (p: cloud__nativeClients__registry_ReturnPurpose) => p;
    assert ProofLib.DistinctBy(purposes, key);
    ProofLib.FilterKeepsDistinctBy(matches, purposes, key);
    var first := found[0];
    var second := found[1];
    assert first != second && first in found && second in found;
    ProofLib.FilterMember(matches, purposes, first);
    ProofLib.FilterMember(matches, purposes, second);
    var i := if first.SignInPurpose? then 0 else if first.BillingPurpose? then 1 else 2;
    var j := if second.SignInPurpose? then 0 else if second.BillingPurpose? then 1 else 2;
    if first.ConnectPurpose? || second.ConnectPurpose? {
      assert r.connectReturn.ConnectsTo? && r.connectReturn.url == url;
    }
    assert i != j;
    assert 0 <= i < |urls| && 0 <= j < |urls|;
    assert urls[i] == url && urls[j] == url;
    var target := (v: cloud__nativeClients__registry_ReturnUrl) => (v == url);
    assert |ProofLib.Filter(target, urls)| == 1;
    ProofLib.FilterTwo(target, urls, i, j);
    assert false;
  }
}

lemma RegistryReturnOwnersAreDistinct(registry: seq<cloud__nativeClients__registry_Registration>, served: cloud__deployment_Environment)
  requires cloud__nativeClients__registry_registryValid(registry, served)
  ensures forall i, j :: 0 <= i < |registry| && 0 <= j < |registry| && i != j ==> cloud__nativeClients__registry_sharesNothing(registry[i], registry[j])
  ensures ProofLib.DistinctBy(registry, (r: cloud__nativeClients__registry_Registration) => r)
{
  RegistryValidFilter(registry, served);
  forall i, j | 0 <= i < |registry| && 0 <= j < |registry| && i != j
    ensures cloud__nativeClients__registry_sharesNothing(registry[i], registry[j])
  {
    var a := registry[i];
    assert a in registry;
    var overlaps := (b: cloud__nativeClients__registry_Registration) => !(cloud__nativeClients__registry_sharesNothing(a, b));
    assert |ProofLib.Filter(overlaps, registry)| == 1;
    if overlaps(registry[j]) {
      assert overlaps(registry[i]);
      ProofLib.FilterTwo(overlaps, registry, i, j);
    }
  }
  forall i, j | 0 <= i < |registry| && 0 <= j < |registry| && i != j
    ensures registry[i] != registry[j]
  {
    assert cloud__nativeClients__registry_sharesNothing(registry[i], registry[j]);
    assert registry[i].clientId != registry[j].clientId;
  }
}

lemma ValidRegistryReturnCount(registry: seq<cloud__nativeClients__registry_Registration>, served: cloud__deployment_Environment, url: cloud__nativeClients__registry_ReturnUrl)
  requires cloud__nativeClients__registry_registryValid(registry, served)
  ensures |cloud__nativeClients__registry_returnsAt(registry, served, url)| <= 1
  ensures (|cloud__nativeClients__registry_returnsAt(registry, served, url)| == 1) <==>
    (exists r :: r in registry && (r.enabled && (url in cloud__nativeClients__registry_returnsOf(r))))
{
  RegistryValidFilter(registry, served);
  RegistryReturnOwnersAreDistinct(registry, served);
  ReturnsAtFilter(registry, served, url);
  var enabled := (r: cloud__nativeClients__registry_Registration) => (r.enabled && (r.environment == served));
  var active := ProofLib.Filter(enabled, registry);
  ProofLib.FilterKeepsDistinctBy(enabled, registry, (r: cloud__nativeClients__registry_Registration) => r);
  var add := (acc: seq<cloud__nativeClients__registry_ReturnEntry>, r: cloud__nativeClients__registry_Registration) =>
    (acc + cloud__nativeClients__registry_entriesAt(r, url));
  var piece := (r: cloud__nativeClients__registry_Registration) => cloud__nativeClients__registry_entriesAt(r, url);
  var key := (e: cloud__nativeClients__registry_ReturnEntry) => 0;
  forall i | 0 <= i < |active|
    ensures ProofLib.DistinctBy(piece(active[i]), key)
  {
    assert active[i] in active;
    ProofLib.FilterMember(enabled, registry, active[i]);
    assert cloud__nativeClients__registry_registrationValid(active[i]);
    ReturnPurposeCount(active[i], url);
    assert |piece(active[i])| <= 1;
  }
  forall i, j, x, y | 0 <= i < j < |active| && x in piece(active[i]) && y in piece(active[j])
    ensures key(x) != key(y)
  {
    var a := active[i];
    var b := active[j];
    assert a in active && b in active;
    assert a != b;
    ProofLib.FilterMember(enabled, registry, a);
    ProofLib.FilterMember(enabled, registry, b);
    var ix :| 0 <= ix < |registry| && registry[ix] == a;
    var iy :| 0 <= iy < |registry| && registry[iy] == b;
    assert ix != iy;
    assert cloud__nativeClients__registry_sharesNothing(a, b);
    EntryTargetsRegistration(a, url, x);
    EntryTargetsRegistration(b, url, y);
    assert url in cloud__nativeClients__registry_returnsOf(a) && url in cloud__nativeClients__registry_returnsOf(b);
    assert false;
  }
  ProofLib.FoldLeftConcatDistinctBy(add, piece, key, [], active);
  var entries := cloud__nativeClients__registry_returnsAt(registry, served, url);
  assert ProofLib.DistinctBy(entries, key);
  if |entries| > 1 {
    assert key(entries[0]) != key(entries[1]);
    assert false;
  }
  if |entries| == 1 {
    assert entries[0] in entries;
    ReturnEntryIsRegistered(registry, served, url, entries[0]);
  }
  if exists r :: r in registry && (r.enabled && (url in cloud__nativeClients__registry_returnsOf(r))) {
    var r :| r in registry && (r.enabled && (url in cloud__nativeClients__registry_returnsOf(r)));
    assert r.environment == served;
    ProofLib.FilterMember(enabled, registry, r);
    var i :| 0 <= i < |active| && active[i] == r;
    ReturnPurposeCount(r, url);
    assert |piece(active[i])| > 0;
    ProofLib.FoldLeftConcatEmpty(add, piece, [], active);
    assert |entries| > 0;
  }
}

lemma lawReturnToAppExactlyForAnEnabledWebReturn_ensures(row: cloud__deployment_EnvironmentProfile, registry: seq<cloud__nativeClients__registry_Registration>, served: cloud__deployment_Environment, url: cloud__nativeClients__registry_ReturnUrl, reported: string)
  ensures (lawReturnToAppExactlyForAnEnabledWebReturn(row, registry, served, url, reported) == true)
{
  if cloud__nativeClients__registry_registryValid(registry, served) && !isPayerUrl(row, url) {
    ReadableReturnAnswer(row, registry, served, url);
    ValidRegistryReturnCount(registry, served, url);
  }
}
