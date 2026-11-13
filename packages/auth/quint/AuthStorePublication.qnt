// TokenStore.publish / StoreBackend.publish, consume and compareDelete.
// One challenge per namespace, two competing publishers and one token each.
// Backend operations are atomic. Physical cleanup of expired rows is abstracted
// by read(), since every backend treats those rows as absent at admission.
module AuthStorePublication {
  val namespaces = Set(1, 2)
  val owners = Set(1, 2)
  val deadline = 2
  type State = {
    now: int,
    claim: int -> int,
    tokens: int -> Set[int],
    issued: int -> Set[int],
    consumed: int -> Set[int],
    previousClaim: int -> int,
    previousTokens: int -> Set[int],
    operation: str,
    namespace: int,
    owner: int,
    accepted: bool,
  }
  var s: State

  action init = s' = {
    now: 0,
    // 0 is the available challenge; -1 is absent; positive values are owners.
    claim: namespaces.mapBy(_ => 0),
    tokens: namespaces.mapBy(_ => Set()),
    issued: namespaces.mapBy(_ => Set()),
    consumed: namespaces.mapBy(_ => Set()),
    previousClaim: namespaces.mapBy(_ => 0),
    previousTokens: namespaces.mapBy(_ => Set()),
    operation: "init", namespace: 1, owner: 1, accepted: false,
  }

  def readClaim(n: int): int = if (s.now < deadline) s.claim.get(n) else -1
  def hasToken(n: int, owner: int): bool =
    s.now < deadline and s.tokens.get(n).contains(owner)

  // A desired guard is an acknowledged replay. It must not reapply unguarded
  // sibling writes, including a token consumed after the original commit.
  action publish(n: int, owner: int): bool = {
    val current = readClaim(n)
    val admitted = s.now < deadline and (current == 0 or current == owner)
    val commit = admitted and current == 0
    s' = {
      ...s,
      claim: if (commit) s.claim.set(n, owner) else s.claim,
      tokens: if (commit) s.tokens.set(n, s.tokens.get(n).union(Set(owner))) else s.tokens,
      issued: if (commit) s.issued.set(n, s.issued.get(n).union(Set(owner))) else s.issued,
      previousClaim: s.claim, previousTokens: s.tokens,
      operation: "publish", namespace: n, owner: owner, accepted: admitted,
    }
  }

  action consume(n: int, owner: int): bool = {
    val admitted = hasToken(n, owner)
    s' = {
      ...s,
      tokens: s.tokens.set(n, s.tokens.get(n).exclude(Set(owner))),
      consumed: if (admitted) s.consumed.set(n, s.consumed.get(n).union(Set(owner))) else s.consumed,
      previousClaim: s.claim, previousTokens: s.tokens,
      operation: "consume", namespace: n, owner: owner, accepted: admitted,
    }
  }

  action revokeClaim(n: int, owner: int): bool = {
    val admitted = readClaim(n) == owner
    s' = {
      ...s,
      claim: if (admitted) s.claim.set(n, -1) else s.claim,
      previousClaim: s.claim, previousTokens: s.tokens,
      operation: "revoke", namespace: n, owner: owner, accepted: admitted,
    }
  }

  action tick = all {
    s.now < 3,
    s' = {
      ...s, now: s.now + 1,
      previousClaim: s.claim, previousTokens: s.tokens,
      operation: "tick", accepted: false,
    },
  }

  action step = {
    nondet n = namespaces.oneOf()
    nondet owner = owners.oneOf()
    any { publish(n, owner), consume(n, owner), revokeClaim(n, owner), tick }
  }

  val TypeOK = and {
    s.now.in(0.to(3)),
    s.claim.keys() == namespaces,
    namespaces.forall(n => s.claim.get(n).in(Set(-1, 0, 1, 2))),
    namespaces.forall(n => s.tokens.get(n).subseteq(owners)),
    namespaces.forall(n => s.issued.get(n).subseteq(owners)),
    namespaces.forall(n => s.consumed.get(n).subseteq(owners)),
  }
  val OnePublisher = namespaces.forall(n => s.issued.get(n).size() <= 1)
  val PublishedBeforeConsumed = namespaces.forall(n =>
    s.consumed.get(n).subseteq(s.issued.get(n)) and s.tokens.get(n).subseteq(s.issued.get(n)))
  val ConsumedTokenStaysAbsent = namespaces.forall(n =>
    s.tokens.get(n).intersect(s.consumed.get(n)).size() == 0)
  val ExpiredOperationRefused =
    (s.operation == "publish" or s.operation == "consume" or s.operation == "revoke")
      .implies(s.accepted.implies(s.now < deadline))
  val NamespaceIsolation = namespaces.forall(n =>
    (s.operation != "init" and s.operation != "tick" and n != s.namespace).implies(
      s.claim.get(n) == s.previousClaim.get(n) and s.tokens.get(n) == s.previousTokens.get(n)))
  val invariant = TypeOK and OnePublisher and PublishedBeforeConsumed and
    ConsumedTokenStaysAbsent and ExpiredOperationRefused and NamespaceIsolation

  run competingPublisherRefusedTest = init
    .then(publish(1, 1)).then(publish(1, 2))
    .expect(not(s.accepted) and s.tokens.get(1) == Set(1))
  run retryCannotRecreateConsumedTokenTest = init
    .then(publish(1, 1)).then(consume(1, 1)).then(publish(1, 1))
    .expect(s.accepted and not(hasToken(1, 1)))
  run expiredRetryRefusedTest = init
    .then(publish(1, 1)).then(tick).then(tick).then(publish(1, 1))
    .expect(not(s.accepted))
  run revokedClaimCannotPublishTest = init
    .then(publish(1, 1)).then(revokeClaim(1, 1)).then(publish(1, 1))
    .expect(not(s.accepted))
  run namespacesRemainIndependentTest = init
    .then(publish(1, 1)).then(publish(2, 2)).then(consume(1, 1))
    .expect(hasToken(2, 2) and not(hasToken(1, 1)))
}
