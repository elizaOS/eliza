lemma MatchSuffix(desired: seq<MigrationEntry>, pos: int)
  requires 0 <= pos <= |desired|
  ensures Std.Collections.Seq.FoldLeft((position: int, migration: MigrationEntry) => matchMigration(desired, position, migration), pos, desired[pos..]) == |desired|
  decreases |desired| - pos
{
  if pos < |desired| {
    assert desired[pos..][0] == desired[pos];
    assert desired[pos..][1..] == desired[pos + 1..];
    MatchSuffix(desired, pos + 1);
  }
}

lemma lawIdenticalLedgerIsCurrent_ensures(entries: seq<MigrationEntry>)
  ensures (lawIdenticalLedgerIsCurrent(entries) == true)
{
  assert entries[0..] == entries;
  MatchSuffix(entries, 0);
}
