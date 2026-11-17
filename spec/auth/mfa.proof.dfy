lemma MfaSingleUseFilters(s: Mfa)
  ensures alwaysRecoveryCodesSingleUse(s) == (((((|ProofLib.Filter((set_x: int) => (set_x in s.recoveryCodes), s.usedRecoveryCodes)| == 0) && (|ProofLib.Filter((set_x: int) => (set_x in s.recoveryCodes), s.retiredRecoveryCodes)| == 0)) && (s.recoveryGeneration >= 1)) && !((exists c :: c in s.recoveryCodes && !((if (s.recoveryGeneration == 1) then ((c == 1) || (c == 2)) else (((quotient_auth__mfa(c, 10) == s.recoveryGeneration) && (remainder_auth__mfa(c, 10) >= 1)) && (remainder_auth__mfa(c, 10) <= 2))))))) && !((exists c :: c in (s.usedRecoveryCodes + ProofLib.Filter((set_x: int) => !((set_x in s.usedRecoveryCodes)), s.retiredRecoveryCodes)) && !(((c >= 1) && (quotient_auth__mfa(c, 10) <= s.recoveryGeneration))))))
{
}

lemma MfaSingleUse(s: Mfa)
  ensures alwaysRecoveryCodesSingleUse(s) <==>
    (forall c :: c in s.usedRecoveryCodes ==> c !in s.recoveryCodes) &&
    (forall c :: c in s.retiredRecoveryCodes ==> c !in s.recoveryCodes) &&
    s.recoveryGeneration >= 1 &&
    (forall c :: c in s.recoveryCodes ==> (if s.recoveryGeneration == 1 then (c == 1 || c == 2) else (quotient_auth__mfa(c, 10) == s.recoveryGeneration && remainder_auth__mfa(c, 10) >= 1 && remainder_auth__mfa(c, 10) <= 2))) &&
    (forall c :: (c in s.usedRecoveryCodes || c in s.retiredRecoveryCodes) ==> c >= 1 && quotient_auth__mfa(c, 10) <= s.recoveryGeneration)
{
  MfaSingleUseFilters(s);
  ProofLib.FilterNone((set_x: int) => (set_x in s.recoveryCodes), s.usedRecoveryCodes);
  ProofLib.FilterNone((set_x: int) => (set_x in s.recoveryCodes), s.retiredRecoveryCodes);
  forall c ensures c in (s.usedRecoveryCodes + ProofLib.Filter((set_x: int) => !((set_x in s.usedRecoveryCodes)), s.retiredRecoveryCodes)) <==> (c in s.usedRecoveryCodes || c in s.retiredRecoveryCodes) {
    ProofLib.FilterMember((set_x: int) => !((set_x in s.usedRecoveryCodes)), s.retiredRecoveryCodes, c);
  }
  forall c | c in s.usedRecoveryCodes ensures exists i :: 0 <= i < |s.usedRecoveryCodes| && s.usedRecoveryCodes[i] == c { }
  forall c | c in s.retiredRecoveryCodes ensures exists i :: 0 <= i < |s.retiredRecoveryCodes| && s.retiredRecoveryCodes[i] == c { }
  forall i | 0 <= i < |s.usedRecoveryCodes| ensures s.usedRecoveryCodes[i] in s.usedRecoveryCodes { }
  forall i | 0 <= i < |s.retiredRecoveryCodes| ensures s.retiredRecoveryCodes[i] in s.retiredRecoveryCodes { }
}

lemma MfaEmits(entry: AuditEntry)
  ensures emits([entry], entry)
{
  ProofLib.FilterMember((e: AuditEntry) => (e == entry), [entry], entry);
}

lemma elapse_ensures(s: Mfa, seconds: int)
  ensures (inv(s) ==> canElapse(s, seconds) ==> alwaysRecoveryCodesSingleUse(elapse(s, seconds)))
  ensures (inv(s) ==> canElapse(s, seconds) ==> stepRecentMfaNeedsALiveChallengeOrRecoveryCode(s, "elapse", elapse(s, seconds)))
  ensures (inv(s) ==> canElapse(s, seconds) ==> stepStaleMfaRefusesEnrollment(s, "elapse", elapse(s, seconds)))
  ensures (inv(s) ==> canElapse(s, seconds) ==> stepFactorChangeClearsAuthority(s, "elapse", elapse(s, seconds)))
  ensures (inv(s) ==> canElapse(s, seconds) ==> stepOnlyAStartedEnrollmentIsConfirmed(s, "elapse", elapse(s, seconds)))
  ensures (inv(s) ==> canElapse(s, seconds) ==> stepFactorChangeIsAudited(s, elapse(s, seconds), []))
{
  MfaSingleUse(s);
  MfaSingleUse(elapse(s, seconds));
}

