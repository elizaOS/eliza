#!/usr/bin/env bash
# Real acoustic live-mic Stage-B capture for #9958.
# For each reference phrase: synthesize speech, play it out the Mac speaker WHILE
# recording the live built-in microphone (acoustic loopback), producing a
# genuinely mic-captured 16 kHz mono WAV — not a clean synthesized file. The
# captured WAVs are then scored by the on-device SFSpeechRecognizer (ANE) bench.
set -euo pipefail

OUT="${1:?usage: capture-loopback.sh <out-audio-dir>}"
mkdir -p "$OUT"

# Reference phrases (mirror the merged quiet eval set).
ids=(utt-01 utt-02 utt-03 utt-04 utt-05)
refs=(
  "turn on the kitchen lights"
  "set a reminder for tomorrow morning"
  "what time is it in tokyo"
  "open the front door"
  "thanks that is all for now"
)

manifest="$OUT/manifest.json"
echo '{ "utterances": [' > "$manifest"

for i in "${!ids[@]}"; do
  id="${ids[$i]}"; ref="${refs[$i]}"
  synth="$OUT/$id.synth.aiff"
  cap="$OUT/$id.wav"
  echo ">>> $id: \"$ref\""
  # 1) synthesize the phrase (Samantha, slowed for clean playback)
  say -v Samantha -r 165 -o "$synth" "$ref"
  # 2) play it out the speaker while capturing the live mic concurrently.
  #    Record a touch longer than playback so we don't clip the tail.
  dur=$(python3 -c "import wave,sys,subprocess,struct; import audioop" 2>/dev/null; afinfo "$synth" 2>/dev/null | awk '/estimated duration/{print $3}')
  dur="${dur:-3}"
  reclen=$(python3 -c "print(round(float('$dur')+0.8,2))")
  # start mic capture in background (16k mono s16le)
  ffmpeg -y -f avfoundation -i ":default" -t "$reclen" -ar 16000 -ac 1 -sample_fmt s16 "$cap" >/dev/null 2>&1 &
  recpid=$!
  sleep 0.35           # let the recorder warm up
  afplay "$synth"      # acoustic playback into the room → mic
  wait "$recpid" || true
  # append manifest entry
  sep=","; [ "$i" -eq 0 ] && sep=""
  printf '%s\n  { "id": "%s", "reference": "%s", "wav": "%s.wav" }' "$sep" "$id" "$ref" "$id" >> "$manifest"
  rm -f "$synth"
done

echo '' >> "$manifest"
echo '] }' >> "$manifest"
echo ">>> manifest: $manifest"
cat "$manifest"
