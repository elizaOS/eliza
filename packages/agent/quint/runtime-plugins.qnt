// Per-plugin registration lane and generation fencing over schema migration.
// Sources: runtime/plugin-lifecycle.ts, blocking-core-boot.ts, plugin-resolver.ts,
// load-plugin-from-{directory,vfs}.ts and view-scoped-actions.ts.
// One plugin abstracts independent lanes. Shared schema migration is serialized.
module runtime_plugins {
  var s: { phase: str, current: bool, roles: bool, schema: bool, published: bool, closed: bool }
  action init = s' = { phase: "absent", current: true, roles: false, schema: false, published: false, closed: false }
  action beginRegister = all { s.phase == "absent", not(s.closed), s' = s.with("phase", "migrating").with("current", true).with("roles", true) }
  action finishMigration = all { s.phase == "migrating", s.current, s' = s.with("phase", "registering").with("schema", true) }
  action publish = all { s.phase == "registering", s.current, not(s.closed), s' = s.with("phase", "ready").with("published", true) }
  action invalidate = all { s.phase != "absent", s' = s.with("current", false).with("published", false).with("phase", "unloading") }
  action rollback = all { Set("migrating", "registering", "unloading").contains(s.phase), s' = s.with("phase", "absent").with("published", false).with("schema", false).with("roles", false) }
  action close = s' = s.with("closed", true).with("published", false).with("current", false).with("phase", "unloading")
  action duplicate = all { s.phase != "absent", s' = s }
  action idle = s' = s
  action step = any { beginRegister, finishMigration, publish, invalidate, rollback, close, duplicate, idle }
  val safety = all { s.published implies all { s.phase == "ready", s.current, s.roles, s.schema, not(s.closed) }, s.closed implies not(s.published) }
  run invalidateDuringMigrationTest = init.then(beginRegister).then(invalidate).then(rollback).expect(safety and not(s.published))
  run gatedPublicationTest = init.then(beginRegister).then(finishMigration).then(publish).then(close).then(rollback).expect(safety and s.closed)
}
