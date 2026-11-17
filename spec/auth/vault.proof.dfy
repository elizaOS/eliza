lemma AckFilter(before: Vault, via: string, after: Vault)
  ensures stepAcknowledgedWriteIsDurable(before, via, after) == !((exists a' :: a' in ProofLib.Filter((a: VaultEntry) => !((a in before.acked)), after.acked) && !((((via == "readBack") && (a' in before.pending)) && (a' in after.entries)))))
  ensures forall x :: x in ProofLib.Filter((a: VaultEntry) => !((a in before.acked)), after.acked) <==> x in after.acked && x !in before.acked
{
  forall x
    ensures x in ProofLib.Filter((a: VaultEntry) => !((a in before.acked)), after.acked) <==> x in after.acked && x !in before.acked
  {
    ProofLib.FilterMember((a: VaultEntry) => !((a in before.acked)), after.acked, x);
  }
}

lemma SlotFilter(s: Vault)
  ensures alwaysOneEntryPerSlot(s) == !((exists e :: e in s.entries && !((|ProofLib.Filter((o: VaultEntry) => ((o.profile == e.profile) && (o.name == e.name)), s.entries)| == 1))))
{
}

lemma OtherFilter(before: Vault, via: string, after: Vault)
  ensures stepOtherProfilesUntouched(before, via, after) == (ProofLib.Filter((e: VaultEntry) => (e.profile != after.lastProfile), after.entries) == ProofLib.Filter((e: VaultEntry) => (e.profile != after.lastProfile), before.entries))
{
}

lemma RestorableFilter(s: Vault)
  ensures alwaysPreviousEntriesRestorable(s) == (!((exists p :: p in s.pending && !((ProofLib.Filter((e: VaultEntry) => (e.profile != p.profile), s.previous) == ProofLib.Filter((e: VaultEntry) => (e.profile != p.profile), s.entries))))) && (!((|s.pending| > 0)) || (!((exists e :: e in s.previous && !((|ProofLib.Filter((o: VaultEntry) => ((o.profile == e.profile) && (o.name == e.name)), s.previous)| == 1)))) && (exists e :: e in s.previous && ((e.profile == "default") && (e.name == "agent-key"))))))
{
}

lemma GenerationFilter(before: Vault, via: string, after: Vault)
  ensures stepGenerationFollowsACleanEmptyRead(before, via, after) == (!((via == "generateSecret")) || !((exists g' :: g' in ProofLib.Filter((g: SlotName) => !((g in before.generated)), after.generated) && !((((g' in before.checkedAbsent) && !((g' in before.readFailures))) && !(hasEntry(before, g'.profile, g'.name)))))))
  ensures forall x :: x in ProofLib.Filter((g: SlotName) => !((g in before.generated)), after.generated) <==> x in after.generated && x !in before.generated
{
  forall x
    ensures x in ProofLib.Filter((g: SlotName) => !((g in before.generated)), after.generated) <==> x in after.generated && x !in before.generated
  {
    ProofLib.FilterMember((g: SlotName) => !((g in before.generated)), after.generated, x);
  }
}

lemma SameOutside(q: VaultEntry -> bool, xs: seq<VaultEntry>, ys: seq<VaultEntry>)
  requires |xs| == |ys|
  requires forall i :: 0 <= i < |xs| ==> q(xs[i]) == q(ys[i]) && (q(xs[i]) ==> xs[i] == ys[i])
  ensures ProofLib.Filter(q, xs) == ProofLib.Filter(q, ys)
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(q, xs);
    ProofLib.FilterNil(q, ys);
  } else {
    ProofLib.FilterCons(q, xs);
    ProofLib.FilterCons(q, ys);
    SameOutside(q, xs[1..], ys[1..]);
  }
}

lemma AppendOutside(q: VaultEntry -> bool, xs: seq<VaultEntry>, x: VaultEntry)
  requires !q(x)
  ensures ProofLib.Filter(q, xs + [x]) == ProofLib.Filter(q, xs)
{
  ProofLib.FilterAppend(q, xs, x);
}

lemma OnePerSlotAppend(entries: seq<VaultEntry>, x: VaultEntry)
  requires forall e :: e in entries ==> |ProofLib.Filter((o: VaultEntry) => ((o.profile == e.profile) && (o.name == e.name)), entries)| == 1
  requires forall e :: e in entries ==> !(e.profile == x.profile && e.name == x.name)
  ensures forall e :: e in entries + [x] ==> |ProofLib.Filter((o: VaultEntry) => ((o.profile == e.profile) && (o.name == e.name)), entries + [x])| == 1
{
  forall e | e in entries + [x]
    ensures |ProofLib.Filter((o: VaultEntry) => ((o.profile == e.profile) && (o.name == e.name)), entries + [x])| == 1
  {
    ProofLib.FilterAppend((o: VaultEntry) => ((o.profile == e.profile) && (o.name == e.name)), entries, x);
    if e == x {
      ProofLib.FilterNone((o: VaultEntry) => ((o.profile == e.profile) && (o.name == e.name)), entries);
    }
  }
}

