lemma OpsNamesFirst(s: seq<agent__deviceActions__capabilities_Capability>)
  requires |s| > 0
  ensures agent__deviceActions__capabilities_namesSome(s)
{
  assert s[0] in s;
}

lemma OpsNeedAll(a: agent__deviceActions__capabilities_Capability, b: agent__deviceActions__capabilities_Capability)
  ensures needAll(a, b).oneOf == []
  ensures a in needAll(a, b).required && b in needAll(a, b).required
  ensures forall x :: x in needAll(a, b).required ==> x == a || x == b
{
  var p := (set_x: agent__deviceActions__capabilities_Capability) => !((set_x in [a]));
  forall x
    ensures x in needAll(a, b).required <==> x == a || x == b
  {
    ProofLib.FilterMember(p, [b], x);
  }
}

lemma OpsMeetsRequired(n: agent__deviceActions__capabilities_Negotiation, need: agent__deviceActions__capabilities_Need)
  requires n.Negotiated? && |need.required| > 0 && need.oneOf == []
  requires forall x :: x in need.required ==> x in n.capabilities
  ensures agent__deviceActions__capabilities_meets(n, need)
{
  OpsNamesFirst(need.required);
}

lemma OpsOpenPhotoNeed(t: OperationType)
  requires t.PhotosAlbumCreate? || t.PhotosShare?
  ensures agent__deviceActions__capabilities_Capability.PhotosLibraryV1 in operationNeed(t, true).required
  ensures agent__deviceActions__capabilities_Capability.PhotosViewV1 in operationNeed(t, true).required
  ensures agent__deviceActions__capabilities_Capability.PhotosViewSelectedV1 in operationNeed(t, true).required
  ensures operationNeed(t, true).oneOf == []
  ensures forall c :: c in operationNeed(t, true).required ==> c.PhotosLibraryV1? || c.PhotosViewV1? || c.PhotosViewSelectedV1?
{
  reveal Std.Collections.Seq.Filter();
  assert family(t) == Family.PhotosViewFamily;
  assert operationNeed(t, true).required == [agent__deviceActions__capabilities_Capability.PhotosLibraryV1, agent__deviceActions__capabilities_Capability.PhotosViewV1, agent__deviceActions__capabilities_Capability.PhotosViewSelectedV1];
}

lemma lawRecordingRunsUnderItsOwnCapabilityAlone_ensures(t: OperationType)
  ensures (lawRecordingRunsUnderItsOwnCapabilityAlone(t) == true)
{
  if t.NotesRecord? {
    var n := Negotiated([agent__deviceActions__capabilities_Capability.NotesRecordV1]);
    assert family(t) == Family.NotesOrganizeFamily;
    assert operationNeed(t, true) == agent__deviceActions__capabilities_needOne(agent__deviceActions__capabilities_Capability.NotesRecordV1);
    OpsMeetsRequired(n, operationNeed(t, true));
  }
}

lemma lawTheLegacyPairStillRecords_ensures(neg: agent__deviceActions__capabilities_Negotiation)
  ensures (lawTheLegacyPairStillRecords(neg) == true)
{
  var organize := agent__deviceActions__capabilities_Capability.NotesOrganizeV1;
  var local := agent__deviceActions__capabilities_Capability.NotesLocalRecordV1;
  if agent__deviceActions__capabilities_negotiatedHas(neg, organize) && agent__deviceActions__capabilities_negotiatedHas(neg, local) {
    var t := OperationType.NotesRecord;
    var v := recordingAlone(neg);
    assert family(t) == Family.NotesOrganizeFamily;
    if v {
      assert operationNeed(t, v) == agent__deviceActions__capabilities_needOne(agent__deviceActions__capabilities_Capability.NotesRecordV1);
    } else {
      assert operationNeed(t, v) == needAll(organize, local);
      OpsNeedAll(organize, local);
    }
    OpsMeetsRequired(neg, operationNeed(t, v));
  }
}

lemma lawTheOpenPhotoFormNeedsItsCapability_ensures(t: OperationType, neg: agent__deviceActions__capabilities_Negotiation)
  ensures (lawTheOpenPhotoFormNeedsItsCapability(t, neg) == true)
{
  if (t.PhotosAlbumCreate? || t.PhotosShare?) && agent__deviceActions__capabilities_meets(neg, operationNeed(t, true)) {
    OpsOpenPhotoNeed(t);
  }
}

