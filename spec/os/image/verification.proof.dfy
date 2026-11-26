lemma ImageVerdictCharacterization(expectation: ImageExpectation, observation: ImageObservation)
  ensures imageVerdict(expectation, observation).Fail? <==> exists c :: c in requiredChecks(expectation) && checkOutcome(expectation, observation, c).Fail?
  ensures imageVerdict(expectation, observation).Unknown? <==> (!(exists c :: c in requiredChecks(expectation) && checkOutcome(expectation, observation, c).Fail?) && exists c :: c in requiredChecks(expectation) && checkOutcome(expectation, observation, c).Unknown?)
  ensures imageVerdict(expectation, observation).Pass? <==> forall c :: c in requiredChecks(expectation) ==> checkOutcome(expectation, observation, c).Pass?
{
  var checks := requiredChecks(expectation);
  var outcomes := (var s_map := checks; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var c := s_map[i_map]; checkOutcome(expectation, observation, c)));
  assert typed1_os__image__verification(CheckOutcome.Fail) == CheckOutcome.Fail;
  assert typed1_os__image__verification(CheckOutcome.Unknown) == CheckOutcome.Unknown;
  assert (exists c :: c in checks && checkOutcome(expectation, observation, c).Fail?) <==> (CheckOutcome.Fail in outcomes) by {
    if exists c :: c in checks && checkOutcome(expectation, observation, c).Fail? {
      var c :| c in checks && checkOutcome(expectation, observation, c).Fail?;
      var i :| 0 <= i < |checks| && checks[i] == c;
      assert outcomes[i] == CheckOutcome.Fail;
    }
    if CheckOutcome.Fail in outcomes {
      var i :| 0 <= i < |outcomes| && outcomes[i] == CheckOutcome.Fail;
      assert checks[i] in checks && checkOutcome(expectation, observation, checks[i]).Fail?;
    }
  }
  assert (exists c :: c in checks && checkOutcome(expectation, observation, c).Unknown?) <==> (CheckOutcome.Unknown in outcomes) by {
    if exists c :: c in checks && checkOutcome(expectation, observation, c).Unknown? {
      var c :| c in checks && checkOutcome(expectation, observation, c).Unknown?;
      var i :| 0 <= i < |checks| && checks[i] == c;
      assert outcomes[i] == CheckOutcome.Unknown;
    }
    if CheckOutcome.Unknown in outcomes {
      var i :| 0 <= i < |outcomes| && outcomes[i] == CheckOutcome.Unknown;
      assert checks[i] in checks && checkOutcome(expectation, observation, checks[i]).Unknown?;
    }
  }
}

lemma lawUnknownCheckNeverPasses_ensures(expectation: ImageExpectation, observation: ImageObservation)
  ensures (lawUnknownCheckNeverPasses(expectation, observation) == true)
{
  ImageVerdictCharacterization(expectation, observation);
}

lemma lawFailureOutranksUnknown_ensures(expectation: ImageExpectation, observation: ImageObservation)
  ensures (lawFailureOutranksUnknown(expectation, observation) == true)
{
  ImageVerdictCharacterization(expectation, observation);
}

lemma lawPassIsEnforcingAndNoWeaker_ensures(expectation: ImageExpectation, observation: ImageObservation)
  ensures (lawPassIsEnforcingAndNoWeaker(expectation, observation) == true)
{
  ImageVerdictCharacterization(expectation, observation);
  var checks := requiredChecks(expectation);
  assert ImageCheck.SelinuxEnforcing in baseChecks;
  assert ImageCheck.SelinuxEnforcing in checks;
  if !expectation.boot.BootUnchecked? {
    assert ImageCheck.VerifiedBoot in checks;
  }
}

lemma lawPassRunsTheStagedLauncher_ensures(expectation: ImageExpectation, observation: ImageObservation)
  ensures (lawPassRunsTheStagedLauncher(expectation, observation) == true)
{
  ImageVerdictCharacterization(expectation, observation);
  assert ImageCheck.LauncherBytes in baseChecks;
  assert ImageCheck.LauncherBytes in requiredChecks(expectation);
}

lemma lawUnreadSelinuxNeverPasses_ensures(expectation: ImageExpectation, observation: ImageObservation)
  ensures (lawUnreadSelinuxNeverPasses(expectation, observation) == true)
{
  ImageVerdictCharacterization(expectation, observation);
  assert ImageCheck.SelinuxEnforcing in baseChecks;
  assert ImageCheck.SelinuxEnforcing in requiredChecks(expectation);
}

lemma lawUnreadListenerNeverPassesAListenerImage_ensures(expectation: ImageExpectation, observation: ImageObservation)
  ensures (lawUnreadListenerNeverPassesAListenerImage(expectation, observation) == true)
{
  ImageVerdictCharacterization(expectation, observation);
  if expectation.listener {
    assert ImageCheck.ListenerGrants in requiredChecks(expectation);
  }
}

lemma lawTheStagedImagePasses_ensures(withListener: bool, lockedTarget: bool, withPrivileges: bool)
  ensures (lawTheStagedImagePasses(withListener, lockedTarget, withPrivileges) == true)
{
  var exp := stagedImage.(
    listener := withListener,
    boot := if lockedTarget then BootAtLeast(BootState.Yellow) else BootExpectation.BootUnchecked,
    privilegedPermissions := if withPrivileges then [phoneStatePermission] else []
  );
  ImageVerdictCharacterization(exp, bootedAsStaged);
  assert audioGrant in [audioGrant];
  assert bootedAsStaged.clock.handledActions == clockAlarmActions;
  assert bootedAsStaged.camera.systemHandles == secureCaptureActions;
  assert stagedListener.granted == [
    "android.permission.CAPTURE_AUDIO_HOTWORD",
    "android.permission.START_ACTIVITIES_FROM_BACKGROUND",
    "android.permission.RECORD_AUDIO"
  ];
  assert os__image__listener_listenerPrivilegedPermissions[0] in stagedListener.granted;
  assert os__image__listener_listenerPrivilegedPermissions[1] in stagedListener.granted;
  assert "android.permission.RECORD_AUDIO" in stagedListener.granted;
  assert phoneStatePermission in [phoneStatePermission];
}
