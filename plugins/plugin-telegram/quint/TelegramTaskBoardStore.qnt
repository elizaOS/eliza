// `/tasks` renders the pinned task board (plugins/plugin-telegram/src/task-board.ts,
// #8902). TelegramTaskBoard.render loads the board message id from the board
// store and edits that message. When the store has no id it posts a new board,
// saves its id and pins it. When the edit fails because the message was
// deleted, the store forgets the id and a new board is posted and pinned.
// registerTelegramTaskBoardCommand always uses createRuntimeMemoryBoardStore,
// a memory row in the agent database, so the id stays after an agent restart
// (#8902 AC3) and a later `/tasks` edits the same pinned board.
// One case: four events in one chat. Each event is a `/tasks` after a task
// status change, an agent restart (a new runtime on the same database), or the
// user deleting the board message in the chat.
module TelegramTaskBoardStore {
  pure val Events = 4
  pure val NoBoard = 0
  // Event kinds.
  pure val Tasks = 1
  pure val Restart = 2
  pure val Delete = 3
  // Bot API calls.
  pure val Send = "sendMessage"
  pure val Pin = "pinChatMessage"
  pure val Edit = "editMessageText"

  // The events so far, in order.
  var events: List[int]
  // Board messages of the bot that are still in the chat. A board is numbered
  // by its post order (1 is the first post).
  var visible: Set[int]
  // The board id that the store holds.
  var stored: int
  // The pinned message.
  var pinned: int
  // The Bot API calls of the bot, in order.
  var calls: List[str]
  var posts: int
  var edits: int
  var deletes: int

  action init = all {
    events' = List(),
    visible' = Set(),
    stored' = NoBoard,
    pinned' = NoBoard,
    calls' = List(),
    posts' = 0,
    edits' = 0,
    deletes' = 0,
  }

  // The stored board is still in the chat.
  val boardInChat = stored != NoBoard and visible.contains(stored)

  // `/tasks`: edit the stored board, or post, save and pin a new one. An edit
  // of a deleted board fails first.
  action tasks = all {
    events.length() < Events,
    events' = events.append(Tasks),
    deletes' = deletes,
    if (boardInChat) all {
      calls' = calls.append(Edit),
      visible' = visible,
      stored' = stored,
      pinned' = pinned,
      posts' = posts,
      edits' = edits + 1,
    } else all {
      calls' = calls.concat(
        if (stored != NoBoard) [Edit, Send, Pin] else [Send, Pin]
      ),
      visible' = visible.union(Set(posts + 1)),
      stored' = posts + 1,
      pinned' = posts + 1,
      posts' = posts + 1,
      edits' = edits,
    },
  }
  // The agent restarts: the board and the store do not change.
  action restart = all {
    events.length() < Events,
    events' = events.append(Restart),
    visible' = visible,
    stored' = stored,
    pinned' = pinned,
    calls' = calls,
    posts' = posts,
    edits' = edits,
    deletes' = deletes,
  }
  // The user deletes the board message in the chat.
  action delete = all {
    events.length() < Events,
    boardInChat,
    events' = events.append(Delete),
    visible' = visible.exclude(Set(stored)),
    stored' = stored,
    pinned' = NoBoard,
    calls' = calls,
    posts' = posts,
    edits' = edits,
    deletes' = deletes + 1,
  }
  action advance = any { tasks, restart, delete }
  // The next event has not run yet.
  action stutter = all {
    events' = events,
    visible' = visible,
    stored' = stored,
    pinned' = pinned,
    calls' = calls,
    posts' = posts,
    edits' = edits,
    deletes' = deletes,
  }
  action step = any { advance, stutter }

  val ModelState = {
    events: events,
    visible: visible,
    stored: stored,
    pinned: pinned,
    calls: calls,
    posts: posts,
    edits: edits,
    deletes: deletes,
  }
  val Finished = events.length() == Events
  temporal ReplayEndsWithoutFairness = eventually(Finished)
  temporal ReplayEnds = advance.weakFair(ModelState)
    .implies(ReplayEndsWithoutFairness)

  // The chat never has more than one board of the bot.
  val OneBoardInChat = visible.size() <= 1
  // A board in the chat is the board that the store holds, so the next
  // `/tasks` edits it, also after a restart.
  val ChatBoardIsStored = visible.size() == 0 or visible == Set(stored)
  // A board in the chat is pinned.
  val ChatBoardIsPinned =
    (visible.size() == 0 and pinned == NoBoard) or visible == Set(pinned)
  // A new board is posted only for the first `/tasks` and after the user
  // deleted the board.
  val PostsOnlyWithoutBoard = posts <= 1 + deletes
  // Each `/tasks` edits the board or posts one.
  val TasksEditOrPost =
    edits + posts == events.indices().filter(i => events[i] == Tasks).size()
  val TypeOK = and {
    events.length() <= Events,
    events.indices().forall(i => Set(Tasks, Restart, Delete).contains(events[i])),
    visible.subseteq(1.to(Events)),
    stored.in(0.to(Events)),
    pinned.in(0.to(Events)),
    posts.in(0.to(Events)),
    edits.in(0.to(Events)),
    deletes.in(0.to(Events)),
    calls.indices().forall(i => Set(Send, Pin, Edit).contains(calls[i])),
  }
}