lemma lawNewerReminderTimingIsNeverDowngraded_ensures(t: OperationType, neg: agent__deviceActions__capabilities_Negotiation)
  ensures (lawNewerReminderTimingIsNeverDowngraded(t, neg) == true)
{
  if (family(t).ReminderFamily? || t.ReminderNamed?) && agent__deviceActions__capabilities_meets(neg, operationNeed(t, true)) {
    var v2 := agent__deviceActions__capabilities_Capability.RemindersLocalRecordV2;
    if family(t).ReminderFamily? {
      assert operationNeed(t, true) == agent__deviceActions__capabilities_needOne(v2);
    } else {
      assert operationNeed(t, true) == needAll(agent__deviceActions__capabilities_Capability.NamedTargetV1, v2);
      OpsNeedAll(agent__deviceActions__capabilities_Capability.NamedTargetV1, v2);
    }
    assert v2 in operationNeed(t, true).required;
  }
}

lemma lawAShownFilesChangeNeedsTheShownTarget_ensures(t: OperationType, neg: agent__deviceActions__capabilities_Negotiation)
  ensures (lawAShownFilesChangeNeedsTheShownTarget(t, neg) == true)
{
  if family(t).FilesFamily? && agent__deviceActions__capabilities_meets(neg, operationNeed(t, true)) {
    assert operationNeed(t, true) == needAll(agent__deviceActions__capabilities_Capability.FilesBrowserV1, agent__deviceActions__capabilities_Capability.FilesShownTargetV1);
    OpsNeedAll(agent__deviceActions__capabilities_Capability.FilesBrowserV1, agent__deviceActions__capabilities_Capability.FilesShownTargetV1);
  }
}

lemma lawClosingEveryTabNeedsItsOwnCapability_ensures(neg: agent__deviceActions__capabilities_Negotiation)
  ensures (lawClosingEveryTabNeedsItsOwnCapability(neg) == true)
{
  var t := OperationType.BrowserTabClose;
  if agent__deviceActions__capabilities_meets(neg, operationNeed(t, true)) {
    assert family(t) == Family.BrowserFamily;
    assert operationNeed(t, true) == needAll(agent__deviceActions__capabilities_Capability.BrowserTabsV1, agent__deviceActions__capabilities_Capability.BrowserTabsCloseAllV1);
    OpsNeedAll(agent__deviceActions__capabilities_Capability.BrowserTabsV1, agent__deviceActions__capabilities_Capability.BrowserTabsCloseAllV1);
  }
}

lemma lawTheTabListNeedsOnlyItsCapability_ensures(versionTwo: bool, neg: agent__deviceActions__capabilities_Negotiation)
  ensures (lawTheTabListNeedsOnlyItsCapability(versionTwo, neg) == true)
{
  var t := OperationType.BrowserTabsShow;
  var cap := agent__deviceActions__capabilities_Capability.BrowserTabsShowV1;
  assert family(t) == Family.BrowserFamily;
  assert operationNeed(t, versionTwo) == agent__deviceActions__capabilities_needOne(cap);
  if agent__deviceActions__capabilities_negotiatedHas(neg, cap) {
    OpsMeetsRequired(neg, operationNeed(t, versionTwo));
  }
}

lemma lawARecordingIsValidUnderEitherForm_ensures(prop: Proposal, neg: agent__deviceActions__capabilities_Negotiation)
  ensures (lawARecordingIsValidUnderEitherForm(prop, neg) == true)
{
  var record := agent__deviceActions__capabilities_Capability.NotesRecordV1;
  if prop.opType.NotesRecord? && prop.shapeValid && prop.binding.NoBinding? {
    var t := prop.opType;
    assert family(t) == Family.NotesOrganizeFamily;
    assert proposalVersion(prop, neg) == recordingAlone(neg);
    if agent__deviceActions__capabilities_negotiatedHas(neg, record) {
      assert operationNeed(t, true) == agent__deviceActions__capabilities_needOne(record);
      OpsMeetsRequired(neg, operationNeed(t, true));
    } else {
      lawTheLegacyPairStillRecords_ensures(neg);
    }
    assert bindingAdmitted(prop, neg);
  }
}

lemma lawACaptureWithoutALensNeedsNoLens_ensures(neg: agent__deviceActions__capabilities_Negotiation)
  ensures (lawACaptureWithoutALensNeedsNoLens(neg) == true)
{
  var prop := Proposal(OperationType.CameraCapturePhoto, false, ReadBinding.NoBinding, true);
  var cap := agent__deviceActions__capabilities_Capability.CameraCapturePhotoV1;
  if agent__deviceActions__capabilities_negotiatedHas(neg, cap) {
    assert family(prop.opType) == Family.CameraFamily;
    assert operationNeed(prop.opType, proposalVersion(prop, neg)) == agent__deviceActions__capabilities_needOne(cap);
    OpsMeetsRequired(neg, operationNeed(prop.opType, proposalVersion(prop, neg)));
    assert bindingAdmitted(prop, neg);
    assert lensAdmitted(prop, neg);
  }
}

