# Kokoro Model Architecture

Core Transformer-based TTS model architecture.

## Differences from Kokoro-82M

The official Kokoro-82M is a decoder-only architecture based on StyleTTS 2 and iSTFTNet, trained in two stages with adversarial training. Key components include:

**Text Encoder**: Phoneme-level BERT transformer pre-trained on Wikipedia, encoding input phonemes into representations. StyleTTS 2 uses both acoustic and prosodic text encoders.

**Style Encoder**: For multi-speaker synthesis, extracts style vectors from reference audio to control prosody and speaker characteristics. This enables zero-shot voice cloning and style transfer.

**Discriminator**: 12-layer WavLM model pre-trained on 94k hours of speech data, frozen during training to prevent overpowering. Used in adversarial training to improve naturalness.

**iSTFTNet Vocoder**: Instead of directly generating waveforms like HiFi-GAN, it predicts magnitude and phase spectrograms which are converted to audio via inverse STFT. This hybrid approach reduces computational cost and model size while maintaining quality.

**Training**: Two-stage process. Stage 1 trains acoustic modules for mel-spectrogram reconstruction. Stage 2 trains TTS prediction modules (duration, prosody) using fixed acoustic modules from stage 1, with style diffusion and adversarial training.

This implementation differs fundamentally: uses a simple encoder-decoder transformer (~22M vs 82M parameters), explicit MFA-derived durations instead of learned alignments through diffusion, teacher forcing with standard multi-head attention instead of WavLM adversarial training, no style encoder (no prosody control or multi-speaker support), single-stage training without adversarial loss, and external HiFi-GAN vocoder instead of integrated iSTFTNet. This version prioritizes educational clarity over production sophistication.

| Component | Kokoro-82M (Official) | This Implementation |
|-----------|----------------------|---------------------|
| **Architecture Type** | Decoder-only | Encoder-decoder |
| **Base Model** | StyleTTS 2 + iSTFTNet | Custom transformer |
| **Parameters** | 82M | ~22M |
| **Text Encoding** | BERT (phoneme-level, pre-trained) | Transformer encoder (6 layers) |
| **Style Modeling** | Style encoder + diffusion | None |
| **Duration Modeling** | Learned via alignment + diffusion | Explicit MLP predictor (MFA) |
| **Prosody Control** | Style vectors from reference audio | None |
| **Speaker Control** | Multi-speaker (zero-shot cloning) | Single speaker only |
| **Discriminator** | WavLM (12 layers, frozen, 94k hours) | None |
| **Training Stages** | Two-stage (acoustic → TTS) | Single-stage |
| **Training Method** | Adversarial + diffusion | Supervised (MSE + BCE) |
| **Vocoder** | Integrated iSTFTNet (mag + phase) | External HiFi-GAN |
| **Attention Type** | StyleTTS 2 attention mechanisms | Standard multi-head |
| **Training Data** | Few hundred hours (permissive) | LJSpeech (24 hours) |
| **Output** | 24kHz audio | 22.05kHz audio |

## Files

`model.py` contains the complete Kokoro TTS model with text encoder (Transformer), duration predictor (MLP), length regulator (duration expansion), mel decoder (Transformer), **PostNet** (5-layer convolutional refinement), and stop token predictor. Main methods are `forward_training()` for training with scheduled sampling and teacher forcing, `forward_inference()` for autoregressive generation, and `get_model_info()` for parameter stats.

`postnet.py` implements the PostNet architecture from Tacotron 2 - a 5-layer convolutional network that refines coarse mel predictions by capturing temporal dependencies and frequency correlations. Includes both standard PostNet and LightweightPostnet variants.

`model_transformers.py` implements the transformer encoder and decoder blocks with multi-head self-attention and gradient checkpointing support.

`positional_encoding.py` provides sinusoidal positional encoding for sequence order (fixed, not learned), supporting sequences up to max_len (default 5000) with dropout regularization.

## Architecture Overview

```
Text → Encoder → Duration → Length → Decoder → Mel Coarse → PostNet → Mel Final
                 Predictor   Regulator                      + Stop Token
```

