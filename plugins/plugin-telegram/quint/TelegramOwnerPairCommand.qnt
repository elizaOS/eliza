// `/eliza_pair <code>` relays an owner pairing code from Telegram to the
// OWNER_BIND_VERIFY service (plugins/plugin-telegram/src/owner-pairing-service.ts;
// the service is packages/agent/src/services/owner-binding.ts). TelegramService
// registers the command with its other commands, before the catch-all message
// handler, behind the same chat authorization gate as `/tasks`
// (src/service.ts registerBotCommands). Each relayed code gets one reply. When
// OWNER_BIND_VERIFY is not registered, the command message goes on to the
// message handler like any other message.
// One case: one agent, with or without OWNER_BIND_VERIFY, and four messages.
// Each message is `/eliza_pair <code>` from a chat the gate allows,
// `/eliza_pair <code>` from a chat the gate denies, or plain text from the
// allowed chat.
module TelegramOwnerPairCommand {
  pure val Events = 4
  // Message kinds.
  pure val PairAllowed = 1
  pure val PairDenied = 2
  pure val Text = 3

  // OWNER_BIND_VERIFY is registered.
  var verifier: bool
  // The messages so far, in order.
  var events: List[int]
  // Codes relayed to OWNER_BIND_VERIFY.
  var relayed: int
  // Messages that reach the message handler (an agent turn).
  var handled: int
  // Replies of the pairing command.
  var replies: int

  action init = {
    nondet registered = Set(true, false).oneOf()
    all {
      verifier' = registered,
      events' = List(),
      relayed' = 0,
      handled' = 0,
      replies' = 0,
    }
  }

  // `/eliza_pair <code>` from an allowed chat: relayed and answered when
  // OWNER_BIND_VERIFY is registered, else an ordinary message.
  action pairAllowed = all {
    events.length() < Events,
    events' = events.append(PairAllowed),
    verifier' = verifier,
    if (verifier) all {
      relayed' = relayed + 1,
      replies' = replies + 1,
      handled' = handled,
    } else all {
      relayed' = relayed,
      replies' = replies,
      handled' = handled + 1,
    },
  }
  // `/eliza_pair <code>` from a chat the gate denies: nothing runs.
  action pairDenied = all {
    events.length() < Events,
    events' = events.append(PairDenied),
    verifier' = verifier,
    relayed' = relayed,
    replies' = replies,
    handled' = handled,
  }
  // Plain text from the allowed chat reaches the message handler.
  action text = all {
    events.length() < Events,
    events' = events.append(Text),
    verifier' = verifier,
    relayed' = relayed,
    replies' = replies,
    handled' = handled + 1,
  }
  action advance = any { pairAllowed, pairDenied, text }
  // The next message has not arrived yet.
  action stutter = all {
    verifier' = verifier,
    events' = events,
    relayed' = relayed,
    replies' = replies,
    handled' = handled,
  }
  action step = any { advance, stutter }

  val ModelState = {
    verifier: verifier,
    events: events,
    relayed: relayed,
    handled: handled,
    replies: replies,
  }
  val Finished = events.length() == Events
  temporal ReplayEndsWithoutFairness = eventually(Finished)
  temporal ReplayEnds = advance.weakFair(ModelState)
    .implies(ReplayEndsWithoutFairness)

  def count(kind: int): int = events.indices().filter(i => events[i] == kind).size()
  pure val NoPairs = 0
  // Every allowed `/eliza_pair <code>` reaches OWNER_BIND_VERIFY when it is
  // registered, and none does without it.
  val AllowedPairsRelayed = relayed == (if (verifier) count(PairAllowed) else NoPairs)
  // With OWNER_BIND_VERIFY registered a pairing command never becomes an
  // agent turn; without it the command is an ordinary message.
  val PairNotAgentTurn = handled == count(Text) + (if (verifier) NoPairs else count(PairAllowed))
  // A message from a denied chat reaches neither the relay nor the handler.
  val DeniedReachesNothing = relayed + handled == count(PairAllowed) + count(Text)
  // Each relayed code gets one reply.
  val RelayReplies = replies == relayed
  val TypeOK = and {
    events.length() <= Events,
    events.indices().forall(i => Set(PairAllowed, PairDenied, Text).contains(events[i])),
    relayed.in(0.to(Events)),
    handled.in(0.to(Events)),
    replies.in(0.to(Events)),
  }
}