lemma lawTheDraftFollowUpNeedsTheNewerRead_ensures(n: agent__deviceActions__capabilities_Negotiation)
  ensures (lawTheDraftFollowUpNeedsTheNewerRead(n) == true)
{
  if senderGuidance(n).AddressThenDraft? {
    OpsMeetsRequired(n, agent__deviceActions__capabilities_smsLatestSenderNeed(true));
  }
}

lemma OpsAnyButClockFilter()
  ensures anyButClock.oneOf == ProofLib.Filter((set_x: agent__deviceActions__capabilities_Capability) => !((set_x in [typed1_agent__deviceActions__operations(agent__deviceActions__capabilities_Capability.ClockHandoffV1), typed1_agent__deviceActions__operations(agent__deviceActions__capabilities_Capability.ClockHandoffV2)])), typed0_agent__deviceActions__operations(agent__deviceActions__capabilities_allCapabilities))
{
}

lemma OpsAnyButClock()
  ensures anyButClock.required == []
  ensures agent__deviceActions__capabilities_Capability.CalendarLocalEventV1 in anyButClock.oneOf
  ensures forall c :: c in anyButClock.oneOf ==> !c.ClockHandoffV1? && !c.ClockHandoffV2?
{
  var p := (set_x: agent__deviceActions__capabilities_Capability) => !((set_x in [typed1_agent__deviceActions__operations(agent__deviceActions__capabilities_Capability.ClockHandoffV1), typed1_agent__deviceActions__operations(agent__deviceActions__capabilities_Capability.ClockHandoffV2)]));
  var xs := typed0_agent__deviceActions__operations(agent__deviceActions__capabilities_allCapabilities);
  OpsAnyButClockFilter();
  agent__deviceActions__capabilities_lawTheVocabularyListsEveryCapability_ensures(agent__deviceActions__capabilities_Capability.CalendarLocalEventV1);
  assert agent__deviceActions__capabilities_Capability.CalendarLocalEventV1 in xs;
  ProofLib.FilterMember(p, xs, agent__deviceActions__capabilities_Capability.CalendarLocalEventV1);
  forall c | c in anyButClock.oneOf
    ensures !c.ClockHandoffV1? && !c.ClockHandoffV2?
  {
    ProofLib.FilterMember(p, xs, c);
  }
}

lemma OpsClockFamily(t: OperationType)
  ensures family(t).ClockFamily? ==> t.ClockHandoff?
{
}

lemma OpsFamilyNeed(f: Family, t: OperationType, versionTwo: bool)
  requires !f.ClockFamily?
  ensures var n := familyNeed(f, t, versionTwo);
    (|n.required| > 0 && !n.required[0].ClockHandoffV1? && !n.required[0].ClockHandoffV2?) ||
    (|n.required| == 0 && |n.oneOf| > 0 && forall c :: c in n.oneOf ==> !c.ClockHandoffV1? && !c.ClockHandoffV2?)
{
  match f {
    case WorkflowFamily => OpsAnyButClock();
    case BaseFamily => OpsAnyButClock();
    case _ =>
  }
}

lemma lawEveryOperationNamesANeed_ensures(t: OperationType, versionTwo: bool)
  ensures (lawEveryOperationNamesANeed(t, versionTwo) == true)
{
  var n := operationNeed(t, versionTwo);
  if family(t).ClockFamily? {
    if versionTwo { OpsNamesFirst(n.required); } else { OpsNamesFirst(n.oneOf); }
  } else {
    OpsFamilyNeed(family(t), t, versionTwo);
    if |n.required| > 0 { OpsNamesFirst(n.required); } else { OpsNamesFirst(n.oneOf); }
  }
}

lemma lawAClockOnlyDeviceReceivesOnlyClockHandoffs_ensures(t: OperationType, versionTwo: bool, neg: agent__deviceActions__capabilities_Negotiation)
  ensures (lawAClockOnlyDeviceReceivesOnlyClockHandoffs(t, versionTwo, neg) == true)
{
  var n := operationNeed(t, versionTwo);
  if clockOnly(neg) && agent__deviceActions__capabilities_meets(neg, n) && !t.ClockHandoff? {
    OpsClockFamily(t);
    OpsFamilyNeed(family(t), t, versionTwo);
    var c: agent__deviceActions__capabilities_Capability;
    if |n.required| > 0 {
      c := n.required[0];
      assert c in n.required;
    } else {
      OpsNamesFirst(n.oneOf);
      c :| c in n.oneOf && c in neg.capabilities;
    }
    agent__deviceActions__capabilities_lawTheVocabularyListsEveryCapability_ensures(c);
    assert agent__deviceActions__capabilities_negotiatedHas(neg, c);
    assert false;
  }
}
