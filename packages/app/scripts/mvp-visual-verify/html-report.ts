/**
 * Renders visual-verification results as a standalone contact sheet. All
 * report strings cross one HTML boundary here, while style values use a
 * narrower allowlist instead of HTML escaping.
 */

export function escapeContactSheetHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function contactSheetSwatchColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : "transparent";
}

function contactSheetCheckClass(value) {
  return value === "pass" || value === "fail" || value === "skip"
    ? value
    : "unknown";
}

export function renderContactSheet(summary, results) {
  const rows = results
    .map((result) => {
      const swatches = result.palette.swatches
        .map(
          (swatch) =>
            `<span class="sw" title="${escapeContactSheetHtml(swatch.hex)} ${escapeContactSheetHtml(swatch.bucket)} ${(swatch.ratio * 100).toFixed(1)}%" style="background:${contactSheetSwatchColor(swatch.hex)}">${(swatch.ratio * 100).toFixed(0)}</span>`,
        )
        .join("");
      const verdict = result.expectation.pass
        ? '<span class="pass">PASS</span>'
        : '<span class="fail">FAIL</span>';
      const checks = result.expectation.checks
        .map(
          (check) =>
            `<div class="chk ${contactSheetCheckClass(check.status)}">${escapeContactSheetHtml(check.name)}: ${escapeContactSheetHtml(check.detail)}</div>`,
        )
        .join("");
      const ocrCell = result.ocr.available
        ? `<div class="ocr">${escapeContactSheetHtml(result.ocr.text || "(no glyphs)")}</div><div class="meta">${escapeContactSheetHtml(result.ocr.words)} words</div>`
        : `<div class="na">N/A — ${escapeContactSheetHtml(result.ocr.reason)}</div>`;
      const diffCell =
        result.diff.status === "new"
          ? '<span class="new">NEW baseline</span>'
          : `${escapeContactSheetHtml(result.diff.changedPercent)}% changed${result.diff.resized ? " (resized)" : ""}${result.diff.diffPng ? `<br><img class="thumb" src="${escapeContactSheetHtml(result.diff.diffPng)}">` : ""}`;
      return `<tr class="${result.expectation.pass ? "" : "row-fail"}">
        <td class="slug">${escapeContactSheetHtml(result.slug)}<br><span class="meta">${escapeContactSheetHtml(result.viewport)}</span></td>
        <td><img class="thumb" src="${escapeContactSheetHtml(result.screenshot)}" loading="lazy"></td>
        <td>${ocrCell}</td>
        <td class="pal">${swatches}<div class="meta">${Object.entries(
          result.palette.buckets,
        )
          .map(
            ([key, value]) =>
              `${escapeContactSheetHtml(key)} ${escapeContactSheetHtml((value * 100).toFixed(0))}%`,
          )
          .join(" · ")}</div></td>
        <td class="diff">${diffCell}</td>
        <td>${verdict}<div class="checks">${checks}</div></td>
      </tr>`;
    })
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>mvp visual verify</title>
<style>
  body{font:13px system-ui,sans-serif;margin:16px;color:#1a1a1a;background:#faf9f7}
  h1{font-size:18px} .summary{margin:8px 0 16px;padding:8px 12px;background:#fff;border:1px solid #e5e0d8;border-radius:6px}
  table{border-collapse:collapse;width:100%} td,th{border:1px solid #e5e0d8;padding:6px;vertical-align:top;text-align:left}
  th{background:#f0ece5;position:sticky;top:0}
  .thumb{max-width:260px;max-height:180px;border:1px solid #ddd}
  .slug{font-weight:600;white-space:nowrap} .meta{color:#8a8378;font-size:11px}
  .ocr{max-width:280px;max-height:160px;overflow:auto;font-size:11px;white-space:pre-wrap;color:#444}
  .sw{display:inline-block;width:26px;height:26px;line-height:26px;text-align:center;font-size:9px;color:#000;mix-blend-mode:difference;border:1px solid #ccc;margin:1px}
  .pass{color:#0a7d3c;font-weight:700} .fail{color:#c0392b;font-weight:700} .na{color:#b58900}
  .row-fail{background:#fff4f2} .checks{margin-top:4px}
  .chk{font-size:11px;padding:1px 0} .chk.pass{color:#0a7d3c} .chk.fail{color:#c0392b} .chk.skip{color:#8a8378}
  .new{color:#b58900;font-weight:600} .missing{margin-top:6px;color:#c0392b;font-weight:600}
</style>
<h1>mvp visual verify</h1>
<div class="summary">
  ${escapeContactSheetHtml(summary.states)} states · OCR: ${escapeContactSheetHtml(summary.ocrEngine)} · expectation failures: <b>${escapeContactSheetHtml(summary.expectationFailures)}</b> ·
  skipped checks: <b>${escapeContactSheetHtml(summary.expectationSkips)}</b> · missing required states: <b>${escapeContactSheetHtml(summary.missingRequiredStates.length)}</b> · overflow states: <b>${escapeContactSheetHtml(summary.overflowStates)}</b> ·
  new baselines: ${escapeContactSheetHtml(summary.newBaselines)} · audit report: ${summary.auditReportPresent ? "loaded" : "ABSENT"} ·
  baseline: ${escapeContactSheetHtml(summary.baselineDir)} · ${escapeContactSheetHtml(summary.generatedAt)}
  ${
    summary.missingRequiredStates.length
      ? `<div class="missing">Missing required: ${escapeContactSheetHtml(
          summary.missingRequiredStates
            .map((state) =>
              state.viewport ? `${state.slug}@${state.viewport}` : state.slug,
            )
            .join(", "),
        )}</div>`
      : ""
  }
</div>
<table>
  <tr><th>state</th><th>screenshot</th><th>OCR text</th><th>palette</th><th>diff vs baseline</th><th>expectations</th></tr>
  ${rows}
</table>`;
}
