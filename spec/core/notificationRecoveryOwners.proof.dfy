lemma RecoveryCounts(s: Owners)
  ensures alwaysRecordIdentitiesAreUnique(s) == (s.nextId > 0 && (forall record :: record in s.records ==> 0 < record.id < s.nextId && |ProofLib.Filter((other: OwnedRecovery) => other.id == record.id, s.records)| == 1))
{}

lemma RecoveryLookup(s: Owners, id: int)
  ensures owned(s, id) == (if |ProofLib.Filter((record: OwnedRecovery) => record.id == id, s.records)| > 0 then ProofLib.Filter((record: OwnedRecovery) => record.id == id, s.records)[0] else absent)
{}

lemma RecoveryKnown(s: Owners, record: OwnedRecovery)
  requires inv(s) && record in s.records
  ensures owned(s, record.id) == record
{
  RecoveryCounts(s); RecoveryLookup(s, record.id);
  ProofLib.FilterMember((other: OwnedRecovery) => other.id == record.id, s.records, record);
}

lemma RecoveryAbsentZero(s: Owners)
  requires inv(s)
  ensures owned(s, 0) == absent
{
  RecoveryCounts(s); RecoveryLookup(s, 0);
  ProofLib.FilterNone((record: OwnedRecovery) => record.id == 0, s.records);
}

lemma RecoveryMapped(s: Owners)
  requires inv(s)
  ensures core__notificationRecovery_inv(owned(s, s.mapped).recovery)
  ensures s.mapped != 0 ==> 0 < s.mapped < s.nextId
{
  RecoveryCounts(s);
  if s.mapped == 0 { RecoveryAbsentZero(s); }
  else {
    var record :| record in s.records && record.id == s.mapped;
    RecoveryKnown(s, record);
  }
}

lemma RecoveryIdentityMap(s: Owners, changed: seq<OwnedRecovery>)
  requires inv(s) && |changed| == |s.records|
  requires forall i :: 0 <= i < |changed| ==> changed[i].id == s.records[i].id
  requires forall record :: record in changed ==> core__notificationRecovery_inv(record.recovery)
  ensures inv(s.(records := changed))
{
  var after := s.(records := changed);
  RecoveryCounts(s); RecoveryCounts(after);
  if s.mapped != 0 {
    var before :| before in s.records && before.id == s.mapped;
    var index :| 0 <= index < |s.records| && s.records[index] == before;
    assert changed[index] in changed && changed[index].id == s.mapped;
  }
  forall record | record in changed
    ensures 0 < record.id < s.nextId
    ensures |ProofLib.Filter((other: OwnedRecovery) => other.id == record.id, changed)| == 1
  {
    var index :| 0 <= index < |changed| && changed[index] == record;
    assert s.records[index] in s.records;
    ProofLib.FilterLengthPointwise((other: OwnedRecovery) => other.id == record.id, (other: OwnedRecovery) => other.id == record.id, s.records, changed);
  }
}

lemma RecoveryReplace(s: Owners, replacement: OwnedRecovery, nextId: int)
  requires inv(s) && nextId >= s.nextId && 0 < replacement.id < nextId
  requires core__notificationRecovery_inv(replacement.recovery)
  ensures inv(s.(records := ProofLib.Filter((record: OwnedRecovery) => record.id != replacement.id, s.records) + [replacement], mapped := replacement.id, nextId := nextId))
{
  var kept := ProofLib.Filter((record: OwnedRecovery) => record.id != replacement.id, s.records);
  var after := s.(records := kept + [replacement], mapped := replacement.id, nextId := nextId);
  RecoveryCounts(s); RecoveryCounts(after);
  forall record | record in after.records
    ensures 0 < record.id < nextId && core__notificationRecovery_inv(record.recovery)
    ensures |ProofLib.Filter((other: OwnedRecovery) => other.id == record.id, after.records)| == 1
  {
    ProofLib.FilterAppend((other: OwnedRecovery) => other.id == record.id, kept, replacement);
    if record == replacement {
      ProofLib.FilterNone((other: OwnedRecovery) => other.id == record.id, kept);
    } else {
      assert record in kept;
      ProofLib.FilterMember((record: OwnedRecovery) => record.id != replacement.id, s.records, record);
      ProofLib.FilterOfFilterShorter((record: OwnedRecovery) => record.id != replacement.id, (other: OwnedRecovery) => other.id == record.id, s.records);
      ProofLib.FilterMember((other: OwnedRecovery) => other.id == record.id, kept, record);
    }
  }
}

