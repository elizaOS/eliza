lemma ContextTextOrderReflexive(prefix: seq<string>, full: seq<string>)
  requires |prefix| <= |full| && prefix == full[..|prefix|]
  ensures var compare := (at: TextOrderCheck, value: string) => TextOrderCheck(at.index + 1, at.matched && value == (if 0 <= at.index && at.index < |full| then full[at.index] else ""));
    Std.Collections.Seq.FoldLeft(compare, initialTextOrderCheck, prefix) == TextOrderCheck(|prefix|, true)
  decreases |prefix|
{
  if |prefix| > 0 {
    var rest := prefix[..|prefix| - 1];
    var last := prefix[|prefix| - 1];
    var compare := (at: TextOrderCheck, value: string) => TextOrderCheck(at.index + 1, at.matched && value == (if 0 <= at.index && at.index < |full| then full[at.index] else ""));
    assert rest == full[..|rest|];
    assert prefix == rest + [last];
    ContextTextOrderReflexive(rest, full);
    ProofLib.FoldLeftAppend(compare, initialTextOrderCheck, rest, last);
    assert full[|rest|] == last;
  }
}

lemma ContextDefinitionReflexive(definition: ContextDefinition)
  ensures sameDefinition(definition, definition)
{
  ContextTextOrderReflexive(definition.parents, definition.parents);
  ContextTextOrderReflexive(definition.subcontexts, definition.subcontexts);
  ContextTextOrderReflexive(definition.aliases, definition.aliases);
}

lemma ContextFilterPartitions<T>(keep: T -> bool, prefix: seq<T>, suffix: seq<T>)
  requires forall row :: row in prefix ==> keep(row)
  requires forall row :: row in suffix ==> !keep(row)
  ensures ProofLib.Filter(keep, prefix + suffix) == prefix
  decreases |prefix|
{
  if |prefix| == 0 {
    assert prefix + suffix == suffix;
    ProofLib.FilterNone(keep, suffix);
    assert |ProofLib.Filter(keep, suffix)| == 0;
  } else {
    assert prefix == [prefix[0]] + prefix[1..];
    assert prefix[0] in prefix;
    assert keep(prefix[0]);
    assert (prefix + suffix)[0] == prefix[0];
    assert (prefix + suffix)[1..] == prefix[1..] + suffix;
    ProofLib.FilterCons(keep, prefix + suffix);
    ContextFilterPartitions(keep, prefix[1..], suffix);
  }
}

lemma ContextAcceptedAppendHasFreshIds(prefix: seq<ContextDefinition>, suffix: seq<ContextDefinition>)
  requires uniqueIds(prefix + suffix)
  ensures forall row :: row in suffix ==> !(exists prior :: prior in prefix && prior.id == row.id)
{
  forall row | row in suffix ensures !(exists prior :: prior in prefix && prior.id == row.id) {
    if exists prior :: prior in prefix && prior.id == row.id {
      var prior :| prior in prefix && prior.id == row.id;
      var i :| 0 <= i < |prefix| && prefix[i] == prior;
      var j :| 0 <= j < |suffix| && suffix[j] == row;
      var rows := prefix + suffix;
      var sameId := (other: ContextDefinition) => other.id == row.id;
      assert row in rows;
      assert rows[i] == prior && rows[|prefix| + j] == row;
      assert |ProofLib.Filter(sameId, rows)| == 1;
      ProofLib.FilterTwo(sameId, rows, i, |prefix| + j);
    }
  }
}

lemma ContextRegistrationIsValid(s: ContextRegistry, incoming: seq<ContextDefinition>, idempotent: bool)
  requires inv(s)
  ensures alwaysValidGraph(registerMany(s, incoming, idempotent))
{}

lemma ContextSameIdsForExactRows(rows: seq<ContextDefinition>)
  ensures sameTextOrder(definitionIds(rows), definitionIds(rows))
{
  var ids := definitionIds(rows);
  ContextTextOrderReflexive(ids, ids);
}

lemma ContextRetainsValues(before: seq<ContextDefinition>, after: seq<ContextDefinition>)
  requires forall row :: row in before ==> row in after
  ensures retainsDefinitionValues(before, after)
{
  forall row | row in before
    ensures exists retained :: retained in after && sameDefinition(row, retained)
  {
    assert row in after;
    ContextDefinitionReflexive(row);
    assert exists retained :: retained in after && sameDefinition(row, retained);
  }
}

lemma ContextSameDefinitions(s: ContextRegistry, after: ContextRegistry)
  requires s.definitions == after.definitions
  ensures stepRejectedBatchPreservesRegistry(s, after)
{
  ContextSameIdsForExactRows(s.definitions);
  ContextRetainsValues(s.definitions, after.definitions);
}

