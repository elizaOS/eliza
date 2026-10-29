# @elizaos/capacitor-owned-media

Android media and selected-document primitives for Eliza hosts: the host's own published media,
the full permitted device photo/video library, exact-byte selections and reviewed changes. Nothing
here uploads media, builds a remote index or rewrites an original; outbound use of any bytes is a
separate, explicit host action.

Owned media (items the host package published, `OWNER_PACKAGE_NAME`):

- `OwnedMediaConfig` – host configuration: a storage namespace for SharedPreferences and private
  file names, and the MediaStore `RELATIVE_PATH` and display-name prefix for photo edit copies and
  kept captures (under `Pictures/` or `DCIM/`) and, optionally, video edit copies (under `Movies/`
  or `DCIM/`). Shared code never chooses product names or folders.
- `OwnedPhotoEdits` – serial edit sessions over one still photo: quarter-turn rotation, centered
  crop and filters, previewed at most 1024 px, saved as a new owned PNG copy. Each save has a UUID
  operation identity, a receipt journal and a deterministic display name, so a crash between
  publish and receipt resolves to `saved` or `failed`, never a duplicate. The session aborts if
  the source changes (MediaStore generation and SHA-256 of the snapshot).
- `VideoCopyEdits` / `VideoEditSpec` – trim, quarter-turn rotation and centered crop of an admitted
  video with Media3 Transformer, saved as a new owned MP4. The encoder reads a frozen private
  snapshot; publication rechecks the source bytes, access and provider revision; each save has
  one durable identity. A closed failed copy can be preserved for forensics by native callers only.
- `OwnedVideoPlayback` – a `BridgeWebViewClient` that serves one host-validated video at a time
  through an opaque same-origin URL with range support. A selected library video rechecks its
  revision and access on every byte request.
- `PhotoFilter` / `PhotoFilterMath` – CSS reference filters (`vivid`, `warm`, `cool`, `mono`,
  `fade`, `noir`) in encoded sRGB with per-primitive clipping. The math is pure Java.
- `OwnedCaptures` – explicit capture publication with one durable operation identity.
- `OwnedMediaSelection` – owned, published media queries with album and trash selection, owned item
  names (`<id>` or `v:<id>`), the shared share type and custom album name rules. Pure Java.
- `OwnedMediaLibrary` – the host's published photos and videos: paged listing (all, favorites,
  videos, Recently deleted) with bounded previews, reads, favorite and trash changes that apply only
  to the listed revision and MediaStore generation and are read back, bounded per-item batches that
  report `complete` or `partial`, counts, and a two-step permanent removal of trashed items whose
  confirmation (two minutes) names each item's generation, so a restored or changed item is skipped.
  The host injects playback-grant revocation for trashed and removed videos.
- `TrashDeleteRequest` – the target of a permanent removal: `all()` only from an explicit
  empty-trash intent (`{"all": true}` on the bridge), or 1–20 named owned items with their reviewed
  revisions. A missing, null or non-list selection is refused, never read as the whole trash
  (`prepareDeleteTrash(JSONArray)` refuses null; use `prepareDeleteAllTrash()`). Pure Java.
- `OwnedAlbums` – device-local custom albums over owned and permitted items. Albums store member
  names and identities, never bytes; a changed or no longer accessible member is withheld but keeps
  its membership. Every change names the album revision, and listings hold the permitted fence.
- `MediaBytes` – exact provider readback after a write.

