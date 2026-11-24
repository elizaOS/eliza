// A step answers with at most two effects, and a receipt is kept where it stands among them.
lemma FlowReceipts(out: seq<SignInEffect>)
  requires |out| <= 2
  ensures Std.Collections.Seq.Filter((e: SignInEffect) => isSettled(e), out) ==
    (if |out| == 0 then [] else (if isSettled(out[0]) then [out[0]] else []) + (if |out| == 2 && isSettled(out[1]) then [out[1]] else []))
{
  var p := (e: SignInEffect) => isSettled(e);
  if |out| == 0 {
    ProofLib.FilterNil(p, out);
  } else {
    ProofLib.FilterCons(p, out);
    if |out| == 1 {
      ProofLib.FilterNil(p, out[1..]);
    } else {
      ProofLib.FilterCons(p, out[1..]);
      ProofLib.FilterNil(p, out[1..][1..]);
    }
  }
}

lemma cloudAnswered_ensures(s: SignIn, attempt: int, reply: CloudReply)
  ensures (inv(s) ==> canCloudAnswered(s, attempt, reply) ==> alwaysNothingStartsWithoutARegistration(cloudAnswered(s, attempt, reply).state))
  ensures (inv(s) ==> canCloudAnswered(s, attempt, reply) ==> alwaysAttemptInAnAdmittedEnvironment(cloudAnswered(s, attempt, reply).state))
  ensures (inv(s) ==> canCloudAnswered(s, attempt, reply) ==> alwaysStepsFitTheMethod(cloudAnswered(s, attempt, reply).state))
  ensures (inv(s) ==> canCloudAnswered(s, attempt, reply) ==> alwaysOneRequestOpenWhileWaiting(cloudAnswered(s, attempt, reply).state))
  ensures (inv(s) ==> canCloudAnswered(s, attempt, reply) ==> alwaysAttemptsAreNumbered(cloudAnswered(s, attempt, reply).state))
  ensures (inv(s) ==> canCloudAnswered(s, attempt, reply) ==> alwaysExchangeHasAnAttempt(cloudAnswered(s, attempt, reply).state))
  ensures (inv(s) ==> canCloudAnswered(s, attempt, reply) ==> alwaysSignedInHasACredential(cloudAnswered(s, attempt, reply).state))
  ensures (inv(s) ==> canCloudAnswered(s, attempt, reply) ==> alwaysServerCodeOnlyUnderScopes(cloudAnswered(s, attempt, reply).state))
  ensures (inv(s) ==> canCloudAnswered(s, attempt, reply) ==> alwaysGoogleReportedOnlyWhenAsked(cloudAnswered(s, attempt, reply).state))
  ensures (inv(s) ==> canCloudAnswered(s, attempt, reply) ==> alwaysScopedPickerReportsGoogle(cloudAnswered(s, attempt, reply).state))
  ensures (inv(s) ==> canCloudAnswered(s, attempt, reply) ==> alwaysReauthenticationStaysWithTheAccount(cloudAnswered(s, attempt, reply).state))
  ensures (inv(s) ==> canCloudAnswered(s, attempt, reply) ==> stepOnlyTheOpenRequestIsSettled(s, "cloudAnswered", cloudAnswered(s, attempt, reply).state, cloudAnswered(s, attempt, reply).out))
  ensures (inv(s) ==> canCloudAnswered(s, attempt, reply) ==> stepServerCodeRedeemedAtMostOnce(s, "cloudAnswered", cloudAnswered(s, attempt, reply).state, cloudAnswered(s, attempt, reply).out))
  ensures (inv(s) ==> canCloudAnswered(s, attempt, reply) ==> stepGoogleNeverFailsSignIn(s, cloudAnswered(s, attempt, reply).state))
  ensures (inv(s) ==> canCloudAnswered(s, attempt, reply) ==> stepCancelRetiresTheSlotOrNothing(s, "cloudAnswered", cloudAnswered(s, attempt, reply).state))
  ensures (inv(s) ==> canCloudAnswered(s, attempt, reply) ==> stepSessionOnlyForTheSignedInAccount(s, "cloudAnswered", cloudAnswered(s, attempt, reply).state, cloudAnswered(s, attempt, reply).out))
{
  if inv(s) && canCloudAnswered(s, attempt, reply) {
    FlowReceipts(cloudAnswered(s, attempt, reply).out);
  }
}