lemma returnLoad_ensures(s: Owners, attemptId: int)
  ensures (inv(s) ==> canReturnLoad(s, attemptId) ==> alwaysMappedIdentityExists(returnLoad(s, attemptId)))
  ensures (inv(s) ==> canReturnLoad(s, attemptId) ==> alwaysRecordIdentitiesAreUnique(returnLoad(s, attemptId)))
  ensures (inv(s) ==> canReturnLoad(s, attemptId) ==> alwaysEachRecoveryRetainsItsRules(returnLoad(s, attemptId)))
  ensures (inv(s) ==> canReturnLoad(s, attemptId) ==> stepOldSuccessPreservesMappedReplacement(s, "returnLoad", returnLoad(s, attemptId)))
{
  if inv(s) && canReturnLoad(s, attemptId) {
    var after := returnLoad(s, attemptId);
    forall record | record in after.records ensures core__notificationRecovery_inv(record.recovery) {
      var index :| 0 <= index < |after.records| && after.records[index] == record;
      var previous := s.records[index];
      RecoveryKnown(s, previous);
    }
    RecoveryIdentityMap(s, after.records);
  }
}

lemma succeed_ensures(s: Owners, attemptId: int)
  ensures (inv(s) ==> canSucceed(s, attemptId) ==> alwaysMappedIdentityExists(succeed(s, attemptId)))
  ensures (inv(s) ==> canSucceed(s, attemptId) ==> alwaysRecordIdentitiesAreUnique(succeed(s, attemptId)))
  ensures (inv(s) ==> canSucceed(s, attemptId) ==> alwaysEachRecoveryRetainsItsRules(succeed(s, attemptId)))
  ensures (inv(s) ==> canSucceed(s, attemptId) ==> stepOldSuccessPreservesMappedReplacement(s, "succeed", succeed(s, attemptId)))
{
  if inv(s) && canSucceed(s, attemptId) {
    var after := succeed(s, attemptId);
    forall record | record in after.records ensures core__notificationRecovery_inv(record.recovery) {
      var index :| 0 <= index < |after.records| && after.records[index] == record;
      var previous := s.records[index];
      RecoveryKnown(s, previous);
      if previous.id == attemptId { core__notificationRecovery_loaded_ensures(previous.recovery); }
    }
    RecoveryIdentityMap(s, after.records);
  }
}

lemma loadFailed_ensures(s: Owners, attemptId: int)
  ensures (inv(s) ==> canLoadFailed(s, attemptId) ==> alwaysMappedIdentityExists(loadFailed(s, attemptId)))
  ensures (inv(s) ==> canLoadFailed(s, attemptId) ==> alwaysRecordIdentitiesAreUnique(loadFailed(s, attemptId)))
  ensures (inv(s) ==> canLoadFailed(s, attemptId) ==> alwaysEachRecoveryRetainsItsRules(loadFailed(s, attemptId)))
  ensures (inv(s) ==> canLoadFailed(s, attemptId) ==> stepOldSuccessPreservesMappedReplacement(s, "loadFailed", loadFailed(s, attemptId)))
{
  if inv(s) && canLoadFailed(s, attemptId) {
    var after := loadFailed(s, attemptId);
    forall record | record in after.records ensures core__notificationRecovery_inv(record.recovery) {
      var index :| 0 <= index < |after.records| && after.records[index] == record;
      var previous := s.records[index];
      RecoveryKnown(s, previous);
      if previous.id == attemptId { core__notificationRecovery_loadFailed_ensures(previous.recovery); }
    }
    RecoveryIdentityMap(s, after.records);
  }
}

