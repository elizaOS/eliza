lemma Added(xs: seq<int>, x: int, y: int)
  ensures y in xs + ProofLib.Filter((set_x: int) => !((set_x in xs)), [x]) <==> y in xs || y == x
{
  ProofLib.FilterMember((set_x: int) => !((set_x in xs)), [x], y);
}

lemma ExactLive(b: BrowserReturns)
  ensures alwaysExactLiveClient(b) <==> !b.misdelivered && forall i :: 0 <= i < |b.delivered| ==> b.delivered[i] in b.started
{
  ProofLib.FilterNone((c: int) => !((c in b.started)), b.delivered);
}

lemma Undelivered(b: BrowserReturns, client: int)
  requires alwaysExactLiveClient(b) && client !in b.started
  ensures deliveries(b, client) == 0
{
  ExactLive(b);
  ProofLib.FilterNone((c: int) => (c == client), b.delivered);
}

lemma start_ensures(b: BrowserReturns, client: int, validOriginAndProof: bool)
  ensures (inv(b) ==> canStart(b, client) ==> alwaysStartedClientsAreRegistered(start(b, client, validOriginAndProof)))
  ensures (inv(b) ==> canStart(b, client) ==> alwaysExactLiveClient(start(b, client, validOriginAndProof)))
  ensures (inv(b) ==> canStart(b, client) ==> alwaysConsumedOnce(start(b, client, validOriginAndProof)))
  ensures (inv(b) ==> canStart(b, client) ==> alwaysIndependentClients(start(b, client, validOriginAndProof)))
{
  if inv(b) && canStart(b, client) && client in b.registered && validOriginAndProof {
    var after := start(b, client, validOriginAndProof);
    forall y ensures (y in after.started <==> y in b.started || y == client) && (y in after.pending <==> y in b.pending || y == client) {
      Added(b.started, client, y);
      Added(b.pending, client, y);
    }
    Undelivered(b, client);
    ExactLive(b);
    ExactLive(after);
  }
}

lemma register_ensures(b: BrowserReturns, client: int)
  ensures (inv(b) ==> canRegister(b, client) ==> alwaysStartedClientsAreRegistered(register(b, client)))
  ensures (inv(b) ==> canRegister(b, client) ==> alwaysExactLiveClient(register(b, client)))
  ensures (inv(b) ==> canRegister(b, client) ==> alwaysConsumedOnce(register(b, client)))
  ensures (inv(b) ==> canRegister(b, client) ==> alwaysIndependentClients(register(b, client)))
{
  if inv(b) && canRegister(b, client) {
    var after := register(b, client);
    forall y ensures y in after.registered <==> y in b.registered || y == client {
      Added(b.registered, client, y);
    }
    Undelivered(b, client);
  }
}

lemma callback_ensures(b: BrowserReturns, client: int, boundClient: int, matchingState: bool, validShape: bool)
  ensures (inv(b) ==> alwaysStartedClientsAreRegistered(callback(b, client, boundClient, matchingState, validShape)))
  ensures (inv(b) ==> alwaysExactLiveClient(callback(b, client, boundClient, matchingState, validShape)))
  ensures (inv(b) ==> alwaysConsumedOnce(callback(b, client, boundClient, matchingState, validShape)))
  ensures (inv(b) ==> alwaysIndependentClients(callback(b, client, boundClient, matchingState, validShape)))
{
  if inv(b) && callbackAdmitted(b, client, boundClient, matchingState, validShape) {
    var after := callback(b, client, boundClient, matchingState, validShape);
    forall y ensures y in after.pending <==> y in b.pending && y != client {
      ProofLib.FilterMember((set_x: int) => !((set_x in [client])), b.pending, y);
    }
    forall k ensures deliveries(after, k) == deliveries(b, k) + (if k == client then 1 else 0) {
      ProofLib.FilterAppend((c: int) => (c == k), b.delivered, client);
    }
    ExactLive(b);
    ExactLive(after);
  }
}