lemma exchangeSettled_ensures(s: SignIn, credentialAttempt: int, key: KeyOutcome)
  ensures (inv(s) ==> canExchangeSettled(s, credentialAttempt, key) ==> alwaysNothingStartsWithoutARegistration(exchangeSettled(s, credentialAttempt, key).state))
  ensures (inv(s) ==> canExchangeSettled(s, credentialAttempt, key) ==> alwaysAttemptInAnAdmittedEnvironment(exchangeSettled(s, credentialAttempt, key).state))
  ensures (inv(s) ==> canExchangeSettled(s, credentialAttempt, key) ==> alwaysStepsFitTheMethod(exchangeSettled(s, credentialAttempt, key).state))
  ensures (inv(s) ==> canExchangeSettled(s, credentialAttempt, key) ==> alwaysOneRequestOpenWhileWaiting(exchangeSettled(s, credentialAttempt, key).state))
  ensures (inv(s) ==> canExchangeSettled(s, credentialAttempt, key) ==> alwaysAttemptsAreNumbered(exchangeSettled(s, credentialAttempt, key).state))
  ensures (inv(s) ==> canExchangeSettled(s, credentialAttempt, key) ==> alwaysExchangeHasAnAttempt(exchangeSettled(s, credentialAttempt, key).state))
  ensures (inv(s) ==> canExchangeSettled(s, credentialAttempt, key) ==> alwaysSignedInHasACredential(exchangeSettled(s, credentialAttempt, key).state))
  ensures (inv(s) ==> canExchangeSettled(s, credentialAttempt, key) ==> alwaysServerCodeOnlyUnderScopes(exchangeSettled(s, credentialAttempt, key).state))
  ensures (inv(s) ==> canExchangeSettled(s, credentialAttempt, key) ==> alwaysGoogleReportedOnlyWhenAsked(exchangeSettled(s, credentialAttempt, key).state))
  ensures (inv(s) ==> canExchangeSettled(s, credentialAttempt, key) ==> alwaysScopedPickerReportsGoogle(exchangeSettled(s, credentialAttempt, key).state))
  ensures (inv(s) ==> canExchangeSettled(s, credentialAttempt, key) ==> alwaysReauthenticationStaysWithTheAccount(exchangeSettled(s, credentialAttempt, key).state))
  ensures (inv(s) ==> canExchangeSettled(s, credentialAttempt, key) ==> stepOnlyTheOpenRequestIsSettled(s, "exchangeSettled", exchangeSettled(s, credentialAttempt, key).state, exchangeSettled(s, credentialAttempt, key).out))
  ensures (inv(s) ==> canExchangeSettled(s, credentialAttempt, key) ==> stepServerCodeRedeemedAtMostOnce(s, "exchangeSettled", exchangeSettled(s, credentialAttempt, key).state, exchangeSettled(s, credentialAttempt, key).out))
  ensures (inv(s) ==> canExchangeSettled(s, credentialAttempt, key) ==> stepGoogleNeverFailsSignIn(s, exchangeSettled(s, credentialAttempt, key).state))
  ensures (inv(s) ==> canExchangeSettled(s, credentialAttempt, key) ==> stepCancelRetiresTheSlotOrNothing(s, "exchangeSettled", exchangeSettled(s, credentialAttempt, key).state))
  ensures (inv(s) ==> canExchangeSettled(s, credentialAttempt, key) ==> stepSessionOnlyForTheSignedInAccount(s, "exchangeSettled", exchangeSettled(s, credentialAttempt, key).state, exchangeSettled(s, credentialAttempt, key).out))
{
  if inv(s) && canExchangeSettled(s, credentialAttempt, key) {
    FlowReceipts(exchangeSettled(s, credentialAttempt, key).out);
  }
}