lemma finalize_ensures(s: Owners, attemptId: int)
  ensures (inv(s) ==> canFinalize(s, attemptId) ==> alwaysMappedIdentityExists(finalize(s, attemptId)))
  ensures (inv(s) ==> canFinalize(s, attemptId) ==> alwaysRecordIdentitiesAreUnique(finalize(s, attemptId)))
  ensures (inv(s) ==> canFinalize(s, attemptId) ==> alwaysEachRecoveryRetainsItsRules(finalize(s, attemptId)))
  ensures (inv(s) ==> canFinalize(s, attemptId) ==> stepOldSuccessPreservesMappedReplacement(s, "finalize", finalize(s, attemptId)))
{
  if inv(s) && canFinalize(s, attemptId) {
    var after := finalize(s, attemptId);
    forall record | record in after.records ensures core__notificationRecovery_inv(record.recovery) {
      var index :| 0 <= index < |after.records| && after.records[index] == record;
      var previous := s.records[index];
      RecoveryKnown(s, previous);
      if previous.id == attemptId { core__notificationRecovery_finalize_ensures(previous.recovery); }
    }
    RecoveryIdentityMap(s, after.records);
  }
}

lemma elapse_ensures(s: Owners, attemptId: int, milliseconds: int)
  ensures (inv(s) ==> canElapse(s, attemptId, milliseconds) ==> alwaysMappedIdentityExists(elapse(s, attemptId, milliseconds)))
  ensures (inv(s) ==> canElapse(s, attemptId, milliseconds) ==> alwaysRecordIdentitiesAreUnique(elapse(s, attemptId, milliseconds)))
  ensures (inv(s) ==> canElapse(s, attemptId, milliseconds) ==> alwaysEachRecoveryRetainsItsRules(elapse(s, attemptId, milliseconds)))
  ensures (inv(s) ==> canElapse(s, attemptId, milliseconds) ==> stepOldSuccessPreservesMappedReplacement(s, "elapse", elapse(s, attemptId, milliseconds)))
{
  if inv(s) && canElapse(s, attemptId, milliseconds) {
    var after := elapse(s, attemptId, milliseconds);
    forall record | record in after.records ensures core__notificationRecovery_inv(record.recovery) {
      var index :| 0 <= index < |after.records| && after.records[index] == record;
      var previous := s.records[index];
      RecoveryKnown(s, previous);
      if previous.id == attemptId { core__notificationRecovery_elapse_ensures(previous.recovery, milliseconds); }
    }
    RecoveryIdentityMap(s, after.records);
  }
}

lemma request_ensures(s: Owners)
  ensures (inv(s) ==> alwaysMappedIdentityExists(request(s)))
  ensures (inv(s) ==> alwaysRecordIdentitiesAreUnique(request(s)))
  ensures (inv(s) ==> alwaysEachRecoveryRetainsItsRules(request(s)))
  ensures (inv(s) ==> stepOldSuccessPreservesMappedReplacement(s, "request", request(s)))
{
  if inv(s) {
    RecoveryMapped(s);
    if !mappedBusy(s) && s.availability.Failed? && !mappedCooling(s) {
      var prior := owned(s, s.mapped).recovery;
      var retargeted := prior.(availability := core__notificationRecovery_Availability.Failed);
      assert core__notificationRecovery_inv(retargeted);
      core__notificationRecovery_request_ensures(retargeted);
      var id := if s.mapped == 0 then s.nextId else s.mapped;
      var nextId := if s.mapped == 0 then s.nextId + 1 else s.nextId;
      var replacement := OwnedRecovery(id, core__notificationRecovery_request(retargeted), false);
      RecoveryReplace(s, replacement, nextId);
    }
  }
}
