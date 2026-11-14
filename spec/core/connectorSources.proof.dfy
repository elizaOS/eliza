lemma SourceOwnerFilters(s: SourceRegistry)
  ensures alwaysSourceOwnersUnique(s) == (forall o :: o in s.owners ==> |ProofLib.Filter((other: SourceOwner) => (other.owner == o.owner), s.owners)| == 1)
{}

lemma SourceAliasFilters(entries: seq<AliasBinding>)
  ensures aliasKeysUnique(entries) == (forall b :: b in entries ==> |ProofLib.Filter((other: AliasBinding) => (other.alias == b.alias), entries)| == 1)
{}

lemma PutSourceAlias(entries: seq<AliasBinding>, alias: string, canonical: string)
  requires aliasKeysUnique(entries)
  ensures aliasKeysUnique(putAlias(entries, alias, canonical))
{
  var after := putAlias(entries, alias, canonical);
  SourceAliasFilters(entries); SourceAliasFilters(after);
  if exists b :: b in entries && b.alias == alias {
    forall b | b in after
      ensures |ProofLib.Filter((other: AliasBinding) => (other.alias == b.alias), after)| == 1
    {
      var i :| 0 <= i < |after| && after[i] == b;
      ProofLib.FilterLengthPointwise((other: AliasBinding) => (other.alias == b.alias), (other: AliasBinding) => (other.alias == b.alias), entries, after);
    }
  } else {
    forall b | b in after
      ensures |ProofLib.Filter((other: AliasBinding) => (other.alias == b.alias), after)| == 1
    {
      ProofLib.FilterAppend((other: AliasBinding) => (other.alias == b.alias), entries, AliasBinding(alias, canonical));
      if b.alias == alias { ProofLib.FilterNone((other: AliasBinding) => (other.alias == b.alias), entries); }
      else { assert b in entries; }
    }
  }
}

lemma FoldSourceAliases(entries: seq<AliasBinding>, aliases: seq<string>, canonical: string)
  requires aliasKeysUnique(entries)
  ensures aliasKeysUnique(Std.Collections.Seq.FoldLeft((acc: seq<AliasBinding>, alias: string) => putAlias(acc, alias, canonical), entries, aliases))
  decreases |aliases|
{
  if |aliases| > 0 {
    PutSourceAlias(entries, aliases[0], canonical);
    FoldSourceAliases(putAlias(entries, aliases[0], canonical), aliases[1..], canonical);
  }
}

lemma RebuildSourceAliases(entries: seq<AliasBinding>, metadata: seq<SourceMetadata>)
  requires aliasKeysUnique(entries)
  ensures aliasKeysUnique(Std.Collections.Seq.FoldLeft((acc: seq<AliasBinding>, m: SourceMetadata) => mergeAliases(acc, m), entries, metadata))
  decreases |metadata|
{
  if |metadata| > 0 {
    FoldSourceAliases(entries, metadata[0].aliases, metadata[0].canonical);
    RebuildSourceAliases(mergeAliases(entries, metadata[0]), metadata[1..]);
  }
}

lemma SourceEntryLookup(s: SourceRegistry, owner: string)
  ensures ownerEntry(s, owner) == (var matches := ProofLib.Filter((o: SourceOwner) => (o.owner == owner), s.owners); if |matches| > 0 then matches[0] else emptyOwner)
{}

lemma SourceOwnerAbsent(s: SourceRegistry, owner: string)
  requires owner != ""
  ensures ownerEntry(s, owner).owner == "" ==> !(exists o :: o in s.owners && o.owner == owner)
{
  SourceEntryLookup(s, owner);
  if exists o :: o in s.owners && o.owner == owner {
    var selected :| selected in s.owners && selected.owner == owner;
    var matches := ProofLib.Filter((o: SourceOwner) => (o.owner == owner), s.owners);
    ProofLib.FilterMember((o: SourceOwner) => (o.owner == owner), s.owners, selected);
    assert |matches| > 0;
    ProofLib.FilterMember((o: SourceOwner) => (o.owner == owner), s.owners, matches[0]);
  }
}

lemma RemoveSourceOwnerParts(s: SourceRegistry, owner: string)
  ensures removeSourceOwner(s, owner).owners == ProofLib.Filter((o: SourceOwner) => (o.owner != owner), s.owners)
{}

