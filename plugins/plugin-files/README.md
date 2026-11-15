# @elizaos/plugin-files

Managed browser files with transactional revisions, selected-file capabilities,
exact-byte import/export, and atomic workflow receipts. Native filesystem access
continues to belong to plugin-native-filesystem.

Hosts call `createBrowserFiles` with their persistent database name, PDF worker
and asset URLs, cancellable picker, and sandboxed document viewer. Configure once
per storage domain and register the returned class through the host's shared
Capacitor registry. Do not rename an existing database without a data migration.
The factory does not register plugins, choose account authority, or mount UI.

The Files agent runner can open or filter from a cold host view. Pass a callback
that resolves after the host commits and renders Files. The open action reads
storage permission independently of the view refresh. Leaving Files or
cancelling the action retires its pending selection and releases any late grant.
Changes to files still require the owner to review them in the active Files view.
`files_open` also accepts `shown`, the position of an item in the filter results on
screen; the view binds that displayed result across permission and selection
waits, so the filter still returns only a count. Filters remain until explicitly
cleared. An incomplete search fails explicitly while retaining its visible rows;
storage hosts must return `truncated: false` only for a complete query. Missing
completeness metadata is treated as incomplete, including legacy native queries;
returned rows remain available for selection without claiming there are no matches.

Move, copy, Trash and Undo admit at most 500 paths per storage call. Leaving the
view fences their later calls; confirmed Trash outcomes remain available for Undo,
and an unknown later outcome is reported without retry. Browser sharing includes
every selected file and folder in the existing exact-byte archive flow.

A host storage port can implement `storageOpen` to hand a file to another app.
Files then opens types it cannot preview (video, audio, office files) that way and
gives the preview `pv.canOpenWith` and `pv.openWith`. Host templates can render the
view output: `toolbar.disabled` and `toolbar.canSort`, `browse.loading` and
`browse.deniedText`, `fd.loading`, `fd.emptyText` and `fd.note` (a listing that is
only part of the folder), `filterEmptyText`, `filterLoading`, `filterNote` and
`loadingText`.
These optional bindings need consumer adoption; controller guards also apply
when an existing template does not render them.

The `documents/*` exports provide scan correction and edge suggestions, reviewed
text-layer validation, PDF generation, local OCR and revisioned draft persistence.
The host supplies PDF metadata, an OCR worker/assets URL and language, and the
draft database name. OCR uses the Tesseract 7 worker protocol; host the worker,
WASM and language data together. The caller owns scan cancellation; no elapsed-time
deadline or remote OCR service is selected implicitly.

`documents/scan-event` suggests a calendar event from locally recognized poster
or flyer text: explicit English dates, times, same-day ranges and labeled
venues; with a reference instant and device zone, also year-less and weekday
dates, today/tomorrow and printed IANA or UTC-offset times (converted, with the
source zone shown), all-day for dated posters without a time and an unticked
repeat hint. Every inference is returned as a disclosure. Ambiguous numeric
dates, conflicting dates or weekdays and zone abbreviations stay blank.
`reviewScanEvent` and `reviewScanAllDayEvent` validate the owner's reviewed
fields into a provider-neutral proposal; nothing here saves. The host's own
calendar review and Save remain the only write.

`documents/source-links` validates the source link a saved item (such as a
summary note) keeps: a selected document named by its exact bytes and, on
Android, an `a1:` reference whose read grant the native media module retains
while any saved or restorable item names it (unsaved links are kept three days);
a credential-free HTTPS page the host's reading policy allows; or an exact
recording revision. `retainedSourceReferences` lists the references saved and
restorable items still name, for the native reference store's reconciliation.

Run `bun run typecheck`, `bun run test`, `bun run lint:check`, and `bun run build`
in this package. Consumer qualification
must exercise IndexedDB transactions, stale selections, cancellation, restart
receipts and exact-byte file flows in a real browser.
