lemma IpLimitBridge(s: RequestIntegrity)
  ensures alwaysWithinIpLimit(s) <==> (forall c :: c in s.ipCounts ==> c.count >= 1 && c.count <= requestsPerIpWindow && |ProofLib.Filter((o: IpCount) => (o.ip == c.ip), s.ipCounts)| == 1)
{
}

lemma OnceBridge(s: RequestIntegrity)
  ensures alwaysNonceExecutesOnce(s) <==> (forall e :: e in s.log ==> |ProofLib.Filter((o: ExecutionRecord) => (o.nonce == e.nonce), s.log)| == 1 && e.nonce in s.usedNonces)
  ensures alwaysKeyExecutesOnce(s) <==> (forall e :: e in s.log ==> e.key == 0 || |ProofLib.Filter((o: ExecutionRecord) => (o.key == e.key), s.log)| == 1)
{
}

lemma UniqueIps(xs: seq<IpCount>)
  ensures (forall c :: c in xs ==> |ProofLib.Filter((o: IpCount) => (o.ip == c.ip), xs)| == 1) <==> ProofLib.DistinctBy(xs, (o: IpCount) => o.ip)
{
  forall i | 0 <= i < |xs|
    ensures |ProofLib.Filter((o: IpCount) => (o.ip == xs[i].ip), xs)| == 1 <==> forall j :: 0 <= j < |xs| && j != i ==> xs[j].ip != xs[i].ip
  {
    ProofLib.FilterCountOneIffUnique((o: IpCount) => (o.ip == xs[i].ip), xs, (o: IpCount) => o.ip, i);
  }
  if ProofLib.DistinctBy(xs, (o: IpCount) => o.ip) {
    forall c | c in xs ensures |ProofLib.Filter((o: IpCount) => (o.ip == c.ip), xs)| == 1 {
      var i :| 0 <= i < |xs| && xs[i] == c;
    }
  }
}

lemma BumpedWithinLimit(counts: seq<IpCount>, ip: int)
  requires forall c :: c in counts ==> c.count >= 1 && c.count <= requestsPerIpWindow && |ProofLib.Filter((o: IpCount) => (o.ip == c.ip), counts)| == 1
  requires countIn(counts, ip) < requestsPerIpWindow
  ensures forall c :: c in bumped(counts, ip) ==> c.count >= 1 && c.count <= requestsPerIpWindow && |ProofLib.Filter((o: IpCount) => (o.ip == c.ip), bumped(counts, ip))| == 1
{
  var b := bumped(counts, ip);
  UniqueIps(counts);
  if exists c :: c in counts && (c.ip == ip) {
    var c0 :| c0 in counts && c0.ip == ip;
    ProofLib.FilterMember((c: IpCount) => (c.ip == ip), counts, c0);
    ProofLib.FilterSubset((c: IpCount) => (c.ip == ip), counts);
    ProofLib.FilterMember((c: IpCount) => (c.ip == ip), counts, ProofLib.Filter((c: IpCount) => (c.ip == ip), counts)[0]);
    assert forall i :: 0 <= i < |counts| ==> b[i].ip == counts[i].ip;
    forall i | 0 <= i < |b| && b[i].ip == ip ensures b[i].count <= requestsPerIpWindow {
      assert counts[i].ip == ip;
      assert counts[i] == ProofLib.Filter((c: IpCount) => (c.ip == ip), counts)[0];
    }
  } else {
    assert b == counts + [IpCount(ip, 1)];
    ProofLib.DistinctByConcat(counts, [IpCount(ip, 1)], (o: IpCount) => o.ip);
  }
  UniqueIps(b);
}