lemma OnePerSlotMap(entries: seq<VaultEntry>, mapped: seq<VaultEntry>)
  requires |entries| == |mapped|
  requires forall i :: 0 <= i < |entries| ==> mapped[i].profile == entries[i].profile && mapped[i].name == entries[i].name
  requires forall e :: e in entries ==> |ProofLib.Filter((o: VaultEntry) => ((o.profile == e.profile) && (o.name == e.name)), entries)| == 1
  ensures forall e :: e in mapped ==> |ProofLib.Filter((o: VaultEntry) => ((o.profile == e.profile) && (o.name == e.name)), mapped)| == 1
{
  forall e | e in mapped
    ensures |ProofLib.Filter((o: VaultEntry) => ((o.profile == e.profile) && (o.name == e.name)), mapped)| == 1
  {
    var i :| 0 <= i < |mapped| && mapped[i] == e;
    var old_ := entries[i];
    assert old_ in entries;
    ProofLib.FilterLengthPointwise((o: VaultEntry) => ((o.profile == e.profile) && (o.name == e.name)), (o: VaultEntry) => ((o.profile == old_.profile) && (o.name == old_.name)), mapped, entries);
    ProofLib.FilterSamePredicate((o: VaultEntry) => ((o.profile == old_.profile) && (o.name == old_.name)), (o: VaultEntry) => ((o.profile == e.profile) && (o.name == e.name)), entries);
  }
}

lemma unlock_ensures(s: Vault, source: MasterKeySource)
  ensures (inv(s) ==> canUnlock(s, source) ==> alwaysNoPlaintextMasterKey(unlock(s, source)))
  ensures (inv(s) ==> canUnlock(s, source) ==> alwaysExistingKeyNeverRegenerated(unlock(s, source)))
  ensures (inv(s) ==> canUnlock(s, source) ==> alwaysAgentKeyStored(unlock(s, source)))
  ensures (inv(s) ==> canUnlock(s, source) ==> alwaysPreviousEntriesRestorable(unlock(s, source)))
  ensures (inv(s) ==> canUnlock(s, source) ==> alwaysPendingWriteIsOnDisk(unlock(s, source)))
  ensures (inv(s) ==> canUnlock(s, source) ==> alwaysOneEntryPerSlot(unlock(s, source)))
  ensures (inv(s) ==> canUnlock(s, source) ==> stepGenerationFollowsACleanEmptyRead(s, "unlock", unlock(s, source)))
  ensures (inv(s) ==> canUnlock(s, source) ==> stepAcknowledgedWriteIsDurable(s, "unlock", unlock(s, source)))
  ensures (inv(s) ==> canUnlock(s, source) ==> stepOtherProfilesUntouched(s, "unlock", unlock(s, source)))
{
  AckFilter(s, "unlock", unlock(s, source));
}

lemma generateSecret_ensures(s: Vault, profile: string, name: string, value: int)
  ensures (inv(s) ==> canGenerateSecret(s, profile, name, value) ==> alwaysNoPlaintextMasterKey(generateSecret(s, profile, name, value)))
  ensures (inv(s) ==> canGenerateSecret(s, profile, name, value) ==> alwaysExistingKeyNeverRegenerated(generateSecret(s, profile, name, value)))
  ensures (inv(s) ==> canGenerateSecret(s, profile, name, value) ==> alwaysAgentKeyStored(generateSecret(s, profile, name, value)))
  ensures (inv(s) ==> canGenerateSecret(s, profile, name, value) ==> alwaysPreviousEntriesRestorable(generateSecret(s, profile, name, value)))
  ensures (inv(s) ==> canGenerateSecret(s, profile, name, value) ==> alwaysPendingWriteIsOnDisk(generateSecret(s, profile, name, value)))
  ensures (inv(s) ==> canGenerateSecret(s, profile, name, value) ==> alwaysOneEntryPerSlot(generateSecret(s, profile, name, value)))
  ensures (inv(s) ==> canGenerateSecret(s, profile, name, value) ==> stepGenerationFollowsACleanEmptyRead(s, "generateSecret", generateSecret(s, profile, name, value)))
  ensures (inv(s) ==> canGenerateSecret(s, profile, name, value) ==> stepAcknowledgedWriteIsDurable(s, "generateSecret", generateSecret(s, profile, name, value)))
  ensures (inv(s) ==> canGenerateSecret(s, profile, name, value) ==> stepOtherProfilesUntouched(s, "generateSecret", generateSecret(s, profile, name, value)))
{
  if inv(s) && canGenerateSecret(s, profile, name, value) {
    var after := generateSecret(s, profile, name, value);
    var added := VaultEntry(profile, name, value);
    AckFilter(s, "generateSecret", after);
    GenerationFilter(s, "generateSecret", after);
    SlotFilter(s);
    SlotFilter(after);
    OnePerSlotAppend(s.entries, added);
    OtherFilter(s, "generateSecret", after);
    AppendOutside((e: VaultEntry) => (e.profile != after.lastProfile), s.entries, added);
    RestorableFilter(after);
    AppendOutside((e: VaultEntry) => (e.profile != added.profile), s.entries, added);
    assert forall p :: p in after.pending ==> p == added;
  }
}

