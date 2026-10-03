# @elizaos/plugin-workflow

Native Smithers workflow authoring and execution through the Eliza runtime.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-workflow build  # build
bun run --cwd plugins/plugin-workflow test   # tests
```

## Portable approval presentation

Workflow authors may supply `request.metadata.approvalPresentation` with `version: 1`, `operation`, `target`, and `account` strings. Keep `request.title` and `request.summary` as the human review heading and explanation. The receipt API bounds these fields and only supports its existing simple approval modes; adding presentation metadata does not authorize execution or relax owner/version checks.

```ts
metadata: {
  approvalPresentation: {
    version: 1,
    operation: "Compute",
    target: "Selected result",
    account: "Workflow owner",
  },
}
```

Legacy `metadata.alphaPhone` remains readable only when `approvalPresentation` is absent. An explicitly malformed value or unsupported version must not fall back to legacy metadata: it produces an unsupported receipt, and an attempted approval is rejected with HTTP422 while the approval stays pending. Generic presentation takes precedence when both fields are present. The request digest remains bound to the original full serialized canonical request; presentation selection does not rewrite it or remove legacy fields from the digest.

Workflow status advertises `approvalPresentationProtocol: 1` alongside `approvalReceiptProtocol: 1`. The authoring prompt instructs use of concrete truthful version1 fields and forbids inventing an account. Missing details require clarification before authoring an executable action. Unsupported custom options, allowed users/scopes, or auto-approval restrictions must not be stripped to fit the portable surface; deny or review those workflows out of band.

Unsupported presentation still permits an explicit denial; it does not authorize approval or require the user to leave an unsupported request permanently pending.


### Generated draft semantic validation

Generated and modified drafts are checked against the pinned Smithers TypeScript API before they are returned. The checker runs a trusted compiler child, never imports or executes the draft, ignores user compiler configuration, and allows only the documented Smithers/Zod imports. TypeScript suppression and reference directives are rejected. Source is limited to 64 KiB, compiler output to 16 KiB, compiler runtime to 15 seconds, and Node old-space heap to 512 MiB (not a total-process RSS cap). Node must be available on the service PATH. TypeScript and declaration dependencies are production dependencies so this behavior is not dependent on a development installation.

One model repair is permitted for semantic diagnostics; compiler availability/resource failures return a service error without model repair. Failed drafts are not deployed, activated, scheduled, or executed. A passing check is type compatibility only: existing approval restrictions, authorization checks, and runtime controls still apply. Manually stored legacy source is outside this initial authoring-only gate.

### Packaged workflow process hosts

Trusted native bootstrap may install `configureWorkflowProcessHost` before the first workflow child dispatch. It accepts separately pinned runtime/compiler executables and prefix files (for example, a packaged musl loader followed by Bun), a canonical dependency root, pinned compiler module and native library directories. Configuration is copied, immutable and cannot be changed after dispatch. Executable and prefix hashes are rechecked before each child. Configured Bun children use `--no-install`; missing dependencies fail instead of fetching packages. No HTTP route or workflow input configures this descriptor. Hosts remain responsible for the complete dependency-artifact manifest and immutable extraction.

Without configuration, Node semantic checking and Bun worker/control/approval commands retain their existing arguments and environment. A Bun compiler host keeps the source/output/time limits but does **not** inherit Node's 512 MiB old-space flag; its memory/resource policy needs separate platform qualification. This process contract does not package or enable a mobile workflow engine, sandbox workflow code, or establish Android support.

For offline packaging discovery, run `node packages/scripts/plugins/plugin-workflow/inventory-mobile-dependencies.ts` from the repository root after the pinned installation. It reports the physical declared dependency/peer graph, separate installed versions, missing edges and platform constraints without executing packages. This conservative inventory is not a minimal runtime closure or an authenticated mobile artifact; package contents, target binaries, declarations, safe extraction and real Android execution still require qualification.

A host may supply `compilerDependencyRoot` for a separate immutable compiler/declaration artifact; it defaults to the runtime `dependencyRoot`. Semantic checking anchors imports and type roots there while execution links stay on the runtime artifact. Both artifacts must describe the same supported workflow API. Host-owned workflow dependency symlinks are refreshed atomically when an artifact path changes; unexpected files/directories are rejected and preserved. This is private-directory maintenance, not protection against a hostile same-UID writer.

### Android immutable source publication

Android runtimes selected by `ELIZA_PLATFORM=android` or `ELIZA_MOBILE_PLATFORM=android` publish complete versioned source through a private directory reservation and same-directory rename, without requiring hard links in app data. Existing identical source is reused; conflicting bytes, nonprivate files and untrusted paths are rejected. A crashed reservation is preserved and causes a bounded refusal rather than being stolen. This coordinates cooperating publishers in one trusted app UID; it is not isolation from arbitrary hostile code with that UID.

The filesystem integration tests exercise multiple real writer processes, concurrent readers, conflicting versions, symlink/permission rejection and abandoned reservations. Runtime dispatch tests exercise both environment aliases. Passing these tests on a POSIX development host does not qualify Android filesystem durability or power-loss recovery. The Windows backend and desktop hard-link publisher remain separate.

### Typed phone draft generation

`POST /api/workflow/phone/generate` accepts a prompt, selected operation IDs,
current catalog/compiler revisions, and optional existing typed draft and device
enrollment. The phone catalog advertises `generationProtocol: 1`. A text model
must be available; enrollment is validated for the authenticated workflow owner
before model submission and again before returning the draft.

The result is an inactive, unsaved typed spec with its digest and required reviews.
Generation never creates workflows, schedules, executions, or device approvals.
Notes and Calendar read scopes must match a previously selected draft scope;
model-supplied device identities, source code and activation are rejected. An
unsupported request returns a clarification error. Saving remains a separate,
explicit typed mutation. This endpoint does not enable mobile workflow execution.
