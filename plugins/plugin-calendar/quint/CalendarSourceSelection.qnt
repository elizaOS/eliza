// Exact source administration over an already-seeded feed preference row.
module CalendarSourceSelection {
  type Request = {
    phase: str, submitted: int, expected: int, included: bool, catalog: str,
    outcome: str, previous: int, current: int,
  }
  type State = {
    version: int, included: bool, ics: bool, enabled: bool,
    adjacentVersion: int, adjacentIncluded: bool,
    requests: int -> Request,
  }
  var s: State

  pure val idle: Request = {
    phase: "idle", submitted: 0, expected: 0, included: true, catalog: "exact",
    outcome: "none", previous: -1, current: -1,
  }

  action initial(ics: bool): bool = s' = {
    version: 0, included: true, ics: ics, enabled: true,
    adjacentVersion: 0, adjacentIncluded: true,
    requests: Map(0 -> idle, 1 -> idle),
  }

  action init = any { initial(false), initial(true) }

  action submit(client: int, included: bool, catalog: str): bool = {
    val request = s.requests.get(client)
    all {
      request.phase == "idle" or
        (client == 0 and request.phase == "settled" and request.submitted == 1 and request.outcome == "rolled_back"),
      s' = { ...s, requests: s.requests.set(client, {
        ...idle, phase: "listed", submitted: request.submitted + 1,
        expected: s.version, included: included, catalog: catalog,
      }) },
    }
  }

  pure def settled(request: Request, outcome: str, current: int): Request = {
    ...request, phase: "settled", outcome: outcome,
    previous: if (current >= 0) request.expected else -1, current: current,
  }

  action admit(client: int): bool = {
    val request = s.requests.get(client)
    // Both public catalog checks are represented by one observation. A later
    // SQL read or conditional update may still lose to a concurrent writer.
    val nextRequest = if (request.catalog != "exact") settled(request, "unselectable", -1)
      else if (request.expected != s.version) settled(request, "catalog_conflict", -1)
      else { ...request, phase: "admitted" }
    all {
      request.phase == "listed",
      s' = { ...s, requests: s.requests.set(client, nextRequest) },
    }
  }

  action readPreference(client: int): bool = {
    val request = s.requests.get(client)
    val nextRequest = if (request.expected != s.version) settled(request, "storage_conflict", -1)
      else if (request.included == s.included) settled(request, "no_op", s.version)
      else { ...request, phase: "changing" }
    all {
      request.phase == "admitted",
      s' = { ...s, requests: s.requests.set(client, nextRequest) },
    }
  }

  action commit(client: int, icsWriteSucceeds: bool): bool = {
    val request = s.requests.get(client)
    all {
      request.phase == "changing",
      if (request.expected != s.version) {
        s' = { ...s, requests: s.requests.set(client, settled(request, "storage_conflict", -1)) }
      } else if (s.ics and not(icsWriteSucceeds)) {
        s' = { ...s, requests: s.requests.set(client, settled(request, "rolled_back", -1)) }
      } else {
        val version = s.version + 1
        s' = { ...s, version: version, included: request.included,
          enabled: if (s.ics) request.included else s.enabled,
          requests: s.requests.set(client, settled(request, "changed", version)),
        }
      },
    }
  }

  action decide(client: int): bool = any {
    admit(client), readPreference(client), commit(client, true), commit(client, false),
  }

  action step = any {
    submit(0, false, "exact"), submit(0, true, "exact"),
    submit(1, false, "exact"), submit(1, true, "exact"),
    submit(1, false, "different_account"), submit(1, false, "health_only"),
    decide(0), decide(1), s' = s,
  }

  pure def isReceipt(request: Request): bool = Set("changed", "no_op").contains(request.outcome)

  val ExactReceiptVersions = Set(0, 1).forall(client => {
    val request = s.requests.get(client)
    and {
      isReceipt(request) == (request.previous >= 0 and request.current >= 0),
      isReceipt(request) implies request.catalog == "exact" and request.previous == request.expected,
      (request.outcome == "changed") implies request.current == request.previous + 1,
      (request.outcome == "no_op") implies request.current == request.previous,
      request.current <= s.version,
    }
  })

  val IcsRowsAgree = s.ics implies s.included == s.enabled
  val AdjacentSourceUnchanged = s.adjacentVersion == 0 and s.adjacentIncluded

  // Conflict, rollback and no-op observations can settle a caller, but never
  // advance the durable version or publish an enablement change.
  temporal WritesNeedExactCurrentVersion = always((
    (next(s.version) != s.version or next(s.included) != s.included or next(s.enabled) != s.enabled) implies
      Set(0, 1).exists(client => and {
        s.requests.get(client).phase == "changing",
        s.requests.get(client).expected == s.version,
        s.requests.get(client).catalog == "exact",
        next(s.requests.get(client).outcome) == "changed",
        next(s.version) == s.version + 1,
      })
  ).orKeep(s))

  temporal RequestsSettle = and {
    Set("listed", "admitted", "changing").contains(s.requests.get(0).phase).leadsTo(s.requests.get(0).phase == "settled"),
    Set("listed", "admitted", "changing").contains(s.requests.get(1).phase).leadsTo(s.requests.get(1).phase == "settled"),
  }
  temporal FairRequestsSettle = (decide(0).weakFair(s) and decide(1).weakFair(s)) implies RequestsSettle

  run CompetingWritesUseDurableCasTest = initial(false)
    .then(submit(0, false, "exact")).then(submit(1, false, "exact"))
    .then(admit(0)).then(admit(1)).then(readPreference(0)).then(readPreference(1))
    .then(commit(0, true)).then(commit(1, true))
    .expect(s.version == 1 and s.requests.get(0).outcome == "changed" and s.requests.get(1).outcome == "storage_conflict")

  run StaleCatalogVersionRejectsEvenNoOpTest = initial(false)
    .then(submit(0, false, "exact")).then(submit(1, false, "exact"))
    .then(admit(0)).then(readPreference(0)).then(commit(0, true)).then(admit(1))
    .expect(s.requests.get(1).outcome == "catalog_conflict" and ExactReceiptVersions)

  run StaleStorageReadRejectsEvenNoOpTest = initial(false)
    .then(submit(0, false, "exact")).then(submit(1, false, "exact"))
    .then(admit(0)).then(admit(1)).then(readPreference(0)).then(commit(0, true)).then(readPreference(1))
    .expect(s.requests.get(1).outcome == "storage_conflict" and ExactReceiptVersions)

  run IcsNoOpPreservesBothRowsTest = initial(true)
    .then(submit(0, true, "exact")).then(admit(0)).then(readPreference(0))
    .expect(s.requests.get(0).outcome == "no_op" and s.version == 0 and s.enabled and s.included)

  run IcsRollbackKeepsVersionForFreshRetryTest = initial(true)
    .then(submit(0, false, "exact")).then(admit(0)).then(readPreference(0)).then(commit(0, false))
    .expect(s.requests.get(0).outcome == "rolled_back" and s.version == 0 and s.enabled and s.included)
    .then(submit(0, false, "exact")).then(admit(0)).then(readPreference(0)).then(commit(0, true))
    .expect(s.requests.get(0).outcome == "changed" and s.version == 1 and not(s.enabled) and not(s.included))

  run DifferentAccountCannotWriteTest = initial(false)
    .then(submit(1, false, "different_account")).then(admit(1))
    .expect(s.requests.get(1).outcome == "unselectable" and s.version == 0 and AdjacentSourceUnchanged)

  run HealthOnlySourceCannotWriteTest = initial(false)
    .then(submit(1, false, "health_only")).then(admit(1))
    .expect(s.requests.get(1).outcome == "unselectable" and s.version == 0)
}
