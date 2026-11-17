lemma OneValueFilter(s: Secrets)
  ensures alwaysOneValuePerName(s) == !((exists n :: n in s.names && !(((n != "") && (|ProofLib.Filter((m: string) => (m == n), s.names)| == 1)))))
{
}

lemma setSecret_ensures(s: Secrets, actor: int, name: string, value: string)
  ensures (inv(s) ==> canSetSecret(s, actor, name, value) ==> alwaysOneValuePerName(setSecret(s, actor, name, value)))
  ensures (inv(s) ==> canSetSecret(s, actor, name, value) ==> alwaysListingShowsOnlyNames(setSecret(s, actor, name, value)))
  ensures (inv(s) ==> canSetSecret(s, actor, name, value) ==> alwaysRetiredActivatorHasNoTimer(setSecret(s, actor, name, value)))
  ensures (inv(s) ==> canSetSecret(s, actor, name, value) ==> alwaysNoCallbackAfterStop(setSecret(s, actor, name, value)))
  ensures (inv(s) ==> canSetSecret(s, actor, name, value) ==> alwaysActivationFollowsCheckAndPoll(setSecret(s, actor, name, value)))
  ensures (inv(s) ==> canSetSecret(s, actor, name, value) ==> alwaysStoppedReleasesEverything(setSecret(s, actor, name, value)))
  ensures (inv(s) ==> canSetSecret(s, actor, name, value) ==> stepNamesChangeOnlyBySecretActions(s, "setSecret", setSecret(s, actor, name, value)))
  ensures (inv(s) ==> canSetSecret(s, actor, name, value) ==> stepListingIsExactlyTheHeldNames(s, "setSecret", setSecret(s, actor, name, value)))
{
  if inv(s) && canSetSecret(s, actor, name, value) && !(name in s.names) {
    var after := setSecret(s, actor, name, value);
    OneValueFilter(s);
    OneValueFilter(after);
    forall n | n in after.names ensures n != "" && |ProofLib.Filter((m: string) => (m == n), after.names)| == 1 {
      ProofLib.FilterAppend((m: string) => (m == n), s.names, name);
      if n == name {
        ProofLib.FilterNone((m: string) => (m == n), s.names);
      }
    }
  }
}

lemma deleteSecret_ensures(s: Secrets, actor: int, name: string)
  ensures (inv(s) ==> canDeleteSecret(s, actor, name) ==> alwaysOneValuePerName(deleteSecret(s, actor, name)))
  ensures (inv(s) ==> canDeleteSecret(s, actor, name) ==> alwaysListingShowsOnlyNames(deleteSecret(s, actor, name)))
  ensures (inv(s) ==> canDeleteSecret(s, actor, name) ==> alwaysRetiredActivatorHasNoTimer(deleteSecret(s, actor, name)))
  ensures (inv(s) ==> canDeleteSecret(s, actor, name) ==> alwaysNoCallbackAfterStop(deleteSecret(s, actor, name)))
  ensures (inv(s) ==> canDeleteSecret(s, actor, name) ==> alwaysActivationFollowsCheckAndPoll(deleteSecret(s, actor, name)))
  ensures (inv(s) ==> canDeleteSecret(s, actor, name) ==> alwaysStoppedReleasesEverything(deleteSecret(s, actor, name)))
  ensures (inv(s) ==> canDeleteSecret(s, actor, name) ==> stepNamesChangeOnlyBySecretActions(s, "deleteSecret", deleteSecret(s, actor, name)))
  ensures (inv(s) ==> canDeleteSecret(s, actor, name) ==> stepListingIsExactlyTheHeldNames(s, "deleteSecret", deleteSecret(s, actor, name)))
{
  if inv(s) && canDeleteSecret(s, actor, name) {
    var after := deleteSecret(s, actor, name);
    var kept := (n: string) => (n != name);
    assert after.names == ProofLib.Filter(kept, s.names);
    OneValueFilter(s);
    OneValueFilter(after);
    forall n | n in after.names ensures n != "" && |ProofLib.Filter((m: string) => (m == n), after.names)| == 1 {
      ProofLib.FilterMember(kept, s.names, n);
      ProofLib.FilterMember((m: string) => (m == n), after.names, n);
      ProofLib.FilterOfFilterShorter(kept, (m: string) => (m == n), s.names);
    }
  }
}

lemma listSecrets_ensures(s: Secrets)
  ensures (inv(s) ==> alwaysOneValuePerName(listSecrets(s)))
  ensures (inv(s) ==> alwaysListingShowsOnlyNames(listSecrets(s)))
  ensures (inv(s) ==> alwaysRetiredActivatorHasNoTimer(listSecrets(s)))
  ensures (inv(s) ==> alwaysNoCallbackAfterStop(listSecrets(s)))
  ensures (inv(s) ==> alwaysActivationFollowsCheckAndPoll(listSecrets(s)))
  ensures (inv(s) ==> alwaysStoppedReleasesEverything(listSecrets(s)))
  ensures (inv(s) ==> stepNamesChangeOnlyBySecretActions(s, "listSecrets", listSecrets(s)))
  ensures (inv(s) ==> stepListingIsExactlyTheHeldNames(s, "listSecrets", listSecrets(s)))
{
  if inv(s) {
    var after := listSecrets(s);
    forall e | e in after.listed ensures e.name != "" && e.mask == "****" {
      ProofLib.FoldLeftConcatMember((entries: seq<ListedSecret>, n: string) => (entries + [ListedSecret(n, declassifyMasked(heldValue(s, n)))]), (n: string) => [ListedSecret(n, declassifyMasked(heldValue(s, n)))], [], s.names, e);
      var i :| 0 <= i < |s.names| && e in [ListedSecret(s.names[i], declassifyMasked(heldValue(s, s.names[i])))];
      assert s.names[i] in s.names;
    }
  }
}

lemma pollAnswered_ensures(s: Secrets)
  ensures (inv(s) ==> canPollAnswered(s) ==> alwaysOneValuePerName(pollAnswered(s)))
  ensures (inv(s) ==> canPollAnswered(s) ==> alwaysListingShowsOnlyNames(pollAnswered(s)))
  ensures (inv(s) ==> canPollAnswered(s) ==> alwaysRetiredActivatorHasNoTimer(pollAnswered(s)))
  ensures (inv(s) ==> canPollAnswered(s) ==> alwaysNoCallbackAfterStop(pollAnswered(s)))
  ensures (inv(s) ==> canPollAnswered(s) ==> alwaysActivationFollowsCheckAndPoll(pollAnswered(s)))
  ensures (inv(s) ==> canPollAnswered(s) ==> alwaysStoppedReleasesEverything(pollAnswered(s)))
  ensures (inv(s) ==> canPollAnswered(s) ==> stepNamesChangeOnlyBySecretActions(s, "pollAnswered", pollAnswered(s)))
  ensures (inv(s) ==> canPollAnswered(s) ==> stepListingIsExactlyTheHeldNames(s, "pollAnswered", pollAnswered(s)))
{
  if inv(s) && canPollAnswered(s) {
    assert !s.registration.NotRegistered? && !s.registration.Checking?;
  }
}
