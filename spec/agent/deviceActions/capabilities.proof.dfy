// A named capability is in the vocabulary, and the filter keeps what passes.
lemma lawEveryNamedCapabilityIsNegotiated_ensures(names: seq<string>, c: Capability)
  ensures (lawEveryNamedCapabilityIsNegotiated(names, c) == true)
{
  if !isRefused(negotiate(true, names)) && capabilityName(c) in names {
    lawTheVocabularyListsEveryCapability_ensures(c);
    var p := (x: Capability) => (capabilityName(x) in names);
    ProofLib.FilterMember(p, allCapabilities, c);
    assert c in namedCapabilities(names);
  }
}

// Each capability, case by case, is one of the listed vocabulary. The prover reads a long list from its end, so
// the first half is read as a list of its own.
lemma lawTheVocabularyListsEveryCapability_ensures(c: Capability)
  ensures (lawTheVocabularyListsEveryCapability(c) == true)
{
  var front := allCapabilities[..25];
  assert front == [Capability.CalendarLocalEventV1, Capability.CalendarCreateV1, Capability.CalendarNextReadV1, Capability.CalendarAgendaReadV1, Capability.CalendarAvailabilityReadV1, Capability.CalendarNamedReadV1, Capability.NamedTargetV1, Capability.NotesLocalRecordV1, Capability.NotesQueryV1, Capability.NotesSearchV1, Capability.NotesListFilterV1, Capability.NotesOrganizeV1, Capability.RemindersLocalRecordV1, Capability.RemindersLocalRecordV2, Capability.RemindersCreateV1, Capability.PhotosLibraryV1, Capability.PhotosViewV1, Capability.CameraCapturePhotoV1, Capability.FilesBrowserV1, Capability.MapsSelectedReadV1, Capability.ClockHandoffV1, Capability.ClockHandoffV2, Capability.SmsSendV1, Capability.MmsSendV1, Capability.SmsComposeV1];
  match c {
    case CalendarLocalEventV1 => assert front[0] == c;
    case CalendarCreateV1 => assert front[1] == c;
    case CalendarNextReadV1 => assert front[2] == c;
    case CalendarAgendaReadV1 => assert front[3] == c;
    case CalendarAvailabilityReadV1 => assert front[4] == c;
    case CalendarNamedReadV1 => assert front[5] == c;
    case NamedTargetV1 => assert front[6] == c;
    case NotesLocalRecordV1 => assert front[7] == c;
    case NotesQueryV1 => assert front[8] == c;
    case NotesSearchV1 => assert front[9] == c;
    case NotesListFilterV1 => assert front[10] == c;
    case NotesOrganizeV1 => assert front[11] == c;
    case RemindersLocalRecordV1 => assert front[12] == c;
    case RemindersLocalRecordV2 => assert front[13] == c;
    case RemindersCreateV1 => assert front[14] == c;
    case PhotosLibraryV1 => assert front[15] == c;
    case PhotosViewV1 => assert front[16] == c;
    case CameraCapturePhotoV1 => assert front[17] == c;
    case FilesBrowserV1 => assert front[18] == c;
    case MapsSelectedReadV1 => assert front[19] == c;
    case ClockHandoffV1 => assert front[20] == c;
    case ClockHandoffV2 => assert front[21] == c;
    case SmsSendV1 => assert front[22] == c;
    case MmsSendV1 => assert front[23] == c;
    case SmsComposeV1 => assert front[24] == c;
    case MessagesReadV1 => assert allCapabilities[25] == c;
    case PhoneDialV1 => assert allCapabilities[26] == c;
    case PhoneCallV1 => assert allCapabilities[27] == c;
    case ContactsWriteV1 => assert allCapabilities[28] == c;
    case VoicemailReadV1 => assert allCapabilities[29] == c;
    case VoicemailDeleteV1 => assert allCapabilities[30] == c;
    case SmsLatestSenderV1 => assert allCapabilities[31] == c;
    case SmsLatestSenderV2 => assert allCapabilities[32] == c;
    case NotesRecordV1 => assert allCapabilities[33] == c;
    case PhotosViewSelectedV1 => assert allCapabilities[34] == c;
    case CameraLibraryIdV1 => assert allCapabilities[35] == c;
    case SmsComposeV2 => assert allCapabilities[36] == c;
    case ContactsWriteV2 => assert allCapabilities[37] == c;
    case ContactsShowV1 => assert allCapabilities[38] == c;
    case ContactsReadV1 => assert allCapabilities[39] == c;
    case ContactsLookupV1 => assert allCapabilities[40] == c;
    case PhoneKeypadV1 => assert allCapabilities[41] == c;
    case BrowserSearchV1 => assert allCapabilities[42] == c;
    case BrowserTabsV1 => assert allCapabilities[43] == c;
    case BrowserTabsCloseAllV1 => assert allCapabilities[44] == c;
    case BrowserFindV1 => assert allCapabilities[45] == c;
    case BrowserHistoryV1 => assert allCapabilities[46] == c;
    case BrowserOpenNewTabV1 => assert allCapabilities[47] == c;
    case FilesShownTargetV1 => assert allCapabilities[48] == c;
  }
}

// Each older form needs only the older capability itself.
lemma lawTheOlderFormsRunUnderTheOlderCapability_ensures(n: Negotiation)
  ensures (lawTheOlderFormsRunUnderTheOlderCapability(n) == true)
{
  assert Capability.SmsComposeV1 in smsComposeNeed(false, false).required;
  assert Capability.ContactsWriteV1 in contactUpdateNeed(false).required;
  assert Capability.PhoneDialV1 in phoneDialNeed(false).required;
}

// Either sender version is one of the suffix read's alternatives.
lemma lawEitherSenderVersionNamesTheSuffix_ensures(n: Negotiation)
  ensures (lawEitherSenderVersionNamesTheSuffix(n) == true)
{
  var need := smsLatestSenderNeed(false);
  assert Capability.SmsLatestSenderV1 in need.oneOf && Capability.SmsLatestSenderV2 in need.oneOf;
  if negotiatedHas(n, Capability.SmsLatestSenderV1) {
    assert Capability.SmsLatestSenderV1 in need.oneOf && Capability.SmsLatestSenderV1 in n.capabilities;
  } else if negotiatedHas(n, Capability.SmsLatestSenderV2) {
    assert Capability.SmsLatestSenderV2 in need.oneOf && Capability.SmsLatestSenderV2 in n.capabilities;
  }
}

// Either clock version is one of the ordinary hand-off's alternatives.
lemma lawEitherClockVersionRunsAnOrdinaryHandoff_ensures(n: Negotiation)
  ensures (lawEitherClockVersionRunsAnOrdinaryHandoff(n) == true)
{
  var need := clockHandoffNeed(false);
  assert Capability.ClockHandoffV1 in need.oneOf && Capability.ClockHandoffV2 in need.oneOf;
  if negotiatedHas(n, Capability.ClockHandoffV1) {
    assert Capability.ClockHandoffV1 in need.oneOf && Capability.ClockHandoffV1 in n.capabilities;
  } else if negotiatedHas(n, Capability.ClockHandoffV2) {
    assert Capability.ClockHandoffV2 in need.oneOf && Capability.ClockHandoffV2 in n.capabilities;
  }
}