**Training flow** uses scheduled sampling and teacher forcing:
- Text becomes phoneme indices
- Encoder processes phoneme sequence
- Duration predictor predicts phoneme durations (or uses ground truth if `use_gt_durations=True`)
- Length regulator expands encoder outputs by durations
- Decoder generates mel frames using:
  - **Teacher forcing**: Ground truth mels as decoder input (0-500 batches)
  - **Scheduled sampling**: Mix of ground truth, model predictions, and zeros (500+ batches)
  - **Zero-input training**: Decoder learns to generate from scratch (30% of sampling)
- Mel projection generates coarse predictions
- **PostNet** refines predictions with 5-layer Conv1D (applied to complete sequence)
- Final output: `mel_final = mel_coarse + 0.5 * mel_residual`
- Stop token predictor indicates sequence end

**Inference flow** is autoregressive with sequence-level PostNet:
1. Encode text, predict durations, expand encoder outputs
2. Generate all coarse mel frames autoregressively (one at a time)
3. Apply PostNet to **complete** coarse sequence (not frame-by-frame)
4. Output refined mel spectrogram until stop token threshold reached

**Key Implementation Details**:
- **Scheduled Sampling**: Prevents exposure bias by gradually exposing model to imperfect predictions during training
- **PostNet on Complete Sequence**: Conv1D (kernel_size=5) needs temporal context - applying frame-by-frame produces garbage
- **Zero-Input Training**: Teaches model to bootstrap from nothing, like inference start conditions
- **Dual Mel Loss (Tacotron 2)**: Supervises both coarse and refined mel predictions for faster convergence
- **Loss Balance**: duration_loss_weight=0.005 prevents duration gradients from overwhelming mel learning

## Dual Mel Loss Architecture

Following **Tacotron 2's dual-loss design**, the model returns BOTH coarse and refined mel spectrograms for separate supervision:

```
Decoder Output → Linear Projection → Mel Coarse (pre-PostNet)
                                          ↓
                                     PostNet (5-layer Conv1D)
                                          ↓
                                     Mel Residual
                                          ↓
                         Mel Refined = Mel Coarse + Mel Residual (post-PostNet)
```

### Why Dual Loss?

