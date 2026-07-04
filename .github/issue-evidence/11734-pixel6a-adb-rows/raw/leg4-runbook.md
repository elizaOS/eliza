# Leg 4 runbook — eliza-1-4b tier attempt on Pixel 6a (#11734)

Artifact: HF `elizaos/eliza-1` `bundles/4b/text/eliza-1-4b-256k.gguf`
(2,952,939,488 bytes, sha256 `798092229ce8fc5d280bcabedaa4549cc34fe2d3abf6db6360df72102d238369`,
verified against `bundles/4b/checksums/SHA256SUMS`). This is the device-class
Q4 4b artifact — the same "256k" naming family as the on-device 2b
(`eliza-1-2b-q4.gguf` is byte-identical in size to the published
`bundles/2b/text/eliza-1-2b-256k.gguf`).

Catalog note: `eliza-1-4b` `minRamGb: 6` / `q4MinRamGb: 6` — the Pixel 6a
reports MemTotal 5589 MB, i.e. this device is *below the tier's own floor*
before the experiment starts.

Steps:
1. `adb push` gguf -> `/data/local/tmp/eliza-1-4b-256k.gguf`
2. Back up `files/.eliza/local-inference/{registry,assignments}.json` (run-as)
3. Park the 2b: `files/.eliza/local-inference/parked-2b/eliza-1-2b-q4.gguf`
4. Stage 4b as the ONLY gguf in `files/.eliza/local-inference/models/text/`
5. Point registry+assignments at `eliza-1-4b` (staged JSONs pushed via /data/local/tmp)
6. `am force-stop` -> relaunch -> wait for `/api/status` running
7. Start `leg4-mem-monitor.sh` (5 s pid+MemAvailable, 30 s dumpsys meminfo)
8. Drive ONE streaming turn (turn-driver.mjs, 480 s timeout), logcat marker before/after
9. Outcome capture: reply JSON + GENERATE_STREAM done line (RAM/tok-s numbers)
   OR process death (`dumpsys activity exit-info`, lmkd/logcat slice, meminfo at kill)
10. Restore 2b (reverse of 3-5), relaunch, verify one turn, delete 4b from device