Full permitted library (other apps' media, as far as Android grants it):

- `PermittedMediaCatalog` – same-user, permission-filtered paging, provider search, reads,
  album membership checks and counts over every external volume. Rows are named by
  `MediaLibraryKey` (`m:<volume>:<i|v>:<id>`). Every read holds a fence over the granted scope
  (full, partial or Android 14 selected), the lock/foreground state and each volume's MediaStore
  version and generation; a changed library or revoked access refuses the read instead of
  returning stale rows. Observation runs only while a host view watches.
- `PermittedMediaReview` – one-shot native review of favorite, Recently deleted and permanent
  removal for 1–20 items: a native dialog naming every item, then Android's MediaStore write
  request. Changes apply only to the reviewed revisions after the activity resumes; recreation
  discards authority and never replays a write. Hosts inject their launch gate.
- `SelectedPhotoCopy` – exact provider-readable bytes of one selected still photo (PNG, JPEG,
  WebP, at most 5 MiB) whose revision survives the whole copy; never a thumbnail and never an
  unredacted-location request.

Selected documents:

- `SelectedDocuments` – opaque capabilities for documents chosen in Android's picker. Renderers
  hold random selection IDs, never content URIs. Only grants Android offered are persisted; a
  revoked grant is forgotten and reported, never repaired. Bounded UTF-8 text reads, local PDF
  page previews, provider rename, sharing and opening.
- `SourceReferences` / `SourceReferenceStore` – durable source links for saved items. A link is
  kept while Android holds the document's persisted read grant; a grant stays while any saved or
  restorable item names it and is released with the last one. A link no item names yet (for
  example a content question whose answer may be saved later) is kept for three days after it was
  last retained, across restarts.
- `DocumentBytes` – bounded reads, type/name/signature agreement for PDF, PNG, JPEG, WebP and
  UTF-8 text, opaque save-only copies and the bounded PDF export payload.
- `DocumentFolderTree` / `FolderSession` – one folder tree the owner chose in Android's folder
  picker, browsed through opaque entry ids in a bounded session (a folder too large for the bound
  stops listing instead of evicting its own rows). Paged listing, create, rename, move, permanent
  delete of empty folders and files, per-item batches and one share sheet; every change names the
  revision the renderer listed and deletion needs explicit confirmation. Android grants the folder
  in place: nothing is copied or imported, and no broad storage permission is used. Choosing
  another tree releases only the previous tree's grant.
- `SelectedDocumentCalls` – the bridge contract of `SelectedDocuments` (restore, describe, rename,
  PDF page, read, open, share, forget by opaque `selectionId`), so a host plugin keeps its own
  plugin and method names and delegates each method.
- `DocumentExport` / `DocumentDestinations` – owner-chosen import and export: strict UTF-8 text up
  to 64 KiB, safe file titles, Android's open/create document pickers and a write that reads the
  bytes back. An export that reached the provider and could not be confirmed is `unverified`,
  never `failed`. `DocumentExport` is pure Java.
- `ReviewedFileHandoff` – one temporary read-only copy of reviewed bytes for one viewer, through
  the host's FileProvider; the host injects the authority, cache folder and provider path name.
  A new copy revokes and deletes the previous one.
- `IsolatedPdfRenderService` / `IsolatedPdfViewerActivity` / `PdfPageLimits` – untrusted PDF pages
  rendered in a permissionless isolated process into read-only shared memory, and a viewer that
  maps those pixels only after checking the reply came from a different, isolated,
  network-denied uid within the size limits. The renderer ends its process past a 10 s deadline
  or 128 MiB PSS. The host declares concrete subclasses (the service with
  `android:isolatedProcess="true"`) and says which sources the viewer admits.

Recordings:

- `RecordingStore` – durable device-local recordings (for example voice notes) whose metadata
  lives in the host's encrypted slot store. Only a native recorder can hand a stopped clip to it;
  renderers name recordings by id and never see paths or bytes. Deletion is two-step and fenced by
  the owning item and one operation identity: `remove` trashes, only the same operation can
  `restore` or `purge`, every answer is a durable receipt and a retired operation never regains
  permission. Older plaintext metadata migrates into the slot only after the slot reads back.

The Android library has no components and declares no permissions. A host that uses the
permitted catalog declares `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO`,
`READ_MEDIA_VISUAL_USER_SELECTED` (and `READ_EXTERNAL_STORAGE` up to API 32) itself and requests
them only from an explicit user action.

```bash
bun run --cwd plugins/plugin-native-media test   # JVM checks and real Android consumer compilation
```

## Host integration (Android)

Include the Gradle module (for example `:eliza-owned-media`) and build one configuration:

```java
OwnedMediaConfig config = OwnedMediaConfig.builder("myapp")
    .edits("Pictures/My App/Edits/", "MyApp-edit-")
    .captures("Pictures/", "SCAN_")
    .videoEdits("Movies/My App/Edits/", "MyApp-video-edit-")
    .build();
OwnedPhotoEdits edits = new OwnedPhotoEdits(context, config);
PermittedMediaCatalog library = new PermittedMediaCatalog(context, false, onLibraryChanged);
PermittedMediaReview review = new PermittedMediaReview(bridge, library, worker);
VideoCopyEdits videos = new VideoCopyEdits(context, config, admittedSources, editorFocused);
OwnedVideoPlayback playback = new OwnedVideoPlayback(bridge, "/_myapp_owned_video/");
bridge.setWebViewClient(playback);
SourceReferenceStore links =
    new SourceReferenceStore(context, "myapp-source-references", "myapp-source-reference-times");
SelectedDocuments documents =
    new SelectedDocuments(context, "myapp-selected-documents", "myapp-document-", links::retains);
DocumentFolderTree folders =
    new DocumentFolderTree(context, "myapp-files-tree", uri -> documents.authorize(uri, 0));
ReviewedFileHandoff handoff = new ReviewedFileHandoff(
    context, context.getPackageName() + ".attachments", "attachments", "attachments");
RecordingStore recordings = new RecordingStore(
    new File(context.getNoBackupFilesDir(), "recordings"), "myapp-recording:v1:", "ownerId", slots);
```

An isolated PDF viewer is two host components:

```java
public final class MyPdfService extends IsolatedPdfRenderService {}
public final class MyPdfActivity extends IsolatedPdfViewerActivity {
  @Override protected Class<? extends IsolatedPdfRenderService> renderer() { return MyPdfService.class; }
  @Override protected boolean admits(Uri source) { return handoff(this).admits(source); }
}
```

```xml
<activity android:name=".MyPdfActivity" android:exported="false" />
<service android:name=".MyPdfService" android:exported="false" android:isolatedProcess="true"
    android:process=":isolated_pdf" android:stopWithTask="true" />
```

`DocumentFolderTree` methods run on one serial worker through `guarded(...)`; launch
`DocumentFolderTree.pickerIntent()` from the host's own activity-result path and pass the result to
`adopt(uri, flags)`. `RecordingStore.Slots` is the host's encrypted store (for example a
Keystore-backed slot store); playback, recorders and any background sweep of the owning items stay
host code and call the store, which serializes every change on one process-wide lock.

