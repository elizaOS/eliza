# Documents

The knowledge plugin, folded into the agent, stores the documents the agent
can search and cite through `plugins/plugin-knowledge/src/routes.ts`;
persistence and search are the runtime's document service. This spec owns
who may write or delete a document in each scope, the upload size limit, the
exact text round trip of an admitted document, and what a bounded search
returns. [Core retrieval](../core/retrievalIndex.md) owns ranking.

## Story: Keep a document exactly as I saved it, and let only its owner change it

> As a user, a document I upload keeps its text exactly, including spacing,
> when I open it and save it again or close it without saving. Only someone
> with authority over its scope can write or delete it, and an upload over the
> size limit is refused.

### Each scope has its own writers, and the body has a size limit

Global and owner-private documents are written only by the owner or an
admin. Agent-private documents also accept the agent and its runtime. A
user-private document is written by the user it belongs to, or by any role
above a user. A guest writes nothing. An upload body is at most 32 MiB.

```quint
type DocumentScope = GlobalScope | OwnerPrivate | AgentPrivate | UserPrivate
type DocumentRole = OwnerRole | AdminRole | AgentRole | RuntimeRole | UserRole | GuestRole
pure val maxBodyBytes = 33554432
pure def mayWrite(role: DocumentRole, scope: DocumentScope, ownEntity: bool): bool =
  if (scope == GlobalScope or scope == OwnerPrivate) role == OwnerRole or role == AdminRole
  else if (scope == AgentPrivate) role == OwnerRole or role == AdminRole or role == AgentRole or role == RuntimeRole
  else role != GuestRole and (ownEntity or role != UserRole)
pure def lawUsersNeverWriteSharedScopes(scope: DocumentScope, ownEntity: bool): bool =
  scope != UserPrivate implies not(mayWrite(UserRole, scope, ownEntity))
pure def lawGuestsNeverWrite(scope: DocumentScope, ownEntity: bool): bool = not(mayWrite(GuestRole, scope, ownEntity))
pure def lawUsersWriteOnlyTheirOwnPrivateDocuments(ownEntity: bool): bool =
  mayWrite(UserRole, UserPrivate, ownEntity) == ownEntity
```

### An admitted document's text round-trips exactly

An upload within the limit and the uploader's authority stores the text as
given. Opening it shows exactly the saved text. Saving returns that text
unchanged and is requested once; closing without saving writes nothing.

```quint
type EditPhase = NotOpened | Opened | Closed
type KnowledgeDocument = { present: bool, scope: DocumentScope, savedText: str, original: str, observed: str, phase: EditPhase, saveRequests: int, deleted: bool }
pure val initial: KnowledgeDocument = { present: false, scope: GlobalScope, savedText: "", original: "", observed: "", phase: NotOpened, saveRequests: 0, deleted: false }
pure val textValues = Set("# Runbook  Restart the worker.", "  Keep this spacing.  ", "Cafe at Tokyo station")
pure val bodyBytesValues = Set(0, 64, 33554432, 33554433)
pure def canUpload(d: KnowledgeDocument, role: DocumentRole, scope: DocumentScope, ownEntity: bool, bodyBytes: int, text: str): bool =
  not(d.present) and not(d.deleted) and bodyBytes > 0 and bodyBytes <= maxBodyBytes and mayWrite(role, scope, ownEntity)
pure def upload(d: KnowledgeDocument, role: DocumentRole, scope: DocumentScope, ownEntity: bool, bodyBytes: int, text: str): KnowledgeDocument =
  { ...d, present: true, scope: scope, savedText: text, original: text }
pure def canOpenDocument(d: KnowledgeDocument): bool = d.present and d.phase != Opened
pure def openDocument(d: KnowledgeDocument): KnowledgeDocument = { ...d, phase: Opened, observed: d.savedText }
pure def canSaveUnchanged(d: KnowledgeDocument): bool = d.present and d.phase == Opened and d.saveRequests == 0
pure def saveUnchanged(d: KnowledgeDocument): KnowledgeDocument = { ...d, phase: Closed, savedText: d.observed, saveRequests: d.saveRequests + 1 }
pure def canCloseWithoutSaving(d: KnowledgeDocument): bool = d.phase == Opened
pure def closeWithoutSaving(d: KnowledgeDocument): KnowledgeDocument = { ...d, phase: Closed }
pure def alwaysStoredTextIsExact(d: KnowledgeDocument): bool = d.present implies d.savedText == d.original
pure def alwaysShownTextIsExact(d: KnowledgeDocument): bool = d.phase != NotOpened implies d.observed == d.original
pure def alwaysAtMostOneSave(d: KnowledgeDocument): bool = d.saveRequests >= 0 and d.saveRequests <= 1
pure def sometimesSavedRoundTrip(d: KnowledgeDocument): bool = d.present and d.saveRequests == 1 and d.phase == Closed
```

### Deleting needs authority over the document's scope

A document is deleted only by a role that may write its scope, and only when
the service reports it deletable. A deleted document is gone for good.

```quint
pure def canDeleteDocument(d: KnowledgeDocument, role: DocumentRole, ownEntity: bool, deletable: bool): bool =
  d.present and deletable and mayWrite(role, d.scope, ownEntity)
pure def deleteDocument(d: KnowledgeDocument, role: DocumentRole, ownEntity: bool, deletable: bool): KnowledgeDocument = { ...d, present: false, deleted: true, phase: NotOpened }
pure def stepDeletedDocumentStaysDeleted(before: KnowledgeDocument, after: KnowledgeDocument): bool = before.deleted implies (after.deleted and not(after.present))
pure def sometimesDeletedByItsOwner(d: KnowledgeDocument): bool = d.deleted and d.scope == OwnerPrivate
```

## Story: Search all of my documents, a page at a time

> As a user, a search counts every document I may read that matches, and
> shows me one bounded page of them.

### A search page is a bounded slice of the complete match set

The total is the number of readable documents that match, counted over the
whole store and not over a page. A page starts at the offset and holds at most
the limit; a non-positive limit returns an empty page.

```quint
pure def pageLength(total: int, offset: int, limit: int): int = {
  val remaining = if (offset >= total) 0 else total - offset
  if (limit <= 0) 0 else if (remaining < limit) remaining else limit
}
pure val totalValues = Set(0, 1, 5, 120)
pure val offsetValues = Set(0, 3, 120)
pure val limitValues = Set(-1, 0, 2, 50)
pure def lawPageIsBounded(total: int, offset: int, limit: int): bool =
  (total >= 0 and offset >= 0) implies (pageLength(total, offset, limit) >= 0 and pageLength(total, offset, limit) <= total and (limit <= 0 or pageLength(total, offset, limit) <= limit))
pure def lawNonPositiveLimitReturnsNothing(total: int, offset: int, limit: int): bool = limit <= 0 implies pageLength(total, offset, limit) == 0
pure def lawPagesCoverTheTotal(total: int, limit: int): bool =
  (total >= 0 and limit > 0) implies pageLength(total, 0, limit) == (if (total < limit) total else limit)
```
