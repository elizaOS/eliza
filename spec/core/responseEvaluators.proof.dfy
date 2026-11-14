lemma ResponseEvaluatorNameCounts(s: ResponseEvaluators)
  ensures alwaysExactNamesUnique(s) ==
    (forall entry :: entry in s.entries ==> |ProofLib.Filter((other: ResponseEvaluator) => other.name == entry.name, s.entries)| == 1)
{}

lemma unregister_ensures(s: ResponseEvaluators, normalizedName: string)
  ensures (inv(s) ==> alwaysExactNamesUnique(unregister(s, normalizedName)))
  ensures (inv(s) ==> stepRegistrationKeepsPriorNames(s, "unregister", unregister(s, normalizedName)))
{
  if inv(s) && normalizedName != "" {
    var after := unregister(s, normalizedName);
    var keep := (entry: ResponseEvaluator) => entry.name != normalizedName;
    assert after.entries == ProofLib.Filter(keep, s.entries);
    ResponseEvaluatorNameCounts(s);
    ResponseEvaluatorNameCounts(after);
    forall entry | entry in after.entries
      ensures |ProofLib.Filter((other: ResponseEvaluator) => other.name == entry.name, after.entries)| == 1
    {
      var sameName := (other: ResponseEvaluator) => other.name == entry.name;
      ProofLib.FilterMember(keep, s.entries, entry);
      ProofLib.FilterOfFilterShorter(keep, sameName, s.entries);
      ProofLib.FilterMember(sameName, after.entries, entry);
    }
  }
}

lemma register_ensures(s: ResponseEvaluators, name: string, reference: int)
  ensures (inv(s) ==> canRegister(s, name, reference) ==> alwaysExactNamesUnique(register(s, name, reference)))
  ensures (inv(s) ==> canRegister(s, name, reference) ==> stepRegistrationKeepsPriorNames(s, "register", register(s, name, reference)))
{
  if inv(s) && canRegister(s, name, reference) && !(exists entry :: entry in s.entries && entry.name == name) {
    var after := register(s, name, reference);
    var added := ResponseEvaluator(name, reference);
    assert after.entries == s.entries + [added];
    ResponseEvaluatorNameCounts(s);
    ResponseEvaluatorNameCounts(after);
    forall entry | entry in after.entries
      ensures |ProofLib.Filter((other: ResponseEvaluator) => other.name == entry.name, after.entries)| == 1
    {
      var sameName := (other: ResponseEvaluator) => other.name == entry.name;
      ProofLib.FilterAppend(sameName, s.entries, added);
      if entry == added {
        ProofLib.FilterNone(sameName, s.entries);
      } else {
        assert entry in s.entries;
        assert entry.name != name;
      }
    }
  }
}
