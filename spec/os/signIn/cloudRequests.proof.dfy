lemma lawASentRequestIsAdmittedOnTheOrigin_ensures(routes: seq<agent__access__routes_Group>, h: Holding, origin: cloud__client_BaseUrl, request: agent__access__routes_Request, headers: seq<string>)
  ensures (lawASentRequestIsAdmittedOnTheOrigin(routes, h, origin, request, headers) == true)
{
  var admission := agent__access__routes_admission(routes, request);
  var offered := agent__access__routes_admittedRoute(admission);
  var first := if 0 < |offered| then offered[0] else agent__access__routes_noTemplate;
  var devices := deviceRouteOf(first);
  var plan := planRequest(routes, h, origin, request, headers);
  if !cloud__client_originAccepted(origin) {
    assert plan == Refuse(CallRefusal.NoOrigin);
  } else if admission.TooLarge? {
    assert plan == Refuse(CallRefusal.BodyTooLarge);
  } else if |offered| != 1 || |devices| != 1 {
    assert plan == Refuse(CallRefusal.NotListed);
  } else if "Authorization" in headers {
    assert !headerAllowed(devices[0], "Authorization");
    assert exists x :: x in headers && !headerAllowed(devices[0], x);
    assert plan == Refuse(CallRefusal.HeaderRefused);
  }
}

lemma lawACancelChangesOnlyItsOwnCallInFlight_ensures(calls: seq<PageCall>, name: string)
  ensures (lawACancelChangesOnlyItsOwnCallInFlight(calls, name) == true)
{
  var after := cancelCall(calls, name);
  var other := (c: PageCall) => c.name != name;
  var settled := (c: PageCall) => c.status.CallSettled?;
  if |calls| > 0 {
    var tail := calls[1..];
    assert after[1..] == cancelCall(tail, name) by {
      forall i | 0 <= i < |tail|
        ensures after[1..][i] == cancelCall(tail, name)[i]
      {
        assert tail[i] == calls[i + 1];
      }
    }
    lawACancelChangesOnlyItsOwnCallInFlight_ensures(tail, name);
    ProofLib.FilterCons(other, calls);
    ProofLib.FilterCons(other, after);
    ProofLib.FilterCons(settled, calls);
    ProofLib.FilterCons(settled, after);
    assert after == [after[0]] + after[1..];
  } else {
    assert after == calls;
  }
}

lemma lawAGrantReadsOnce_ensures(grants: seq<Grant>, grant: string)
  ensures (lawAGrantReadsOnce(grants, grant) == true)
{
  var left := redeem(grants, grant).grants;
  forall i | 0 <= i < |left| ensures left[i].grant != grant {
    ProofLib.FilterMember((g: Grant) => g.grant != grant, grants, left[i]);
  }
  ProofLib.FilterNone((g: Grant) => g.grant == grant, left);
}