lemma readSecret_ensures(s: Vault, profile: string, name: string, fails: bool)
  ensures (inv(s) ==> canReadSecret(s, profile, name, fails) ==> alwaysNoPlaintextMasterKey(readSecret(s, profile, name, fails)))
  ensures (inv(s) ==> canReadSecret(s, profile, name, fails) ==> alwaysExistingKeyNeverRegenerated(readSecret(s, profile, name, fails)))
  ensures (inv(s) ==> canReadSecret(s, profile, name, fails) ==> alwaysAgentKeyStored(readSecret(s, profile, name, fails)))
  ensures (inv(s) ==> canReadSecret(s, profile, name, fails) ==> alwaysPreviousEntriesRestorable(readSecret(s, profile, name, fails)))
  ensures (inv(s) ==> canReadSecret(s, profile, name, fails) ==> alwaysPendingWriteIsOnDisk(readSecret(s, profile, name, fails)))
  ensures (inv(s) ==> canReadSecret(s, profile, name, fails) ==> alwaysOneEntryPerSlot(readSecret(s, profile, name, fails)))
  ensures (inv(s) ==> canReadSecret(s, profile, name, fails) ==> stepGenerationFollowsACleanEmptyRead(s, "readSecret", readSecret(s, profile, name, fails)))
  ensures (inv(s) ==> canReadSecret(s, profile, name, fails) ==> stepAcknowledgedWriteIsDurable(s, "readSecret", readSecret(s, profile, name, fails)))
  ensures (inv(s) ==> canReadSecret(s, profile, name, fails) ==> stepOtherProfilesUntouched(s, "readSecret", readSecret(s, profile, name, fails)))
{
  AckFilter(s, "readSecret", readSecret(s, profile, name, fails));
}

lemma writeSecret_ensures(s: Vault, profile: string, name: string, value: int)
  ensures (inv(s) ==> canWriteSecret(s, profile, name, value) ==> alwaysNoPlaintextMasterKey(writeSecret(s, profile, name, value)))
  ensures (inv(s) ==> canWriteSecret(s, profile, name, value) ==> alwaysExistingKeyNeverRegenerated(writeSecret(s, profile, name, value)))
  ensures (inv(s) ==> canWriteSecret(s, profile, name, value) ==> alwaysAgentKeyStored(writeSecret(s, profile, name, value)))
  ensures (inv(s) ==> canWriteSecret(s, profile, name, value) ==> alwaysPreviousEntriesRestorable(writeSecret(s, profile, name, value)))
  ensures (inv(s) ==> canWriteSecret(s, profile, name, value) ==> alwaysPendingWriteIsOnDisk(writeSecret(s, profile, name, value)))
  ensures (inv(s) ==> canWriteSecret(s, profile, name, value) ==> alwaysOneEntryPerSlot(writeSecret(s, profile, name, value)))
  ensures (inv(s) ==> canWriteSecret(s, profile, name, value) ==> stepGenerationFollowsACleanEmptyRead(s, "writeSecret", writeSecret(s, profile, name, value)))
  ensures (inv(s) ==> canWriteSecret(s, profile, name, value) ==> stepAcknowledgedWriteIsDurable(s, "writeSecret", writeSecret(s, profile, name, value)))
  ensures (inv(s) ==> canWriteSecret(s, profile, name, value) ==> stepOtherProfilesUntouched(s, "writeSecret", writeSecret(s, profile, name, value)))
{
  if inv(s) && canWriteSecret(s, profile, name, value) {
    var after := writeSecret(s, profile, name, value);
    var written := VaultEntry(profile, name, value);
    AckFilter(s, "writeSecret", after);
    SlotFilter(s);
    SlotFilter(after);
    assert |after.entries| == |s.entries|;
    OnePerSlotMap(s.entries, after.entries);
    var k :| k in s.entries && k.profile == profile && k.name == name;
    var i :| 0 <= i < |s.entries| && s.entries[i] == k;
    assert after.entries[i] == written;
    var a :| a in s.entries && a.profile == "default" && a.name == "agent-key";
    var j :| 0 <= j < |s.entries| && s.entries[j] == a;
    assert after.entries[j] in after.entries;
    OtherFilter(s, "writeSecret", after);
    SameOutside((e: VaultEntry) => (e.profile != after.lastProfile), after.entries, s.entries);
    RestorableFilter(after);
    SameOutside((e: VaultEntry) => (e.profile != written.profile), s.entries, after.entries);
    assert forall p :: p in after.pending ==> p == written;
  }
}

