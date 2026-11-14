lemma RollbackReference(s: AdapterOwnership, captureId: int, ok: bool)
  ensures finishRollback(s, captureId, ok).active == (if ok then (if |ProofLib.Filter((c: AdapterCapture) => (c.id == captureId), s.captures)| > 0 then ProofLib.Filter((c: AdapterCapture) => (c.id == captureId), s.captures)[0] else AdapterCapture(0, 0, false, 0, false, false, false)).previous else s.active)
{}

lemma finishRollback_ensures(s: AdapterOwnership, captureId: int, ok: bool)
  ensures (inv(s) ==> canFinishRollback(s, captureId, ok) ==> alwaysActiveAdapterKnown(finishRollback(s, captureId, ok)))
  ensures (inv(s) ==> canFinishRollback(s, captureId, ok) ==> alwaysCapturedAdaptersKnown(finishRollback(s, captureId, ok)))
  ensures (inv(s) ==> canFinishRollback(s, captureId, ok) ==> alwaysMigrationReferenceKnown(finishRollback(s, captureId, ok)))
  ensures (inv(s) ==> canFinishRollback(s, captureId, ok) ==> stepMigrationIdentityPreserved(s, finishRollback(s, captureId, ok)))
{
  if inv(s) && canFinishRollback(s, captureId, ok) {
    RollbackReference(s, captureId, ok);
    var capture :| capture in s.captures && capture.id == captureId && capture.pending && (ok || adapterById(s, capture.closing).hasClose || adapterById(s, capture.closing).hasStop);
    ProofLib.FilterMember((c: AdapterCapture) => (c.id == captureId), s.captures, capture);
    var matching := ProofLib.Filter((c: AdapterCapture) => (c.id == captureId), s.captures);
    assert |matching| > 0;
    ProofLib.FilterMember((c: AdapterCapture) => (c.id == captureId), s.captures, matching[0]);
    assert matching[0] in s.captures;
  }
}

lemma finishMigration_ensures(s: AdapterOwnership, migrationId: int, ok: bool, errorId: string)
  ensures (inv(s) ==> canFinishMigration(s, migrationId, ok, errorId) ==> alwaysActiveAdapterKnown(finishMigration(s, migrationId, ok, errorId)))
  ensures (inv(s) ==> canFinishMigration(s, migrationId, ok, errorId) ==> alwaysCapturedAdaptersKnown(finishMigration(s, migrationId, ok, errorId)))
  ensures (inv(s) ==> canFinishMigration(s, migrationId, ok, errorId) ==> alwaysMigrationReferenceKnown(finishMigration(s, migrationId, ok, errorId)))
  ensures (inv(s) ==> canFinishMigration(s, migrationId, ok, errorId) ==> stepMigrationIdentityPreserved(s, finishMigration(s, migrationId, ok, errorId)))
{
  if inv(s) && canFinishMigration(s, migrationId, ok, errorId) {
    var after := finishMigration(s, migrationId, ok, errorId);
    forall m | m in s.migrations
      ensures exists other :: other in after.migrations && other.id == m.id && other.adapter == m.adapter && other.paths == m.paths && other.schemas == m.schemas
    {
      var i :| 0 <= i < |s.migrations| && s.migrations[i] == m;
      assert after.migrations[i].id == m.id && after.migrations[i].adapter == m.adapter;
      assert after.migrations[i].paths == m.paths && after.migrations[i].schemas == m.schemas;
    }
  }
}
