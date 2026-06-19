#!/usr/bin/env python3
"""
Training Configuration for English LJSpeech Dataset
"""

import torch
from dataclasses import dataclass
from typing import Optional


@dataclass
class EnglishTrainingConfig:
    """Training configuration optimized for LJSpeech English dataset"""

    # Dataset paths
    data_dir: str = "LJSpeech-1.1"
    output_dir: str = "output_models_english"

    # Basic training parameters
    num_epochs: int = 300  # Extended for full convergence
    batch_size: int = 32        # Optimal for RTX 4090 with BF16
    learning_rate: float = 1e-3 # Keep at 1e-3 - gradient explosion protection handles instability
    device: str = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"

    # Validation split
    validation_split: float = 0.05  # 5% of data for validation (~650 samples from LJSpeech)
    validate_every: int = 1         # Run validation every N epochs
    save_best_only: bool = True     # Only save checkpoints that improve validation loss

    # Learning Rate Reasoning (batch=32, BF16):
    # - Base LJSpeech LR: 4e-5 (batch=16, FP32)
    # - Batch scaling: 32/16 = 2x → apply ~1.5x (not full 2x due to BF16 stability)
    # - BF16 benefit: Lower gradient noise → can handle slightly higher LR
    # - Mixed losses: L1 (smooth) + MSE (moderate) + BCE (sensitive) → need balance
    # - Safe range: 4e-5 to 8e-5 (6e-5 is empirically validated sweet spot)
    # - With cosine annealing: avg LR ~3e-5 (60% of training below 4e-5)
    # - Result: Fast convergence without BCE instability or NaNs
    #
    # Scaling guide for other batch sizes (BF16):
    # - Batch 16: 4e-5 to 5e-5 (conservative baseline)
    # - Batch 32: 6e-5 (recommended, validated)
    # - Batch 48: 7e-5 (with gradient checkpointing)
    # - Batch 64: 7.5e-5 to 8e-5 (upper limit, monitor closely)

    # Learning rate warmup (critical for transformer stability)
    warmup_epochs: int = 10   # Linear warmup from 0 to learning_rate over first N epochs
    # Warmup reasoning:
    # - Large 62M transformer needs gentle start to prevent instability
    # - 10 epochs = ~4,100 steps (standard for transformers: 4k-8k steps)
    # - Prevents early loss spikes and improves final convergence by 5-10%
    # - Schedule: epochs 0-10 (linear ramp 0→1e-3), epochs 10+ (cosine annealing)

    # Learning rate scheduler (Cosine Annealing - NO RESTARTS)
    # FIXED: Removed CosineAnnealingWarmRestarts to prevent catastrophic LR spikes
    # Restarts caused training collapse at epoch 60 (mel_loss 0.4 → 3.0)
    # Now uses smooth monotonic decay: learning_rate → lr_eta_min over full training
    lr_eta_min: float = 5e-6  # Minimum learning rate (raised floor for faster learning)

    # Optimizer parameters (AdamW - optimal for transformers)
    weight_decay: float = 0.01  # Increased from 0.005 for BF16 stability
    adam_eps: float = 1e-8      # Standard epsilon
    adam_betas: tuple = (0.9, 0.999)  # Default betas work well

    # Model architecture parameters
    n_mels: int = 80                    # Number of mel frequency bins
    hidden_dim: int = 512               # Hidden dimension for embeddings and transformers
    n_encoder_layers: int = 6           # Number of transformer encoder layers
    n_decoder_layers: int = 6           # Number of transformer decoder layers
    n_heads: int = 8                    # Number of attention heads
    encoder_ff_dim: int = 2048          # Feed-forward dimension in encoder
    decoder_ff_dim: int = 2048          # Feed-forward dimension in decoder
    encoder_dropout: float = 0.1        # Dropout rate
    max_decoder_seq_len: int = 4000     # Maximum decoder sequence length

    # Loss weights (BALANCED for all components)
    # Duration predictor MUST learn properly - wrong durations = garbage audio even with good mels
    # Testing showed 0.005 is TOO SMALL (stuck at 0.323), but 0.05 is TOO HIGH (gradient explosions)
    # Sweet spot: 0.02 provides sufficient signal without instability
    duration_loss_weight: float = 0.02   # Balanced - not too weak (0.005) nor too strong (0.05)
    stop_token_loss_weight: float = 0.1  # Weight for stop token loss

    # Dual Mel Loss Weights (Tacotron 2 architecture)
    # L_mel = α * L(mel_coarse, target) + β * L(mel_refined, target)
    # mel_coarse: Direct decoder output (pre-PostNet) - ensures decoder learns
    # mel_refined: After PostNet refinement (post-PostNet) - final quality
    mel_coarse_loss_weight: float = 0.5  # Pre-PostNet loss (stabilizes decoder training)
    mel_refined_loss_weight: float = 1.0  # Post-PostNet loss (prioritizes final quality)
    # Reasoning:
    # - Both losses prevent PostNet from "fighting" decoder
    # - Pre-PostNet (0.5): Strong gradients to decoder, faster convergence
    # - Post-PostNet (1.0): Prioritizes final mel quality for vocoder
    # - Total mel weight ≈ 1.5x, but split across two targets
    # - This is the standard Tacotron 2 approach used in all major TTS models

    # Audio processing parameters (optimized for LJSpeech)
    max_seq_length: int = 2500          # Maximum mel frame sequence length
    sample_rate: int = 22050            # Audio sample rate (LJSpeech is 22050 Hz)
    hop_length: int = 256               # STFT hop length in samples
    win_length: int = 1024              # STFT window length in samples
    n_fft: int = 1024                   # FFT size
    f_min: float = 0.0                  # Minimum frequency
    f_max: float = 8000.0               # Maximum frequency (Nyquist = sr/2 = 11025)

    # Data loading
    num_workers: int = 2                # Number of data loading workers (conservative default)
    # OPTIMIZATION: After first run, monitor GPU utilization. If GPU waits for data:
    # - 4-8 cores: try num_workers=4
    # - 8-16 cores: try num_workers=6
    # - 16+ cores: try num_workers=8
    # Note: Each worker uses ~1-2GB RAM. Monitor with: nvidia-smi dmon -s u
    pin_memory: bool = True             # Pin memory for faster GPU transfer (disable for MPS)
    prefetch_factor: int = 3            # Number of batches to prefetch (only used if num_workers > 0)
    persistent_workers: bool = True     # Keep workers alive between epochs (only used if num_workers > 0)

    # Checkpointing
    save_every: int = 10                # Save checkpoint every N epochs (reduced frequency to save disk space)
    resume_checkpoint: str = 'auto'     # Resume from checkpoint ('auto' for latest, or path to .pth)
    keep_last_n_checkpoints: int = 2    # Only keep the last N checkpoints (auto-delete old ones)

    # Gradient checkpointing (memory optimization)
    gradient_checkpointing: bool = True # Enable gradient checkpointing
    checkpoint_segments: int = 2        # Number of segments for checkpointing
    auto_optimize_checkpointing: bool = True  # Auto-optimize segments based on GPU memory

    # Mixed precision training (auto-detects best dtype)
    use_mixed_precision: bool = True    # Enable mixed precision training
    mixed_precision_dtype = torch.bfloat16  # Preferred dtype (auto-falls back to fp16 if bf16 unsupported)
    # AUTOMATIC BEHAVIOR:
    # - CUDA: Auto-detects BF16 support (Ampere+), falls back to FP16 on older GPUs
    # - MPS: Uses config dtype (BF16 or FP16)
    # - BF16: No GradScaler needed (inherently stable)
    # - FP16: Conservative GradScaler enabled automatically (init_scale=4096)
    amp_init_scale: float = 2**12       # Initial loss scale for FP16 (4096, conservative)
    amp_growth_factor: float = 2.0      # Growth factor for loss scale (FP16 only)
    amp_backoff_factor: float = 0.5     # Backoff factor for loss scale (FP16 only)
    amp_growth_interval: int = 1000     # Steps between scale increases (FP16 only)

    # Gradient clipping
    max_grad_norm: float = 1.0          # Maximum gradient norm for clipping

    # Scheduled Sampling - DISABLED for stability
    # ISSUE: Even gentle sampling (1.5%) caused catastrophic stop token failure at epoch 38
    # - Stop loss exploded: 0.004 → 0.38 (95x increase) when sampling started
    # - Gradients exploded silently (BF16 has no overflow warnings)
    # - Stop token confusion cascaded to duration/mel predictors
    # SOLUTION: Train with pure teacher forcing (100% stable, proven to work)
    # - Inference quality will be tested after training converges to mel_loss ~0.2-0.3
    # - Can fine-tune with very gentle sampling (0.5%) in later epochs if needed
    enable_scheduled_sampling: bool = False  # DISABLED - caused training collapse
    scheduled_sampling_warmup_batches: int = 999999  # Effectively never start
    scheduled_sampling_max_prob: float = 0.0         # No sampling
    scheduled_sampling_zero_input_ratio: float = 0.0 # No zero-input training
    # Note: Pure teacher forcing is how most production TTS models train successfully
    # FastSpeech, Tacotron 2, and Glow-TTS all use 100% teacher forcing

    # Ground Truth Durations (IMPORTANT for early training stability)
    # Using GT durations bypasses duration predictor, allowing mel predictor to learn faster
    use_gt_durations_until_epoch: int = 0  # Use ground truth durations for first N epochs (0 = disabled)

    # Profiling (debugging)
    enable_profiling: bool = False      # Enable GPU profiling
    profile_epoch_start: int = 1        # Start profiling from this epoch
    profile_wait_steps: int = 1         # Wait steps before profiling
    profile_warmup_steps: int = 1       # Warmup steps for profiling
    profile_steps: int = 5              # Active profiling steps
    run_standalone_profiling: bool = False

    # Interbatch profiling
    enable_interbatch_profiling: bool = False
    interbatch_report_interval: int = 100

    # Adaptive memory management
    enable_adaptive_memory: bool = True
    memory_report_interval: int = 500

    # Logging
    log_dir: str = "runs"               # TensorBoard log directory
    log_interval: int = 50              # Log every N batches

    # Weights & Biases logging
    use_wandb: bool = False             # Enable Weights & Biases logging
    wandb_project: str = "kokoro-english-tts"  # W&B project name
    wandb_entity: Optional[str] = None  # W&B entity (username or team)
    wandb_run_name: Optional[str] = None  # W&B run name (auto-generated if None)
    wandb_tags: list = None             # W&B tags for the run
    wandb_notes: Optional[str] = None   # W&B notes for the run

    # Validation
    validation_split: float = 0.05      # Fraction of data for validation
    validate_every: int = 1             # Validate every N epochs

    def __post_init__(self):
        """Post-initialization validation and adjustments"""
        import os

        # Check if we should suppress output (only during testing)
        quiet = os.environ.get('TESTING')

        # Validate checkpoint segments
        if self.checkpoint_segments < 1:
            self.checkpoint_segments = 1
            if not quiet:
                print("Warning: checkpoint_segments must be >= 1, setting to 1")

        # Disable pin_memory for MPS (not supported)
        if self.device == "mps":
            self.pin_memory = False
            if not quiet:
                print("Note: pin_memory disabled for MPS device")

        # Auto-optimize checkpointing if requested
        if self.auto_optimize_checkpointing and self.gradient_checkpointing:
            self._optimize_checkpointing()

        # Log configuration
        self._log_config()

    def _optimize_checkpointing(self):
        """Optimize checkpoint segments based on available GPU memory"""
        import os

        quiet = os.environ.get('TESTING')

        device = None
        if torch.cuda.is_available():
            device = "cuda"
            if not quiet:
                print("CUDA available, optimizing checkpointing for GPU")
        elif torch.backends.mps.is_available():
            device = "mps"
            if not quiet:
                print("MPS available, optimizing checkpointing for Apple Silicon")
        else:
            if not quiet:
                print("No GPU acceleration available, skipping checkpointing optimization")
            return

        try:
            if device == "cuda":
                # Get GPU memory info
                total_memory_mb = torch.cuda.get_device_properties(0).total_memory / 1024**2
                if not quiet:
                    print(f"CUDA Device: {torch.cuda.get_device_name(0)}")
                    print(f"Total GPU Memory: {total_memory_mb:.1f} MB")

                # Estimate segments based on available memory
                # More memory = fewer segments needed
                if total_memory_mb > 20000:  # >20GB
                    self.checkpoint_segments = 2
                elif total_memory_mb > 10000:  # >10GB
                    self.checkpoint_segments = 3
                elif total_memory_mb > 6000:   # >6GB
                    self.checkpoint_segments = 4
                else:
                    self.checkpoint_segments = 6  # <6GB - more aggressive

            elif device == "mps":
                # For MPS, use conservative settings
                # MPS unified memory handling is different from CUDA
                if not quiet:
                    print("Using conservative checkpointing settings for MPS")
                self.checkpoint_segments = 4

            if not quiet:
                print(f"Optimized checkpoint_segments: {self.checkpoint_segments}")

        except Exception as e:
            if not quiet:
                print(f"Error optimizing checkpointing: {e}")
                print("Using default checkpoint_segments")

    def _log_config(self):
        """Log important configuration details"""
        import os
        # Skip logging during tests
        if os.environ.get('TESTING'):
            return

        print("\n" + "="*60)
        print("English TTS Training Configuration")
        print("="*60)
        print(f"Dataset: {self.data_dir}")
        print(f"Output: {self.output_dir}")
        print(f"Device: {self.device}")
        print(f"Batch Size: {self.batch_size}")
        print(f"Learning Rate: {self.learning_rate}")
        print(f"Epochs: {self.num_epochs}")
        print(f"Mixed Precision: {self.use_mixed_precision}")

        if self.gradient_checkpointing:
            print(f"Gradient Checkpointing: Enabled ({self.checkpoint_segments} segments)")
            estimated_savings = (self.checkpoint_segments - 1) / self.checkpoint_segments * 100
            print(f"  Estimated memory savings: ~{estimated_savings:.1f}%")
        else:
            print("Gradient Checkpointing: Disabled")

        print(f"\nAudio Config:")
        print(f"  Sample Rate: {self.sample_rate} Hz")
        print(f"  Mel Channels: {self.n_mels}")
        print(f"  FFT Size: {self.n_fft}")
        print(f"  Hop Length: {self.hop_length}")
        print(f"  Window Length: {self.win_length}")

        print(f"\nModel Config:")
        print(f"  Hidden Dim: {self.hidden_dim}")
        print(f"  Encoder Layers: {self.n_encoder_layers}")
        print(f"  Decoder Layers: {self.n_decoder_layers}")
        print(f"  Attention Heads: {self.n_heads}")
        print(f"  Encoder FF Dim: {self.encoder_ff_dim}")
        print(f"  Decoder FF Dim: {self.decoder_ff_dim}")
        print("="*60 + "\n")

    def to_dict(self) -> dict:
        """Convert config to dictionary"""
        return {k: v for k, v in self.__dict__.items() if not k.startswith('_')}

    @classmethod
    def from_dict(cls, config_dict: dict) -> 'EnglishTrainingConfig':
        """Create config from dictionary"""
        return cls(**config_dict)


