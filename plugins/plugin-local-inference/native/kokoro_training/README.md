# Kokoro English TTS

Training implementation for English text-to-speech using the Kokoro Transformer architecture with LJSpeech dataset support.

## Current State

This is a simplified training implementation based on the Kokoro architecture. The official Kokoro-82M uses a decoder-only architecture based on StyleTTS 2 and iSTFTNet, employing a phoneme-level BERT text encoder, style encoder for prosody control, WavLM-based discriminator (12 layers, pre-trained on 94k hours), and iSTFTNet vocoder generating magnitude and phase for inverse STFT conversion. Training uses two stages: acoustic modules for mel-spectrogram reconstruction, then TTS prediction modules with style diffusion and adversarial training. This implementation uses explicit MFA-derived durations with a duration predictor, teacher forcing with standard multi-head attention, no style encoder or multi-speaker embeddings, a simple encoder-decoder transformer (~22M parameters vs 82M), and external HiFi-GAN vocoder, prioritizing training clarity and educational value over production architecture.

| Component | Kokoro-82M (Official) | This Implementation |
|-----------|----------------------|---------------------|
| **Architecture** | Decoder-only (StyleTTS 2 + iSTFTNet) | Encoder-decoder transformer |
| **Parameters** | 82M | ~22M |
| **Text Encoder** | Phoneme-level BERT (pre-trained) | Standard transformer (6 layers) |
| **Style Encoder** | Yes (prosody/speaker control) | No |
| **Alignment** | Learned via diffusion | Explicit MFA durations |
| **Discriminator** | WavLM (12 layers, 94k hours) | None |
| **Training** | Two-stage + adversarial | Single-stage supervised |
| **Vocoder** | Integrated iSTFTNet | External HiFi-GAN |
| **Multi-speaker** | Yes (zero-shot) | No |
| **Training Data** | Few hundred hours | LJSpeech (24 hours) |

## Features

Full encoder-decoder transformer with multi-head attention, phoneme-level duration alignment using Montreal Forced Aligner (MFA), CUDA support with optional mixed precision training, experiment tracking via Weights & Biases, checkpoint management for resuming training, and adaptive memory management with gradient checkpointing.

## Quick Start

Install dependencies:
```bash
pip install -r requirements.txt
```

The system uses `g2p_en` for grapheme-to-phoneme conversion (ARPA phonemes), which perfectly matches MFA's english_us_arpa alignment model.

Download LJSpeech dataset with pre-aligned MFA annotations (3.8GB, **recommended - saves 1-3 hours**):
```bash
python setup_ljspeech.py --zenodo
```

```bash
# Download dataset only
python setup_ljspeech.py

# Then run alignment with standard dictionary (matches g2p_en)
python setup_ljspeech.py --align --no-custom-dict
```

**Note**: The `--no-custom-dict` flag uses MFA's standard `english_us_arpa` dictionary, which perfectly matches our `g2p_en` phoneme processor. This ensures 100% alignment compatibility.

Start training:
```bash
python training_english.py --corpus LJSpeech-1.1 --wandb
```

Resume from checkpoint:
```bash
python training_english.py --corpus LJSpeech-1.1 --resume auto --wandb
```

Generate speech:
```bash
python inference_english.py \
  --model kokoro_english_model/kokoro_english_final.pth \
  --text "Hello world, this is a test." \
  --output output.wav
```

## Training Options

| Argument | Default | Description |
|----------|---------|-------------|
| `--corpus` | `LJSpeech-1.1` | Path to LJSpeech dataset |
| `--output` | `./kokoro_english_model` | Output directory for checkpoints |
| `--batch-size` | from config (32) | Training batch size |
| `--epochs` | from config (300) | Number of training epochs |
| `--learning-rate` | from config (1e-3) | Learning rate |
| `--model-size` | `default` | Model size: `small` (6M), `medium` (25M, **recommended for LJSpeech**), `default` (62M), `large` (120M) |
| `--device` | `auto` | Device: `auto`, `cuda`, `mps`, `cpu` |
| `--resume` | `None` | Resume from checkpoint (`auto` for latest, or path to .pth) |
| `--wandb` | `False` | Enable Weights & Biases logging |
| `--no-gradient-checkpointing` | `False` | Disable gradient checkpointing (uses more memory) |
| `--no-mixed-precision` | `False` | Disable mixed precision training |
| `--test-mode` | `False` | Quick test with 100 samples, 5 epochs |

## Model Architecture

The model consists of a text encoder (6-layer transformer with 8 attention heads), duration predictor (MLP for phoneme durations), length regulator (expands encoder outputs), mel decoder (6-layer transformer with masked attention), **PostNet** (5-layer convolutional refinement network from Tacotron 2), and stop token predictor.

Configuration: 512 hidden dimensions, 6 encoder/decoder layers, 8 attention heads, 2048 feed-forward dimensions, 80 mel channels, 22,050 Hz sample rate. Gradient checkpointing enabled for memory efficiency.

### Current Implementation Features

