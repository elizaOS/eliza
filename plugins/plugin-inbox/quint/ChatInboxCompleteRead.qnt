// fetchChatMessages (plugins/plugin-inbox/src/inbox/message-fetcher.ts) reads
// the agent's connector chat rooms through loadInboxCandidateMemories:
// newest-first pages of raw memories from runtime.getMemoriesByRoomIds. A
// user message with text is kept; the agent's own replies are skipped. With a
// limit L a page holds 3 * L rows, the scan stops once L messages are kept,
// and the newest L are returned. Without a limit the read is complete: pages
// of CompletePage rows continue until history ends, and every kept message is
// returned. GetLifeOpsInboxRequest.limit (packages/contracts/src/lifeops/
// inbox.ts): "When omitted, every matching message is returned." InboxView's
// GET /api/lifeops/inbox sends no limit; InboxDomain.getInbox then calls
// fetchAllMessages, which calls fetchChatMessages without one.
//
// One Discord DM room. Its history, newest first: `agents` agent replies,
// then `users` user messages.
// limit: NoLimit, or the limit the caller passes.
// offset: rows read so far. pages: getMemoriesByRoomIds calls so far.
// kept: user messages kept from the pages read so far.
// done: the scan has ended. returned: messages fetchChatMessages returned.
module ChatInboxCompleteRead {
  pure val NoLimit = -1
  pure val CompletePage = 600
  pure val AgentCounts = Set(0, 3)
  pure val UserCounts = Set(0, 1, 200, 201, 600)
  pure val Limits = Set(NoLimit, 1, 200)

  var agents: int
  var users: int
  var limit: int
  var offset: int
  var pages: int
  var kept: int
  var done: bool
  var returned: int

  pure def least(a: int, b: int): int = if (a < b) a else b
  pure def most(a: int, b: int): int = if (a > b) a else b

  // Raw rows per page.
  pure def pageSize(l: int): int = if (l == NoLimit) CompletePage else 3 * l
  // Rows, and user messages among them, at positions first..last-1 of the
  // history (agent replies take positions 0..a-1).
  pure def rowsIn(a: int, u: int, first: int, last: int): int =
    most(0, least(last, a + u) - first)
  pure def usersIn(a: int, u: int, first: int, last: int): int =
    most(0, least(last, a + u) - most(first, a))
  // The kept messages fetchChatMessages returns once the scan ends.
  pure def result(l: int, k: int): int = if (l == NoLimit) k else least(k, l)

  action init = {
    nondet a = AgentCounts.oneOf()
    nondet u = UserCounts.oneOf()
    nondet l = Limits.oneOf()
    all {
      agents' = a,
      users' = u,
      limit' = l,
      offset' = 0,
      pages' = 0,
      kept' = 0,
      done' = false,
      returned' = 0,
    }
  }

  // One getMemoriesByRoomIds page at the current offset. A short or empty
  // page ends the scan; with a limit, so does having that many messages.
  action readPage = {
    val window = pageSize(limit)
    val rows = rowsIn(agents, users, offset, offset + window)
    val nextKept = kept + usersIn(agents, users, offset, offset + window)
    val ends = or {
      rows < window,
      and { limit != NoLimit, nextKept >= limit },
    }
    all {
      not(done),
      agents' = agents,
      users' = users,
      limit' = limit,
      offset' = offset + rows,
      pages' = pages + 1,
      kept' = nextKept,
      done' = ends,
      returned' = if (ends) result(limit, nextKept) else 0,
    }
  }

  // The inbox read may not have started yet.
  action stutter = all {
    agents' = agents,
    users' = users,
    limit' = limit,
    offset' = offset,
    pages' = pages,
    kept' = kept,
    done' = done,
    returned' = returned,
  }
  action step = any { readPage, stutter }

  val ModelState = {
    agents: agents,
    users: users,
    limit: limit,
    offset: offset,
    pages: pages,
    kept: kept,
    done: done,
    returned: returned,
  }
  temporal ReadFinishesWithoutFairness = eventually(done)
  temporal ReadFinishes = readPage.weakFair(ModelState)
    .implies(ReadFinishesWithoutFairness)

  // Without a limit every user message is returned, however long the
  // history is.
  val Complete = or { not(done), limit != NoLimit, returned == users }
  // With a limit the newest messages up to that limit are returned.
  val CappedByLimit = or {
    not(done),
    limit == NoLimit,
    returned == least(users, limit),
  }
  // Nothing is returned before the scan ends.
  val NothingBeforeDone = done or returned == 0
  // Agent replies are never kept.
  val OnlyUserMessages = kept <= users
  // The scan reads each row at most once and ends one page after history.
  val PagesBounded = pages <= (agents + users) / pageSize(limit) + 1
  val TypeOK = and {
    AgentCounts.contains(agents),
    UserCounts.contains(users),
    Limits.contains(limit),
    offset >= 0,
    offset <= agents + users,
    pages >= 0,
    kept >= 0,
  }
}