lemma receive_ensures(s: RequestIntegrity, request: SignedRequest)
  ensures (inv(s) ==> canReceive(s, request) ==> alwaysExecutedWithinWindow(receive(s, request)))
  ensures (inv(s) ==> canReceive(s, request) ==> alwaysNonceExecutesOnce(receive(s, request)))
  ensures (inv(s) ==> canReceive(s, request) ==> alwaysKeyExecutesOnce(receive(s, request)))
  ensures (inv(s) ==> canReceive(s, request) ==> alwaysWithinIpLimit(receive(s, request)))
  ensures (inv(s) ==> canReceive(s, request) ==> stepOutageExecutesNothing(s, receive(s, request)))
{
  if inv(s) && canReceive(s, request) {
    var after := receive(s, request);
    IpLimitBridge(s);
    IpLimitBridge(after);
    if ipCount(s, request.clientIp) < requestsPerIpWindow {
      if (s.now - s.ipWindowStart) >= ipWindow {
        ProofLib.FilterNil((c: IpCount) => (c.ip == request.clientIp), []);
        BumpedWithinLimit([], request.clientIp);
      } else {
        BumpedWithinLimit(s.ipCounts, request.clientIp);
      }
    }
  }
}

lemma LogAppend(log: seq<ExecutionRecord>, used: seq<int>, used2: seq<int>, rec: ExecutionRecord)
  requires forall e :: e in log ==> |ProofLib.Filter((o: ExecutionRecord) => (o.nonce == e.nonce), log)| == 1 && e.nonce in used
  requires forall e :: e in log ==> e.key == 0 || |ProofLib.Filter((o: ExecutionRecord) => (o.key == e.key), log)| == 1
  requires !(rec.nonce in used) && rec.nonce in used2 && forall n :: n in used ==> n in used2
  requires rec.key == 0 || forall e :: e in log ==> e.key != rec.key
  ensures forall e :: e in log + [rec] ==> |ProofLib.Filter((o: ExecutionRecord) => (o.nonce == e.nonce), log + [rec])| == 1 && e.nonce in used2
  ensures forall e :: e in log + [rec] ==> e.key == 0 || |ProofLib.Filter((o: ExecutionRecord) => (o.key == e.key), log + [rec])| == 1
{
  forall e | e in log + [rec]
    ensures |ProofLib.Filter((o: ExecutionRecord) => (o.nonce == e.nonce), log + [rec])| == 1
    ensures e.key == 0 || |ProofLib.Filter((o: ExecutionRecord) => (o.key == e.key), log + [rec])| == 1
  {
    ProofLib.FilterAppend((o: ExecutionRecord) => (o.nonce == e.nonce), log, rec);
    ProofLib.FilterAppend((o: ExecutionRecord) => (o.key == e.key), log, rec);
    if e == rec {
      ProofLib.FilterNone((o: ExecutionRecord) => (o.nonce == e.nonce), log);
      ProofLib.FilterNone((o: ExecutionRecord) => (o.key == e.key), log);
    }
  }
}

lemma commitRequest_ensures(s: RequestIntegrity, nonce: int)
  ensures (inv(s) ==> canCommitRequest(s, nonce) ==> alwaysExecutedWithinWindow(commitRequest(s, nonce)))
  ensures (inv(s) ==> canCommitRequest(s, nonce) ==> alwaysNonceExecutesOnce(commitRequest(s, nonce)))
  ensures (inv(s) ==> canCommitRequest(s, nonce) ==> alwaysKeyExecutesOnce(commitRequest(s, nonce)))
  ensures (inv(s) ==> canCommitRequest(s, nonce) ==> alwaysWithinIpLimit(commitRequest(s, nonce)))
  ensures (inv(s) ==> canCommitRequest(s, nonce) ==> stepOutageExecutesNothing(s, commitRequest(s, nonce)))
{
  if inv(s) && canCommitRequest(s, nonce) {
    var after := commitRequest(s, nonce);
    OnceBridge(s);
    OnceBridge(after);
    ProofLib.FilterCons((set_x: int) => !((set_x in s.usedNonces)), [nonce]);
    ProofLib.FilterNil((set_x: int) => !((set_x in s.usedNonces)), [nonce][1..]);
    if |after.log| > |s.log| {
      var rec := after.log[|s.log|];
      assert after.log == s.log + [rec];
      LogAppend(s.log, s.usedNonces, after.usedNonces, rec);
    }
  }
}
