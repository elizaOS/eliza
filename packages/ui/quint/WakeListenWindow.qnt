// Exact wakeWindowReducer with compressed millisecond constants 3 and 8.
// Input clocks may move backward. Closure requires a future tick at the cap.
module WakeListenWindow {
  pure val idleTimeout = 3
  pure val maxWindow = 8
  var s: {
    phase: str,
    opened: int,
    awaiting: int,
    event: str,
    previous: str,
    now: int,
    age: int
  }
  pure def closed(event, previous, now, age) = {
    phase: "idle",
    opened: 0,
    awaiting: 0,
    event: event,
    previous: previous,
    now: now,
    age: age
  }
  action init = s' = closed("init", "idle", 0, 0)
  action handle(event: str, now: int): bool = {
    val age = now - s.opened
    val base = s
      .with("event", event)
      .with("previous", s.phase)
      .with("now", now)
      .with("age", age)
    s' = if (event == "wake") base
      .with("phase", "open")
      .with("opened", now)
      .with("awaiting", 0)
    else if (event == "reset" or (event == "agent-responded" and s.phase != "idle")) closed(event, s.phase, now, age)
    else if (event == "speech" and s.phase != "idle") base
      .with("phase", "awaiting-response")
      .with("awaiting", now)
    else if (event == "tick" and s.phase != "idle" and (age >= maxWindow or (s.phase == "open" and age >= idleTimeout))) closed(event, s.phase, now, age)
    else base
  }
  action step = {
    nondet event = Set("wake", "reset", "agent-responded", "speech", "tick").oneOf();
    nondet now = 0.to(12).oneOf();
    handle(event, now)
  }
  val invariant = and {
    Set("idle", "open", "awaiting-response").contains(s.phase),
    (s.phase == "idle") implies (s.opened == 0 and s.awaiting == 0),
    (s.event == "wake") implies (s.phase == "open" and s.opened == s.now and s.awaiting == 0),
    (s.event == "speech" and s.previous == "idle") implies s.phase == "idle",
    (s.event == "tick" and s.previous != "idle" and s.age >= maxWindow) implies s.phase == "idle",
    (s.event == "tick" and s.previous == "open" and s.age >= idleTimeout) implies s.phase == "idle"
  }
}
