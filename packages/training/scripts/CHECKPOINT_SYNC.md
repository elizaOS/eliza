# Checkpoint sync + progress visibility

These three scripts give you live progress visibility while a long Vast.ai
training run is in flight. They are deliberately separate from
`train_vast.sh` so you can start, stop, and restart them independently of
the run itself — losing the watcher never costs you the training run, and
restarting the watcher doesn't disturb anything on the Vast box.

```
checkpoint_sync_loop.sh  ── pulls checkpoint-* dirs from Vast every 30 min
       │
       ▼
training/checkpoints/<run-name>/checkpoint-<N>/
       │
       ▼
eval_loop.sh             ── scores each new checkpoint with eliza_bench
       │
       ▼
training/checkpoints/<run-name>/_progress.jsonl
       │
       ▼
progress_report.py       ── renders an HTML chart from _progress.jsonl
```

## During a Vast run

Open two extra terminals after `bash scripts/train_vast.sh provision-and-train ...`
has actually started training. The sync loop reads the same
`ELIZA_VAST_INSTANCE_ID` / `.vast_instance_id` that `train_vast.sh`
provisioned, so no extra config is needed.

```bash
# Terminal 2 — pull intermediate checkpoints back every 30 min.
bash scripts/checkpoint_sync_loop.sh --run-name qwen3-5-9b-apollo &

# Terminal 3 — score each new checkpoint as it arrives.
bash scripts/eval_loop.sh \
  --run-name qwen3-5-9b-apollo \
  --registry-key qwen3.5-9b &
```

Both loops trap `SIGTERM` and `SIGINT`, so a plain `kill <pid>` (or
`Ctrl-C` in the foreground) exits cleanly between sweeps. They each log
to `~/.eliza/checkpoint-sync.log` and `~/.eliza/checkpoint-eval.log`
respectively, with 10 MB rotation.

### Useful flags

```bash
# Faster sweep cadence for a smoke run:
bash scripts/checkpoint_sync_loop.sh --run-name smoke-v1 --interval-seconds 300
bash scripts/eval_loop.sh           --run-name smoke-v1 --registry-key qwen3.5-2b --interval-seconds 60

# Bigger eval sample (slower, more stable curve):
bash scripts/eval_loop.sh --run-name <name> --registry-key <k> --max-examples 200

# Cap local disk usage by keeping only the 4 most recent intermediate
# checkpoints (final/ is never pruned):
bash scripts/checkpoint_sync_loop.sh --run-name <name> --max-checkpoints 4
```

## View progress

```bash
python scripts/progress_report.py --run-name qwen3-5-9b-apollo
# wrote 7-row progress report to .../checkpoints/qwen3-5-9b-apollo/_progress.html
```

Then open the printed HTML path in a browser. The chart loads Plotly from
the official CDN so the file is fully self-contained — you can scp it
elsewhere or attach it to a status update without bundling assets.

If no progress data exists yet (the sync/eval loops haven't produced any
`_progress.jsonl` entries), the report renders a "no progress data yet"
placeholder rather than crashing. That's intentional: it's safe to call
`progress_report.py` immediately after `provision-and-train`.

## Files on disk

| Path | Owner | Format |
|---|---|---|
| `training/checkpoints/<run>/checkpoint-<N>/` | `checkpoint_sync_loop.sh` | rsync mirror of remote checkpoint dir |
| `training/checkpoints/<run>/_pull-log.jsonl` | `checkpoint_sync_loop.sh` | one JSON object per successful pull |
| `training/checkpoints/<run>/checkpoint-<N>/_eval.json` | `eval_loop.sh` | per-checkpoint result; absence == "not yet evaluated" |
| `training/checkpoints/<run>/_progress.jsonl` | `eval_loop.sh` | one JSON object per evaluated step (UI plots this) |
| `training/checkpoints/<run>/_progress.html` | `progress_report.py` | self-contained HTML chart |
| `~/.eliza/checkpoint-sync.log` | `checkpoint_sync_loop.sh` | sweep log, 10 MB rotation |
| `~/.eliza/checkpoint-eval.log` | `eval_loop.sh` | scorer log, 10 MB rotation |

### `_pull-log.jsonl` schema

```json
{"step": 200, "pulled_at": "2026-05-04T17:30:12Z", "size_mb": 18432}
```

Step `-1` is reserved for `final/` at pull time; the eval loop promotes it
to `max(known steps) + 1` when it scores so the final checkpoint sits at
the rightmost X position on the progress curve.

### `_progress.jsonl` schema

```json
{
  "step": 200,
  "checkpoint_dir": "/home/shaw/eliza/training/checkpoints/<run>/checkpoint-200",
  "format_ok": 0.84,
  "content_ok": 0.61,
  "tokens_per_sec": 38.2,
  "peak_vram_mb": 14336,
  "evaluated_at": "2026-05-04T17:42:08Z",
  "registry_key": "qwen3.5-9b"
}
```

`format_ok` and `content_ok` are macro-averaged across whatever buckets
the val set produced (sum of bucket `format_ok` / bucket `content_ok`
divided by sum of bucket `n`). The full per-bucket breakdown is preserved
next to the marker as `_eval.bench-summary.json`.

## Eliza Cloud UI

When the cloud UI lands it will read these same `_pull-log.jsonl` and
`_progress.jsonl` files (the contracts are deliberately small and stable).
This CLI path stays useful regardless — it's the right tool when you're
on a plane, when the cloud UI is down, or when you want to attach a
single HTML file to an email.

## Cleaning up

```bash
# Stop the loops.
kill %1 %2   # if you backgrounded them in the same shell

# Or by pgrep:
pkill -TERM -f 'checkpoint_sync_loop.sh --run-name <name>'
pkill -TERM -f 'eval_loop.sh --run-name <name>'

# Remove evaluated markers to force rescore (keeps checkpoints):
find training/checkpoints/<name> -name _eval.json -delete
rm -f training/checkpoints/<name>/_progress.jsonl
```
