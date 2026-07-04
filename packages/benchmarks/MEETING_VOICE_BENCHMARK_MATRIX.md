# Meeting, Transcription, and Voice Benchmark Matrix

Research matrix for issue #13352. This file records which external meeting,
speech, and voice-assistant benchmarks are already covered by elizaOS, which
ones need legal or infrastructure review, and where an adapter should land.

Status is based on repo inspection plus public source pages on 2026-07-04. The
source review checked the QMSum, MeetingBank, ELITR-Bench, VoiceCodeBench,
VoiceBench, and Sierra 3-Bench primary pages directly; the remaining P1/P2 rows
are conservative until their adapter PRs recheck license/access terms. Do not
commit raw external data unless the allowed-use column explicitly permits a repo
fixture and the source license is rechecked in the adapter PR.

## Existing elizaOS Coverage

| Surface | Existing coverage | Gap this matrix should drive |
| --- | --- | --- |
| `packages/scenario-runner` | Real `AgentRuntime` scenarios, deterministic/live lanes, JSON reports, native JSONL export. | Meeting transcript and voice task adapters that produce scenario definitions or scenario metadata from external datasets. |
| `packages/benchmarks/lifeops-bench` | Multi-turn tool-use benchmark with deterministic world-state scoring across Eliza/Hermes/OpenClaw/Cerebras adapters. | Knowledge-grounded and voice-interruption domains inspired by Sierra tau-Knowledge/tau-Voice without copying restricted data. |
| `packages/benchmarks/meeting-transcription-proof` | Planned adapter-contract scaffold from #13378 / #13359 for transcript, diarization, speaker identity, consent, retention, and meeting note metrics; not pre-existing `develop` coverage at the time of the matrix. | Dataset adapters for QMSum, MeetingBank, ELITR-Bench, TCR, and controlled public meeting slices. |
| `packages/benchmarks/voice-speaker-validation` | Speaker profile lifecycle, diarization, single-stream, and async identity checks. | Public speaker-count/diarization stress slices and trait-aware regression fixtures. |
| `packages/benchmarks/registry` | Integrated `voicebench`, `voicebench_quality`, `mmau`, and scoring gates that reject mock results for publishable runs. | New registry entries for VoiceCodeBench, QMSum/MeetingBank smoke slices, and tau-style knowledge/voice methodology. |
| `packages/training` | Eliza-1 benchmark matrix and voice gates for ASR/TTS/runtime metrics. | Exact structured-token recovery, long-form ASR, dropped-frame/interruption robustness, and voice task pass-at-1 gates. |
| `plugins/plugin-google` | Google Meet artifact import path with the current `GoogleMeetReport` export; canonical `elizaos.meeting_artifact.v1` is planned adapter/schema work rather than an existing plugin-google export. | Reference-based artifact grading: summary, quote grounding, action items, topic relevance, and privacy/retention checks. |

## Benchmark Matrix

Allowed-use values:

- `repo-fixture`: small derived fixture can be committed after license check.
- `downloaded-eval`: adapter downloads public data at run time; no raw data in repo.
- `private-eval`: use only with credentials/access approval; do not redistribute.
- `training-ok`: candidate training/fine-tuning data after contamination review.
- `eval-only`: evaluate only; keep out of training.
- `needs-legal`: license/access is unclear or restricted.
- `do-not-use`: avoid until legal/product explicitly changes the decision.

