# Knowledge document views

## Story: Find and manage the documents I am allowed to use

> As a viewer, I can browse and open accessible documents; as the owner of a document, I can manage its pins and sharing.

### Access follows the document owner, the resolved sharing audience, and the document's removal state

The shell uses the same resolved principal for a list, a detail request, and retrieval. Its authenticated principal is independent of request body fields. Documents still being indexed can be opened when readable; only indexed documents can contribute to retrieval.

```quint
type DocumentScope = OwnerDocument | SharedDocument | PublicDocument
type DocumentState = IndexingDocument | ReadyDocument | FailedDocument | RemovedDocument
type KnowledgeDocument = { docId: str, documentOwner: str, documentScope: DocumentScope, audience: Set[str], documentState: DocumentState, title: str }
pure def documentReadable(row: KnowledgeDocument, viewer: str): bool =
  row.documentState != RemovedDocument and viewer != "" and
  (row.documentOwner == viewer or row.documentScope == PublicDocument or
  (row.documentScope == SharedDocument and row.audience.contains(viewer)))
pure def visibleDocuments(rows: List[KnowledgeDocument], viewer: str): List[KnowledgeDocument] =
  rows.select(row => documentReadable(row, viewer))
pure def searchableDocuments(rows: List[KnowledgeDocument], viewer: str): List[KnowledgeDocument] =
  rows.select(row => documentReadable(row, viewer) and row.documentState == ReadyDocument)
pure def lawPrivateDocumentStaysWithItsOwner(row: KnowledgeDocument, viewer: str): bool =
  (row.documentScope == OwnerDocument and documentReadable(row, viewer)) implies row.documentOwner == viewer
pure def lawRetrievedDocumentsAreReady(rows: List[KnowledgeDocument], viewer: str): bool =
  searchableDocuments(rows, viewer).every(row => row.documentState == ReadyDocument and documentReadable(row, viewer))
```

### Ownership is required for changes to a document or its audience

```quint
pure def documentManageable(row: KnowledgeDocument, viewer: str): bool =
  viewer != "" and viewer == row.documentOwner and row.documentState != RemovedDocument
pure def lawDocumentManagementRequiresOwnership(row: KnowledgeDocument, viewer: str): bool =
  documentManageable(row, viewer) implies viewer == row.documentOwner
pure val rowValues = Set({ docId: "d1", documentOwner: "owner", documentScope: OwnerDocument, audience: Set(), documentState: ReadyDocument, title: "Notes" }, { docId: "d2", documentOwner: "other", documentScope: SharedDocument, audience: Set("owner"), documentState: IndexingDocument, title: "Shared" })
pure val rowsValues = Set(List(), List({ docId: "d1", documentOwner: "owner", documentScope: OwnerDocument, audience: Set(), documentState: ReadyDocument, title: "Notes" }, { docId: "d2", documentOwner: "other", documentScope: SharedDocument, audience: Set("owner"), documentState: IndexingDocument, title: "Shared" }))
```
