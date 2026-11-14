lemma EnvironmentFilters(s: Environment)
  ensures alwaysKeysAreUnique(s) == ((forall entry :: entry in s.processValues ==> |ProofLib.Filter((other: EnvEntry) => (other.key == entry.key), s.processValues)| == 1) && (forall entry :: entry in s.cachedValues ==> |ProofLib.Filter((other: EnvEntry) => (other.key == entry.key), s.cachedValues)| == 1))
{}

lemma EnvironmentDistinct(entries: seq<EnvEntry>)
  ensures (forall entry :: entry in entries ==> |ProofLib.Filter((other: EnvEntry) => (other.key == entry.key), entries)| == 1) <==> ProofLib.DistinctBy(entries, (entry: EnvEntry) => entry.key)
{
  if forall entry :: entry in entries ==> |ProofLib.Filter((other: EnvEntry) => (other.key == entry.key), entries)| == 1 {
    forall i, j | 0 <= i < |entries| && 0 <= j < |entries| && i != j
      ensures entries[i].key != entries[j].key
    {
      ProofLib.FilterCountOneIffUnique((other: EnvEntry) => (other.key == entries[i].key), entries, (entry: EnvEntry) => entry.key, i);
    }
  } else if ProofLib.DistinctBy(entries, (entry: EnvEntry) => entry.key) {
    forall entry | entry in entries
      ensures |ProofLib.Filter((other: EnvEntry) => (other.key == entry.key), entries)| == 1
    {
      var i :| 0 <= i < |entries| && entries[i] == entry;
      ProofLib.FilterOne((other: EnvEntry) => (other.key == entry.key), entries, i);
    }
  }
}

lemma EnvironmentReplace(entries: seq<EnvEntry>, key: string, value: EnvValue)
  requires ProofLib.DistinctBy(entries, (entry: EnvEntry) => entry.key)
  ensures ProofLib.DistinctBy(ProofLib.Filter((entry: EnvEntry) => (entry.key != key), entries) + [EnvEntry(key, value)], (entry: EnvEntry) => entry.key)
{
  var kept := ProofLib.Filter((entry: EnvEntry) => (entry.key != key), entries);
  ProofLib.FilterKeepsDistinctBy((entry: EnvEntry) => (entry.key != key), entries, (entry: EnvEntry) => entry.key);
  forall entry | entry in kept ensures entry.key != key {
    ProofLib.FilterMember((entry: EnvEntry) => (entry.key != key), entries, entry);
  }
  ProofLib.DistinctByConcat(kept, [EnvEntry(key, value)], (entry: EnvEntry) => entry.key);
}

lemma EnvironmentWriteParts(s: Environment, key: string, text: string)
  ensures setEnvironment(s, key, text).processValues == ProofLib.Filter((entry: EnvEntry) => (entry.key != key), s.processValues) + [EnvEntry(key, PresentValue(text))]
  ensures setEnvironment(s, key, text).cachedValues == ProofLib.Filter((entry: EnvEntry) => (entry.key != key), s.cachedValues)
{}

lemma EnvironmentExternalParts(s: Environment, key: string, value: EnvValue)
  ensures externalEnvironmentChange(s, key, value).processValues == ProofLib.Filter((entry: EnvEntry) => (entry.key != key), s.processValues) + [EnvEntry(key, value)]
{}

lemma setEnvironment_ensures(s: Environment, key: string, text: string)
  ensures (inv(s) ==> alwaysKeysAreUnique(setEnvironment(s, key, text)))
  ensures (inv(s) ==> stepExternalWriteLeavesCacheIntact(s, "setEnvironment", setEnvironment(s, key, text), []))
{
  if inv(s) {
    var after := setEnvironment(s, key, text);
    EnvironmentFilters(s); EnvironmentFilters(after);
    EnvironmentDistinct(s.processValues); EnvironmentDistinct(s.cachedValues);
    EnvironmentDistinct(after.processValues); EnvironmentDistinct(after.cachedValues);
    EnvironmentWriteParts(s, key, text);
    EnvironmentReplace(s.processValues, key, PresentValue(text));
    ProofLib.FilterKeepsDistinctBy((entry: EnvEntry) => (entry.key != key), s.cachedValues, (entry: EnvEntry) => entry.key);
  }
}

lemma externalEnvironmentChange_ensures(s: Environment, key: string, value: EnvValue)
  ensures (inv(s) ==> alwaysKeysAreUnique(externalEnvironmentChange(s, key, value)))
  ensures (inv(s) ==> stepExternalWriteLeavesCacheIntact(s, "externalEnvironmentChange", externalEnvironmentChange(s, key, value), []))
{
  if inv(s) {
    var after := externalEnvironmentChange(s, key, value);
    EnvironmentFilters(s); EnvironmentFilters(after);
    EnvironmentDistinct(s.processValues); EnvironmentDistinct(after.processValues);
    EnvironmentExternalParts(s, key, value);
    EnvironmentReplace(s.processValues, key, value);
  }
}

lemma readEnvironment_ensures(s: Environment, key: string, defaultValue: EnvValue)
  ensures (inv(s) ==> alwaysKeysAreUnique(readEnvironment(s, key, defaultValue).state))
  ensures (inv(s) ==> stepExternalWriteLeavesCacheIntact(s, "readEnvironment", readEnvironment(s, key, defaultValue).state, readEnvironment(s, key, defaultValue).out))
{
  if inv(s) {
    var after := readEnvironment(s, key, defaultValue).state;
    EnvironmentFilters(s); EnvironmentFilters(after);
    EnvironmentDistinct(s.cachedValues); EnvironmentDistinct(after.cachedValues);
    if !containsKey(s.cachedValues, key) {
      var cachedValue := if containsKey(s.cachedValues, key) then valueAt(s.cachedValues, key) else valueAt(s.processValues, key);
      ProofLib.DistinctByConcat(s.cachedValues, [EnvEntry(key, cachedValue)], (entry: EnvEntry) => entry.key);
    }
  }
}