lemma ContextKeepsDefinitionPrefix(s: ContextRegistry, after: ContextRegistry, suffix: seq<ContextDefinition>)
  requires uniqueIds(after.definitions) && after.definitions == s.definitions + suffix
  ensures stepExistingDefinitionsNeverChange(s, after)
{
  var existing := (row: ContextDefinition) => exists prior :: prior in s.definitions && prior.id == row.id;
  ContextAcceptedAppendHasFreshIds(s.definitions, suffix);
  forall row | row in s.definitions ensures existing(row) {
    assert row.id == row.id;
  }
  ContextFilterPartitions(existing, s.definitions, suffix);
  assert existingDefinitions(s.definitions, after.definitions) == s.definitions;
  ContextSameIdsForExactRows(s.definitions);
  ContextRetainsValues(s.definitions, after.definitions);
}

lemma registerMany_ensures(s: ContextRegistry, incoming: seq<ContextDefinition>, idempotent: bool)
  ensures (inv(s) ==> alwaysValidGraph(registerMany(s, incoming, idempotent)))
  ensures (inv(s) ==> stepRejectedBatchPreservesRegistry(s, registerMany(s, incoming, idempotent)))
  ensures (inv(s) ==> stepExistingDefinitionsNeverChange(s, registerMany(s, incoming, idempotent)))
{
  if inv(s) {
    ContextRegistrationIsValid(s, incoming, idempotent);
    var after := registerMany(s, incoming, idempotent);
    assert uniqueIds(after.definitions);
    if after.resultKind.RegistryUpdated? {
      var suffix := candidateDefinitions(s, incoming, idempotent)[|s.definitions|..];
      assert after.definitions == s.definitions + suffix;
      ContextKeepsDefinitionPrefix(s, after, suffix);
    } else {
      assert after.definitions == s.definitions;
      ContextKeepsDefinitionPrefix(s, after, []);
      ContextSameDefinitions(s, after);
    }
  }
}

lemma lawEmptySubcontextCycleRejected_ensures(idempotent: bool)
  ensures (lawEmptySubcontextCycleRejected(idempotent) == true)
{
  var singleton := [emptySelfReference];
  assert initial.definitions == [];
  assert emptySelfReference.id == "" && emptySelfReference.subcontexts == [""];
  var idMatches := (row: ContextDefinition) => row.id == "";
  var canonical := (row: ContextDefinition) => !(exists prior :: prior in initial.definitions && prior.id == row.id);
  ProofLib.FilterAppend(idMatches, [], emptySelfReference);
  ProofLib.FilterNil(idMatches, []);
  assert canonical(emptySelfReference);
  assert singleton == [] + [emptySelfReference];
  ProofLib.FilterAppend(canonical, [], emptySelfReference);
  ProofLib.FilterNil(canonical, []);
  assert ProofLib.Filter(canonical, singleton) == singleton;
  assert candidateDefinitions(initial, singleton, idempotent) == singleton;
  var edge := ContextEdge("", "");
  var children := (found: seq<ContextEdge>, child: string) => addEdge(found, emptySelfReference.id, child);
  ProofLib.FoldLeftAppend(children, noEdges, [], "");
  var addChild := (found: seq<ContextEdge>, added: ContextEdge) => addEdge(found, added.source, added.target);
  ProofLib.FoldLeftAppend(addChild, noEdges, [], edge);
  assert addDefinitionEdges([], emptySelfReference) == [edge];
  var addDefinition := (found: seq<ContextEdge>, row: ContextDefinition) => addDefinitionEdges(found, row);
  ProofLib.FoldLeftAppend(addDefinition, noEdges, [], emptySelfReference);
  assert graphEdges(singleton) == [edge];
  var via := (found: seq<ContextEdge>, row: ContextDefinition) => throughVertex(found, row.id);
  ProofLib.FoldLeftAppend(via, [edge], [], emptySelfReference);
  var rights := (extended: seq<ContextEdge>, right: ContextEdge) =>
    if right.source == "" then addEdge(extended, edge.source, right.target) else extended;
  ProofLib.FoldLeftAppend(rights, [edge], [], edge);
  assert addEdge([edge], "", "") == [edge];
  var lefts := (paths: seq<ContextEdge>, left: ContextEdge) =>
    if left.target != "" then paths else Std.Collections.Seq.FoldLeft(
      (extended: seq<ContextEdge>, right: ContextEdge) =>
        if right.source == "" then addEdge(extended, left.source, right.target) else extended, paths, [edge]);
  ProofLib.FoldLeftAppend(lefts, [edge], [], edge);
  assert lefts([edge], edge) == [edge];
  assert throughVertex([edge], "") == [edge];
  assert graphReachability(singleton) == [edge];
  assert uniqueIds(singleton) && knownEdges(singleton) && !acyclic(singleton);
}
