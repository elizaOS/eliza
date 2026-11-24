// One tablet lease and its acknowledged mobile sign-in. A tick abstracts
// clock progress; the access and idle windows are represented proportionally.
module MobileMailLease {
  type State = {
    phase: str,
    clock: int,
    ownerCurrent: bool,
    keyCurrent: bool,
    refresh: int,
    accessUntil: int,
    idleUntil: int,
    offered: int,
    offeredUntil: int,
    spent: Set[int],
    mailReturned: bool,
    lastProof: str
  }
  var s: State

  action init = s' = {
    phase: "unissued", clock: 0, ownerCurrent: true, keyCurrent: false,
    refresh: 0, accessUntil: 0, idleUntil: 0, offered: 0, offeredUntil: 0,
    spent: Set(), mailReturned: false, lastProof: "none"
  }
  pure def live(value: State): bool =
    value.phase == "active" and value.ownerCurrent and value.keyCurrent and value.clock < value.idleUntil
  pure def commitOffer(value: State): State = {
    ...value, refresh: value.offered, accessUntil: value.offeredUntil,
    idleUntil: value.clock + 8, offered: 0, offeredUntil: 0,
    spent: value.spent.union(Set(value.refresh))
  }

  action issue = all {
    s.phase == "unissued" and s.ownerCurrent,
    s' = { ...s, phase: "awaiting-ack", refresh: 1, idleUntil: s.clock + 8 }
  }
  action acknowledge = all {
    s.phase == "awaiting-ack" and s.ownerCurrent and s.clock < s.idleUntil,
    s' = { ...s, phase: "active", keyCurrent: true }
  }
  action requestRefresh = all {
    live(s) and s.offered == 0 and s.refresh < 4,
    s' = { ...s, offered: s.refresh + 1, offeredUntil: s.clock + 2, mailReturned: false }
  }
  action retryRefresh = all {
    live(s) and s.offered != 0,
    s' = { ...s, mailReturned: false }
  }
  action useOfferRefresh = all {
    live(s) and s.offered != 0,
    s' = { ...commitOffer(s), mailReturned: false }
  }
  action readWithOffer = all {
    live(s) and s.offered != 0 and s.clock < s.offeredUntil,
    s' = { ...commitOffer(s), mailReturned: true, lastProof: "lease" }
  }
  action readWithAccess = all {
    live(s) and s.clock < s.accessUntil,
    s' = { ...s, mailReturned: true, lastProof: "lease" }
  }
  action rawDeviceRequest =
    s' = { ...s, mailReturned: false, lastProof: "raw-key" }
  action wrongRoute =
    s' = { ...s, mailReturned: false, lastProof: "outside-mail" }
  action spentReuse = all {
    s.keyCurrent and s.spent.size() > 0,
    s' = { ...s, phase: "revoked", keyCurrent: false, offered: 0, offeredUntil: 0, mailReturned: false }
  }
  action endLease = all {
    s.phase == "active",
    s' = { ...s, phase: "revoked", offered: 0, offeredUntil: 0, mailReturned: false }
  }
  action removeOwner =
    s' = { ...s, ownerCurrent: false, keyCurrent: false, mailReturned: false }
  action tick = all {
    s.clock < 12,
    s' = { ...s, clock: s.clock + 1, mailReturned: false }
  }
  action step = any {
    issue, acknowledge, requestRefresh, retryRefresh, useOfferRefresh,
    readWithOffer, readWithAccess, rawDeviceRequest, wrongRoute,
    spentReuse, endLease, removeOwner, tick
  }

  val safety = and {
    s.mailReturned implies (live(s) and s.lastProof == "lease" and s.clock < s.accessUntil),
    not(s.spent.contains(s.refresh)),
    s.offered != 0 implies s.offered > s.refresh,
    s.phase != "active" implies not(s.mailReturned)
  }
}