lemma pickerAnswered_ensures(s: SignIn, attempt: int, picked: PickerResult)
  ensures (inv(s) ==> canPickerAnswered(s, attempt, picked) ==> alwaysNothingStartsWithoutARegistration(pickerAnswered(s, attempt, picked).state))
  ensures (inv(s) ==> canPickerAnswered(s, attempt, picked) ==> alwaysAttemptInAnAdmittedEnvironment(pickerAnswered(s, attempt, picked).state))
  ensures (inv(s) ==> canPickerAnswered(s, attempt, picked) ==> alwaysStepsFitTheMethod(pickerAnswered(s, attempt, picked).state))
  ensures (inv(s) ==> canPickerAnswered(s, attempt, picked) ==> alwaysOneRequestOpenWhileWaiting(pickerAnswered(s, attempt, picked).state))
  ensures (inv(s) ==> canPickerAnswered(s, attempt, picked) ==> alwaysAttemptsAreNumbered(pickerAnswered(s, attempt, picked).state))
  ensures (inv(s) ==> canPickerAnswered(s, attempt, picked) ==> alwaysExchangeHasAnAttempt(pickerAnswered(s, attempt, picked).state))
  ensures (inv(s) ==> canPickerAnswered(s, attempt, picked) ==> alwaysSignedInHasACredential(pickerAnswered(s, attempt, picked).state))
  ensures (inv(s) ==> canPickerAnswered(s, attempt, picked) ==> alwaysServerCodeOnlyUnderScopes(pickerAnswered(s, attempt, picked).state))
  ensures (inv(s) ==> canPickerAnswered(s, attempt, picked) ==> alwaysGoogleReportedOnlyWhenAsked(pickerAnswered(s, attempt, picked).state))
  ensures (inv(s) ==> canPickerAnswered(s, attempt, picked) ==> alwaysScopedPickerReportsGoogle(pickerAnswered(s, attempt, picked).state))
  ensures (inv(s) ==> canPickerAnswered(s, attempt, picked) ==> alwaysReauthenticationStaysWithTheAccount(pickerAnswered(s, attempt, picked).state))
  ensures (inv(s) ==> canPickerAnswered(s, attempt, picked) ==> stepOnlyTheOpenRequestIsSettled(s, "pickerAnswered", pickerAnswered(s, attempt, picked).state, pickerAnswered(s, attempt, picked).out))
  ensures (inv(s) ==> canPickerAnswered(s, attempt, picked) ==> stepServerCodeRedeemedAtMostOnce(s, "pickerAnswered", pickerAnswered(s, attempt, picked).state, pickerAnswered(s, attempt, picked).out))
  ensures (inv(s) ==> canPickerAnswered(s, attempt, picked) ==> stepGoogleNeverFailsSignIn(s, pickerAnswered(s, attempt, picked).state))
  ensures (inv(s) ==> canPickerAnswered(s, attempt, picked) ==> stepCancelRetiresTheSlotOrNothing(s, "pickerAnswered", pickerAnswered(s, attempt, picked).state))
  ensures (inv(s) ==> canPickerAnswered(s, attempt, picked) ==> stepSessionOnlyForTheSignedInAccount(s, "pickerAnswered", pickerAnswered(s, attempt, picked).state, pickerAnswered(s, attempt, picked).out))
{
  if inv(s) && canPickerAnswered(s, attempt, picked) {
    FlowReceipts(pickerAnswered(s, attempt, picked).out);
  }
}