| Source | Task/modality | Status in elizaOS | License/access posture | Allowed use | Harness target | Priority | Minimal starting slice |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MeetBench / MeetAll / MeetMaster: https://github.com/huyuelin/MeetBench-MeetAll.github.io | Meeting-agent QA, meeting summaries, factuality and structure judging; multilingual/multimodal meetings. | New; only indirectly overlaps with meeting-proof and scenario-runner. | Project notes describe MeetAll data as CC BY-NC 4.0 / non-commercial research only. | `needs-legal`, likely `eval-only`/`do-not-use` for commercial repo fixtures. | Scenario-runner live-only meeting-agent scenarios; no raw data in repo. | P2 | Metadata-only adapter proof plus one synthetic eliza-owned fixture that mirrors task shape. |
| QMSum: https://github.com/Yale-LILY/QMSum | Query-focused meeting summarization over academic/product/committee meetings. | New; maps cleanly to meeting artifact QA. | GitHub repo is MIT; underlying source meeting corpora still need citation/license review per corpus. | `downloaded-eval`; small query/summary fixture only after corpus-level review. | `meeting-transcription-proof` and scenario-runner transcript QA scenarios. | P0 | 10 query-summary pairs with transcript excerpts, exact reference spans, and judge fallback. |
| MeetingBank / MeetingBank-utils: https://meetingbank.github.io/ and https://github.com/YebowenHu/MeetingBank-utils | City council meeting summarization with transcripts, videos, agendas, and minutes. | New; target adapter scaffold is #13378 / #13359, not existing dataset coverage on `develop`. | Public meeting data; site and Zenodo publish dataset, but city/source terms and video reuse need review. | `downloaded-eval`; repo fixture should be minimal metadata/excerpt only. | Meeting artifact generation and long-context summarization benchmark. | P0 | 5 public meeting sections with transcript excerpt, agenda, reference minutes, and action-item extraction. |
| ELITR-Bench: https://github.com/utter-project/ELITR-Bench | Long-context meeting transcript QA with ground-truth answers and metadata. | New. | GitHub lists CC BY 4.0; verify upstream ELITR meeting-data terms before raw fixture use. | `downloaded-eval`; `repo-fixture` only for tiny CC-compatible examples. | Scenario-runner long-context QA and retrieval/quote-grounding checks. | P1 | 20 QA rows with answer/reference metadata and no audio. |
| Topic-Conversation Relevance (TCR): https://github.com/microsoft/topic_conversation | Topic relevance over 1,500 meetings and 15k+ topics. | New. | Paper/repo indicate CC BY 4.0 data, but source-meeting provenance needs review. | `downloaded-eval`; possible small `repo-fixture` after provenance check. | Scenario-runner topic tracking and meeting artifact topic relevance. | P1 | 50 topic/transcript-window pairs with exact-match relevance metrics. |
| AMI Meeting Corpus: https://groups.inf.ed.ac.uk/ami/corpus/ | Meeting audio/video/transcripts, diarization, summaries. | Partially covered by generic meeting proof metrics, not dataset-specific. | Research corpus with separate license/access terms. | `needs-legal`, likely `private-eval` or `downloaded-eval`. | Meeting transcription, diarization, speaker attribution, summarization. | P1 | License-gated manifest adapter; no committed media. |
| ICSI Meeting Corpus: https://groups.inf.ed.ac.uk/ami/icsi/ | Meeting speech, transcripts, speaker labels. | Partially covered conceptually only. | Research corpus with access restrictions and citation requirements. | `needs-legal`, likely `private-eval`. | Speaker validation and meeting transcription proof. | P1 | Manifest-only adapter plus documented acquisition step. |
| CHiME-6: https://chimechallenge.github.io/chime6/ | Dinner-party multi-speaker ASR/diarization under real noise. | Partially covered by voice-speaker-validation abstractions, not dataset. | Challenge data requires agreement and download process. | `private-eval`; no repo data. | ASR/diarization stress lane and Eliza-1 ASR gates. | P1 | 1-hour manifest slice with WER/DER/JER metrics. |
| SAMSum: https://huggingface.co/datasets/Samsung/samsum | Dialogue summarization, not meeting-specific. | New; lower-fidelity baseline. | HF endpoint returned 401 during the 2026-07-04 link check; treat access and license as gated until rechecked. | `needs-legal`, likely `private-eval`; no repo fixture unless access terms change. | Baseline summarization scorer only, clearly marked non-meeting. | P2 | Metadata-only until access and license are verified. |
| DialogSum: https://huggingface.co/datasets/knkarthick/dialogsum | Dialogue summarization, not meeting-specific. | New; lower-fidelity baseline. | HF dataset; license must be checked before fixture. | `downloaded-eval`. | Baseline summarization scorer. | P2 | 100 short dialogue summaries. |
| MediaSum: https://github.com/zcgzcgzcg1/MediaSum | Interview/media transcript summarization. | New. | Dataset terms need review. | `needs-legal`; likely `downloaded-eval`. | Long transcript summarization baseline. | P2 | Metadata-only until license verified. |
| LongSpeech: https://arxiv.org/html/2601.13539v1 | Long-duration speech benchmark for ASR, ST, summarization, language detection, speaker count, QA, temporal localization, and emotion. | New. | Paper describes dataset; public code/data availability and license need review. | `needs-legal`, likely `downloaded-eval`. | Eliza-1 long-form ASR and audio QA gates. | P2 | 10-minute public subset if released with redistributable terms. |
| Sierra mu-Bench: https://huggingface.co/datasets/sierra-research/mu-bench | Multilingual transcription from real customer-service calls. | New. | Restricted access, non-commercial/restricted terms and deletion/redistribution limits. | `private-eval`, `eval-only`; no training or repo fixtures. | Private ASR regression lane. | P2 | Access-gated manifest and local-only result schema. |
| VoiceCodeBench: https://huggingface.co/datasets/besimple-ai/voice-code-bench | Exact structured-token recovery for workplace speech: paths, URLs, numbers, code-like entities. | New. | HF page indicates MIT and small human-recorded WAV set. | `downloaded-eval`; candidate `repo-fixture` for a tiny sample if license confirmed. | Eliza-1 ASR gate and meeting-transcription-proof exact-token metric. | P0 | 30 clips covering URLs, file paths, IDs, and punctuation; report CTEM/TSR. |
| Picovoice STT benchmark: https://github.com/Picovoice/speech-to-text-benchmark | WER/punctuation over LibriSpeech, TED-LIUM, Common Voice, MLS, VoxPopuli, FLEURS. | New harness; overlaps with ASR metrics. | Framework repo and component datasets have separate licenses. | `downloaded-eval`; dataset-specific gates. | Eliza-1 ASR comparison harness. | P1 | Common Voice or FLEURS 50-row smoke slice with checksums. |
| LibriSpeech: https://www.openslr.org/12 | Read-speech ASR baseline. | Not directly integrated. | Widely used OpenSLR corpus; verify license before committing slices. | `downloaded-eval`; possible small fixture after review. | Eliza-1 ASR baseline. | P2 | 100 dev-clean utterances. |
| TED-LIUM: https://www.openslr.org/51 | Lecture/talk ASR baseline. | Not directly integrated. | OpenSLR dataset with its own terms. | `downloaded-eval`. | Long-form ASR and punctuation baseline. | P2 | 30 short segments plus transcript refs. |
| Common Voice: https://commonvoice.mozilla.org/datasets | Multilingual ASR. | Not directly integrated. | Mozilla Common Voice has versioned licenses; review selected release. | `downloaded-eval`; possible training after contamination review. | Eliza-1 multilingual ASR gates. | P1 | 50 clips per target language. |
| MLS: https://www.openslr.org/94 | Multilingual read-speech ASR. | Not directly integrated. | OpenSLR dataset terms. | `downloaded-eval`. | Multilingual ASR. | P2 | 50 clips across high-priority locales. |
| VoxPopuli: https://github.com/facebookresearch/voxpopuli | Multilingual parliamentary speech ASR. | Not directly integrated. | Research dataset; terms vary by source. | `downloaded-eval`, `needs-legal` for fixtures. | Long-form multilingual ASR. | P2 | 50 short segments. |
| FLEURS: https://huggingface.co/datasets/google/fleurs | Multilingual speech recognition/translation. | Not directly integrated. | HF dataset; verify license/version. | `downloaded-eval`. | Multilingual ASR and language-ID gate. | P1 | 50 clips per launch locale. |
| VoiceBench: https://github.com/matthewcym/voicebench and https://huggingface.co/datasets/hlt-lab/voicebench | LLM-based voice assistant benchmark across spoken instruction subsets. | Partially covered: `voicebench_quality` is registered; `voicebench` latency harness exists. | HF/GitHub pages indicate Apache-2.0 for public dataset/code; verify exact subset terms. | `downloaded-eval`; selected `repo-fixture` possible for smoke. | Existing `voicebench_quality`; add missing subsets or adapter parity tests. | P0 | Close gap between registered suite list and current HF subsets; document skipped subsets. |
| VoiceAssistant-Eval: https://github.com/mathllm/VoiceAssistant-Eval and https://huggingface.co/datasets/MathLLMs/VoiceAssistant-Eval | Listening, speaking, and viewing; content quality, speech quality, consistency. | New. | Public HF/GitHub; license needs check before fixtures. | `downloaded-eval`, `needs-legal` for raw media fixtures. | Eliza-1 voice gates and scenario-runner multimodal live lane. | P2 | Metadata-only adapter plus 20 listening/speaking rows after license check. |
| VocalBench: https://github.com/SJTU-OmniAgent/VocalBench | Semantic, acoustic, chat, latency/RTF dimensions for speech interaction models. | New; overlaps with voicebench latency. | Public repo; data/license needs review. | `downloaded-eval`, `needs-legal`. | Eliza-1 speech-to-speech release gate. | P2 | Latency/RTF metric schema first, data second. |
| VCB-Bench: https://github.com/Tencent/VCB-Bench | Chinese voice chat benchmark with robustness and multi-turn tasks. | New. | Public repo; license/data terms need review. | `downloaded-eval`, `needs-legal`. | Multilingual voice assistant lane. | P2 | 20 Chinese prompt/audio rows with pass-at-1 task scoring. |
| MTalk-Bench: https://github.com/FreedomIntelligence/MTalk-Bench | Multi-turn speech-to-speech dialogue with semantic, paralinguistic, ambient, multiparty dimensions. | New. | Research license noted by project; verify terms before use. | `needs-legal`, likely `eval-only`. | Scenario-runner live voice and Eliza-1 full-duplex gates. | P2 | Methodology-only first; no raw data committed. |
| aiewf-eval: https://github.com/kwindla/aiewf-eval | Multi-turn workflow evals with text, realtime audio, speech-to-speech, tool-use, instruction, and grounding dimensions. | New; methodology overlaps LifeOpsBench and scenario-runner. | Public repo; license needs review. | `downloaded-eval` for code ideas, not data until verified. | LifeOpsBench adapter design and realtime audio scenario design. | P1 | Borrow report/schema concepts; implement an elizaOS-native workflow smoke fixture. |
| Vox-Profile: https://arxiv.org/html/2505.14648v1 | Speaker/speech trait robustness benchmark. | New; overlaps speaker validation. | Paper/data release status needs review. | `needs-legal`. | Voice-speaker-validation robustness report. | P2 | Trait taxonomy mapped to existing speaker validation metrics. |
| Picovoice TTS benchmark: https://github.com/Picovoice/text-to-speech-benchmark | Streaming TTS responsiveness under assistant-like generated text. | New harness; overlaps TTS latency gates. | Framework and datasets need license review. | `downloaded-eval`. | Eliza-1 TTS latency/resource gate. | P1 | 20 generated-response prompts with first-audio/p95/resource metrics. |
| Sierra tau-Knowledge / tau-Voice / 3-Bench: https://sierra.ai/blog/bench-advancing-agent-benchmarking-to-knowledge-and-voice | Knowledge-grounded backend task completion and realistic voice interactions with interruptions/noise/dropped frames. | New as dataset; methodology overlaps LifeOpsBench and Eliza-1 voice gates. | Blog describes benchmark release; public code/data/license must be verified separately. | `needs-legal`; methodology can be used without copying data. | LifeOpsBench knowledge domain and scenario-runner live voice task lane. | P0 methodology, P2 data | Add eliza-owned knowledge-base task and voice-interruption scenario using the same scoring philosophy. |
| MultiVox: https://arxiv.org/html/2507.10859v1 | Omni voice assistant benchmark with speech plus visual cues and paralinguistic features. | New. | Paper/data release and license need review. | `needs-legal`. | Multimodal scenario-runner and Eliza-1 audio-vision gate. | P2 | Methodology-only until data terms are clear. |
| SOVA-Bench: https://arxiv.org/abs/2506.02457 | Speech conversational voice assistant benchmark, including understanding and generated speech quality. | New. | Paper/data license needs review. | `needs-legal`. | Eliza-1 speech generation quality and acoustic metrics. | P2 | Metric taxonomy and scoring schema first. |
| AudioBench / OpenAudioBench: https://github.com/audiollms/audiobench | AudioLLM benchmark across speech, audio-scene, and voice understanding tasks. | Partially covered by registered MMAU and voicebench, but AudioBench itself is new. | Public repo; dataset licenses vary by subset. | `downloaded-eval`, subset-specific legal review. | Benchmark registry audio understanding lane. | P1 | Map only speech/voice subsets first; avoid scene/music until model support is explicit. |
| Big Bench Audio: https://huggingface.co/blog/big-bench-audio-release | Speech reasoning benchmark adapted from Big Bench Hard, evaluated across speech-to-speech/text paths. | New; overlaps MMAU/VoiceBench reasoning. | Public blog/dataset; license and access need verification. | `needs-legal` until source package checked. | Eliza-1 speech reasoning gate and hosted provider comparison. | P1 | 100-question reasoning slice, pass-at-1 exact answer. |
| ADU-Bench: https://arxiv.org/abs/2412.05167 | Open-ended audio dialogue understanding, multilingual ambiguity handling. | New. | Paper/data release and license need review. | `needs-legal`. | Scenario-runner voice ambiguity scenarios. | P2 | Methodology and ambiguity taxonomy first. |
| AIR-Bench: https://aclanthology.org/2024.acl-long.109/ | Generative audio-language benchmark with speech, natural sounds, and music. | New; broader than current voice-only lanes. | Public benchmark; subset licenses need review. | `downloaded-eval`, subset-specific. | Audio understanding registry entry after speech subset triage. | P2 | Speech-only foundation rows, no music/sound scene rows initially. |

