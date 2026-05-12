"""progress_report.py — render a self-contained HTML chart of a training
run's progress curve from the JSONL files written by `eval_loop.sh` and
`checkpoint_sync_loop.sh`.

This is the standalone CLI fallback for when the Eliza Cloud UI isn't
running. The cloud UI reads the same `_progress.jsonl` and `_pull-log.jsonl`
files, so this script and the cloud view stay in sync without either side
having to import from the other.

Args:
  --run-name <name>     (required) — must match the run name passed to
                         checkpoint_sync_loop.sh / eval_loop.sh.
  --out <path>          Default: training/checkpoints/<run-name>/_progress.html.

Output: a single HTML file. Plotly.js is loaded from the official CDN so we
don't have to vendor it (per AGENTS spec: no new heavy deps). When
`_progress.jsonl` is missing or empty the page renders a "no progress data
yet" placeholder so an operator opening the file early in a run sees a
sensible message rather than a stack trace.
"""

from __future__ import annotations

import argparse
import html
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

PLOTLY_CDN = "https://cdn.plot.ly/plotly-2.35.2.min.js"


def load_jsonl(path: Path) -> list[dict]:
    """Tolerant JSONL loader — skips blank lines and malformed records.

    A malformed record gets reported on stderr but doesn't abort the
    report; partial visibility is more useful than a crash.
    """
    if not path.is_file():
        return []
    out: list[dict] = []
    with path.open("r", encoding="utf-8") as f:
        for line_num, raw in enumerate(f, start=1):
            raw = raw.strip()
            if not raw:
                continue
            try:
                out.append(json.loads(raw))
            except json.JSONDecodeError as exc:
                print(f"warn: {path}:{line_num} skipped — {exc}", file=sys.stderr)
    return out


def merge_progress_with_pulls(progress: list[dict], pulls: list[dict]) -> list[dict]:
    """Join `_pull-log.jsonl` (pulled_at, size_mb) onto `_progress.jsonl`
    (step, format_ok, content_ok, ...) by step. Pull entries that don't
    yet have a corresponding eval are dropped from the joined view (they
    show up only in the chart's "pending" annotation count). Eval entries
    without a pull row keep working — pulled_at falls back to evaluated_at.
    """
    pulls_by_step: dict[int, dict] = {}
    for p in pulls:
        try:
            step = int(p.get("step"))
        except (TypeError, ValueError):
            continue
        # If the same step shows up multiple times (refresh pull), keep the
        # earliest pulled_at — that's "first time we saw this step".
        if step not in pulls_by_step:
            pulls_by_step[step] = p

    rows: list[dict] = []
    for ev in progress:
        try:
            step = int(ev.get("step"))
        except (TypeError, ValueError):
            continue
        pull = pulls_by_step.get(step) or {}
        rows.append({
            "step": step,
            "format_ok": float(ev.get("format_ok") or 0.0),
            "content_ok": float(ev.get("content_ok") or 0.0),
            "tokens_per_sec": float(ev.get("tokens_per_sec") or 0.0),
            "peak_vram_mb": int(ev.get("peak_vram_mb") or 0),
            "evaluated_at": str(ev.get("evaluated_at") or ""),
            "pulled_at": str(pull.get("pulled_at") or ev.get("evaluated_at") or ""),
            "size_mb": int(pull.get("size_mb") or 0),
            "registry_key": str(ev.get("registry_key") or ""),
        })
    rows.sort(key=lambda r: r["step"])
    return rows


def render_empty_html(run_name: str, progress_path: Path, pulls_path: Path) -> str:
    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>training progress — {html.escape(run_name)}</title>
