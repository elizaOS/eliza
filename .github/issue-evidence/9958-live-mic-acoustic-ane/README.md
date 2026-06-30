# #9958 — real live-microphone → on-device ANE Stage-B (acoustic loopback)

This closes the **"real mic → ASR"** gap that the merged Stage-B bench
(`.github/issue-evidence/9958-stt-stage-b-eval/`) left open: that run fed
`say`-synthesized WAVs through `SFSpeechURLRecognitionRequest` (file recognition).
This run captures audio **through the actual microphone** and recognizes it
**on-device (ANE)** — a genuine acoustic capture path, not a file.

## Method (reproducible — `capture-loopback.sh`)

For each reference phrase, on this Apple-Silicon MacBook Pro (macOS 26.2):

1. `say -v Samantha` synthesizes the phrase.
2. The phrase is **played out the built-in speaker** while `ffmpeg -f avfoundation`
   **records the built-in microphone live** (16 kHz mono s16) — an acoustic
   loopback (speaker → room → mic), so the captured WAV is a real mic recording.
3. The captured WAVs are recognized by `stage-b-stt-bench --on-device`
   (`SFSpeechRecognizer`, `requiresOnDeviceRecognition = true` — the ANE-backed
   Stage-B confirm path), with WER scored by word-level Levenshtein.

> Output volume must be up (the first attempt captured at −41 dB / system volume 0
> → "No speech detected"; at volume 90 the capture is ~−20 dB and recognizes cleanly).

## Result — `live-mic-ane-scored.json`

| utt | reference | ANE hypothesis (live-mic) | WER | latency | RTF |
|-----|-----------|---------------------------|-----|---------|-----|
| 01 | turn on the kitchen lights | Turn on the kitchen **light** | 1/5 | 335 ms | 0.168 |
| 02 | set a reminder for tomorrow morning | Set a reminder for tomorrow morning | 0/6 | 43 ms | 0.018 |
| 03 | what time is it in tokyo | What time is it in Tokyo | 0/6 | 40 ms | 0.020 |
| 04 | open the front door | Open the front door | 0/4 | 36 ms | 0.022 |
| 05 | thanks that is all for now | Thanks that is all for now | 0/6 | 39 ms | 0.019 |

**Aggregate: WER 3.7 % (1/27 words), 4/5 exact, median latency 40 ms, on-device ANE confirmed.**
The single error is `lights → light` — a plausible-word substitution, not a capture failure.

## Artifacts
- `audio/utt-0*.wav` — the real live-mic captures (mean ~−20 dB; recognizable speech).
- `audio/manifest.json` — id / reference / wav.
- `apple-sfspeech-live-mic.json` — raw bench output (per-utterance latency/RTF/hypothesis).
- `live-mic-ane-scored.json` — WER-scored summary.
- `run-screenshot.png` — desktop screenshot at run time.
- `capture-loopback.sh` — the reproducible capture harness.

## Honest scope / what is still device-gated
- **`SFSpeechRecognizer` ANE here runs on the Mac's Neural Engine.** The **iPhone A17**
  ANE Stage-B measurement is a distinct chip and remains an on-device handoff —
  see the iPhone handoff note below; it needs the device **unlocked** + a
  one-time **Speech Recognition permission** grant.
- **Full mic → ASR → agent → Kokoro → speaker round trip** (the agent loop, not
  just ASR) still needs the running app + a live session; this run proves the
  **capture → on-device ASR** leg of that loop on real hardware.

## iPhone (Shaw's iPhone 15 Pro, iOS 26.5) — handoff
The connected iPhone is paired + developer-mode-on, but was **locked** during this
session, so its on-device app/voice work is human-gated. To produce the iPhone-A17
ANE Stage-B numbers: unlock the device, build the Stage-B harness as an iOS host
target (the `stage-b-stt-bench` Swift source is platform-portable; the macOS arm is
proven here), grant **Speech Recognition** + **Microphone** on first launch, and run
the same manifest. The numbers above are the macOS-ANE reference to compare against.
