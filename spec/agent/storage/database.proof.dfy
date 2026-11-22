lemma writeLog_ensures(s: Store, room: string, at: int)
  ensures (inv(s) ==> canWriteLog(s, room, at) ==> alwaysDataPhasesHaveIdentity(writeLog(s, room, at)))
  ensures (inv(s) ==> canWriteLog(s, room, at) ==> alwaysCreatedIdentityWasPublished(writeLog(s, room, at)))
  ensures (inv(s) ==> canWriteLog(s, room, at) ==> alwaysUnusableIdentityKeepsNoId(writeLog(s, room, at)))
  ensures (inv(s) ==> canWriteLog(s, room, at) ==> alwaysStoreBelongsToItsLaunch(writeLog(s, room, at)))
  ensures (inv(s) ==> canWriteLog(s, room, at) ==> alwaysLockedExactlyWhileTheDirectoryIsUsed(writeLog(s, room, at)))
  ensures (inv(s) ==> canWriteLog(s, room, at) ==> alwaysFaultExactlyWhenFailed(writeLog(s, room, at)))
  ensures (inv(s) ==> canWriteLog(s, room, at) ==> alwaysSchemaWithinTheBundle(writeLog(s, room, at)))
  ensures (inv(s) ==> canWriteLog(s, room, at) ==> alwaysSeedMatchesTheBundle(writeLog(s, room, at)))
  ensures (inv(s) ==> canWriteLog(s, room, at) ==> alwaysWorkOnlyWhileOpenOrClosing(writeLog(s, room, at)))
  ensures (inv(s) ==> canWriteLog(s, room, at) ==> alwaysSweepTargetsStayExpired(writeLog(s, room, at)))
  ensures (inv(s) ==> canWriteLog(s, room, at) ==> stepIdentityNeverChanges(s, writeLog(s, room, at)))
  ensures (inv(s) ==> canWriteLog(s, room, at) ==> stepFailureIsFinal(s, writeLog(s, room, at)))
  ensures (inv(s) ==> canWriteLog(s, room, at) ==> stepSchemaMovesOneMigrationAtATime(s, "writeLog", writeLog(s, room, at)))
  ensures (inv(s) ==> canWriteLog(s, room, at) ==> stepOnlyASweepRemovesARow(s, "writeLog", writeLog(s, room, at)))
{
  if inv(s) && canWriteLog(s, room, at) && s.sweep.SweepRunning? {
    var entry := LogRow(s.nextLogId, room, at);
    var after := writeLog(s, room, at);
    assert after.logs == s.logs + [entry];
    assert after.sweep == s.sweep && after.launch == s.launch;
    forall row | row in s.sweep.targets
      ensures expired(after.logs, row, after.launch.retention, after.sweep.now)
    {
      assert expired(s.logs, row, s.launch.retention, s.sweep.now);
      var newer := (o: LogRow) => ((o.room == row.room) && ((o.at > row.at) || ((o.at == row.at) && (o.id > row.id))));
      NewerLogFilter(s.logs, row);
      NewerLogFilter(after.logs, row);
      assert newerInRoom(s.logs, row) == |ProofLib.Filter(newer, s.logs)|;
      assert newerInRoom(after.logs, row) == |ProofLib.Filter(newer, after.logs)|;
      ProofLib.FilterAppend(newer, s.logs, entry);
      assert newerInRoom(after.logs, row) >= newerInRoom(s.logs, row);
    }
    assert alwaysSweepTargetsStayExpired(after);
  }
}

lemma finishSweep_ensures(s: Store)
  ensures (inv(s) ==> canFinishSweep(s) ==> alwaysDataPhasesHaveIdentity(finishSweep(s)))
  ensures (inv(s) ==> canFinishSweep(s) ==> alwaysCreatedIdentityWasPublished(finishSweep(s)))
  ensures (inv(s) ==> canFinishSweep(s) ==> alwaysUnusableIdentityKeepsNoId(finishSweep(s)))
  ensures (inv(s) ==> canFinishSweep(s) ==> alwaysStoreBelongsToItsLaunch(finishSweep(s)))
  ensures (inv(s) ==> canFinishSweep(s) ==> alwaysLockedExactlyWhileTheDirectoryIsUsed(finishSweep(s)))
  ensures (inv(s) ==> canFinishSweep(s) ==> alwaysFaultExactlyWhenFailed(finishSweep(s)))
  ensures (inv(s) ==> canFinishSweep(s) ==> alwaysSchemaWithinTheBundle(finishSweep(s)))
  ensures (inv(s) ==> canFinishSweep(s) ==> alwaysSeedMatchesTheBundle(finishSweep(s)))
  ensures (inv(s) ==> canFinishSweep(s) ==> alwaysWorkOnlyWhileOpenOrClosing(finishSweep(s)))
  ensures (inv(s) ==> canFinishSweep(s) ==> alwaysSweepTargetsStayExpired(finishSweep(s)))
  ensures (inv(s) ==> canFinishSweep(s) ==> stepIdentityNeverChanges(s, finishSweep(s)))
  ensures (inv(s) ==> canFinishSweep(s) ==> stepFailureIsFinal(s, finishSweep(s)))
  ensures (inv(s) ==> canFinishSweep(s) ==> stepSchemaMovesOneMigrationAtATime(s, "finishSweep", finishSweep(s)))
  ensures (inv(s) ==> canFinishSweep(s) ==> stepOnlyASweepRemovesARow(s, "finishSweep", finishSweep(s)))
{
  if inv(s) && canFinishSweep(s) {
    var after := finishSweep(s);
    var local_6 := s.sweep;
    var local_7 := (if local_6.SweepRunning? then local_6.targets else []);
    var kept := (r: LogRow) => !((r in local_7));
    FinishedSweepFilter(s);
    assert after.logs == ProofLib.Filter(kept, s.logs);
    forall row | row in s.logs && !(row in local_7)
      ensures row in after.logs
    {
      ProofLib.FilterMember(kept, s.logs, row);
    }
    assert stepOnlyASweepRemovesARow(s, "finishSweep", after);
  }
}

lemma NewerLogFilter(logs: seq<LogRow>, row: LogRow)
  ensures newerInRoom(logs, row) == |ProofLib.Filter((o: LogRow) => ((o.room == row.room) && ((o.at > row.at) || ((o.at == row.at) && (o.id > row.id)))), logs)|
{
}

lemma FinishedSweepFilter(s: Store)
  ensures finishSweep(s).logs == (var local_6 := s.sweep;
    var local_7 := (if local_6.SweepRunning? then local_6.targets else []);
    ProofLib.Filter((r: LogRow) => !((r in local_7)), s.logs))
{
}
