module OAuthStatusHeartbeat {
  var goal: int
  var ticks: int
  var closed: bool
  var dataFrames: int
  action init = {
    nondet chosen = Set(1, 2).oneOf()
    all { goal' = chosen, ticks' = 0, closed' = false, dataFrames' = 1 }
  }
  action heartbeat = all {
    not(closed), ticks < goal, goal' = goal, ticks' = ticks + 1,
    closed' = false, dataFrames' = dataFrames
  }
  action cancel = all {
    not(closed), ticks == goal, goal' = goal, ticks' = ticks,
    closed' = true, dataFrames' = dataFrames + 1
  }
  action idle = all {
    closed, goal' = goal, ticks' = ticks, closed' = closed, dataFrames' = dataFrames
  }
  action step = any { heartbeat, cancel, idle }
  val CommentDoesNotChangeState = dataFrames == (if (closed) 2 else 1)
  val TicksStayBounded = ticks <= goal
  val TerminalCloses = not(closed) or ticks == goal
  temporal Finishes = and {
    heartbeat.weakFair((goal, ticks, closed, dataFrames)),
    cancel.weakFair((goal, ticks, closed, dataFrames))
  }.implies(eventually(closed))
}
