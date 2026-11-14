lemma SharedSecretLookup(s: Secrets,row: SecretEntry)
  requires alwaysSecretMapsAreBijective(s) && row in s.entries
  ensures |ProofLib.Filter((entry: SecretEntry) => entry.placeholder == row.placeholder,s.entries)| == 1
  ensures ProofLib.Filter((entry: SecretEntry) => entry.placeholder == row.placeholder,s.entries)[0] == row
{
  ProofLib.FilterMember((entry: SecretEntry) => entry.placeholder == row.placeholder,s.entries,row);
}

lemma SharedSecretAppend(s: Secrets,t: Secrets,newEntry: SecretEntry)
  requires alwaysSecretMapsAreBijective(s) && s.nonce == t.nonce && newEntry.nonce == s.nonce
  requires t.entries == s.entries + [newEntry]
  requires forall row :: row in s.entries ==> row.value != newEntry.value && row.placeholder != newEntry.placeholder
  ensures alwaysSecretMapsAreBijective(t)
{
  forall row | row in t.entries
    ensures row.nonce == t.nonce && |ProofLib.Filter((other: SecretEntry) => other.value == row.value,t.entries)| == 1 &&
      |ProofLib.Filter((other: SecretEntry) => other.placeholder == row.placeholder,t.entries)| == 1
  {
    if row == newEntry {
      ProofLib.FilterOne((other: SecretEntry) => other.value == row.value,t.entries,|s.entries|);
      ProofLib.FilterOne((other: SecretEntry) => other.placeholder == row.placeholder,t.entries,|s.entries|);
    } else {
      assert row in s.entries;
      ProofLib.FilterAppend((other: SecretEntry) => other.value == row.value,s.entries,newEntry);
      ProofLib.FilterAppend((other: SecretEntry) => other.placeholder == row.placeholder,s.entries,newEntry);
    }
  }
}

lemma learn_ensures(s: Secrets, source: SecretText, placeholder: string, userReadable: bool, replyProtected: bool)
  ensures (inv(s) ==> canLearn(s, source, placeholder, userReadable, replyProtected) ==> alwaysSecretMapsAreBijective(learn(s, source, placeholder, userReadable, replyProtected)))
  ensures (inv(s) ==> canLearn(s, source, placeholder, userReadable, replyProtected) ==> alwaysUnstartedSessionHasNoEntries(learn(s, source, placeholder, userReadable, replyProtected)))
  ensures (inv(s) ==> canLearn(s, source, placeholder, userReadable, replyProtected) ==> alwaysReplacementCacheComesFromValues(learn(s, source, placeholder, userReadable, replyProtected)))
{
  if inv(s) && canLearn(s,source,placeholder,userReadable,replyProtected) {
    var t := learn(s,source,placeholder,userReadable,replyProtected);
    var row := SecretEntry(source.value,source.characters,placeholder,s.nonce,userReadable,replyProtected);
    SharedSecretAppend(s,t,row);
  }
}

lemma cacheReplacement_ensures(s: Secrets, value: string)
  ensures (inv(s) ==> canCacheReplacement(s, value) ==> alwaysSecretMapsAreBijective(cacheReplacement(s, value)))
  ensures (inv(s) ==> canCacheReplacement(s, value) ==> alwaysUnstartedSessionHasNoEntries(cacheReplacement(s, value)))
  ensures (inv(s) ==> canCacheReplacement(s, value) ==> alwaysReplacementCacheComesFromValues(cacheReplacement(s, value)))
{
  if inv(s) && canCacheReplacement(s,value) {
    var t := cacheReplacement(s,value);
    ProofLib.FilterSubset((set_x: string) => !(set_x in s.replacementCached),[value]);
    forall v | v in t.replacementCached ensures exists row :: row in t.entries && row.value == v
    {
      if v !in s.replacementCached {
        ProofLib.FilterMember((set_x: string) => !(set_x in s.replacementCached),[value],v);
        assert v == value;
      }
    }
  }
}

lemma lawProtectedReplyIsRedacted_ensures(s: Secrets, placeholder: string)
  ensures (lawProtectedReplyIsRedacted(s, placeholder) == true)
{
  if alwaysSecretMapsAreBijective(s) && (exists row :: row in s.entries && row.placeholder == placeholder && row.replyProtected) {
    var row :| row in s.entries && row.placeholder == placeholder && row.replyProtected;
    SharedSecretLookup(s,row);
  }
}

lemma lawOverlappingProtectedReplyIsRedacted_ensures(s: Secrets, placeholder: string)
  ensures (lawOverlappingProtectedReplyIsRedacted(s, placeholder) == true)
{
  if alwaysSecretMapsAreBijective(s) && (exists row :: row in s.entries && row.placeholder == placeholder && (exists protectedText :: protectedText in s.protectedTexts && overlaps(row.characters,protectedText.characters))) {
    var row :| row in s.entries && row.placeholder == placeholder && (exists protectedText :: protectedText in s.protectedTexts && overlaps(row.characters,protectedText.characters));
    SharedSecretLookup(s,row);
  }
}
