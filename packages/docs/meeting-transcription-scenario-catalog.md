# Meeting Transcription Scenario Catalog

Issue: #12486

## Scenario Matrix

| ID | Lane | Surface | Capture | Proof Focus | Required Evidence |
| --- | --- | --- | --- | --- | --- |
| MTP-001 | mocked_plumbing | all | bot, bot-free | schema and registry plumbing | fixture report |
| MTP-002 | real_product | on-device | bot-free | clean single-speaker baseline | audio, transcript, metrics |
| MTP-101 | real_product | Google Meet | bot | meeting artifact import, transcript, diarization | audio, video, logs, transcript, metrics |
| MTP-102 | real_product | Google Meet | bot-free | browser or device capture without a meeting bot | audio, video, logs, screenshots, metrics |
| MTP-201 | real_product | Zoom | bot | Zoom meeting capture and artifact adapter | audio, video, logs, transcript, metrics |
| MTP-202 | real_product | Zoom | bot-free | desktop/device capture without bot presence | audio, video, logs, screenshots, metrics |
| MTP-301 | real_product | on-device | bot-free | local ASR, diarization, speaker ID | audio, device logs, transcript, speaker artifacts |
| MTP-401 | real_product | cloud agent | bot | cloud agent meeting join, capture, and summary | backend logs, trajectories, transcript, metrics |
| MTP-501 | real_product | hybrid local/cloud | bot-free | local capture with cloud model assistance | audio, frontend logs, backend logs, trajectories |
| MTP-601 | real_product | room feed | bot-free | active speaker and room-feed detection | video, screenshots, active-speaker metrics |
| MTP-701 | real_product | all | bot, bot-free | consent, correction, sharing, retention, deletion | screenshots, consent record, retention artifact |
| MTP-801 | real_product | all | bot, bot-free | speaker enrollment, unknown speaker creation, correction, and voice-profile deletion | speaker artifacts, transcript, retention artifact |

## Acoustic Stress Cases

Each real capture surface should be run against these conditions:

- quiet close-talk;
- music under speech;
- stationary background noise;
- babble from unrelated speakers;
- overlapping speakers;
- far-field room microphone;
- reverberant room;
- degraded network or compressed meeting audio.

## Speaker Identity Cases

Each speaker identity run should cover:

- enrollment from a clean sample;
- recognition in the target meeting;
- unknown speaker handling;
- speaker naming;
- merge of duplicate speaker identities;
- split of incorrectly merged identities;
- profile revocation and post-revocation non-recognition;
- multi-speaker attribution from one camera or microphone stream;
- shared-room uncertainty that withholds overconfident names when evidence is
  ambiguous.

## UX Cases

The UI proof should cover:

- live transcript capture;
- post-meeting transcript review;
- speaker correction;
- transcript sharing;
- recording/transcription consent disclosure;
- retention policy display;
- deletion or revocation confirmation;
- permission denied and no-audio states.