## Recommended P0 Implementation Issues

1. VoiceCodeBench exact-token ASR gate: #13358
   - Target: `packages/training` plus `packages/benchmarks/registry`.
   - Metrics: CTEM/TSR, URL/path/ID exact recovery, punctuation-critical WER.
   - Evidence: real Eliza-1 or configured ASR provider run over a downloaded slice, score JSON, and manually reviewed failures.

2. QMSum and MeetingBank meeting artifact adapter: #13359
   - Target: `packages/benchmarks/meeting-transcription-proof` with scenario-runner export.
   - Metrics: query answer correctness, quote grounding, action-item extraction, agenda/topic coverage, summary faithfulness.
   - Evidence: real provider run over a tiny downloaded slice and `elizaos.meeting_artifact.v1` outputs inspected by hand.

3. VoiceBench coverage closeout: #13360
   - Target: existing `voicebench_quality` and `voicebench` registry entries.
   - Metrics: current suite coverage vs public VoiceBench subsets, per-suite score, STT provider, judge model, mock-result rejection.
   - Evidence: real `voicebench_quality` run with non-mock STT and Cerebras judge, plus report JSON.

4. Sierra-style tau-Knowledge/tau-Voice eliza-owned fixtures: #13361
   - Target: `lifeops-bench` and scenario-runner live voice.
   - Metrics: deterministic backend state success, knowledge-source grounding, interruption recovery, dropped-frame robustness, task pass-at-1.
   - Evidence: eliza-owned synthetic domain only; no Sierra data unless license/access is confirmed.

