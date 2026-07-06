# Pixel-truth OCR triage for the all-views audit

The aesthetic audit (`test/ui-smoke/all-views-aesthetic-audit.spec.ts`) captures a
screenshot of every view and scores it from the **DOM**: readable-char count,
color buckets, divider density, whitespace. Those metrics never see what actually
_painted_. A view can carry a full DOM subtree and still render blank, leak a
developer string a user should never read (`[object Object]`, `undefined`, an
unresolved `{{token}}`), or be missing the one label it exists to show — and the
DOM audit calls it `good`.

This stage reads the **pixels**. It OCRs each captured screenshot with the
packaged `tesseract.js` dependency, runs content rules over the recognized text,
and cross-checks the result against the DOM verdict already in `report.json`.
The OCR engine is installed by the normal workspace `bun install`; if it is
missing or cannot initialize, the gate fails instead of skipping the check.

## What it produces

- **Verifications** — a view whose pixels contain every label it's supposed to
  show earns a positive `verified`, retiring it from the manual `needs-eyeball`
  pile instead of leaving a human to squint at it.
- **Regressions** — a view the DOM audit passed (`good`/`needs-eyeball`) whose
  pixels are broken: blank paint, a developer-string leak, an unresolved
  placeholder, or a missing required label. These are the bugs the DOM metrics
  structurally cannot see (a crash caught by an error boundary and _rendered_
  moves neither `consoleErrors` nor `readableChars`).

## Files

| File | Role |
|------|------|
| `scripts/mvp-visual-verify/ocr.mjs` | Shared OCR engine resolver. Prefers packaged `tesseract.js`, with an explicit system `tesseract` fallback for debugging. |
| `test/ui-smoke/ocr-content-rules.ts` | Pure, dependency-free verdict rules (blank / dev-string / placeholder / expectation). Unit-tested; no OCR engine, no `page`, no fs. |
| `test/ui-smoke/ocr-view-expectations.ts` | Per-builtin-view expectation manifest (required/forbidden on-screen labels), seeded from the real OCR of a healthy capture. |
| `test/ui-smoke/ocr-triage-baseline.json` | `slug::viewport` of pixel-broken renders already tracked by an issue. Ratchet posture: known debt is reported but non-gating; a NEW pixel-broken render fails the gate. |
| `scripts/ocr-triage.ts` | CLI: OCRs a capture dir, applies the rules, cross-checks `report.json`, writes `ocr-triage.json`, exits non-zero on a new regression. |
| `test/audit/ocr-content-rules.test.ts` | Unit tests for the rules module. |

## Run

```bash
# After an audit run has populated aesthetic-audit-output/ (screenshots + report.json):
bun scripts/ocr-triage.ts \
  --audit-dir aesthetic-audit-output \
  --baseline test/ui-smoke/ocr-triage-baseline.json

# Reuse a precomputed OCR pass instead of re-running OCR:
bun scripts/ocr-triage.ts --audit-dir <dir> --ocr <ocr.ndjson> --baseline <file>
```

Exit `0` when no new regression; `1` when a view regressed off the baseline. Wire
the invocation into the audit lane after the Playwright capture so a new
pixel-broken render fails CI the way a new DOM `broken` already does.

## Adding an expectation

Add an entry to `VIEW_EXPECTATIONS` keyed by the capture slug. Prefer short,
high-contrast chrome labels that OCR reliably; use `requireAny` for states that
legitimately vary (time-of-day greeting, empty-vs-populated). A view with no entry
is still checked for the universal defects (blank, dev-string, placeholder).

## Baseline discipline

A `slug::viewport` goes in the baseline only with an accompanying issue link in
the file's `tracking` map. Removing an entry once the render is fixed re-arms the
gate for that view. Never baseline a new regression to make CI green — that is the
one move the ratchet exists to prevent.
