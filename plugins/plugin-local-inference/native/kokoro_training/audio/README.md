# Audio Processing & Vocoder

Audio processing utilities and neural vocoder (HiFi-GAN) for mel-to-waveform conversion.

## Files

`vocoder_manager.py` provides unified interface for different vocoder backends. Supports HiFi-GAN (neural, high quality) and Griffin-Lim (classical algorithm, fast but lower quality). Features automatic model download from HuggingFace, caching, device management (CUDA/CPU), and fallback to Griffin-Lim if HiFi-GAN fails.

`hifigan_vocoder.py` loads and runs HiFi-GAN neural vocoder. Uses pre-trained model from HuggingFace. High-quality mel-to-waveform conversion at ~100x faster than real-time on GPU. Automatic download and caching. Generator uses upsampling CNN with residual blocks, trained on LJSpeech, produces 22050 Hz audio from 80-channel mels.

`audio_utils.py` contains helper functions for audio processing. `AudioUtils` handles mel spectrogram computation and audio I/O. `PhonemeProcessorUtils` provides text normalization helpers.

## Audio Configuration

Mel spectrogram parameters: 22050 Hz sample rate, 1024 FFT window size, 256 hop length (~11.6ms frame shift), 80 mel channels, 0-8000 Hz frequency range. Hop length of 256 at 22050 Hz gives ~86 frames/second. Typical 3 second utterance produces ~258 mel frames.

## Vocoder Comparison

HiFi-GAN (recommended): excellent quality (near natural), ~100x real-time on GPU or ~10x on CPU, ~50MB model size, auto-downloads on first use. Best for production and high-quality synthesis.

Griffin-Lim: fair quality with artifacts, ~20x real-time on CPU, no model needed, built into torchaudio. Good for quick testing and debugging.

## Usage

```python
from audio import VocoderManager, AudioUtils
from kokoro.model import KokoroModel
from data.english_phoneme_processor import EnglishPhonemeProcessor

# Text to phonemes
processor = EnglishPhonemeProcessor()
phonemes = processor.text_to_phonemes("Hello world")
phoneme_ids = processor.phonemes_to_indices(phonemes)

# Generate mel spectrogram
model = KokoroModel.load("checkpoint.pth")
mel_output = model.inference(phoneme_ids)

# Mel to audio
vocoder = VocoderManager(vocoder_type='hifigan')
audio = vocoder.generate(mel_output, sample_rate=22050)

# Save
AudioUtils.save_audio(audio, "output.wav", 22050)
```

HiFi-GAN performance: ~200x real-time on RTX 3090, ~100x on P4000, ~15x on M1 CPU, ~8x on Intel i7. Memory usage: ~50MB model, ~100MB VRAM for 10s audio. Supports batch processing.

HiFi-GAN model downloaded once and cached in `./vocoder_models/`. Mel spectrograms must match vocoder training format (22050 Hz sample rate).