## Source And Repo Review Notes

- QMSum's primary repository describes 1,808 query-summary pairs over 232
  meetings across Academic, Product, and Committee domains and carries an MIT
  repository license, but adapter PRs still need corpus-level provenance review.
- MeetingBank's project page describes 1,366 city-council meetings, more than
  3,579 hours of video, transcripts, minutes, agendas, and 6,892 segment-level
  summarization instances; adapters should download by manifest rather than
  commit raw data.
- ELITR-Bench includes password-protected JSON archives with manually crafted
  questions, ground-truth answers, metadata, and generated responses. GitHub
  reports mixed code/data licenses, including CC BY 4.0 for data, so keep it P1
  and recheck upstream ELITR terms before fixtures.
- VoiceCodeBench's Hugging Face card reports MIT licensing, 300 test rows, audio
  modality, and structured entities; it is the cleanest P0 exact-token ASR slice.
- VoiceBench's GitHub repository and Hugging Face dataset report Apache-2.0
  licensing, public data, and 20,554 rows. elizaOS already registers
  `voicebench` and `voicebench_quality`, so the P0 work is coverage closeout, not
  a greenfield benchmark.
- Sierra's 3-Bench blog describes tau-Voice as realistic full-duplex voice with
  interruptions, noisy/compressed audio, dropped frames, and task pass@1
  failures. The P0 value is methodology and eliza-owned fixtures until public
  code/data/license status is reviewed.
- Local repo inspection found existing benchmark registry coverage for
  `voicebench`, `voicebench_quality`, `mmau`, and `tau_bench`, plus
  voice-speaker-validation, LifeOpsBench, plugin-google Meet report imports, and
  Eliza-1 training/eval surfaces. #13378 is the proposed
  meeting-transcription-proof adapter-contract scaffold; no direct QMSum,
  MeetingBank, VoiceCodeBench, ELITR-Bench, or TCR adapter exists on `develop`
  today.

## Follow-Up Triage

- Legal: MeetBench/MeetAll, mu-Bench, MTalk-Bench, AMI, ICSI, CHiME-6, and any dataset with non-commercial, restricted, or source-corpus terms.
- Infra: long audio downloads, GPU/ASR providers, and nightly-only release lanes.
- Product/model: which Eliza-1 gates become blocking versus dashboard-only.
- Contamination: keep training data and evaluation data separated; do not fine-tune on benchmark rows without explicit approval.

## Verification Notes

This PR is documentation and planning only. It does not add adapters, benchmark
data, model behavior, or runtime code. Applicable evidence is source review and
repo coverage inspection; real run evidence belongs to the adapter PRs listed
above.
