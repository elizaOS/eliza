lemma ArchiveShape(selection: seq<SelectedFile>)
  ensures |archiveEntries(selection)| == |selection|
  ensures forall i :: 0 <= i < |selection| ==> archiveEntries(selection)[i] == ArchiveEntry(i + 1, selection[i].source, selection[i].bytes)
  decreases |selection|
{
  if |selection| > 0 {
    var front := selection[..|selection| - 1];
    assert selection == front + [selection[|selection| - 1]];
    ProofLib.FoldLeftAppend((entries: seq<ArchiveEntry>, file: SelectedFile) => (entries + [ArchiveEntry((|entries| + 1), file.source, file.bytes)]), [], front, selection[|selection| - 1]);
    ArchiveShape(front);
  }
}

lemma NamesConsecutive(entries: seq<ArchiveEntry>)
  requires forall i :: 0 <= i < |entries| ==> entries[i].position == i + 1
  ensures Std.Collections.Seq.FoldLeft((walk: NameWalk, entry: ArchiveEntry) => NameWalk((walk.consecutive && (entry.position == (walk.last + 1))), entry.position), NameWalk(true, 0), entries) == NameWalk(true, |entries|)
  decreases |entries|
{
  if |entries| > 0 {
    var front := entries[..|entries| - 1];
    assert entries == front + [entries[|entries| - 1]];
    ProofLib.FoldLeftAppend((walk: NameWalk, entry: ArchiveEntry) => NameWalk((walk.consecutive && (entry.position == (walk.last + 1))), entry.position), NameWalk(true, 0), front, entries[|entries| - 1]);
    NamesConsecutive(front);
  }
}

lemma lawArchiveHoldsSelectedBytesInOrder_ensures(selection: seq<SelectedFile>)
  ensures (lawArchiveHoldsSelectedBytesInOrder(selection) == true)
{
  ArchiveShape(selection);
}

lemma lawArchiveNamesCountFromOne_ensures(selection: seq<SelectedFile>)
  ensures (lawArchiveNamesCountFromOne(selection) == true)
{
  ArchiveShape(selection);
  NamesConsecutive(archiveEntries(selection));
}
