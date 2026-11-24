// spec/agent/deviceActions/operations.md, "Each operation has one capability need, which a clock-only device meets only for the Clock handoff"

lemma lawTheTabListNeedsOnlyItsCapability_ensures(versionTwo: bool, neg: agent__deviceActions__capabilities_Negotiation)
  ensures (lawTheTabListNeedsOnlyItsCapability(versionTwo, neg) == true)
{
  var capability := agent__deviceActions__capabilities_Capability.BrowserTabsShowV1;
  var operation := OperationType.BrowserTabsShow;
  assert family(operation) == Family.BrowserFamily;
  assert familyNeed(Family.BrowserFamily, operation, versionTwo) == agent__deviceActions__capabilities_needOne(capability);
  assert operationNeed(operation, versionTwo) == agent__deviceActions__capabilities_needOne(capability);
  SingleCapabilityMeets(neg, capability);
}

lemma SingleCapabilityMeets(neg: agent__deviceActions__capabilities_Negotiation, capability: agent__deviceActions__capabilities_Capability)
  ensures agent__deviceActions__capabilities_meets(neg, agent__deviceActions__capabilities_needOne(capability)) ==
    agent__deviceActions__capabilities_negotiatedHas(neg, capability)
{
  var need := agent__deviceActions__capabilities_needOne(capability);
  assert need.required == [capability] && need.oneOf == [];
  assert capability in need.required;
  if neg.Negotiated? {
    if capability in neg.capabilities {
      assert forall c :: c in need.required ==> c in neg.capabilities;
    } else {
      assert exists c :: c in need.required && c !in neg.capabilities;
    }
  }
}

lemma lawRecordingRunsUnderItsOwnCapabilityAlone_ensures(t: OperationType)
  ensures (lawRecordingRunsUnderItsOwnCapabilityAlone(t) == true)
{
  if t.NotesRecord? {
    var capability := agent__deviceActions__capabilities_Capability.NotesRecordV1;
    var negotiated := agent__deviceActions__capabilities_Negotiation.Negotiated([capability]);
    assert family(t) == Family.NotesOrganizeFamily;
    assert familyNeed(Family.NotesOrganizeFamily, t, true) == agent__deviceActions__capabilities_needOne(capability);
    assert operationNeed(t, true) == agent__deviceActions__capabilities_needOne(capability);
    SingleCapabilityMeets(negotiated, capability);
    assert agent__deviceActions__capabilities_negotiatedHas(negotiated, capability);
  }
}

lemma lawTheDraftFollowUpNeedsTheNewerRead_ensures(n: agent__deviceActions__capabilities_Negotiation)
  ensures (lawTheDraftFollowUpNeedsTheNewerRead(n) == true)
{
  if senderGuidance(n).AddressThenDraft? {
    var capability := agent__deviceActions__capabilities_Capability.SmsLatestSenderV2;
    assert agent__deviceActions__capabilities_negotiatedHas(n, capability);
    assert agent__deviceActions__capabilities_smsLatestSenderNeed(true) == agent__deviceActions__capabilities_needOne(capability);
    SingleCapabilityMeets(n, capability);
  }
}

lemma lawACaptureWithoutALensNeedsNoLens_ensures(neg: agent__deviceActions__capabilities_Negotiation)
  ensures (lawACaptureWithoutALensNeedsNoLens(neg) == true)
{
  var capability := agent__deviceActions__capabilities_Capability.CameraCapturePhotoV1;
  if agent__deviceActions__capabilities_negotiatedHas(neg, capability) {
    var operation := OperationType.CameraCapturePhoto;
    var proposal := Proposal(operation, false, ReadBinding.NoBinding, true);
    var versionTwo := proposalVersion(proposal, neg);
    assert family(operation) == Family.CameraFamily;
    assert familyNeed(Family.CameraFamily, operation, versionTwo) == agent__deviceActions__capabilities_needOne(capability);
    assert operationNeed(operation, versionTwo) == agent__deviceActions__capabilities_needOne(capability);
    SingleCapabilityMeets(neg, capability);
    assert bindingAdmitted(proposal, neg) && lensAdmitted(proposal, neg);
    assert validate(proposal, neg);
  }
}

