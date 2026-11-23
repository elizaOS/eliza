module PasswordVaultAccess {
  type Delivery = NoDelivery | Delivered | Refused
  type State = {
    foreground: bool, admitted: bool, userUnlocked: bool, deviceUnlocked: bool,
    screenSecure: bool,
    legacySelected: bool, generation: int, grant: bool,
    pending: int, delivery: Delivery, deliveredTicket: int
  }

  var vault: State

  pure val empty: State = {
    foreground: false, admitted: true, userUnlocked: true, deviceUnlocked: true,
    screenSecure: false, legacySelected: false, generation: 0, grant: false,
    pending: 0, delivery: NoDelivery, deliveredTicket: 0
  }
  pure val maxGeneration = 2
  pure def ownerForeground(s: State): bool =
    s.foreground and s.admitted and s.userUnlocked and s.deviceUnlocked
  pure def usable(s: State): bool =
    ownerForeground(s) and not(s.legacySelected) and s.grant

  action fresh = vault' = empty
  action legacy = vault' = { ...empty, screenSecure: true, legacySelected: true }
  action legacyWithoutScreenLock = vault' = { ...empty, legacySelected: true }
  action init = any { fresh, legacy, legacyWithoutScreenLock }

  action resume = all {
    not(vault.foreground),
    vault' = { ...vault, foreground: true, delivery: NoDelivery }
  }
  action leave = all {
    vault.foreground,
    vault' = { ...vault, foreground: false, grant: false, delivery: NoDelivery }
  }
  action retireOwner = all {
    vault.admitted,
    vault' = { ...vault, admitted: false, grant: false, delivery: NoDelivery }
  }
  action admitOwner = all {
    not(vault.admitted),
    vault' = { ...vault, admitted: true, delivery: NoDelivery }
  }
  action androidUnlock(user: bool, device: bool): bool =
    vault' = { ...vault, userUnlocked: user, deviceUnlocked: device, delivery: NoDelivery }

  action authorize = all {
    ownerForeground(vault), not(vault.legacySelected), not(vault.grant),
    vault.generation < maxGeneration,
    vault' = { ...vault, generation: vault.generation + 1, grant: true, delivery: NoDelivery }
  }
  action finishLegacy(originalKeyRead: bool, verifiedCopy: bool, selected: bool): bool = all {
    ownerForeground(vault), vault.legacySelected, vault.screenSecure,
    vault.generation < maxGeneration,
    val migrated = originalKeyRead and verifiedCopy and selected
    vault' = { ...vault, generation: vault.generation + 1,
      legacySelected: not(migrated), grant: migrated, delivery: NoDelivery }
  }
  action confirmPrompt = all {
    usable(vault), vault.pending == 0,
    vault' = { ...vault, pending: vault.generation, delivery: NoDelivery }
  }
  action settle(confirmed: bool): bool = all {
    vault.pending != 0,
    val deliver = confirmed and usable(vault) and vault.pending == vault.generation
    vault' = { ...vault, pending: 0,
      delivery: if (deliver) Delivered else Refused,
      deliveredTicket: if (deliver) vault.pending else 0 }
  }
  action settleConfirmation = any { settle(true), settle(false) }

  action step = any {
    resume, leave, retireOwner, admitOwner, authorize,
    androidUnlock(true, true), androidUnlock(true, false),
    androidUnlock(false, true), androidUnlock(false, false),
    finishLegacy(false, false, false), finishLegacy(true, false, false),
    finishLegacy(true, true, false), finishLegacy(true, true, true),
    confirmPrompt, settleConfirmation, vault' = vault
  }

  val GrantBelongsToCurrentVisit = vault.grant implies
    vault.foreground and vault.admitted and not(vault.legacySelected) and vault.generation > 0
  val DeliveryNeedsCurrentGrant = vault.delivery == Delivered implies
    usable(vault) and vault.deliveredTicket == vault.generation
  temporal PendingConfirmationSettles = settleConfirmation.weakFair(vault).implies(
    always(vault.pending != 0 implies eventually(vault.pending == 0)))

  run foregroundWithoutScreenLockTest = fresh.then(resume)
    .expect(not(vault.screenSecure) and not(usable(vault)))
    .then(authorize).then(confirmPrompt).then(settle(true)).expect(vault.delivery == Delivered)
  run cancellationTest = fresh.then(resume).then(authorize).then(confirmPrompt)
    .then(settle(false)).expect(vault.delivery == Refused)
  run deviceLockedTest = fresh.then(resume).then(authorize).then(confirmPrompt)
    .then(androidUnlock(true, false)).then(settle(true)).expect(vault.delivery == Refused)
  run userLockedTest = fresh.then(resume).then(authorize).then(confirmPrompt)
    .then(androidUnlock(false, true)).then(settle(true)).expect(vault.delivery == Refused)
  run staleVisitTest = fresh.then(resume).then(authorize).then(confirmPrompt)
    .then(leave).then(resume).expect(not(usable(vault)))
    .then(authorize).then(settle(true)).expect(vault.delivery == Refused)
    .then(confirmPrompt).then(settle(true)).expect(vault.delivery == Delivered)
  run retiredOwnerTest = fresh.then(resume).then(authorize).then(confirmPrompt)
    .then(retireOwner).then(admitOwner).expect(not(usable(vault)))
    .then(authorize).then(settle(true)).expect(vault.delivery == Refused)
  run legacyRetryTest = legacy.then(resume).expect(not(usable(vault)))
    .then(finishLegacy(true, true, false)).expect(vault.legacySelected and not(usable(vault)))
    .then(finishLegacy(true, true, true)).expect(not(vault.legacySelected) and usable(vault))
  run legacyWithoutScreenLockTest = legacyWithoutScreenLock.then(resume)
    .expect(ownerForeground(vault) and vault.legacySelected and not(usable(vault)))
  run legacyAuthorizationRefusedTest = legacy.then(resume)
    .then(finishLegacy(false, false, false)).expect(vault.legacySelected and not(usable(vault)))
  run legacyCopyRefusedTest = legacy.then(resume)
    .then(finishLegacy(true, false, false)).expect(vault.legacySelected and not(usable(vault)))
}
