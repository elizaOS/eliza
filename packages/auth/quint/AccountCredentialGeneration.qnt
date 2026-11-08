// src/auth/account-storage.ts: storage-owned replacement generations and the
// refresh and identity metadata compare-and-swap commits. Two providers share
// an account id and two callers can retain older generations. Each storage API
// call is atomic under its lock.
module AccountCredentialGeneration {
  val accountKeys = Set(1, 2)
  val readers = Set(1, 2)
  val maxGeneration = 5
  type Record = { generation: int, credential: int, idToken: int, label: int }
  type Reader = { key: int, generation: int, stage: str }
  type State = {
    records: int -> Record,
    previous: int -> Record,
    readers: int -> Reader,
    nextGeneration: int,
    saves: int,
    operation: str,
    key: int,
    reader: int,
    value: int,
    includesIdToken: bool,
    expected: int,
    result: str,
  }
  var s: State
  val absent = { generation: 0, credential: 0, idToken: 0, label: 0 }

  action init = {
    val records = accountKeys.mapBy(k => {
      generation: k, credential: k, idToken: k, label: k
    })
    s' = {
      records: records, previous: records,
      readers: readers.mapBy(_ => { key: 1, generation: 0, stage: "idle" }),
      nextGeneration: 3, saves: 0, operation: "init", key: 1, reader: 1,
      value: 0, includesIdToken: false, expected: 0, result: "none",
    }
  }

  action begin(reader: int, key: int): bool = all {
    s.readers.get(reader).stage == "idle",
    s.records.get(key).generation > 0,
    s' = {
      ...s,
      readers: s.readers.set(reader, {
        key: key, generation: s.records.get(key).generation, stage: "waiting"
      }),
      previous: s.records, operation: "begin", key: key, reader: reader,
      value: 0, includesIdToken: false, expected: s.records.get(key).generation,
      result: "loaded",
    },
  }

  action refresh(reader: int, includesIdToken: bool): bool = {
    val held = s.readers.get(reader)
    val record = s.records.get(held.key)
    val admitted = record.generation == held.generation
    val incoming = reader + 2
    val nextRecord = {
      ...record,
      generation: s.nextGeneration,
      credential: incoming,
      idToken: if (includesIdToken) incoming else record.idToken,
    }
    all {
      s.readers.get(reader).stage == "waiting",
      s' = {
        ...s,
        records: if (admitted) s.records.set(held.key, nextRecord) else s.records,
        readers: s.readers.set(reader, { ...held, stage: "done" }),
        nextGeneration: s.nextGeneration + if (admitted) 1 else 0,
        previous: s.records, operation: "refresh", key: held.key, reader: reader,
        value: incoming, includesIdToken: includesIdToken, expected: held.generation,
        result: if (record.generation == 0) "missing"
          else if (admitted) "updated" else "changed",
      },
    }
  }

  // saveAccount always allocates a generation, including identical credentials.
  action save(key: int, value: int, includesIdToken: bool): bool = all {
    s.saves < 1,
    s' = {
      ...s,
      saves: s.saves + 1,
      records: s.records.set(key, {
        generation: s.nextGeneration, credential: value,
        idToken: if (includesIdToken) value else 0, label: key,
      }),
      nextGeneration: s.nextGeneration + 1,
      previous: s.records, operation: "save", key: key, value: value,
      includesIdToken: includesIdToken, expected: 0, result: "saved",
    },
  }

  pure def updateLabel(state: State, key: int, value: int, expected: int): State = {
    val record = state.records.get(key)
    val present = record.generation > 0
    // Zero represents an omitted expectation. A captured generation is positive.
    val admitted = present and (expected == 0 or record.generation == expected)
    {
      ...state,
      records: if (admitted) state.records.set(key, { ...record, label: value }) else state.records,
      previous: state.records,
      operation: if (expected == 0) "metadata" else "conditional-metadata",
      key: key, value: value, includesIdToken: false, expected: expected,
      result: if (not(present)) "missing" else if (admitted) "updated" else "changed",
    }
  }
  action metadata(key: int, value: int): bool = s' = updateLabel(s, key, value, 0)

  // The login path can retain a generation while the profile write is pending.
  action conditionalMetadata(reader: int, value: int): bool = {
    val held = s.readers.get(reader)
    all {
      held.stage == "waiting",
      s' = {
        ...updateLabel(s, held.key, value, held.generation),
        readers: s.readers.set(reader, { ...held, stage: "done" }),
        reader: reader,
      },
    }
  }

  action remove(key: int): bool = s' = {
    ...s, records: s.records.set(key, absent), previous: s.records,
    operation: "remove", key: key, value: 0, includesIdToken: false,
    expected: 0, result: "deleted",
  }

  action complete(reader: int): bool = any {
    {
      nondet withToken = Set(false, true).oneOf()
      refresh(reader, withToken)
    },
    {
      nondet value = accountKeys.oneOf()
      conditionalMetadata(reader, value)
    },
  }
  action step = any {
    {
      nondet reader = readers.oneOf()
      nondet key = accountKeys.oneOf()
      begin(reader, key)
    },
    {
      nondet reader = readers.oneOf()
      complete(reader)
    },
    {
      nondet key = accountKeys.oneOf()
      nondet value = accountKeys.oneOf()
      nondet withToken = Set(false, true).oneOf()
      save(key, value, withToken)
    },
    {
      nondet key = accountKeys.oneOf()
      nondet value = accountKeys.oneOf()
      metadata(key, value)
    },
    {
      nondet key = accountKeys.oneOf()
      remove(key)
    },
  }

  val TypeOK = and {
    s.records.keys() == accountKeys,
    s.readers.keys() == readers,
    s.nextGeneration.in(3.to(maxGeneration + 1)),
    s.saves.in(0.to(1)),
    readers.forall(reader => and {
      s.readers.get(reader).key.in(accountKeys),
      s.readers.get(reader).generation.in(0.to(maxGeneration)),
      s.readers.get(reader).stage.in(Set("idle", "waiting", "done")),
    }),
    accountKeys.forall(k => and {
      s.records.get(k).generation.in(0.to(maxGeneration)),
      s.records.get(k).credential.in(0.to(4)),
      s.records.get(k).idToken.in(0.to(4)),
      s.records.get(k).label.in(0.to(2)),
    }),
  }
  val FreshGenerations = accountKeys.forall(k =>
    s.records.get(k).generation < s.nextGeneration) and
    ((s.records.get(1).generation > 0 and s.records.get(2).generation > 0)
      .implies(s.records.get(1).generation != s.records.get(2).generation))
  val StaleRefreshCannotReplace =
    (s.operation == "refresh" and s.previous.get(s.key).generation != s.expected)
      .implies(s.records == s.previous)
  val RefreshCannotResurrect =
    (s.operation == "refresh" and s.previous.get(s.key).generation == 0)
      .implies(s.records.get(s.key).generation == 0 and s.result == "missing")
  val RefreshPreservesCurrentLabel =
    (s.operation == "refresh" and s.result == "updated")
      .implies(s.records.get(s.key).label == s.previous.get(s.key).label)
  val MissingIdTokenIsCarriedForward =
    (s.operation == "refresh" and s.result == "updated" and not(s.includesIdToken))
      .implies(s.records.get(s.key).idToken == s.previous.get(s.key).idToken)
  val MetadataPreservesCredentials =
    s.operation.in(Set("metadata", "conditional-metadata")).implies(accountKeys.forall(k => and {
      s.records.get(k).generation == s.previous.get(k).generation,
      s.records.get(k).credential == s.previous.get(k).credential,
      s.records.get(k).idToken == s.previous.get(k).idToken,
    }))
  val ConditionalMetadataHonorsGeneration = (s.operation == "conditional-metadata").implies({
    val generation = s.previous.get(s.key).generation
    if (generation == s.expected) {
      s.result == "updated" and s.records.get(s.key).label == s.value
    } else {
      s.records == s.previous and
        s.result == (if (generation == 0) "missing" else "changed")
    }
  })
  val ProviderIsolation = accountKeys.forall(k =>
    (k != s.key).implies(s.records.get(k) == s.previous.get(k)))
  val invariant = TypeOK and FreshGenerations and StaleRefreshCannotReplace and
    RefreshCannotResurrect and RefreshPreservesCurrentLabel and
    MissingIdTokenIsCarriedForward and MetadataPreservesCredentials and
    ConditionalMetadataHonorsGeneration and ProviderIsolation

  temporal AccountRequestsSettle = readers.forall(reader => complete(reader).weakFair(s)).implies(
    readers.forall(reader => always((s.readers.get(reader).stage == "waiting").implies(
      eventually(s.readers.get(reader).stage != "waiting")))))

  run deletedAccountCannotReturnTest = init.then(begin(1, 1)).then(remove(1))
    .then(refresh(1, false)).expect(s.result == "missing")
  run identicalReplacementFencesRefreshTest = init.then(begin(1, 1))
    .then(save(1, 1, true)).then(refresh(1, false))
    .expect(s.result == "changed" and s.records.get(1).credential == 1)
  run oneConcurrentRefreshWinsTest = init.then(begin(1, 1)).then(begin(2, 1))
    .then(refresh(1, false)).then(refresh(2, true))
    .expect(s.result == "changed" and s.records.get(1).credential == 3)
  run metadataSurvivesRefreshTest = init.then(begin(1, 1)).then(metadata(1, 2))
    .then(refresh(1, false))
    .expect(s.records.get(1).label == 2 and s.records.get(1).idToken == 1)
  run oldProfileCannotEditIdenticalReplacementTest = init.then(begin(1, 1))
    .then(save(1, 1, true)).then(conditionalMetadata(1, 2))
    .expect(s.result == "changed" and s.records.get(1).label == 1)
  run oldProfileCannotRecreateDeletedRecordTest = init.then(begin(1, 1))
    .then(remove(1)).then(conditionalMetadata(1, 2))
    .expect(s.result == "missing" and s.records.get(1) == absent)
  run currentProfilePreservesGenerationTest = init.then(begin(1, 1))
    .then(metadata(1, 2)).then(conditionalMetadata(1, 1))
    .expect(s.result == "updated" and s.records.get(1).generation == 1 and s.records.get(1).label == 1)
}
