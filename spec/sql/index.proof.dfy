// spec/sql/index.md, "Applied migrations are a prefix of the desired sequence and must match their recorded checksum"
lemma FoldMatchingPrefix(entries: seq<MigrationEntry>, count: int)
  requires 0 <= count <= |entries|
  ensures Std.Collections.Seq.FoldLeft((position: int, migration: MigrationEntry) => matchMigration(entries, position, migration), 0, entries[..count]) == count
  decreases count
{
  if count > 0 {
    var position := count - 1;
    var prefix := entries[..position];
    var migration := entries[position];
    var step := (acc: int, entry: MigrationEntry) => matchMigration(entries, acc, entry);
    FoldMatchingPrefix(entries, position);
    assert entries[..count] == prefix + [migration];
    ProofLib.FoldLeftAppend(step, 0, prefix, migration);
    assert matchMigration(entries, position, migration) == count;
  } else {
    assert entries[..count] == [];
  }
}

lemma lawIdenticalLedgerIsCurrent_ensures(entries: seq<MigrationEntry>)
  ensures (lawIdenticalLedgerIsCurrent(entries) == true)
{
  FoldMatchingPrefix(entries, |entries|);
  assert entries[..|entries|] == entries;
}
