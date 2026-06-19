# Training Infrastructure

Training components including trainers, configuration, checkpointing, and optimization utilities.

## Files

`config_english.py` provides training configuration dataclass. Functions: `get_default_config()` for standard setup, `get_small_config()` for testing. Configuration covers data paths/batch size/workers, model architecture dimensions, training parameters (learning rate, epochs, optimizer), audio settings (sample rate, mel parameters), hardware (device, mixed precision, memory), and logging (W&B, checkpoints, profiling).

`trainer.py` contains core training loop with profiling and memory management. Features automatic checkpoint resumption, learning rate scheduling (CosineAnnealingWarmRestarts), gradient clipping (norm=1.0), OOM recovery, and periodic memory cleanup. Supports mixed precision for both CUDA and MPS.

`english_trainer.py` extends base trainer for English TTS with W&B logging. Adds per-batch logging (every 10 batches), epoch summary metrics, memory/mixed precision tracking, smooth loss curves. Logs batch losses (total, mel, duration, stop), learning rate schedule, gradient scale, memory pressure, and throughput.

`checkpoint_manager.py` handles saving and loading model checkpoints. Functions: `save_checkpoint()`, `load_checkpoint()`, `save_phoneme_processor()`, `find_latest_checkpoint()`. Checkpoints contain epoch, model state dict, optimizer state, scheduler state, loss, config, and mixed precision scaler state.

`adaptive_memory_manager.py` provides intelligent memory cleanup based on pressure. Monitors usage every batch, triggers cleanup when pressure high, tracks overhead, handles emergency cleanup on OOM. Device-aware with different strategies for CUDA vs MPS. CUDA thresholds: low < 60%, moderate 60-75%, high 75-85%, critical > 85%.

`interbatch_profiler.py` measures time spent between batches. Tracks data loading time, forward pass time, backward pass time, interbatch gap, and throughput. Used to identify bottlenecks in training pipeline.

`mps_grad_scaler.py` provides custom gradient scaler for Apple Silicon since PyTorch's built-in scaler is CUDA-only. Features loss scaling for FP16 training, overflow detection, dynamic scale adjustment.

`device_type.py` contains simple enum for device types: CUDA, MPS, CPU.

## Training Flow

Initialization: load config, create dataset/dataloader, initialize model, setup optimizer/scheduler, load checkpoint if resuming, initialize W&B if enabled.

Training loop for each batch: adaptive memory check, load data to device, forward pass with mixed precision autocast, backward pass with scaler, optimizer step with gradient clipping (max_norm=1.0), log to W&B every 10 batches. Epoch end: scheduler step, save checkpoint, log epoch summary to W&B.

## Configuration

Default config: batch size 16, hidden dim 512, 6 encoder/decoder layers, 1e-4 learning rate, mixed precision enabled.

Small config for testing: batch size 8, hidden dim 256, 4 encoder/decoder layers.

Custom config example:
```python
config = EnglishTrainingConfig(
    data_dir="LJSpeech-1.1",
    batch_size=32,
    learning_rate=5e-5,
    hidden_dim=768,
    n_encoder_layers=8,
    use_wandb=True,
    enable_profiling=False
)
```

## Key Features

Mixed precision: CUDA uses native `torch.cuda.amp.GradScaler`, MPS uses custom `MPSGradScaler`. Provides 30-50% speed improvement and 40-60% memory reduction. Falls back to FP32 on CPU or if errors occur.

Adaptive memory management monitors GPU/MPS memory every batch, cleans cache when pressure detected, prevents OOM proactively. Overhead typically <1%.

W&B integration provides automatic experiment tracking, real-time loss curves, system metrics, hyperparameter logging, model checkpointing to cloud.

Checkpoint management with auto-resume using `--resume auto`. Saves every N epochs (configurable), includes full training state, enables model selection by lowest loss.

## Performance Tips

Memory optimization: gradient checkpointing enabled by default (75% reduction), adaptive cleanup prevents OOM, start with large batch size and reduce if needed, use `--no-mixed-precision` if unstable.

Speed optimization: use 2-4 data workers (not more), pin memory enabled for CUDA automatically, length-based batching reduces padding waste, disable profiling after debugging.

Quality optimization: 1e-4 learning rate is good default, cosine annealing with warm restarts for scheduling, gradient clipping prevents exploding gradients, MFA alignments essential for duration accuracy.

## Common Issues

OOM errors: reduce batch size, enable gradient checkpointing, disable mixed precision, use adaptive memory management.

Slow training: check data loading bottleneck with profiler, increase batch size if memory available, use mixed precision, reduce workers if CPU-bound.

NaN losses: check learning rate (possibly too high), disable mixed precision temporarily, check input data for NaN values, review gradient clipping.

Checkpoints saved every 5 epochs by default. W&B logging optional but recommended. Mixed precision tested on CUDA and MPS. Adaptive memory manager works on all devices. Profiling adds ~5% overhead when enabled.
