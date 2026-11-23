# Notes organizing and recording on the device

The agent can propose to filter the device's Notes list, move a note to a
folder, create a folder, restore a note from Recently deleted, and start or
stop a voice note. Each proposal travels as a
[device action](../agent/deviceActions/operations.md); the
[list filter](./listFilter.md) owns the canonical list review. The device
owns the folder list, and the agent names a folder only by the name the
device sent.

## Story: Organize my notes only where I can see it

> As the owner, I want the agent to organize my notes or record a voice note
> only when my phone said it can, only on a screen where I can review it, and
> never to move, create or restore anything without my review.

### Recording is offered with its own capability or with the full organize set

A voice note can be started or stopped when the device advertised
`notes.record.v1` alone, which needs no folders and no local Notes record,
or when it advertised both `notes.organize.v1` and `notes.local-record.v1`
as before. The canonical list filter needs `notes.list-filter.v1`. Every
other organize operation needs both `notes.organize.v1` and
`notes.local-record.v1`; recording alone never offers them.

```quint
type OrganizeKind = FilterNotes | FilterCanonicalList | MoveNote | CreateFolder | RestoreNote | RecordVoice
type Advertised = { recordCap: bool, organizeCap: bool, localRecordCap: bool, listFilterCap: bool }
pure def recordingOffered(caps: Advertised): bool = caps.recordCap or (caps.organizeCap and caps.localRecordCap)
pure def organizeOffered(kind: OrganizeKind, caps: Advertised): bool =
  if (kind == RecordVoice) recordingOffered(caps)
  else if (kind == FilterCanonicalList) caps.listFilterCap
  else caps.organizeCap and caps.localRecordCap
pure val recordOnly: Advertised = { recordCap: true, organizeCap: false, localRecordCap: false, listFilterCap: false }
pure val legacyPair: Advertised = { recordCap: false, organizeCap: true, localRecordCap: true, listFilterCap: false }
pure val capsValues = Set(recordOnly, legacyPair, { ...legacyPair, localRecordCap: false }, { ...recordOnly, recordCap: false, listFilterCap: true })
pure def lawRecordCapabilityAloneOffersOnlyRecording(kind: OrganizeKind): bool =
  organizeOffered(kind, recordOnly) iff kind == RecordVoice
pure def lawLegacyPairStillOffersRecording(caps: Advertised): bool =
  caps.organizeCap and caps.localRecordCap implies organizeOffered(RecordVoice, caps)
pure def lawOrganizeWithoutLocalRecordOffersNoChange(caps: Advertised): bool =
  not(caps.localRecordCap) implies not(organizeOffered(MoveNote, caps) or organizeOffered(CreateFolder, caps) or organizeOffered(RestoreNote, caps))
```

### A proposal is reviewed or run only on the unlocked phone in Home or Notes, and recording only in Notes

A sensitive or locked screen admits nothing. Filtering, moving, creating a
folder and restoring are admitted while Home or Notes is open. Recording is
admitted only while Notes is open. The canonical list filter is admitted
only on the canonical Notes list.

```quint
type OrganizeScreen = HomeScreen | NotesScreen | OtherScreen
pure def organizeContextAllowed(kind: OrganizeKind, screen: OrganizeScreen, sensitive: bool, canonicalList: bool): bool =
  not(sensitive) and (
    if (kind == FilterCanonicalList) screen == NotesScreen and canonicalList
    else if (kind == RecordVoice) screen == NotesScreen
    else screen == HomeScreen or screen == NotesScreen)
pure def lawSensitiveScreenAdmitsNothing(kind: OrganizeKind, screen: OrganizeScreen, canonicalList: bool): bool =
  not(organizeContextAllowed(kind, screen, true, canonicalList))
pure def lawRecordingOnlyInNotes(screen: OrganizeScreen, canonicalList: bool): bool =
  organizeContextAllowed(RecordVoice, screen, false, canonicalList) iff screen == NotesScreen
pure def lawHomeAdmitsReviewedChanges(kind: OrganizeKind, canonicalList: bool): bool =
  (kind == MoveNote or kind == CreateFolder or kind == RestoreNote or kind == FilterNotes) implies
    organizeContextAllowed(kind, HomeScreen, false, canonicalList)
```