lemma readBack_ensures(s: Vault, matches: bool)
  ensures (inv(s) ==> canReadBack(s, matches) ==> alwaysNoPlaintextMasterKey(readBack(s, matches)))
  ensures (inv(s) ==> canReadBack(s, matches) ==> alwaysExistingKeyNeverRegenerated(readBack(s, matches)))
  ensures (inv(s) ==> canReadBack(s, matches) ==> alwaysAgentKeyStored(readBack(s, matches)))
  ensures (inv(s) ==> canReadBack(s, matches) ==> alwaysPreviousEntriesRestorable(readBack(s, matches)))
  ensures (inv(s) ==> canReadBack(s, matches) ==> alwaysPendingWriteIsOnDisk(readBack(s, matches)))
  ensures (inv(s) ==> canReadBack(s, matches) ==> alwaysOneEntryPerSlot(readBack(s, matches)))
  ensures (inv(s) ==> canReadBack(s, matches) ==> stepGenerationFollowsACleanEmptyRead(s, "readBack", readBack(s, matches)))
  ensures (inv(s) ==> canReadBack(s, matches) ==> stepAcknowledgedWriteIsDurable(s, "readBack", readBack(s, matches)))
  ensures (inv(s) ==> canReadBack(s, matches) ==> stepOtherProfilesUntouched(s, "readBack", readBack(s, matches)))
{
  if inv(s) && canReadBack(s, matches) {
    var after := readBack(s, matches);
    AckFilter(s, "readBack", after);
    SlotFilter(after);
    RestorableFilter(s);
    OtherFilter(s, "readBack", after);
    if !matches {
      var p := s.pending[0];
      assert p in s.pending;
      ProofLib.FilterSamePredicate((e: VaultEntry) => (e.profile != after.lastProfile), (e: VaultEntry) => (e.profile != p.profile), s.previous);
      ProofLib.FilterSamePredicate((e: VaultEntry) => (e.profile != after.lastProfile), (e: VaultEntry) => (e.profile != p.profile), s.entries);
    }
  }
}

lemma rollbackFails_ensures(s: Vault)
  ensures (inv(s) ==> canRollbackFails(s) ==> alwaysNoPlaintextMasterKey(rollbackFails(s)))
  ensures (inv(s) ==> canRollbackFails(s) ==> alwaysExistingKeyNeverRegenerated(rollbackFails(s)))
  ensures (inv(s) ==> canRollbackFails(s) ==> alwaysAgentKeyStored(rollbackFails(s)))
  ensures (inv(s) ==> canRollbackFails(s) ==> alwaysPreviousEntriesRestorable(rollbackFails(s)))
  ensures (inv(s) ==> canRollbackFails(s) ==> alwaysPendingWriteIsOnDisk(rollbackFails(s)))
  ensures (inv(s) ==> canRollbackFails(s) ==> alwaysOneEntryPerSlot(rollbackFails(s)))
  ensures (inv(s) ==> canRollbackFails(s) ==> stepGenerationFollowsACleanEmptyRead(s, "rollbackFails", rollbackFails(s)))
  ensures (inv(s) ==> canRollbackFails(s) ==> stepAcknowledgedWriteIsDurable(s, "rollbackFails", rollbackFails(s)))
  ensures (inv(s) ==> canRollbackFails(s) ==> stepOtherProfilesUntouched(s, "rollbackFails", rollbackFails(s)))
{
  AckFilter(s, "rollbackFails", rollbackFails(s));
}

lemma initialHolds_ensures()
  ensures inv(initialHolds())
{
  var s := initialHolds();
  SlotFilter(s);
  RestorableFilter(s);
  var e := s.entries[0];
  ProofLib.FilterOne((o: VaultEntry) => ((o.profile == e.profile) && (o.name == e.name)), s.entries, 0);
  assert forall x :: x in s.entries ==> x == e;
  assert e in s.entries;
}
