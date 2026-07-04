# Meeting Transcription Issue Packet

Issue: #12486

## Implementation Packet

This packet turns the issue scope into concrete workstreams that can be verified
by the new `meeting_transcription_proof` benchmark registry entry.

## Workstreams

1. Canonical transcript and artifact schema.
2. Google Meet capture adapter proof.
3. Zoom capture adapter proof.
4. Bot capture mode proof.
5. Bot-free capture mode proof.
6. Public meeting transcription and diarization dataset importers.
7. Acoustic stress generation for music, noise, babble, overlap, and far-field
   conditions.
8. Multi-speaker single-stream diarization.
9. Voice profile enrollment, recognition, naming, merge/split, and revocation.
10. Audio-visual active speaker and room-feed detection.
11. Transcript capture, correction, sharing, consent, and retention UX proof.
12. Evidence bundles with real audio, video, logs, screenshots, metrics, model
    trajectories, and domain artifacts.
13. Dataset source manifests with license, version/checksum, condition coverage,
    and evidence links for music/noise/babble/overlap/far-field/shared-room/
    audiovisual lanes.
14. Capture path manifests for Zoom bot, Zoom bot-free, Google Meet bot, Google
    Meet bot-free, on-device, cloud agent, and hybrid local/cloud routes.
15. Speaker operation manifests for voice profile enrollment, recognition,
    unknown speaker creation, correction, merge/split, deletion,
    post-deletion non-recognition, multi-speaker single-stream attribution, and
    shared-room uncertainty, with privacy controls and confidence policies.

## Acceptance Gates

Each workstream must either produce a real evidence artifact referenced by a
`real_product` manifest or be explicitly absent from the manifest and fail the
real lane. The mock lane may cover only plumbing.

The implementation PR should include:

- the `meeting_transcription_proof` registry entry;
- a smoke report from the mocked plumbing lane;
- at least one real manifest template or captured real manifest when real
  meeting evidence is available;
- score tests proving that mocked reports cannot claim publishable status and
  real reports cannot omit evidence;
- documentation for operators who capture Zoom, Google Meet, device, cloud, and
  hybrid evidence.

## Related Existing Surfaces

Existing voice and audio benchmark packages that feed this issue:

- `packages/benchmarks/voice`
- `packages/benchmarks/voice-speaker-validation`
- `packages/benchmarks/voicebench`
- `packages/benchmarks/voicebench-quality`
- `packages/benchmarks/voiceagentbench`
- `packages/benchmarks/mmau-audio`

The meeting proof registry does not replace those packages. It coordinates
their outputs into one product-facing evidence bundle.