lemma issueChallenge_ensures(s: Mfa)
  ensures (inv(s) ==> alwaysRecoveryCodesSingleUse(issueChallenge(s)))
  ensures (inv(s) ==> stepRecentMfaNeedsALiveChallengeOrRecoveryCode(s, "issueChallenge", issueChallenge(s)))
  ensures (inv(s) ==> stepStaleMfaRefusesEnrollment(s, "issueChallenge", issueChallenge(s)))
  ensures (inv(s) ==> stepFactorChangeClearsAuthority(s, "issueChallenge", issueChallenge(s)))
  ensures (inv(s) ==> stepOnlyAStartedEnrollmentIsConfirmed(s, "issueChallenge", issueChallenge(s)))
  ensures (inv(s) ==> stepFactorChangeIsAudited(s, issueChallenge(s), []))
{
  MfaSingleUse(s);
  MfaSingleUse(issueChallenge(s));
}

lemma completeChallenge_ensures(s: Mfa, codeValid: bool)
  ensures (inv(s) ==> canCompleteChallenge(s, codeValid) ==> alwaysRecoveryCodesSingleUse(completeChallenge(s, codeValid)))
  ensures (inv(s) ==> canCompleteChallenge(s, codeValid) ==> stepRecentMfaNeedsALiveChallengeOrRecoveryCode(s, "completeChallenge", completeChallenge(s, codeValid)))
  ensures (inv(s) ==> canCompleteChallenge(s, codeValid) ==> stepStaleMfaRefusesEnrollment(s, "completeChallenge", completeChallenge(s, codeValid)))
  ensures (inv(s) ==> canCompleteChallenge(s, codeValid) ==> stepFactorChangeClearsAuthority(s, "completeChallenge", completeChallenge(s, codeValid)))
  ensures (inv(s) ==> canCompleteChallenge(s, codeValid) ==> stepOnlyAStartedEnrollmentIsConfirmed(s, "completeChallenge", completeChallenge(s, codeValid)))
  ensures (inv(s) ==> canCompleteChallenge(s, codeValid) ==> stepFactorChangeIsAudited(s, completeChallenge(s, codeValid), []))
{
  MfaSingleUse(s);
  MfaSingleUse(completeChallenge(s, codeValid));
}

lemma startEnrollment_ensures(s: Mfa, factor: Factor)
  ensures (inv(s) ==> canStartEnrollment(s, factor) ==> alwaysRecoveryCodesSingleUse(startEnrollment(s, factor)))
  ensures (inv(s) ==> canStartEnrollment(s, factor) ==> stepRecentMfaNeedsALiveChallengeOrRecoveryCode(s, "startEnrollment", startEnrollment(s, factor)))
  ensures (inv(s) ==> canStartEnrollment(s, factor) ==> stepStaleMfaRefusesEnrollment(s, "startEnrollment", startEnrollment(s, factor)))
  ensures (inv(s) ==> canStartEnrollment(s, factor) ==> stepFactorChangeClearsAuthority(s, "startEnrollment", startEnrollment(s, factor)))
  ensures (inv(s) ==> canStartEnrollment(s, factor) ==> stepOnlyAStartedEnrollmentIsConfirmed(s, "startEnrollment", startEnrollment(s, factor)))
  ensures (inv(s) ==> canStartEnrollment(s, factor) ==> stepFactorChangeIsAudited(s, startEnrollment(s, factor), []))
{
  MfaSingleUse(s);
  MfaSingleUse(startEnrollment(s, factor));
}

lemma confirmEnrollment_ensures(s: Mfa, answer: EnrollmentReply)
  ensures (inv(s) ==> canConfirmEnrollment(s, answer) ==> alwaysRecoveryCodesSingleUse(confirmEnrollment(s, answer).state))
  ensures (inv(s) ==> canConfirmEnrollment(s, answer) ==> stepRecentMfaNeedsALiveChallengeOrRecoveryCode(s, "confirmEnrollment", confirmEnrollment(s, answer).state))
  ensures (inv(s) ==> canConfirmEnrollment(s, answer) ==> stepStaleMfaRefusesEnrollment(s, "confirmEnrollment", confirmEnrollment(s, answer).state))
  ensures (inv(s) ==> canConfirmEnrollment(s, answer) ==> stepFactorChangeClearsAuthority(s, "confirmEnrollment", confirmEnrollment(s, answer).state))
  ensures (inv(s) ==> canConfirmEnrollment(s, answer) ==> stepOnlyAStartedEnrollmentIsConfirmed(s, "confirmEnrollment", confirmEnrollment(s, answer).state))
  ensures (inv(s) ==> canConfirmEnrollment(s, answer) ==> stepFactorChangeIsAudited(s, confirmEnrollment(s, answer).state, confirmEnrollment(s, answer).out))
{
  MfaSingleUse(s);
  MfaSingleUse(confirmEnrollment(s, answer).state);
  MfaEmits(FactorChanged);
}