### Moving, creating a folder or restoring is reviewed first; filtering and recording may run directly

Filtering and recording change no saved note, so they may run without a
separate review when the owner's own current message asked for them and no
workflow bound them. Moving a note, creating a folder and restoring a note
change saved data, so the owner reviews each first; a move is bound to the
reviewed note revision.

```quint
pure def organizeChangesSavedNotes(kind: OrganizeKind): bool = kind == MoveNote or kind == CreateFolder or kind == RestoreNote
pure def organizeRunsDirectly(kind: OrganizeKind, boundToOwnerMessage: bool, workflowBound: bool): bool =
  not(organizeChangesSavedNotes(kind)) and boundToOwnerMessage and not(workflowBound)
pure def lawSavedChangesAreReviewed(kind: OrganizeKind, boundToOwnerMessage: bool, workflowBound: bool): bool =
  organizeChangesSavedNotes(kind) implies not(organizeRunsDirectly(kind, boundToOwnerMessage, workflowBound))
```

### A folder is named by a bounded name that is unique in the device's list

A folder name collapses each run of whitespace to one space and trims it,
and is then 1 to 40 units with no NUL. The device sends at most 100 folders,
each with its own ID and a name no other folder has once case and width are
folded. A list that breaks any of these is no list: it never reads as no
folders. A filter text is 1 to 200 units with no NUL. A note keeps only its
folder's ID; clearing the folder removes it.

```quint
pure def folderNameAdmitted(units: int, hasNul: bool): bool = not(hasNul) and units >= 1 and units <= 40
pure def folderListAdmitted(count: int, uniqueIds: bool, uniqueNames: bool, namesAdmitted: bool): bool =
  count >= 0 and count <= 100 and uniqueIds and uniqueNames and namesAdmitted
pure def filterTextAdmitted(units: int, hasNul: bool): bool = not(hasNul) and units >= 1 and units <= 200
pure val unitsValues = Set(0, 1, 40, 41, 200, 201)
pure val countValues = Set(0, 100, 101)
pure def lawOverlongFolderNameRefused(units: int, hasNul: bool): bool = units > 40 implies not(folderNameAdmitted(units, hasNul))
pure def lawDuplicateFolderNamesBreakTheList(count: int, uniqueIds: bool, namesAdmitted: bool): bool =
  not(folderListAdmitted(count, uniqueIds, false, namesAdmitted))
```

### A proposed folder is one the device sent, or a new name the owner said

A move or a filter names a folder only from the folder list the device sent
with the turn, by its name there; with no list, or a name the list does not
have, nothing is proposed, and taking a note out of its folder names none.
A new folder's name is words the owner said in this message. A move is of
the phone note open in Notes, as its [read](./read.md) targets it.

```quint
type FolderUse = ListedFolder | NoFolderNamed | NewFolderName
pure def folderGrounded(folderUse: FolderUse, listSent: bool, inDeviceList: bool, inOwnerWords: bool): bool =
  if (folderUse == ListedFolder) listSent and inDeviceList
  else if (folderUse == NewFolderName) inOwnerWords
  else true
pure def lawAnUnlistedFolderIsNeverProposed(listSent: bool, inOwnerWords: bool): bool =
  not(folderGrounded(ListedFolder, listSent, false, inOwnerWords)) and not(folderGrounded(ListedFolder, false, true, inOwnerWords))
pure def lawANewFolderIsNamedByTheOwner(listSent: bool, inDeviceList: bool): bool =
  not(folderGrounded(NewFolderName, listSent, inDeviceList, false))
pure def lawNoFolderNeedsNoList(inDeviceList: bool, inOwnerWords: bool): bool = folderGrounded(NoFolderNamed, false, inDeviceList, inOwnerWords)
```
