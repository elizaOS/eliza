# AP Benchmarks Evidence

AP benchmark evidence is a post-`linux-boot` dependent lane. Do not build,
wire, or intake AP benchmark evidence from artifacts that predate the accepted
`build/evidence/cpu_ap/eliza_e1_linux_boot.log` intake.

Exact post-Linux commands:

```sh
python3 scripts/capture_cpu_ap_evidence.py sync-linux-docs linux
scripts/build_firemarshal_eliza_ap_benchmarks_payload.sh
eval "$(python3 scripts/wire_cpu_ap_capture_commands.py --format shell)"
scripts/capture_chipyard_linux_evidence.sh ap-benchmarks
python3 scripts/capture_cpu_ap_evidence.py hashes
python3 scripts/check_cpu_ap_evidence.py --require-evidence
```

`scripts/build_firemarshal_eliza_ap_benchmarks_payload.sh` writes
`external/chipyard/software/firemarshal/images/firechip/eliza-e1-ap-benchmarks/payload_freshness_manifest.json`.
That sidecar binds the no-disk payload to the accepted Linux boot transcript,
its `intake_utc`, and the current generated manifest hash.
`scripts/wire_cpu_ap_capture_commands.py` refuses to export
`ELIZA_AP_BENCHMARKS_CMD` when the sidecar is missing, stale, bound to a
different Linux boot transcript, or generated before the accepted Linux boot
intake. `scripts/capture_cpu_ap_evidence.py intake ap-benchmarks` also rejects
source transcripts whose mtime is older than the accepted Linux boot intake.
