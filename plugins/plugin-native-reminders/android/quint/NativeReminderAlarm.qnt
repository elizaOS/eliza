// One alarm arm under the store lock; capability may disappear between check and OS call.
module NativeReminderAlarm {
  var s: { capability: bool, checked: bool, phase: str, alarm: str, permissionRequests: int,
    icon: int, resolvedIcon: int, installedIdentity: int }
  action initialized(capability: bool, icon: int): bool = {
    s' = { capability: capability, checked: false, phase: "idle", alarm: "none", permissionRequests: 0,
      icon: icon, resolvedIcon: if (icon == 0) 2 else icon, installedIdentity: 1 } }
  action init = { nondet capability = Set(false, true).oneOf() nondet icon = Set(0, 1).oneOf()
    initialized(capability, icon) }
  action check = all { s.phase == "idle", s' = { ...s, checked: s.capability, phase: "arming" } }
  action withdraw = s' = { ...s, capability: false }
  action arm = all { s.phase == "arming", s' = { ...s, phase: "done",
    alarm: if (s.checked and s.capability) "exact" else "inexact" } }
  action cancel = all { s.phase == "done", s' = { ...s, alarm: "none" } }
  action step = any { check, withdraw, arm, cancel, s' = s }
  val NeverRequestsCapability = s.permissionRequests == 0
  val FixedInstalledIdentity = s.installedIdentity == 1
  val HostIconOrFallback = s.resolvedIcon == (if (s.icon == 0) 2 else s.icon)
  val ArmedHasAcknowledgement = s.alarm != "none" implies s.phase == "done"
  run heldCapabilitySelectsExactTest = initialized(true, 0).then(check).then(arm).expect(s.alarm == "exact")
  run absentCapabilityStaysInexactTest = initialized(false, 1).then(check).then(arm).expect(s.alarm == "inexact")
  run withdrawnCapabilityFallsBackTest = initialized(true, 1).then(check).then(withdraw).then(arm).expect(s.alarm == "inexact")
}