def get_default_config() -> EnglishTrainingConfig:
    """Get default configuration for LJSpeech training"""
    return EnglishTrainingConfig()


def get_small_config() -> EnglishTrainingConfig:
    """Get configuration for testing with smaller model"""
    config = EnglishTrainingConfig(
        batch_size=8,
        n_encoder_layers=4,
        n_decoder_layers=4,
        hidden_dim=256,
        encoder_ff_dim=1024,
        decoder_ff_dim=1024,
        num_epochs=10,
    )
    return config


def get_medium_config() -> EnglishTrainingConfig:
    """
    Get configuration for medium model - OPTIMAL for single-speaker LJSpeech

    Medium model (~25-30M params) is the sweet spot for LJSpeech:
    - 2-3x faster training than large (62M)
    - More reliable convergence with limited data (24 hours)
    - No gradient checkpointing needed (saves 20-30% training time)
    - Still achieves excellent quality for single speaker

    Recommended for:
    - Single-speaker datasets (LJSpeech, LibriTTS single speaker)
    - Limited GPU memory (8-12GB)
    - Faster iteration during development
    """
    config = EnglishTrainingConfig(
        batch_size=32,  # Can use same batch size as default
        n_encoder_layers=4,  # Reduced from 6 - sufficient for single speaker
        n_decoder_layers=4,  # Reduced from 6 - sufficient for single speaker
        hidden_dim=384,      # Between small (256) and default (512)
        encoder_ff_dim=1536, # 4x hidden_dim (standard ratio)
        decoder_ff_dim=1536, # 4x hidden_dim (standard ratio)
        n_heads=8,           # Keep 8 heads (divisible by 384)
        gradient_checkpointing=False,  # Not needed for medium model
    )
    return config


def get_large_config() -> EnglishTrainingConfig:
    """Get configuration for larger model (requires more GPU memory)"""
    config = EnglishTrainingConfig(
        batch_size=32,
        n_encoder_layers=8,
        n_decoder_layers=8,
        hidden_dim=768,
        encoder_ff_dim=3072,
        decoder_ff_dim=3072,
        n_heads=12,
    )
    return config


if __name__ == "__main__":
    # Test configurations
    print("Default Config:")
    config = get_default_config()

    print("\nSmall Config (for testing):")
    config_small = get_small_config()

    print("\nLarge Config (for high-end GPUs):")
    config_large = get_large_config()