**Scheduled Sampling** (CRITICAL for inference quality):
- Gradually exposes model to its own predictions during training to prevent exposure bias
- Schedule: 0-500 batches (pure teacher forcing) → 500-1000 (10% sampling) → 1000-2000 (30% sampling) → 2000+ (50% sampling)
- Includes zero-input training (30% of sampling time) to teach model to generate from scratch
- Prevents the common issue where models train perfectly but produce garbage audio at inference

**PostNet Architecture**:
- 5-layer convolutional network (mel_dim → 512 → 512 → 512 → 512 → mel_dim)
- Refines coarse mel predictions by capturing temporal dependencies and frequency correlations
- Applied to complete sequences (not frame-by-frame) for proper context
- Uses residual connection: `mel_final = mel_coarse + 0.5 * mel_residual`

**Loss Configuration**:
- Mel Loss Weight: 1.0 (primary objective)
- Duration Loss Weight: 0.01 (small to prevent gradient imbalance)
- Stop Token Loss Weight: 0.1
- Gradient clipping: 1.0 (prevents explosion)

**Training Optimizations**:
- Optional ground truth duration bypass for early epochs (`use_gt_durations_until_epoch`)
- Conservative learning rate (7e-5) optimized for batch size 32 with BF16
- Automatic BF16/FP16 mixed precision detection
- Adaptive memory management with gradient checkpointing

### Architecture Flow

```
Input: Phoneme indices
         ↓
    Text Encoder (Transformer)
         ↓
    Duration Predictor → predicted durations
         ↓
    Length Regulator (expand by durations)
         ↓
    Decoder (Transformer with scheduled sampling)
         ├─ Teacher forcing (0-500 batches)
         ├─ Mixed sampling (500-2000 batches)
         └─ Full exposure (2000+ batches)
         ↓
    Mel Projection Coarse → coarse mels
         ↓
    PostNet (5-layer Conv1D) → residual
         ↓
    mel_final = coarse + 0.5 * residual
         ↓
    Clamp to [-11.5, 0.0]
         ↓
    Output: Mel spectrogram → HiFi-GAN vocoder → Audio
```

## Implementation Notes

### Why These Features Are Critical

**Scheduled Sampling** prevents exposure bias - the most common failure mode in autoregressive TTS:
- **Problem**: Models trained only with perfect ground truth inputs produce garbage when using their own predictions at inference
- **Solution**: Gradually expose model to imperfect predictions during training (0% → 10% → 30% → 50%)
- **Impact**: Without this, training loss looks good but inference produces unintelligible audio

**PostNet on Complete Sequences** is required for proper temporal context:
- **Problem**: Applying Conv1D (kernel_size=5) frame-by-frame gives no context → random noise
- **Solution**: Generate all coarse frames first, then apply PostNet to complete sequence
- **Impact**: Frame-by-frame PostNet was the root cause of garbage autoregressive output

**Loss Weight Balance** prevents gradient imbalance:
- **Problem**: duration_loss_weight=1.0 caused duration gradients (20,000+) to overwhelm mel gradients (0.4)
- **Solution**: Reduce to 0.01 - just enough to train duration predictor without dominating
- **Impact**: Mel predictor can now learn effectively

### Expected Training Timeline

Based on overfit test success (mel loss 0.016 after 3000 iterations):

- **Epoch 10**: Mel loss ~1.0 - Barely intelligible, learning phoneme-to-mel mapping
- **Epoch 20**: Mel loss ~0.5 - Robotic but clear, basic prosody emerging
- **Epoch 50**: Mel loss ~0.3 - Natural-sounding, good quality
- **Epoch 100**: Mel loss ~0.2-0.3 - High quality, production-ready

**Note**: Full dataset mel loss will be higher than overfit (0.2-0.3 vs 0.016) because it generalizes across 13,000 diverse samples, not just 1. Audio quality should be excellent at ~0.3.

### Troubleshooting

**Training crashes with "unexpected keyword argument"**:
- Fixed in latest version - `forward()` wrapper now accepts `use_gt_durations` and `decoder_input_mels`
- Run: `git pull` or check `kokoro/model.py` lines 777-803

**Model produces garbage audio at inference despite low training loss**:
- Check scheduled sampling is enabled: Look for "Scheduled Sampling: ENABLED" in logs
- If disabled, set `enable_scheduled_sampling: True` in `training/config_english.py`
- This is the #1 cause of "trains well, fails at inference" issues

**Mel loss stuck above 1.0 after epoch 20**:
- Check `duration_loss_weight = 0.01` (not 0.25 or 1.0) in config
- Check gradient norm stays below 5.0 (if exploding, reduce learning rate)
- Verify PostNet is present: `grep "PostNet" kokoro/model.py` should find it

**Audio quality not improving after epoch 50**:
- Verify mel loss is still decreasing (should reach 0.2-0.3 by epoch 100)
- Check learning rate schedule - should decrease with cosine annealing
- Generate test audio every 10 epochs to track progress

