// isTrustedLocalRequest (packages/core/src/security/loopback-trust.ts) grants
// same-machine trust to a loopback peer only when no proxy client-IP header
// names a non-loopback or unparseable client (proxyClientHeaderBlocksLocalTrust).
// The agent API (isAuthorized) and the app compat auth accept such a request
// without a token. A reverse proxy on the same machine (nginx
// `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` with the
// default loopback upstream Host) forwards the X-Forwarded-For the client sent
// and appends the address it saw as a plain element.
// sent: the X-Forwarded-For elements the client sends, by kind.
// pending: the client changed its header since the last proxied request.
// origin: where the last proxied request came from ("none" before the first).
// verdict: 0 no request yet, 1 trusted as same-machine, 2 refused.
// last: the latest action, 0 none, 1 compose, 2 send.
module ProxyClientElements {
  pure val KINDS = Set(
    "plainLoopback", "forLoopback", "forQuotedLoopback6", "unknown",
    "forRemote", "lookalike",
  )
  // Elements that name a loopback client or carry no address at all.
  pure val LOCAL_KINDS = Set(
    "plainLoopback", "forLoopback", "forQuotedLoopback6", "unknown",
  )
  pure val ORIGINS = Set("local4", "local6", "remote4", "remote6")
  pure val LOCAL_ORIGINS = Set("local4", "local6")
  pure val MAX_SENT = 2

  var sent: Set[str]
  var pending: bool
  var origin: str
  var verdict: int
  var last: int

  // Same-machine trust holds only when every element, including the one the
  // proxy appended, is loopback or carries no address.
  pure def trusted(elements: Set[str], from: str): bool =
    elements.subseteq(LOCAL_KINDS) and LOCAL_ORIGINS.contains(from)

  action init = all {
    sent' = Set(), pending' = false, origin' = "none", verdict' = 0, last' = 0,
  }
  // The client adds one element to the X-Forwarded-For value it sends.
  action compose = {
    nondet kind = KINDS.oneOf()
    all {
      sent.size() < MAX_SENT,
      not(sent.contains(kind)),
      sent' = sent.union(Set(kind)), pending' = true,
      origin' = origin, verdict' = verdict, last' = 1,
    }
  }
  // The client's request goes through the proxy, which appends the address it
  // saw, and reaches the loopback listener.
  action send = {
    nondet from = ORIGINS.oneOf()
    all {
      sent' = sent, pending' = false, origin' = from,
      verdict' = if (trusted(sent, from)) 1 else 2, last' = 2,
    }
  }
  // Nothing happens: the client composes nothing and sends nothing.
  action stutter = all {
    sent' = sent, pending' = pending, origin' = origin, verdict' = verdict,
    last' = last,
  }
  action step = any { compose, send, stutter }

  val ModelState = {
    sent: sent, pending: pending, origin: origin, verdict: verdict, last: last,
  }
  // After the client changes its header, a later request is judged.
  temporal HeaderReachesVerdictWithoutFairness =
    pending.leadsTo(not(pending) and verdict != 0)
  temporal HeaderReachesVerdict = send.weakFair(ModelState)
    .implies(HeaderReachesVerdictWithoutFairness)

  // A request the proxy saw from another machine is never trusted, whatever
  // the client put in front of the appended address.
  val RemoteClientNeverTrusted =
    not(Set("remote4", "remote6").contains(origin) and verdict == 1)
  // An element that does not parse as a for= pair or an address refuses trust.
  val UnparseableElementRefuses =
    pending or not(sent.contains("lookalike") and verdict == 1)
  // A same-machine client whose elements are all loopback keeps its trust.
  val LoopbackChainKeepsTrust =
    last != 2 or not(trusted(sent, origin)) or verdict == 1
  val VerdictFollowsElements =
    last != 2 or verdict == (if (trusted(sent, origin)) 1 else 2)
  val TypeOK =
    sent.subseteq(KINDS) and sent.size() <= MAX_SENT and
    ORIGINS.union(Set("none")).contains(origin) and
    Set(0, 1, 2).contains(verdict) and Set(0, 1, 2).contains(last) and
    (verdict == 0 iff origin == "none") and
    (last == 2 implies not(pending))
}