**Problem with single loss**: If you only supervise the final refined mel (post-PostNet), gradients must flow through 5 convolutional layers before reaching the decoder. This causes:
- ❌ Slow convergence (decoder doesn't get direct feedback)
- ❌ Weak gradients (diluted through PostNet)
- ❌ PostNet may "fight" decoder (no gradient balance)

**Solution**: Compute **TWO separate losses**:
```python
L_mel = α * L1(mel_coarse, target) + β * L1(mel_refined, target)
        ↑ pre-PostNet (decoder)      ↑ post-PostNet (final quality)
```

### Loss Configuration

Default weights (from `training/config_english.py`):
```python
mel_coarse_loss_weight: float = 0.5   # Pre-PostNet (decoder supervision)
mel_refined_loss_weight: float = 1.0  # Post-PostNet (final quality)
```

**Reasoning**:
- **α = 0.5**: Decoder gets strong direct gradients → learns faster
- **β = 1.0**: PostNet refinement prioritized → better final quality
- **Gradient balance**: Both decoder and PostNet get clear optimization targets
- **No conflict**: PostNet refines instead of fighting decoder

### Benefits

✅ **Faster convergence**: Decoder learns 2-3x faster with direct supervision
✅ **Stable training**: Clear gradient flow to all components
✅ **Better quality**: PostNet specializes in fine details (formants, harmonics)
✅ **Industry standard**: Used in Tacotron 2, FastSpeech, and all major TTS models

### Implementation

The model's `forward_training()` returns BOTH mels:
```python
mel_coarse, mel_refined, durations, stop_logits = model.forward_training(...)
```

The trainer computes both losses separately:
```python
loss_mel_coarse = L1(mel_coarse, target)  # Direct decoder supervision
loss_mel_refined = L1(mel_refined, target)  # Final quality supervision
total_loss = 0.5 * loss_mel_coarse + 1.0 * loss_mel_refined + ...
```

This dual-loss approach is **critical for training large models** (62M parameters) on limited data (24 hours).

## Model Parameters

Default configuration: 63 vocab size (English phonemes), 512 hidden dim, 6 encoder layers, 6 decoder layers, 8 attention heads, 2048 feed-forward dim, 80 mel channels, gradient checkpointing with 4 segments.

Total parameters: ~5.7M (small) or ~22M (default). Model size: ~22 MB (small) or ~85 MB (default).

Clean separation of encoder, duration, and decoder. Gradient checkpointing for large batches. Configurable layers, heads, and dimensions. Supports both training and inference modes. Uses teacher forcing during training, proper autoregressive causal masking, handles variable length sequences, explicit phoneme duration prediction. Checkpoint segments reduce memory by ~75%.

## Usage

```python
from kokoro.model import KokoroModel

model = KokoroModel(
    vocab_size=63,
    mel_dim=80,
    hidden_dim=512,
    n_encoder_layers=6,
    n_decoder_layers=6
)

# Training with scheduled sampling (recommended)
# Returns BOTH mel_coarse (pre-PostNet) and mel_refined (post-PostNet)
mel_coarse, mel_refined, duration_pred, stop_pred = model.forward_training(
    phoneme_indices=phoneme_indices,
    mel_specs=mel_specs,
    phoneme_durations=phoneme_durations,
    stop_token_targets=stop_token_targets,
    use_gt_durations=False,  # Set True to bypass duration predictor
    decoder_input_mels=None  # For scheduled sampling: pass predictions or zeros
)

# Compute dual mel loss (Tacotron 2 approach)
loss_mel_coarse = L1(mel_coarse, mel_specs)   # Pre-PostNet (decoder)
loss_mel_refined = L1(mel_refined, mel_specs)  # Post-PostNet (final)
total_mel_loss = 0.5 * loss_mel_coarse + 1.0 * loss_mel_refined

# Training with scheduled sampling - zero input
decoder_input_zeros = torch.zeros_like(mel_specs)
mel_coarse, mel_refined, duration_pred, stop_pred = model.forward_training(
    phoneme_indices=phoneme_indices,
    mel_specs=mel_specs,
    phoneme_durations=phoneme_durations,
    stop_token_targets=stop_token_targets,
    decoder_input_mels=decoder_input_zeros  # Train to generate from scratch
)

# Inference (autoregressive)
mel_output = model.forward_inference(
    phoneme_indices=phoneme_indices,
    max_len=1000,
    stop_threshold=0.5
)

# Forward() wrapper dispatches to training/inference
# Training mode (when mel_specs provided)
mel_coarse, mel_refined, duration_pred, stop_pred = model(
    phoneme_indices,
    mel_specs,
    phoneme_durations,
    stop_token_targets
)
```

**Key Training Features**:
- **Dual mel output**: Returns both `mel_coarse` (pre-PostNet) and `mel_refined` (post-PostNet) for dual-loss training
- `use_gt_durations=True`: Bypass duration predictor for faster mel learning (useful for first few epochs)
- `decoder_input_mels=None`: Standard teacher forcing (uses ground truth)
- `decoder_input_mels=zeros`: Zero-input training (teaches model to generate from scratch)
- `decoder_input_mels=predictions`: Scheduled sampling (uses model's own predictions)
- Separate loss weights: `mel_coarse_loss_weight=0.5`, `mel_refined_loss_weight=1.0`

**Inference Notes**:
- PostNet is automatically applied to the complete sequence (not frame-by-frame)
- Mel values are clamped to [-11.5, 0.0] to match vocoder training range
- Stop threshold 0.5 means generation stops when sigmoid(stop_logit) > 0.5

Requires PyTorch 2.0+. Gradient checkpointing trades compute for memory. GPUProfiler is a lightweight stub. Supports CUDA, MPS (Apple Silicon), and CPU.
