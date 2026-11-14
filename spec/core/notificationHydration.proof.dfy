lemma HydrationIndexedCoordinates(rows: seq<string>)
  ensures migrateLegacy(rows).rowIds == rows
  ensures migrateLegacy(rows).watermark == |rows|
  ensures |migrateLegacy(rows).coordinates| == |rows|
  ensures forall i :: 0 <= i < |rows| ==>
    migrateLegacy(rows).coordinates[i] == core__notifications_Coordinate(rows[i], i + 1)
  decreases |rows|
{
  if |rows| > 0 {
    var prior := rows[..|rows|-1];
    var last := rows[|rows|-1];
    assert rows == prior + [last];
    HydrationIndexedCoordinates(prior);
    var build := (accumulated: MigrationBuild, id: string) => MigrationBuild(accumulated.coordinates + [core__notifications_Coordinate(id, accumulated.watermark + 1)], accumulated.watermark + 1);
    ProofLib.FoldLeftAppend(build, MigrationBuild([], 0), prior, last);
  }
}

lemma HydrationLegacyDistinct(rows: seq<string>)
  requires uniqueLegacy(rows)
  ensures ProofLib.Distinct(rows)
{
  assert forall id :: id in rows ==> |ProofLib.Filter((other: string) => other == id, rows)| == 1;
  forall i, j | 0 <= i < j < |rows| ensures rows[i] != rows[j] {
    var id := rows[i];
    assert id in rows;
    if rows[j] == id {
      ProofLib.FilterTwo((other: string) => other == id, rows, i, j);
    }
  }
}

lemma HydrationCheckCoordinate(snapshot: core__notifications_Snapshot, previous: int, coord: core__notifications_Coordinate)
  requires 0 <= previous < coord.value <= snapshot.watermark
  requires ProofLib.Filter((entry: core__notifications_Coordinate) => entry.id == coord.id, snapshot.coordinates) == [coord]
  ensures core__notifications_checkCoordinate(snapshot, core__notifications_CoordinateCheck(true, previous), coord.id) == core__notifications_CoordinateCheck(true, coord.value)
{}

lemma HydrationCheckPrefix(snapshot: core__notifications_Snapshot, length: int)
  requires 0 <= length <= |snapshot.rowIds|
  requires |snapshot.coordinates| == |snapshot.rowIds| == snapshot.watermark
  requires ProofLib.Distinct(snapshot.rowIds)
  requires forall i :: 0 <= i < |snapshot.rowIds| ==>
    snapshot.coordinates[i] == core__notifications_Coordinate(snapshot.rowIds[i], i + 1)
  ensures Std.Collections.Seq.FoldLeft((checked: core__notifications_CoordinateCheck, id: string) => core__notifications_checkCoordinate(snapshot, checked, id), core__notifications_CoordinateCheck(true, 0), snapshot.rowIds[..length]) == core__notifications_CoordinateCheck(true, length)
  decreases length
{
  if length > 0 {
    var index := length - 1;
    HydrationCheckPrefix(snapshot, index);
    var id := snapshot.rowIds[index];
    var coord := snapshot.coordinates[index];
    var matches := (entry: core__notifications_Coordinate) => entry.id == id;
    ProofLib.FilterOne(matches, snapshot.coordinates, index);
    ProofLib.FilterMember(matches, snapshot.coordinates, coord);
    assert ProofLib.Filter(matches, snapshot.coordinates) == [coord];
    HydrationCheckCoordinate(snapshot, index, coord);
    assert snapshot.rowIds[..length] == snapshot.rowIds[..index] + [id];
    ProofLib.FoldLeftAppend((checked: core__notifications_CoordinateCheck, id: string) => core__notifications_checkCoordinate(snapshot, checked, id), core__notifications_CoordinateCheck(true, 0), snapshot.rowIds[..index], id);
  }
}

lemma HydrationMigratedSnapshotValid(rows: seq<string>)
  requires uniqueLegacy(rows)
  ensures core__notifications_validSnapshot(migrateLegacy(rows))
{
  HydrationIndexedCoordinates(rows);
  HydrationLegacyDistinct(rows);
  var snapshot := migrateLegacy(rows);
  HydrationCheckPrefix(snapshot, |snapshot.rowIds|);
  assert snapshot.rowIds[..|snapshot.rowIds|] == snapshot.rowIds;
  assert Std.Collections.Seq.FoldLeft((checked: core__notifications_CoordinateCheck, id: string) => core__notifications_checkCoordinate(snapshot, checked, id), core__notifications_CoordinateCheck(true, 0), snapshot.rowIds).valid;
}

lemma readLoaded_ensures(s: Hydration)
  ensures (inv(s) ==> canReadLoaded(s) ==> alwaysReadyHasDurableCoordinates(readLoaded(s)))
  ensures (inv(s) ==> canReadLoaded(s) ==> alwaysReadinessMatchesPhase(readLoaded(s)))
  ensures (inv(s) ==> canReadLoaded(s) ==> alwaysMigrationKeepsInsertionOrder(readLoaded(s)))
  ensures (inv(s) ==> canReadLoaded(s) ==> alwaysPendingMigrationIsValid(readLoaded(s)))
  ensures (inv(s) ==> canReadLoaded(s) ==> alwaysReadingStartsFresh(readLoaded(s)))
  ensures (inv(s) ==> canReadLoaded(s) ==> alwaysStartupAccounting(readLoaded(s)))
  ensures (inv(s) ==> canReadLoaded(s) ==> stepInvalidCurrentSnapshotNeverWrites(s, "readLoaded", readLoaded(s)))
  ensures (inv(s) ==> canReadLoaded(s) ==> stepCurrentSnapshotLoadRetainsEpoch(s, "readLoaded", readLoaded(s)))
{
  if inv(s) && canReadLoaded(s) && s.store.format.LegacyInbox? && uniqueLegacy(s.store.snapshot.rowIds) {
    HydrationMigratedSnapshotValid(s.store.snapshot.rowIds);
  }
}
