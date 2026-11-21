module PasswordBackup {
  type Scope = { deployment: int, organization: int, account: int }
  type Slot = { revision: int, bytes: int }
  type Change = Save(int) | Remove
  type Access = Inference | Backup
  type Outcome = Rejected | Read(int) | Changed
  type State = { slots: Scope -> Slot, outcome: Outcome }

  val scopes = Set(
    { deployment: 1, organization: 1, account: 1 },
    { deployment: 1, organization: 1, account: 2 },
    { deployment: 1, organization: 2, account: 1 },
    { deployment: 2, organization: 1, account: 1 }
  )
  val vacant = { revision: 0, bytes: 0 }
  var state: State

  pure def authorized(credentialScope: Scope, target: Scope, access: Access): bool =
    credentialScope == target and access == Backup

  pure def write(s: State, target: Scope, credentialScope: Scope, access: Access, expected: int, change: Change): State = {
    val current = s.slots.get(target)
    val nextBytes = match change {
      | Save(bytes) => if (bytes >= 1 and bytes <= 2) bytes else -1
      | Remove => if (current.bytes > 0) 0 else -1
    }
    if (authorized(credentialScope, target, access) and expected == current.revision and nextBytes >= 0)
      { slots: s.slots.set(target, { revision: current.revision + 1, bytes: nextBytes }), outcome: Changed }
    else { ...s, outcome: Rejected }
  }

  pure def read(s: State, target: Scope, credentialScope: Scope, access: Access): State =
    if (authorized(credentialScope, target, access)) { ...s, outcome: Read(s.slots.get(target).bytes) }
    else { ...s, outcome: Rejected }

  action init = state' = { slots: scopes.mapBy(_ => vacant), outcome: Rejected }

  action step = {
    nondet target = scopes.oneOf()
    nondet credentialScope = scopes.oneOf()
    nondet access = Set(Inference, Backup).oneOf()
    nondet expected = Set(0, 1, 2, 3).oneOf()
    nondet change = Set(Save(0), Save(1), Save(2), Save(3), Remove).oneOf()
    any {
      state' = read(state, target, credentialScope, access),
      all {
        state.slots.get(target).revision < 4,
        state' = write(state, target, credentialScope, access, expected, change)
      }
    }
  }

  val bounded = scopes.forall(scope => {
    val slot = state.slots.get(scope)
    0 <= slot.revision and slot.revision <= 4 and 0 <= slot.bytes and slot.bytes <= 2
  })

  val readOwnerOnly = scopes.forall(target => scopes.forall(owner =>
    (target != owner implies read(state, target, owner, Backup).outcome == Rejected)
    and read(state, target, owner, Inference).outcome == Rejected
  ))

  val writesNeedGrantAndRevision = scopes.forall(target => scopes.forall(owner => {
    val revision = state.slots.get(target).revision
    val wrongRevision = revision + 1
    (target != owner implies write(state, target, owner, Backup, revision, Save(1)).slots == state.slots)
    and write(state, target, owner, Inference, revision, Save(1)).slots == state.slots
    and write(state, target, owner, Inference, revision, Remove).slots == state.slots
    and write(state, target, owner, Backup, wrongRevision, Save(1)).slots == state.slots
    and write(state, target, owner, Backup, wrongRevision, Remove).slots == state.slots
  }))

  val deletesKeepRevision = scopes.forall(target => {
    val before = state.slots.get(target)
    val removed = write(state, target, target, Backup, before.revision, Remove)
    before.bytes > 0 implies
      (removed.slots.get(target).bytes == 0
        and removed.slots.get(target).revision == before.revision + 1
        and write(removed, target, target, Backup, 0, Save(1)).slots == removed.slots)
  })

  val changesStayInScope = scopes.forall(target => {
    val updated = write(state, target, target, Backup, state.slots.get(target).revision, Save(1))
    scopes.forall(other => other != target implies updated.slots.get(other) == state.slots.get(other))
  })
}
