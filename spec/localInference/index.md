# Local inference

`@elizaos/plugin-local-inference` runs models on the device the agent runs
on: it downloads curated models, installs and activates one, serves text
generation and embeddings from it, speaks replies through the device's
audio output, and keeps the privacy of the transcripts it records.

Microphone capture and the live transcription session belong to the
device's voice path ([voice capture](../os/voice/capture.md)); this package receives what
that path captured. The agent host's model settings
([agent models](../agent/host/models.md)) read the installed and active
models from here.

| Area | Specification |
| --- | --- |
| Downloading, installing, assigning and activating models | [Models](./models.md) |
| Text generation and embeddings | [Text and embeddings](./textAndEmbeddings.md) |
| Speaking replies on the device | [Speech output](./speechOutput.md) |
| Consent, redaction and sharing of transcripts | [Transcript privacy](./transcriptPrivacy.md) |