lemma googleConnected_ensures(s: SignIn, attempt: int, connected: bool)
  ensures (inv(s) ==> canGoogleConnected(s, attempt, connected) ==> alwaysNothingStartsWithoutARegistration(googleConnected(s, attempt, connected).state))
  ensures (inv(s) ==> canGoogleConnected(s, attempt, connected) ==> alwaysAttemptInAnAdmittedEnvironment(googleConnected(s, attempt, connected).state))
  ensures (inv(s) ==> canGoogleConnected(s, attempt, connected) ==> alwaysStepsFitTheMethod(googleConnected(s, attempt, connected).state))
  ensures (inv(s) ==> canGoogleConnected(s, attempt, connected) ==> alwaysOneRequestOpenWhileWaiting(googleConnected(s, attempt, connected).state))
  ensures (inv(s) ==> canGoogleConnected(s, attempt, connected) ==> alwaysAttemptsAreNumbered(googleConnected(s, attempt, connected).state))
  ensures (inv(s) ==> canGoogleConnected(s, attempt, connected) ==> alwaysExchangeHasAnAttempt(googleConnected(s, attempt, connected).state))
  ensures (inv(s) ==> canGoogleConnected(s, attempt, connected) ==> alwaysSignedInHasACredential(googleConnected(s, attempt, connected).state))
  ensures (inv(s) ==> canGoogleConnected(s, attempt, connected) ==> alwaysServerCodeOnlyUnderScopes(googleConnected(s, attempt, connected).state))
  ensures (inv(s) ==> canGoogleConnected(s, attempt, connected) ==> alwaysGoogleReportedOnlyWhenAsked(googleConnected(s, attempt, connected).state))
  ensures (inv(s) ==> canGoogleConnected(s, attempt, connected) ==> alwaysScopedPickerReportsGoogle(googleConnected(s, attempt, connected).state))
  ensures (inv(s) ==> canGoogleConnected(s, attempt, connected) ==> alwaysReauthenticationStaysWithTheAccount(googleConnected(s, attempt, connected).state))
  ensures (inv(s) ==> canGoogleConnected(s, attempt, connected) ==> stepOnlyTheOpenRequestIsSettled(s, "googleConnected", googleConnected(s, attempt, connected).state, googleConnected(s, attempt, connected).out))
  ensures (inv(s) ==> canGoogleConnected(s, attempt, connected) ==> stepServerCodeRedeemedAtMostOnce(s, "googleConnected", googleConnected(s, attempt, connected).state, googleConnected(s, attempt, connected).out))
  ensures (inv(s) ==> canGoogleConnected(s, attempt, connected) ==> stepGoogleNeverFailsSignIn(s, googleConnected(s, attempt, connected).state))
  ensures (inv(s) ==> canGoogleConnected(s, attempt, connected) ==> stepCancelRetiresTheSlotOrNothing(s, "googleConnected", googleConnected(s, attempt, connected).state))
  ensures (inv(s) ==> canGoogleConnected(s, attempt, connected) ==> stepSessionOnlyForTheSignedInAccount(s, "googleConnected", googleConnected(s, attempt, connected).state, googleConnected(s, attempt, connected).out))
{
  if inv(s) && canGoogleConnected(s, attempt, connected) {
    FlowReceipts(googleConnected(s, attempt, connected).out);
  }
}

lemma cancel_ensures(s: SignIn, attempt: int)
  ensures (inv(s) ==> canCancel(s, attempt) ==> alwaysNothingStartsWithoutARegistration(cancel(s, attempt).state))
  ensures (inv(s) ==> canCancel(s, attempt) ==> alwaysAttemptInAnAdmittedEnvironment(cancel(s, attempt).state))
  ensures (inv(s) ==> canCancel(s, attempt) ==> alwaysStepsFitTheMethod(cancel(s, attempt).state))
  ensures (inv(s) ==> canCancel(s, attempt) ==> alwaysOneRequestOpenWhileWaiting(cancel(s, attempt).state))
  ensures (inv(s) ==> canCancel(s, attempt) ==> alwaysAttemptsAreNumbered(cancel(s, attempt).state))
  ensures (inv(s) ==> canCancel(s, attempt) ==> alwaysExchangeHasAnAttempt(cancel(s, attempt).state))
  ensures (inv(s) ==> canCancel(s, attempt) ==> alwaysSignedInHasACredential(cancel(s, attempt).state))
  ensures (inv(s) ==> canCancel(s, attempt) ==> alwaysServerCodeOnlyUnderScopes(cancel(s, attempt).state))
  ensures (inv(s) ==> canCancel(s, attempt) ==> alwaysGoogleReportedOnlyWhenAsked(cancel(s, attempt).state))
  ensures (inv(s) ==> canCancel(s, attempt) ==> alwaysScopedPickerReportsGoogle(cancel(s, attempt).state))
  ensures (inv(s) ==> canCancel(s, attempt) ==> alwaysReauthenticationStaysWithTheAccount(cancel(s, attempt).state))
  ensures (inv(s) ==> canCancel(s, attempt) ==> stepOnlyTheOpenRequestIsSettled(s, "cancel", cancel(s, attempt).state, cancel(s, attempt).out))
  ensures (inv(s) ==> canCancel(s, attempt) ==> stepServerCodeRedeemedAtMostOnce(s, "cancel", cancel(s, attempt).state, cancel(s, attempt).out))
  ensures (inv(s) ==> canCancel(s, attempt) ==> stepGoogleNeverFailsSignIn(s, cancel(s, attempt).state))
  ensures (inv(s) ==> canCancel(s, attempt) ==> stepCancelRetiresTheSlotOrNothing(s, "cancel", cancel(s, attempt).state))
  ensures (inv(s) ==> canCancel(s, attempt) ==> stepSessionOnlyForTheSignedInAccount(s, "cancel", cancel(s, attempt).state, cancel(s, attempt).out))
{
  if inv(s) && canCancel(s, attempt) {
    FlowReceipts(cancel(s, attempt).out);
  }
}