lemma BothCapabilitiesMeet(neg: agent__deviceActions__capabilities_Negotiation, first: agent__deviceActions__capabilities_Capability, second: agent__deviceActions__capabilities_Capability)
  requires first != second
  ensures agent__deviceActions__capabilities_meets(neg, needAll(first, second)) ==
    (agent__deviceActions__capabilities_negotiatedHas(neg, first) && agent__deviceActions__capabilities_negotiatedHas(neg, second))
{
  var keep := (cap: agent__deviceActions__capabilities_Capability) => !(cap in [first]);
  ProofLib.FilterCons(keep, [second]);
  ProofLib.FilterNil(keep, [second][1..]);
  assert keep(second);
  assert ProofLib.Filter(keep, [second]) == [second];
  var need := needAll(first, second);
  assert need.required == [first] + ProofLib.Filter(keep, [second]);
  assert need.required == [first, second] && need.oneOf == [];
  assert first in need.required && second in need.required;
  if neg.Negotiated? {
    if first in neg.capabilities && second in neg.capabilities {
      assert forall c :: c in need.required ==> c in neg.capabilities;
    } else {
      assert exists c :: c in need.required && c !in neg.capabilities;
    }
  }
}

lemma lawNewerReminderTimingIsNeverDowngraded_ensures(t: OperationType, neg: agent__deviceActions__capabilities_Negotiation)
  ensures (lawNewerReminderTimingIsNeverDowngraded(t, neg) == true)
{
  var timing := agent__deviceActions__capabilities_Capability.RemindersLocalRecordV2;
  if family(t).ReminderFamily? {
    assert familyNeed(Family.ReminderFamily, t, true) == agent__deviceActions__capabilities_needOne(timing);
    assert operationNeed(t, true) == agent__deviceActions__capabilities_needOne(timing);
    SingleCapabilityMeets(neg, timing);
  } else if t.ReminderNamed? {
    var named := agent__deviceActions__capabilities_Capability.NamedTargetV1;
    assert operationNeed(t, true) == needAll(named, timing);
    BothCapabilitiesMeet(neg, named, timing);
  }
}

lemma lawARecordingIsValidUnderEitherForm_ensures(prop: Proposal, neg: agent__deviceActions__capabilities_Negotiation)
  ensures (lawARecordingIsValidUnderEitherForm(prop, neg) == true)
{
  if prop.opType.NotesRecord? && prop.shapeValid && prop.binding.NoBinding? {
    var standalone := agent__deviceActions__capabilities_Capability.NotesRecordV1;
    var versionTwo := proposalVersion(prop, neg);
    assert family(prop.opType) == Family.NotesOrganizeFamily;
    assert bindingAdmitted(prop, neg) && lensAdmitted(prop, neg);
    if versionTwo {
      assert operationNeed(prop.opType, versionTwo) == agent__deviceActions__capabilities_needOne(standalone);
      SingleCapabilityMeets(neg, standalone);
    } else {
      var organize := agent__deviceActions__capabilities_Capability.NotesOrganizeV1;
      var local := agent__deviceActions__capabilities_Capability.NotesLocalRecordV1;
      assert operationNeed(prop.opType, versionTwo) == needAll(organize, local);
      BothCapabilitiesMeet(neg, organize, local);
    }
  }
}

lemma lawClosingEveryTabNeedsItsOwnCapability_ensures(neg: agent__deviceActions__capabilities_Negotiation)
  ensures (lawClosingEveryTabNeedsItsOwnCapability(neg) == true)
{
  var tabs := agent__deviceActions__capabilities_Capability.BrowserTabsV1;
  var closeAll := agent__deviceActions__capabilities_Capability.BrowserTabsCloseAllV1;
  var operation := OperationType.BrowserTabClose;
  assert family(operation) == Family.BrowserFamily;
  assert familyNeed(Family.BrowserFamily, operation, true) == needAll(tabs, closeAll);
  assert operationNeed(operation, true) == needAll(tabs, closeAll);
  BothCapabilitiesMeet(neg, tabs, closeAll);
}

