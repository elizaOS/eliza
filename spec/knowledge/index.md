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

Only the owner of a non-removed document may manage its pins, audience, text,
or deletion. Bundled and character-sourced documents cannot be edited or
deleted, and non-text-backed documents cannot be edited as text. Uploads must
carry a supported content type and stay within the 32 MB body limit.

```quint
type DocumentProvenance = UploadedDocument | UrlDocument | BundledDocument | CharacterDocument | TranscriptDocument | NoteDocument
pure val maxDocumentUploadBytes: int = 33554432
pure def documentManageable(row: KnowledgeDocument, viewer: str): bool =
  viewer != "" and viewer == row.documentOwner and row.documentState != RemovedDocument
pure def documentEditable(provenance: DocumentProvenance, textBacked: bool): bool =
  provenance != BundledDocument and provenance != CharacterDocument and textBacked
pure def documentDeletable(provenance: DocumentProvenance): bool =
  provenance != BundledDocument and provenance != CharacterDocument
pure def uploadAdmitted(bodyBytes: int, contentTypeSupported: bool): bool =
  bodyBytes > 0 and bodyBytes <= maxDocumentUploadBytes and contentTypeSupported
pure def lawDocumentManagementRequiresOwnership(row: KnowledgeDocument, viewer: str): bool =
  documentManageable(row, viewer) implies viewer == row.documentOwner
pure def lawBundledAndCharacterNeverEditable(textBacked: bool): bool =
  not(documentEditable(BundledDocument, textBacked)) and not(documentEditable(CharacterDocument, textBacked))
pure def lawBinaryNeverEditable(provenance: DocumentProvenance): bool =
  not(documentEditable(provenance, false))
pure def lawBundledAndCharacterNeverDeletable(provenance: DocumentProvenance): bool =
  (provenance == BundledDocument or provenance == CharacterDocument) implies not(documentDeletable(provenance))
pure def lawOversizedUploadRefused(bodyBytes: int, contentTypeSupported: bool): bool =
  bodyBytes > maxDocumentUploadBytes implies not(uploadAdmitted(bodyBytes, contentTypeSupported))
pure val bodyBytesValues = Set(0, 1024, 33554432, 33554433)
pure val rowValues = Set({ docId: "d1", documentOwner: "owner", documentScope: OwnerDocument, audience: Set(), documentState: ReadyDocument, title: "Notes" }, { docId: "d2", documentOwner: "other", documentScope: SharedDocument, audience: Set("owner"), documentState: IndexingDocument, title: "Shared" })
pure val rowsValues = Set(List(), List({ docId: "d1", documentOwner: "owner", documentScope: OwnerDocument, audience: Set(), documentState: ReadyDocument, title: "Notes" }, { docId: "d2", documentOwner: "other", documentScope: SharedDocument, audience: Set("owner"), documentState: IndexingDocument, title: "Shared" }))
```