**Out of memory errors**:
- Reduce batch size: try 16, 8, or 4
- Gradient checkpointing is enabled by default (saves ~75% memory)
- For MPS (Apple Silicon), batch size 8-16 recommended

### Validation Strategy

Run inference tests periodically to catch issues early:

```bash
# Every 10 epochs, generate test audio
python inference_english.py \
  --model kokoro_english_model/checkpoint_epoch_20.pth \
  --text "The quick brown fox jumps over the lazy dog." \
  --output test_epoch_20.wav
```

Compare audio quality across epochs:
- Epoch 10: Should be barely intelligible (proves model is learning)
- Epoch 20: Should be robotic but clear (proves no garbage output)
- Epoch 50+: Should sound natural (proves training is working)

If any checkpoint produces garbage audio, scheduled sampling may have been disabled. Check training logs.

## Dataset Structure

The LJSpeech dataset should be organized as:

```
LJSpeech-1.1/
├── metadata.csv           # Transcriptions
├── wavs/                  # Audio files (13,100 samples)
│   ├── LJ001-0001.wav
│   └── ...
└── TextGrid/              # MFA alignments (if using Zenodo)
    ├── LJ001-0001.TextGrid
    └── ...
```

## Inference

Basic usage:
```python
from inference_english import EnglishTTSInference

tts = EnglishTTSInference(
    model_path="kokoro_english_model/kokoro_english_final.pth",
    device="cuda"
)

tts.synthesize_to_file(
    text="Hello, how are you today?",
    output_path="output.wav"
)
```

Advanced options:
```bash
python inference_english.py \
  --model kokoro_english_model/checkpoint_epoch_50.pth \
  --text "Your text here" \
  --output output.wav \
  --device cuda \
  --vocoder hifigan
```

## Troubleshooting

`ImportError: cannot import name 'TypeIs' from 'typing_extensions'`
Run `pip install --upgrade typing-extensions`

Mixed precision errors on CUDA
Add `--no-mixed-precision` flag

Out of memory
Reduce `--batch-size` (try 8, 4, or 2)

W&B not showing loss charts
Fixed in latest version (losses log every 10 batches)

Performance tips: Use batch size 16-32 for CUDA GPUs. CPU training not recommended, but if needed use batch size 2-4. Gradient checkpointing is enabled by default. Pre-aligned Zenodo dataset saves 1-3 hours of setup.

## File Structure

```
kokoro-english-tts/
├── README.md
├── requirements.txt
├── setup_ljspeech.py                # Dataset setup
├── training_english.py              # Main training script
├── inference_english.py             # Main inference script
├── test_english_implementation.py   # Test suite
│
├── kokoro/                          # Core model architecture
│   ├── __init__.py
│   ├── model.py                     # Kokoro TTS model
│   ├── model_transformers.py        # Transformer encoder/decoder
│   └── positional_encoding.py      # Sinusoidal encoding
│
├── data/                            # Dataset and preprocessing
│   ├── __init__.py
│   ├── ljspeech_dataset.py          # LJSpeech data loader
│   └── english_phoneme_processor.py # English G2P (g2p_en - ARPA)
│
├── audio/                           # Audio processing and vocoder
│   ├── __init__.py
│   ├── audio_utils.py               # Audio utilities
│   ├── vocoder_manager.py           # Vocoder interface
│   └── hifigan_vocoder.py           # HiFi-GAN implementation
│
└── training/                        # Training infrastructure
    ├── __init__.py
    ├── config_english.py            # Training configuration
    ├── trainer.py                   # Base trainer
    ├── english_trainer.py           # English trainer with W&B
    ├── checkpoint_manager.py        # Checkpoint utilities
    ├── adaptive_memory_manager.py   # Memory optimization
    ├── interbatch_profiler.py       # Performance profiling
    ├── mps_grad_scaler.py           # MPS mixed precision
    └── device_type.py               # Device enumeration
```

## Requirements

- Python 3.11 (atleast tested with this)
- PyTorch 2.0+ (CUDA 11.8+ for GPU)
- g2p_en - English G2P (ARPA phonemes matching MFA)
- librosa, soundfile - Audio processing
- wandb - Experiment tracking (optional)
- tqdm - Progress bars

See `requirements.txt` for full list.

## Testing

Run implementation tests:
```bash
python test_english_implementation.py
```

Quick training test (100 samples):
```bash
python training_english.py --test-mode
```

## Model Outputs

Training generates checkpoints every 5 epochs, a phoneme processor file, and a final model. Each checkpoint contains model state dict, optimizer state, learning rate scheduler state, training configuration, current epoch and loss, and mixed precision scaler state.

## License

This implementation is for educational and research purposes.

## Acknowledgments

Based on the original Kokoro TTS model. LJSpeech dataset by Keith Ito. Montreal Forced Aligner for phoneme-level alignments. g2p_en for English grapheme-to-phoneme conversion (ARPA phonemes). Original implementation based on [kokoro-ruslan](https://github.com/igorshmukler/kokoro-ruslan).
