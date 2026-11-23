// The compact progress line of a Telegram turn
// (plugins/plugin-telegram/src/messageManager.ts,
// createTelegramCompactProgressCallback). The first compact progress update of
// a turn posts a status message; each later update edits that message through
// MessageManager.editMessage. When the edit fails, the callback posts a new
// status message. Telegram refuses an edit whose text already matches the
// message ("message is not modified"); the message already shows that text, so
// editMessage resolves and nothing is posted. Telegram refuses an edit of a
// deleted message ("message to edit not found"); editMessage rethrows that, and
// the callback posts a new status message.
// One case: four events in one chat. Each event is a progress update that shows
// text A or text B, or the user deleting the status message.
module TelegramEditUnchanged {
  pure val Events = 4
  pure val NoMessage = 0
  // Event kinds. A progress event is also the text that it shows.
  pure val TextA = 1
  pure val TextB = 2
  pure val Delete = 3
  // Bot API calls.
  pure val Send = "sendMessage"
  pure val Edit = "editMessageText"

  // The events so far, in order.
  var events: List[int]
  // Status messages of the bot that are still in the chat. A message is
  // numbered by its post order (1 is the first post).
  var visible: Set[int]
  // The text that each posted message shows.
  var shown: int -> int
  // The status message that the next update edits.
  var status: int
  // The Bot API calls of the bot, in order.
  var calls: List[str]
  var posts: int
  var edits: int
  // Edits that Telegram refused as "message is not modified".
  var unchanged: int
  var deletes: int

  action init = all {
    events' = List(),
    visible' = Set(),
    shown' = Map(),
    status' = NoMessage,
    calls' = List(),
    posts' = 0,
    edits' = 0,
    unchanged' = 0,
    deletes' = 0,
  }

  // The status message is still in the chat.
  val statusInChat = status != NoMessage and visible.contains(status)

  // A progress update: edit the status message, or post a new one when there
  // is none yet or the edit of a deleted one failed.
  action update(text: int): bool = all {
    events.length() < Events,
    events' = events.append(text),
    deletes' = deletes,
    if (statusInChat) all {
      // Applied, or refused as unchanged: either way the message shows the text.
      calls' = calls.append(Edit),
      visible' = visible,
      shown' = shown.set(status, text),
      status' = status,
      posts' = posts,
      edits' = edits + 1,
      unchanged' = if (shown.get(status) == text) unchanged + 1 else unchanged,
    } else all {
      calls' = calls.concat(if (status != NoMessage) [Edit, Send] else [Send]),
      visible' = visible.union(Set(posts + 1)),
      shown' = shown.put(posts + 1, text),
      status' = posts + 1,
      posts' = posts + 1,
      edits' = if (status != NoMessage) edits + 1 else edits,
      unchanged' = unchanged,
    },
  }
  // The user deletes the status message in the chat.
  action delete = all {
    events.length() < Events,
    statusInChat,
    events' = events.append(Delete),
    visible' = visible.exclude(Set(status)),
    shown' = shown,
    status' = status,
    calls' = calls,
    posts' = posts,
    edits' = edits,
    unchanged' = unchanged,
    deletes' = deletes + 1,
  }
  action advance = any { update(TextA), update(TextB), delete }
  // The next event has not run yet.
  action stutter = all {
    events' = events,
    visible' = visible,
    shown' = shown,
    status' = status,
    calls' = calls,
    posts' = posts,
    edits' = edits,
    unchanged' = unchanged,
    deletes' = deletes,
  }
  action step = any { advance, stutter }

  val ModelState = {
    events: events,
    visible: visible,
    shown: shown,
    status: status,
    calls: calls,
    posts: posts,
    edits: edits,
    unchanged: unchanged,
    deletes: deletes,
  }
  val Finished = events.length() == Events
  temporal ReplayEndsWithoutFairness = eventually(Finished)
  temporal ReplayEnds = advance.weakFair(ModelState)
    .implies(ReplayEndsWithoutFairness)

  // The text of the newest progress update.
  val latest = events.foldl(NoMessage, (text, event) =>
    if (event == Delete) text else event
  )
  // The chat never has more than one status message of the bot.
  val OneStatusMessage = visible.size() <= 1
  // A status message in the chat is the one that the next update edits, and
  // it shows the newest update.
  val ShowsLatest =
    visible.size() == 0 or (visible == Set(status) and shown.get(status) == latest)
  // A new status message is posted only for the first update and after the
  // user deleted the status message, never for an unchanged text.
  val PostsOnlyWithoutStatus = posts <= 1 + deletes
  // Every update after the first edits the status message once; an update
  // after a deletion edits and then posts.
  val updates = events.indices().filter(i => events[i] != Delete).size()
  val LaterUpdatesEdit = or {
    updates == 0 and edits == 0,
    edits + 1 == updates,
  }
  val TypeOK = and {
    events.length() <= Events,
    events.indices().forall(i => Set(TextA, TextB, Delete).contains(events[i])),
    visible.subseteq(1.to(Events)),
    shown.keys() == 1.to(posts),
    shown.keys().forall(id => Set(TextA, TextB).contains(shown.get(id))),
    status.in(0.to(Events)),
    posts.in(0.to(Events)),
    edits.in(0.to(Events)),
    unchanged.in(0.to(edits)),
    deletes.in(0.to(Events)),
    calls.indices().forall(i => Set(Send, Edit).contains(calls[i])),
  }
}