lemma registerSource_ensures(s: SourceRegistry, owner: string, canonical: string, aliases: seq<string>, kind: SourceKind, passive: PassiveValue, identity: seq<string>, hasIdentity: bool, worldKeys: seq<string>, hasWorldKeys: bool, kindPresent: bool, passivePresent: bool, identityPresent: bool, worldKeysPresent: bool)
  ensures (inv(s) ==> canRegisterSource(s, owner, canonical, aliases, kind, passive, identity, hasIdentity, worldKeys, hasWorldKeys, kindPresent, passivePresent, identityPresent, worldKeysPresent) ==> alwaysSourceOwnersUnique(registerSource(s, owner, canonical, aliases, kind, passive, identity, hasIdentity, worldKeys, hasWorldKeys, kindPresent, passivePresent, identityPresent, worldKeysPresent)))
  ensures (inv(s) ==> canRegisterSource(s, owner, canonical, aliases, kind, passive, identity, hasIdentity, worldKeys, hasWorldKeys, kindPresent, passivePresent, identityPresent, worldKeysPresent) ==> alwaysSourceCachesMatchOwners(registerSource(s, owner, canonical, aliases, kind, passive, identity, hasIdentity, worldKeys, hasWorldKeys, kindPresent, passivePresent, identityPresent, worldKeysPresent)))
  ensures (inv(s) ==> canRegisterSource(s, owner, canonical, aliases, kind, passive, identity, hasIdentity, worldKeys, hasWorldKeys, kindPresent, passivePresent, identityPresent, worldKeysPresent) ==> alwaysAliasesUnique(registerSource(s, owner, canonical, aliases, kind, passive, identity, hasIdentity, worldKeys, hasWorldKeys, kindPresent, passivePresent, identityPresent, worldKeysPresent)))
{
  if inv(s) && canRegisterSource(s, owner, canonical, aliases, kind, passive, identity, hasIdentity, worldKeys, hasWorldKeys, kindPresent, passivePresent, identityPresent, worldKeysPresent) {
    var after := registerSource(s, owner, canonical, aliases, kind, passive, identity, hasIdentity, worldKeys, hasWorldKeys, kindPresent, passivePresent, identityPresent, worldKeysPresent);
    SourceOwnerFilters(s); SourceOwnerFilters(after); SourceOwnerAbsent(s, owner);
    SourceAliasFilters([]); RebuildSourceAliases([], after.merged);
    if ownerEntry(s, owner).owner == "" {
      var added := after.owners[|s.owners|];
      forall o | o in after.owners
        ensures |ProofLib.Filter((other: SourceOwner) => (other.owner == o.owner), after.owners)| == 1
      {
        ProofLib.FilterAppend((other: SourceOwner) => (other.owner == o.owner), s.owners, added);
        if o.owner == owner { ProofLib.FilterNone((other: SourceOwner) => (other.owner == o.owner), s.owners); }
        else { assert o in s.owners; }
      }
    } else {
      forall o | o in after.owners
        ensures |ProofLib.Filter((other: SourceOwner) => (other.owner == o.owner), after.owners)| == 1
      {
        var i :| 0 <= i < |after.owners| && after.owners[i] == o;
        ProofLib.FilterLengthPointwise((other: SourceOwner) => (other.owner == o.owner), (other: SourceOwner) => (other.owner == o.owner), s.owners, after.owners);
      }
    }
  }
}

lemma removeSourceOwner_ensures(s: SourceRegistry, owner: string)
  ensures (inv(s) ==> canRemoveSourceOwner(s, owner) ==> alwaysSourceOwnersUnique(removeSourceOwner(s, owner)))
  ensures (inv(s) ==> canRemoveSourceOwner(s, owner) ==> alwaysSourceCachesMatchOwners(removeSourceOwner(s, owner)))
  ensures (inv(s) ==> canRemoveSourceOwner(s, owner) ==> alwaysAliasesUnique(removeSourceOwner(s, owner)))
{
  if inv(s) && canRemoveSourceOwner(s, owner) {
    var after := removeSourceOwner(s, owner);
    RemoveSourceOwnerParts(s, owner);
    SourceOwnerFilters(s); SourceOwnerFilters(after);
    SourceAliasFilters([]); RebuildSourceAliases([], after.merged);
    ProofLib.FilterSubset((o: SourceOwner) => (o.owner != owner), s.owners);
    forall o | o in after.owners
      ensures |ProofLib.Filter((other: SourceOwner) => (other.owner == o.owner), after.owners)| == 1
    {
      assert o in s.owners;
      ProofLib.FilterOfFilterShorter((o: SourceOwner) => (o.owner != owner), (other: SourceOwner) => (other.owner == o.owner), s.owners);
      ProofLib.FilterMember((other: SourceOwner) => (other.owner == o.owner), after.owners, o);
    }
  }
}