Call `OwnedPhotoEdits` from one serial worker thread. Preference names are
`<namespace>-photo-edit-results` and `<namespace>-video-copy-results-v1`, and the video snapshot
directory is `<namespace>-video-edits` in the host cache, so a host that already stored receipts
under those names keeps them. Keep one `PermittedMediaCatalog`, one `PermittedMediaReview` and one
`SelectedDocuments` per process; pass the catalog's foreground state from the host's activity
lifecycle. Installed hosts keep their existing preference names, folders and path prefixes.

## Validation

Tests require JDK 21, an Android SDK through `ANDROID_HOME`, and Gradle 8.13
through `GRADLE_BIN` (or `gradle` on PATH). The consumer uses the installed
Capacitor Android dependency; `CAPACITOR_ANDROID_DIR` can select a host module.
Compiling the APKs is not a device execution result. To run the consumer on an
isolated Android test device, install its host and test APKs, then run
`adb shell am instrument -w example.ownedmedia.host.test/androidx.test.runner.AndroidJUnitRunner`.
The tests create and remove synthetic MediaStore items owned by the fixture app and grant the
fixture its media read permissions.

Capture operations reserve their identity and image hash before insertion. A
retry resolves a published item instead of inserting another. An incomplete
pending item is removed and is not silently retried. Unknown provider outcomes
remain unconfirmed. Capture and edit receipts are retained; saving a new edit
does not evict older receipts. A confirmed edit-save receipt stays successful
after the user renames or deletes the resulting copy.
