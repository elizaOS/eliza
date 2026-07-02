# audio-fixtures

Real audio clips retained as test fixtures for the local-inference voice
pipeline (ASR decode, per-word timing, VAD, wake-word negatives).

## `freeman.wav`

A real ~22.05 kHz mono speech recording (~761 KB). Its transcript is a known
quantity that the ASR/decode tests assert against, so it must not be
substituted or regenerated — the tests compare against this exact clip.

Relocated here out of the removed standalone `omnivoice.cpp` submodule
(`native/omnivoice.cpp/examples/freeman.wav`), which was retired along with the
OmniVoice TTS engine. Kokoro is now the only on-device TTS; this fixture is a
plain committed asset with no build-time dependency.
