// proactive-interaction-gate.ts: two surfaces, one abstract debounce/cooldown
// interval and two emissions/day. wouldAdmit is read-only; tryAdmit commits.
module services_proactive {
  var s: { enabled: bool, surface: int, settled: bool, cooldown: bool, count: int, lastText: int, lastSurface: int }
  action init = s' = { enabled: false, surface: 0, settled: true, cooldown: false, count: 0, lastText: 0, lastSurface: 0 }
  action enable(active: bool): bool = s' = s.with("enabled", active)
  action switch(surface: int): bool = all { surface.in(Set(1,2)), s' = s.with("surface", surface).with("settled", false) }
  action settle = s' = s.with("settled", true)
  action age = s' = s.with("cooldown", false).with("lastText", 0)
  action nextDay = s' = s.with("count", 0)
  action emit(surface: int, text: int): bool = all { s.enabled, s.settled, not(s.cooldown), s.count < 2, surface == s.surface, text.in(Set(1,2)), not(s.lastText == text and s.lastSurface == surface), s' = s.with("count", s.count + 1).with("cooldown", true).with("lastText", text).with("lastSurface", surface) }
  action keep = s' = s
  action step = any { enable(true), enable(false), switch(1), switch(2), settle, age, nextDay, emit(1,1), emit(1,2), emit(2,1), emit(2,2), keep }
  val safety = all { s.count >= 0, s.count <= 2, s.surface.in(Set(0,1,2)), s.lastSurface.in(Set(0,1,2)) }
  run latestSurfaceSettlesTest = init.then(enable(true)).then(switch(1)).then(switch(2)).then(settle).then(emit(2,1)).expect(s.count == 1 and s.lastSurface == 2)
  run dailyCapTest = init.then(enable(true)).then(switch(1)).then(settle).then(emit(1,1)).then(age).then(emit(1,2)).expect(s.count == 2)
}
