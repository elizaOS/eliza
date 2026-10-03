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
