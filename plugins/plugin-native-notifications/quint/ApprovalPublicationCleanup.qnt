// One authorized approval call after route preparation. A publication failure
// can leave storage unchanged, committed, uncertain, malformed or foreign.
module ApprovalPublicationCleanup {
  val receipts = Set("absent", "failed-exact", "withdrawn-exact", "withdrawal-intent",
    "live", "uncertain", "corrupt", "foreign", "wrong-expiry")
  val terminal = Set("absent", "failed-exact", "withdrawn-exact", "withdrawal-intent")
  val invalid = Set("corrupt", "foreign", "wrong-expiry")
  type State = {
    phase: str, receipt: str, route: bool, primary: str, suppressed: bool,
    cleanupAuthority: bool, posts: int, postsAtFailure: int,
  }
  var s: State
  action init = s' = {
    phase: "prepared", receipt: "absent", route: true, primary: "none",
    suppressed: false, cleanupAuthority: false, posts: 0, postsAtFailure: 0,
  }
  action publicationFails(receipt: str, posted: bool): bool = all {
    s.phase == "prepared",
    s' = { ...s, phase: "failed", receipt: receipt, primary: "publication",
      posts: if (posted) 1 else 0, postsAtFailure: if (posted) 1 else 0 },
  }
  action cleanup(readable: bool, canForget: bool): bool = {
    val valid = readable and not(invalid.contains(s.receipt))
    val definite = valid and terminal.contains(s.receipt)
    all {
      s.phase == "failed",
      s' = { ...s, phase: "returned",
        route: not(definite and canForget), cleanupAuthority: definite,
        suppressed: not(valid) or (definite and not(canForget)),
      },
    }
  }
  action step = any {
    { nondet receipt = receipts.oneOf()
      nondet posted = Set(false, true).oneOf()
      publicationFails(receipt, posted) },
    { nondet readable = Set(false, true).oneOf()
      nondet canForget = Set(false, true).oneOf()
      cleanup(readable, canForget) },
    s' = s,
  }
  val TypeOK = and {
    s.phase.in(Set("prepared", "failed", "returned")), s.receipt.in(receipts),
    s.primary.in(Set("none", "publication")), s.posts.in(0.to(1)),
    s.postsAtFailure.in(0.to(1)),
  }
  val CleanupRequiresProof = not(s.route).implies(
    s.phase == "returned" and s.cleanupAuthority and terminal.contains(s.receipt))
  val UncertainRoutesRemain = invalid.union(Set("live", "uncertain")).contains(s.receipt)
    .implies(s.route)
  val PublicationErrorSurvives = (s.phase != "prepared").implies(s.primary == "publication")
  val CleanupNeverPosts = s.posts == s.postsAtFailure
  val FailedCleanupRetainsRoute = s.suppressed.implies(s.route)
  val invariant = TypeOK and CleanupRequiresProof and UncertainRoutesRemain and
    PublicationErrorSurvives and CleanupNeverPosts and FailedCleanupRetainsRoute
}
