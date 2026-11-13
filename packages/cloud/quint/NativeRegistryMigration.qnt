// One environment's protected four-client snapshot, its transaction, and
// idempotent import receipt. Source/provider authenticity is checked before
// begin and is an assumption represented by validSource, not proved here.
module NativeRegistryMigration {
  var storedRows: int
  var stagedRows: int
  var receiptRows: int
  var phase: str
  var validSource: bool
  var conflict: bool
  action init = all { storedRows' = 0, stagedRows' = 0, receiptRows' = 0,
    phase' = "idle", validSource' = true, conflict' = false }
  action begin(valid: bool, conflicting: bool): bool = all {
    phase != "running", phase' = "running", validSource' = valid, conflict' = conflicting,
    stagedRows' = 0, storedRows' = storedRows, receiptRows' = receiptRows
  }
  action stage = all { phase == "running", validSource, not(conflict),
    stagedRows' = 4, storedRows' = storedRows, receiptRows' = receiptRows,
    phase' = phase, validSource' = validSource, conflict' = conflict }
  action commit = all { phase == "running", validSource, not(conflict), stagedRows == 4,
    storedRows' = 4, receiptRows' = 4, stagedRows' = 0, phase' = "committed",
    validSource' = validSource, conflict' = conflict }
  action rollback = all { phase == "running", storedRows' = storedRows,
    receiptRows' = receiptRows, stagedRows' = 0, phase' = "idle",
    validSource' = validSource, conflict' = conflict }
  action discoverConflict = all { phase == "running", stagedRows == 4, conflict' = true,
    storedRows' = storedRows, stagedRows' = stagedRows, receiptRows' = receiptRows, phase' = phase, validSource' = validSource }
  action step = any {
    { nondet valid = Bool.oneOf(); nondet conflicting = Bool.oneOf(); begin(valid, conflicting) },
    stage, discoverConflict, commit, rollback
  }
  val atomic = storedRows.in(Set(0, 4)) and receiptRows == storedRows
  val bounded = stagedRows.in(Set(0, 4))
  val safety = atomic and bounded
  run importAndRetryTest = init.then(begin(true, false)).then(stage).then(commit)
    .then(begin(true, false)).then(stage).then(commit).expect(storedRows == 4 and receiptRows == 4)
  run partialFailureRollsBackTest = init.then(begin(true, false)).then(stage).then(discoverConflict).then(rollback).expect(storedRows == 0 and receiptRows == 0)
  run conflictDoesNotPublishTest = init.then(begin(true, true)).then(rollback).expect(storedRows == 0 and receiptRows == 0)
  run invalidSourceDoesNotPublishTest = init.then(begin(false, false)).then(rollback).expect(storedRows == 0 and receiptRows == 0)
  run rollbackPreservesPriorImportTest = init.then(begin(true, false)).then(stage).then(commit)
    .then(begin(true, true)).then(rollback).expect(storedRows == 4 and receiptRows == 4)
}

// Release admission is independent of the retained historical client count.
// A reviewed deletion after cutover must not re-import the legacy registry.
module NativeRegistryRelease {
  var marker: str
  var rowsPresent: bool
  var sourceAvailable: bool
  var schemaValid: bool
  var identityValid: bool
  var admitted: bool
  var sourceRead: bool
  action init = all {
    marker' = "absent", rowsPresent' = false, sourceAvailable' = true,
    schemaValid' = true, identityValid' = true, admitted' = false, sourceRead' = false
  }
  action configure(schema: bool, identity: bool, source: bool): bool = all {
    schemaValid' = schema, identityValid' = identity, sourceAvailable' = source,
    marker' = marker, rowsPresent' = rowsPresent, admitted' = false, sourceRead' = false
  }
  action legacyImport = all {
    marker == "absent", schemaValid, identityValid, sourceAvailable,
    marker' = "unbound", rowsPresent' = true, admitted' = false, sourceRead' = true,
    schemaValid' = schemaValid, identityValid' = identityValid, sourceAvailable' = sourceAvailable
  }
  action importForRelease = all {
    marker == "absent", schemaValid, identityValid, sourceAvailable,
    marker' = "bound", rowsPresent' = true, admitted' = true, sourceRead' = true,
    schemaValid' = schemaValid, identityValid' = identityValid, sourceAvailable' = sourceAvailable
  }
  action adoptPreparation = all {
    marker == "unbound", rowsPresent, schemaValid, identityValid,
    marker' = "bound", rowsPresent' = rowsPresent, admitted' = true, sourceRead' = false,
    schemaValid' = schemaValid, identityValid' = identityValid, sourceAvailable' = sourceAvailable
  }
  action resumeRelease = all {
    marker == "bound", schemaValid, identityValid,
    marker' = marker, rowsPresent' = rowsPresent, admitted' = true, sourceRead' = false,
    schemaValid' = schemaValid, identityValid' = identityValid, sourceAvailable' = sourceAvailable
  }
  action reviewedDeletion = all {
    marker == "bound", marker' = marker, rowsPresent' = false, admitted' = false, sourceRead' = false,
    schemaValid' = schemaValid, identityValid' = identityValid, sourceAvailable' = sourceAvailable
  }
  action corruptMarker = all {
    marker != "absent", marker' = "invalid", rowsPresent' = rowsPresent, admitted' = false, sourceRead' = false,
    schemaValid' = schemaValid, identityValid' = identityValid, sourceAvailable' = sourceAvailable
  }
  action step = any {
    { nondet schema = Bool.oneOf(); nondet identity = Bool.oneOf(); nondet source = Bool.oneOf(); configure(schema, identity, source) },
    legacyImport, importForRelease, adoptPreparation, resumeRelease, reviewedDeletion, corruptMarker
  }
  val safety = (admitted implies (marker == "bound" and schemaValid and identityValid)) and
    (sourceRead implies sourceAvailable)
  run initialImportTest = init.then(importForRelease).expect(admitted and rowsPresent)
  run adoptPreparationTest = init.then(legacyImport).then(adoptPreparation).expect(admitted and not(sourceRead))
  run deleteAfterCutoverTest = init.then(importForRelease).then(reviewedDeletion)
    .then(configure(true, true, false)).then(resumeRelease).expect(admitted and not(rowsPresent) and not(sourceRead))
  run absentSourceRefusedTest = init.then(configure(true, true, false)).expect(not(admitted))
  run invalidSchemaRefusedTest = init.then(importForRelease).then(configure(false, true, true)).expect(not(admitted))
  run wrongIdentityRefusedTest = init.then(importForRelease).then(configure(true, false, true)).expect(not(admitted))
  run invalidMarkerRefusedTest = init.then(importForRelease).then(corruptMarker).expect(not(admitted))
}