<style>
body {{ font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        max-width: 720px; margin: 4em auto; color: #222; padding: 0 1em; }}
code {{ background: #f4f4f4; padding: 0.1em 0.4em; border-radius: 3px; }}
</style>
</head><body>
<h1>training progress — {html.escape(run_name)}</h1>
<p>No progress data yet for <code>{html.escape(run_name)}</code>.</p>
<p>This page reads:</p>
<ul>
  <li><code>{html.escape(str(progress_path))}</code> — appended by <code>eval_loop.sh</code></li>
  <li><code>{html.escape(str(pulls_path))}</code> — appended by <code>checkpoint_sync_loop.sh</code></li>
</ul>
<p>Start the sync + eval loops in a separate terminal:</p>
<pre>bash scripts/checkpoint_sync_loop.sh --run-name {html.escape(run_name)} &amp;
bash scripts/eval_loop.sh --run-name {html.escape(run_name)} --registry-key &lt;k&gt; &amp;</pre>
<p>Then re-run <code>python scripts/progress_report.py --run-name {html.escape(run_name)}</code>.</p>
</body></html>
"""


def render_html(run_name: str, rows: list[dict], pulls_pending: int) -> str:
    steps = [r["step"] for r in rows]
    format_ok = [r["format_ok"] for r in rows]
    content_ok = [r["content_ok"] for r in rows]

    # Build the table HTML. We escape every cell value defensively because
    # the registry-key / dir paths originate from user-supplied flags.
    table_rows = []
    for r in rows:
        table_rows.append(
            "<tr>"
            f"<td>{html.escape(r['pulled_at'])}</td>"
            f"<td>{r['step']}</td>"
            f"<td>{r['format_ok']:.3f}</td>"
            f"<td>{r['content_ok']:.3f}</td>"
            f"<td>{r['tokens_per_sec']:.1f}</td>"
            f"<td>{r['peak_vram_mb']}</td>"
            "</tr>"
        )

    chart_data = {
        "steps": steps,
        "format_ok": format_ok,
        "content_ok": content_ok,
    }

    # `json.dumps` -> safe JS literal (no XSS surface; numbers + ascii keys).
    chart_data_json = json.dumps(chart_data)

    pending_note = (
        f"<p><em>{pulls_pending} checkpoint(s) pulled but not yet evaluated — "
        f"the eval loop will pick them up on its next sweep.</em></p>"
        if pulls_pending else ""
    )

    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>training progress — {html.escape(run_name)}</title>
<script src="{PLOTLY_CDN}"></script>
<style>
body {{ font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        max-width: 1080px; margin: 2em auto; color: #222; padding: 0 1em; }}
h1 {{ margin-bottom: 0.2em; }}
h1 + .subtitle {{ color: #666; margin-top: 0; margin-bottom: 1.5em; }}
#chart {{ width: 100%; height: 480px; }}
table {{ border-collapse: collapse; width: 100%; margin-top: 2em; font-size: 0.9em; }}
th, td {{ border-bottom: 1px solid #eee; padding: 0.4em 0.6em; text-align: left; }}
th {{ background: #fafafa; }}
td:nth-child(2), td:nth-child(3), td:nth-child(4),
td:nth-child(5), td:nth-child(6) {{ font-variant-numeric: tabular-nums; text-align: right; }}
</style>
</head><body>
<h1>training progress — {html.escape(run_name)}</h1>
<p class="subtitle">{len(rows)} evaluated checkpoint(s)</p>
{pending_note}
<div id="chart"></div>
<table>
<thead><tr>
  <th>pulled_at (UTC)</th><th>step</th>
  <th>format_ok</th><th>content_ok</th>
  <th>tok/s</th><th>peak vram (MB)</th>
</tr></thead>
<tbody>
{''.join(table_rows)}
</tbody>
</table>
<script>
(function() {{
  const data = {chart_data_json};
  const traces = [
    {{
      x: data.steps, y: data.format_ok,
      mode: "lines+markers", name: "format_ok",
      line: {{ color: "#1f77b4" }},
    }},
    {{
      x: data.steps, y: data.content_ok,
      mode: "lines+markers", name: "content_ok",
      line: {{ color: "#d62728" }},
    }},
  ];
  const layout = {{
    margin: {{ t: 24, r: 24, b: 48, l: 48 }},
    xaxis: {{ title: "training step" }},
    yaxis: {{ title: "score (0..1)", range: [0, 1] }},
    legend: {{ orientation: "h", y: -0.2 }},
  }};
  Plotly.newPlot("chart", traces, layout, {{ responsive: true, displaylogo: false }});
}})();
</script>
</body></html>
"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run-name", required=True)
    ap.add_argument("--out", default=None,
                    help="Output HTML path. Default: "
                         "training/checkpoints/<run-name>/_progress.html")
    args = ap.parse_args()

    run_dir = ROOT / "checkpoints" / args.run_name
    progress_path = run_dir / "_progress.jsonl"
    pulls_path = run_dir / "_pull-log.jsonl"
    out_path = Path(args.out) if args.out else run_dir / "_progress.html"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    progress = load_jsonl(progress_path)
    pulls = load_jsonl(pulls_path)

    if not progress:
        out_path.write_text(render_empty_html(args.run_name, progress_path, pulls_path))
        print(f"wrote empty-state report to {out_path}")
        return 0

    rows = merge_progress_with_pulls(progress, pulls)
    evaluated_steps = {r["step"] for r in rows}
    pulls_pending = sum(
        1 for p in pulls
        if isinstance(p.get("step"), int) and p["step"] not in evaluated_steps
    )

    out_path.write_text(render_html(args.run_name, rows, pulls_pending))
    print(f"wrote {len(rows)}-row progress report to {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
