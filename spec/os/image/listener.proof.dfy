lemma ReviewedWakeNamesFilterBridge(names: seq<WakeName>)
  ensures wakeNamesAdmitted(names) == (((|names| >= 1) && (|names| <= 8)) && !(exists n :: n in names && !((!n.MalformedWakeName?) && (|ProofLib.Filter((m: WakeName) => (m == n), names)| == 1))))
{
}

lemma ReviewedChecksHold()
  ensures sourceAdmitsListener(reviewedSource)
  ensures isListenerOf(reviewedListener.packageName, reviewedRequest.launcherPackage)
  ensures sameSigner(reviewedListener.signer, reviewedRequest.launcherSigner)
  ensures permissionsReviewed(reviewedListener.requested)
  ensures overlayAdmitted(reviewedRequest.overlay)
  ensures wakeNamesAdmitted(reviewedRequest.wakeNames)
  ensures policyBoundToSigner(reviewedRequest.policyCertificate, reviewedRequest.launcherSigner)
  ensures descriptorMatches(reviewedRequest.descriptor, reviewedListener)
  ensures qualificationMatches(reviewedRequest, reviewedSource)
  ensures qualificationPassed(reviewedRequest.qualification, true)
  ensures qualificationPassed(reviewedRequest.qualification, false)
{
  assert reviewedSource.patches[0].name == "chip" && reviewedSource.patches[1].name == "ops";
  assert reviewedListener.requested == [
    "android.permission.CAPTURE_AUDIO_HOTWORD",
    "android.permission.START_ACTIVITIES_FROM_BACKGROUND",
    "android.permission.RECORD_AUDIO",
    "android.permission.FOREGROUND_SERVICE_MICROPHONE"
  ];
  assert reviewedListener.requested[0] in listenerPrivilegedPermissions;
  assert reviewedListener.requested[1] in listenerPrivilegedPermissions;
  assert reviewedListener.requested[2] in listenerUnprivilegedPermissions;
  assert reviewedListener.requested[3] in listenerUnprivilegedPermissions;
  assert listenerPrivilegedPermissions[0] in reviewedListener.requested;
  assert listenerPrivilegedPermissions[1] in reviewedListener.requested;
  assert listenerRequiredPermissions[0] in reviewedListener.requested;
  assert listenerRequiredPermissions[1] in reviewedListener.requested;
  forall i | 0 <= i < |indicatorExemptRoles|
    ensures exists row :: row in reviewedRequest.overlay.roles && row.role == indicatorExemptRoles[i]
  {
    assert reviewedRequest.overlay.roles[i] in reviewedRequest.overlay.roles;
    assert reviewedRequest.overlay.roles[i].role == indicatorExemptRoles[i];
  }
  ReviewedWakeNamesFilterBridge(reviewedRequest.wakeNames);
  var w := WakeWord("hey");
  assert reviewedRequest.wakeNames == [w];
  var pw := (m: WakeName) => (m == w);
  ProofLib.FilterCons(pw, [w]);
  ProofLib.FilterNil(pw, [w][1..]);
  assert |ProofLib.Filter(pw, [w])| == 1;
  var sp := sourcePatches(reviewedSource);
  assert |sp| == 2 && |reviewedInputs.patches| == 2;
  assert sp[0] == reviewedInputs.patches[1] && sp[1] == reviewedInputs.patches[0];
  forall i | 0 <= i < |listenerGates|
    ensures gatePassed(reviewedGates, listenerGates[i])
  {
    assert reviewedGates[i] in reviewedGates;
    assert reviewedGates[i].gate == listenerGates[i] && evidenced(reviewedGates[i].result);
  }
}

lemma lawAReviewedListenerStagesActivated_ensures(mode: os__image__apk_StagingMode)
  ensures (lawAReviewedListenerStagesActivated(mode) == true)
{
  ReviewedChecksHold();
}

lemma lawWithoutARecordOnlyDevelopmentStagesInert_ensures(mode: os__image__apk_StagingMode)
  ensures (lawWithoutARecordOnlyDevelopmentStagesInert(mode) == true)
{
  ReviewedChecksHold();
}