lemma useRecoveryCode_ensures(s: Mfa, code: int)
  ensures (inv(s) ==> canUseRecoveryCode(s, code) ==> alwaysRecoveryCodesSingleUse(useRecoveryCode(s, code).state))
  ensures (inv(s) ==> canUseRecoveryCode(s, code) ==> stepRecentMfaNeedsALiveChallengeOrRecoveryCode(s, "useRecoveryCode", useRecoveryCode(s, code).state))
  ensures (inv(s) ==> canUseRecoveryCode(s, code) ==> stepStaleMfaRefusesEnrollment(s, "useRecoveryCode", useRecoveryCode(s, code).state))
  ensures (inv(s) ==> canUseRecoveryCode(s, code) ==> stepFactorChangeClearsAuthority(s, "useRecoveryCode", useRecoveryCode(s, code).state))
  ensures (inv(s) ==> canUseRecoveryCode(s, code) ==> stepOnlyAStartedEnrollmentIsConfirmed(s, "useRecoveryCode", useRecoveryCode(s, code).state))
  ensures (inv(s) ==> canUseRecoveryCode(s, code) ==> stepFactorChangeIsAudited(s, useRecoveryCode(s, code).state, useRecoveryCode(s, code).out))
{
  MfaEmits(RecoveryCodeUsed);
  if inv(s) && canUseRecoveryCode(s, code) {
    var after := useRecoveryCode(s, code).state;
    MfaSingleUse(s);
    forall c ensures c in after.recoveryCodes <==> c in s.recoveryCodes && c != code {
      ProofLib.FilterMember((set_x: int) => !((set_x in [code])), s.recoveryCodes, c);
    }
    forall c ensures c in after.usedRecoveryCodes <==> c in s.usedRecoveryCodes || c == code {
      ProofLib.FilterMember((set_x: int) => !((set_x in s.usedRecoveryCodes)), [code], c);
    }
    MfaSingleUse(after);
  }
}

lemma regenerateRecoveryCodes_ensures(s: Mfa)
  ensures (inv(s) ==> canRegenerateRecoveryCodes(s) ==> alwaysRecoveryCodesSingleUse(regenerateRecoveryCodes(s).state))
  ensures (inv(s) ==> canRegenerateRecoveryCodes(s) ==> stepRecentMfaNeedsALiveChallengeOrRecoveryCode(s, "regenerateRecoveryCodes", regenerateRecoveryCodes(s).state))
  ensures (inv(s) ==> canRegenerateRecoveryCodes(s) ==> stepStaleMfaRefusesEnrollment(s, "regenerateRecoveryCodes", regenerateRecoveryCodes(s).state))
  ensures (inv(s) ==> canRegenerateRecoveryCodes(s) ==> stepFactorChangeClearsAuthority(s, "regenerateRecoveryCodes", regenerateRecoveryCodes(s).state))
  ensures (inv(s) ==> canRegenerateRecoveryCodes(s) ==> stepOnlyAStartedEnrollmentIsConfirmed(s, "regenerateRecoveryCodes", regenerateRecoveryCodes(s).state))
  ensures (inv(s) ==> canRegenerateRecoveryCodes(s) ==> stepFactorChangeIsAudited(s, regenerateRecoveryCodes(s).state, regenerateRecoveryCodes(s).out))
{
  MfaEmits(RecoveryCodesRegenerated);
  if inv(s) && canRegenerateRecoveryCodes(s) {
    var after := regenerateRecoveryCodes(s).state;
    var g := s.recoveryGeneration + 1;
    MfaSingleUse(s);
    assert quotient_auth__mfa(g * 10 + 1, 10) == g && remainder_auth__mfa(g * 10 + 1, 10) == 1;
    assert quotient_auth__mfa(g * 10 + 2, 10) == g && remainder_auth__mfa(g * 10 + 2, 10) == 2;
    forall c ensures c in after.recoveryCodes <==> c == g * 10 + 1 || c == g * 10 + 2 {
      ProofLib.FilterMember((set_x: int) => !((set_x in [((g * 10) + 1)])), [((g * 10) + 2)], c);
    }
    forall c ensures c in after.retiredRecoveryCodes <==> c in s.retiredRecoveryCodes || c in s.recoveryCodes {
      ProofLib.FilterMember((set_x: int) => !((set_x in s.retiredRecoveryCodes)), s.recoveryCodes, c);
    }
    forall c | c in s.recoveryCodes ensures c >= 1 && quotient_auth__mfa(c, 10) < g {
    }
    MfaSingleUse(after);
  }
}