lemma lawAShownFilesChangeNeedsTheShownTarget_ensures(t: OperationType, neg: agent__deviceActions__capabilities_Negotiation)
  ensures (lawAShownFilesChangeNeedsTheShownTarget(t, neg) == true)
{
  if family(t).FilesFamily? {
    var files := agent__deviceActions__capabilities_Capability.FilesBrowserV1;
    var shown := agent__deviceActions__capabilities_Capability.FilesShownTargetV1;
    assert familyNeed(Family.FilesFamily, t, true) == needAll(files, shown);
    assert operationNeed(t, true) == needAll(files, shown);
    BothCapabilitiesMeet(neg, files, shown);
  }
}

lemma lawTheLegacyPairStillRecords_ensures(neg: agent__deviceActions__capabilities_Negotiation)
  ensures (lawTheLegacyPairStillRecords(neg) == true)
{
  var organize := agent__deviceActions__capabilities_Capability.NotesOrganizeV1;
  var local := agent__deviceActions__capabilities_Capability.NotesLocalRecordV1;
  var standalone := agent__deviceActions__capabilities_Capability.NotesRecordV1;
  var operation := OperationType.NotesRecord;
  assert family(operation) == Family.NotesOrganizeFamily;
  if recordingAlone(neg) {
    assert familyNeed(Family.NotesOrganizeFamily, operation, true) == agent__deviceActions__capabilities_needOne(standalone);
    assert operationNeed(operation, true) == agent__deviceActions__capabilities_needOne(standalone);
    SingleCapabilityMeets(neg, standalone);
  } else {
    assert familyNeed(Family.NotesOrganizeFamily, operation, false) == needAll(organize, local);
    assert operationNeed(operation, false) == needAll(organize, local);
    BothCapabilitiesMeet(neg, organize, local);
  }
}

lemma AnyButClockHasAnAlternative()
  ensures agent__deviceActions__capabilities_namesSome(anyButClock.oneOf)
{
  var capability := agent__deviceActions__capabilities_Capability.CalendarLocalEventV1;
  var firstClock := agent__deviceActions__capabilities_Capability.ClockHandoffV1;
  var secondClock := agent__deviceActions__capabilities_Capability.ClockHandoffV2;
  var available := agent__deviceActions__capabilities_allCapabilities;
  var keep := (c: agent__deviceActions__capabilities_Capability) => !(c in [firstClock, secondClock]);
  assert available[..1] == [capability];
  assert capability in available;
  ProofLib.FilterMember(keep, available, capability);
  assert anyButClock.oneOf == ProofLib.Filter(keep, available);
  assert capability in anyButClock.oneOf;
}

lemma lawEveryOperationNamesANeed_ensures(t: OperationType, versionTwo: bool)
  ensures (lawEveryOperationNamesANeed(t, versionTwo) == true)
{
  var f := family(t);
  var need := operationNeed(t, versionTwo);
  if need == anyButClock {
    AnyButClockHasAnAlternative();
  } else {
    match f {
      case ReminderFamily => assert |need.required| > 0 || |need.oneOf| > 0;
      case ClockFamily => assert |need.required| > 0 || |need.oneOf| > 0;
      case TelephonyFamily => assert |need.required| > 0 || |need.oneOf| > 0;
      case CalendarFamily => assert |need.required| > 0;
      case ReviewFamily => assert |need.required| > 0;
      case NotesOrganizeFamily => assert |need.required| > 0;
      case PhotosViewFamily => assert |need.required| > 0;
      case BrowserFamily => assert |need.required| > 0;
      case _ => assert |need.required| > 0;
    }
    if |need.required| > 0 {
      assert need.required[0] in need.required;
    } else {
      assert need.oneOf[0] in need.oneOf;
    }
  }
}
