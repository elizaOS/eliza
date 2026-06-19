#!/usr/bin/env python3
"""
English TTS Trainer - Standalone trainer for English dataset with BF16/FP16 mixed precision support
"""

import os
import time
import torch
import torch.nn as nn
from torch.utils.data import DataLoader
from tqdm import tqdm
import logging
import torch.profiler
import gc
from typing import Tuple, Dict, Any, Optional

import datetime
from .device_type import DeviceType
from data.ljspeech_dataset import LJSpeechDataset, collate_fn, LengthBasedBatchSampler
from data.english_phoneme_processor import EnglishPhonemeProcessor
from kokoro.model import KokoroModel
from .checkpoint_manager import (
    save_phoneme_processor, save_model_config, load_checkpoint, find_latest_checkpoint,
    save_checkpoint, save_final_model, cleanup_old_checkpoints, check_disk_space
)
from .interbatch_profiler import InterbatchProfiler
from .mps_grad_scaler import MPSGradScaler
from .adaptive_memory_manager import AdaptiveMemoryManager
import wandb

from contextlib import nullcontext
logger = logging.getLogger(__name__)


class EnglishTrainer:
    """
    Standalone trainer for English TTS using LJSpeech dataset.

    Includes BF16/FP16 mixed precision support, W&B logging, and adaptive memory management.
    """

    def __init__(self, config):
        """Initialize English trainer with LJSpeech dataset"""
        self.config = config
        self.device = config.device if hasattr(config, 'device') else 'cpu'
        if isinstance(self.device, str):
            self.device = torch.device(self.device)

        # Initialize memory manager and other components
        self.memory_manager = AdaptiveMemoryManager(self.device, config)

        # Mixed precision setup with automatic BF16/FP16 detection
        self.use_mixed_precision = getattr(config, 'use_mixed_precision', True)

        if self.use_mixed_precision and self.device.type == DeviceType.CUDA.value:
            # Auto-detect best dtype for CUDA devices
            if torch.cuda.is_bf16_supported():
                # ✅ Prefer BF16 on modern GPUs (Ampere/Ada/Hopper)
                self.autocast_dtype = torch.bfloat16
                self.scaler = None  # No GradScaler needed for BF16
                self.device_type = 'cuda'
                logger.info("✓ Using bfloat16 autocast on CUDA (no GradScaler needed)")
                logger.info("  GPU supports BF16 - optimal stability without scaling")
            else:
                # Fallback to FP16 with conservative GradScaler for older GPUs
                self.autocast_dtype = torch.float16
                self.scaler = torch.cuda.amp.GradScaler(
                    init_scale=2**12,  # Conservative initial scale (4096)
                    growth_factor=2.0,
                    backoff_factor=0.5,
                    growth_interval=1000,
                    enabled=True
                )
                self.max_grad_scale = 2**15  # Maximum scale limit (32768)
                self.device_type = 'cuda'
                logger.info("✓ Using float16 autocast on CUDA with GradScaler fallback")
                logger.info("  GPU does not support BF16 - using FP16 with conservative scaling")

        elif self.use_mixed_precision and self.device.type == DeviceType.MPS.value:
            # MPS (Apple Silicon) handling
            config_dtype = getattr(config, 'mixed_precision_dtype', torch.float16)
            if config_dtype == torch.bfloat16:
                self.autocast_dtype = torch.bfloat16
                self.scaler = None
                logger.info("✓ Using bfloat16 autocast on MPS (no scaler needed)")
            else:
                self.autocast_dtype = torch.float16
                self.scaler = MPSGradScaler(
                    init_scale=2**12,
                    growth_factor=2.0,
                    backoff_factor=0.5,
                    growth_interval=1000
                )
                logger.info("✓ Using float16 autocast on MPS with custom scaler")
            self.device_type = DeviceType.MPS.value

        else:
            # CPU or mixed precision disabled
            self.use_mixed_precision = False
            self.scaler = None
            self.autocast_dtype = torch.float32
            self.device_type = self.device.type
            if self.device.type == DeviceType.CUDA.value or self.device.type == DeviceType.MPS.value:
                logger.info("Mixed precision training disabled by configuration")
            else:
                logger.info(f"Mixed precision not supported on {self.device.type}, using FP32")

        # NOW create our English dataset
        logger.info("Loading English LJSpeech dataset...")
        full_dataset = LJSpeechDataset(config.data_dir, config)
        logger.info(f"Loaded {len(full_dataset)} samples")

        # Split into train and validation
        validation_split = getattr(config, 'validation_split', 0.05)
        if validation_split > 0:
            total_size = len(full_dataset)
            val_size = int(total_size * validation_split)
            train_size = total_size - val_size

            # Use torch.utils.data.random_split for deterministic splitting
            from torch.utils.data import random_split
            generator = torch.Generator().manual_seed(42)  # Fixed seed for reproducibility
            self.train_dataset, self.val_dataset = random_split(
                full_dataset, [train_size, val_size], generator=generator
            )
            logger.info(f"Split dataset: {train_size} train, {val_size} validation")

            # Validation dataloader (no batch sampler, just regular batching)
            self.val_dataloader = DataLoader(
                self.val_dataset,
                batch_size=config.batch_size,
                shuffle=False,  # Don't shuffle validation
                collate_fn=collate_fn,
                num_workers=getattr(config, 'num_workers', 2),
                pin_memory=getattr(config, 'pin_memory', False) and self.device.type == DeviceType.CUDA.value,
                drop_last=False  # Use all validation samples
            )
        else:
            self.train_dataset = full_dataset
            self.val_dataset = None
            self.val_dataloader = None
            logger.info("No validation split - using all data for training")

        # Store full dataset reference for compatibility
        self.dataset = full_dataset

        # Create batch sampler for training
        self.batch_sampler = LengthBasedBatchSampler(
            dataset=self.train_dataset,
            batch_size=config.batch_size,
            drop_last=True,
            shuffle=True
        )

        # Create training dataloader
        self.dataloader = DataLoader(
            self.train_dataset,
            batch_sampler=self.batch_sampler,
            collate_fn=collate_fn,
            num_workers=getattr(config, 'num_workers', 2),
            pin_memory=getattr(config, 'pin_memory', False) and self.device.type == DeviceType.CUDA.value,
            prefetch_factor=3 if getattr(config, 'num_workers', 2) > 0 else None,
            persistent_workers=getattr(config, 'num_workers', 2) > 0
        )

        # Initialize model with English vocab size
        vocab_size = self.dataset.phoneme_processor.get_vocab_size()
        logger.info(f"English vocabulary size: {vocab_size}")

        self.model = KokoroModel(
            vocab_size=vocab_size,
            mel_dim=config.n_mels,
            hidden_dim=config.hidden_dim,
            n_encoder_layers=getattr(config, 'n_encoder_layers', 6),
            n_decoder_layers=getattr(config, 'n_decoder_layers', 6),
            n_heads=getattr(config, 'n_heads', 8),
            encoder_ff_dim=getattr(config, 'encoder_ff_dim', 2048),
            encoder_dropout=getattr(config, 'encoder_dropout', 0.1),
            decoder_ff_dim=getattr(config, 'decoder_ff_dim', 2048),
            max_decoder_seq_len=getattr(config, 'max_decoder_seq_len', 4000),
            enable_profiling=getattr(config, 'enable_profiling', False),
            gradient_checkpointing=getattr(config, 'gradient_checkpointing', True),
            checkpoint_segments=getattr(config, 'checkpoint_segments', 2)
        )
        self.model.to(self.device)

        # Log model info
        model_info = self.model.get_model_info()
        logger.info(f"Model initialized with {model_info['total_parameters']:,} parameters ({model_info['model_size_mb']:.1f} MB)")

        # Initialize optimizer
        self.optimizer = torch.optim.AdamW(
            self.model.parameters(),
            lr=config.learning_rate,
            weight_decay=getattr(config, 'weight_decay', 0.01),
            eps=getattr(config, 'adam_eps', 1e-8),
            betas=getattr(config, 'adam_betas', (0.9, 0.999))
        )

        # Loss functions
        self.criterion_mel = nn.L1Loss(reduction='none')
        self.criterion_duration = nn.MSELoss(reduction='none')
        self.criterion_stop_token = nn.BCEWithLogitsLoss(reduction='none')

        # Learning rate scheduler with warmup
        # Convert epochs to batches since we call scheduler.step() per batch
        num_batches_per_epoch = len(self.dataloader)

        # Warmup configuration
        warmup_epochs = getattr(config, 'warmup_epochs', 10)
        warmup_batches = warmup_epochs * num_batches_per_epoch

        # Cosine annealing configuration (NO RESTARTS - smooth monotonic decay)
        # Total batches for cosine decay (after warmup completes)
        total_training_batches = config.num_epochs * num_batches_per_epoch
        cosine_batches = total_training_batches - warmup_batches

        logger.info(f"Learning rate scheduler: LinearLR warmup + CosineAnnealingLR")
        logger.info(f"  Warmup: {warmup_epochs} epochs = {warmup_batches} batches (0 → {config.learning_rate})")
        logger.info(f"  Cosine: {config.num_epochs - warmup_epochs} epochs = {cosine_batches} batches")
        logger.info(f"  Cosine eta_min: {getattr(config, 'lr_eta_min', 1e-6)}")
        logger.info(f"  NO RESTARTS - smooth monotonic decay for stable training")

        # Create warmup scheduler (LinearLR from start_factor to 1.0)
        warmup_scheduler = torch.optim.lr_scheduler.LinearLR(
            self.optimizer,
            start_factor=1e-10,  # Start near 0 (1e-10 * LR ≈ 0)
            end_factor=1.0,      # End at full LR
            total_iters=warmup_batches
        )

        # Create cosine annealing scheduler (NO RESTARTS!)
        # CosineAnnealingLR: smooth decay from learning_rate to eta_min over T_max batches
        cosine_scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
            self.optimizer,
            T_max=cosine_batches,  # Decay over remaining training batches
            eta_min=getattr(config, 'lr_eta_min', 1e-6)
        )

        # Chain them together with SequentialLR
        self.scheduler = torch.optim.lr_scheduler.SequentialLR(
            self.optimizer,
            schedulers=[warmup_scheduler, cosine_scheduler],
            milestones=[warmup_batches]  # Switch to cosine after warmup_batches
        )

        # Training state
        self.start_epoch = 0
        self.best_loss = float('inf')
        self.best_val_loss = float('inf')  # Track best validation loss

        # Stats
        self.mixed_precision_stats = {
            'scale_updates': 0,
            'scale_decreases': 0,
            'overflow_count': 0,
            'successful_steps': 0,
            'skipped_steps': 0
        }

        # Profiling
        self.profiler = None
        self.profiling_stats = {}
        self.memory_snapshots = []

        self.log_dir = os.path.join(config.output_dir, "profiler_logs",
                                    datetime.datetime.now().strftime("%Y%m%d_%H%M%S"))
        os.makedirs(self.log_dir, exist_ok=True)

        # Interbatch profiler
        self.interbatch_profiler = InterbatchProfiler(config)

        # Memory management
        self.enable_adaptive_memory = getattr(config, 'enable_adaptive_memory', True)
        self.memory_report_interval = getattr(config, 'memory_report_interval', 500)

        # W&B initialization
        self.use_wandb = getattr(config, 'use_wandb', False)
        self.wandb_run = None

        logger.info(f"W&B requested: {getattr(config, 'use_wandb', False)}")

        if self.use_wandb:
            logger.info("Initializing W&B logging...")
            self._init_wandb()
        else:
            logger.info("W&B logging disabled")

        logger.info("English trainer initialized successfully")

    def _init_wandb(self):
        """Initialize Weights & Biases logging"""
        try:
            # Prepare wandb config
            wandb_config = {
                # Model architecture
                "model": "Kokoro-English-TTS",
                "vocab_size": len(self.dataset.phoneme_processor.phoneme_to_id),
                "hidden_dim": self.config.hidden_dim,
                "n_encoder_layers": getattr(self.config, 'n_encoder_layers', 6),
                "n_decoder_layers": getattr(self.config, 'n_decoder_layers', 6),
                "n_heads": getattr(self.config, 'n_heads', 8),

                # Training params
                "batch_size": self.config.batch_size,
                "learning_rate": self.config.learning_rate,
                "num_epochs": self.config.num_epochs,
                "device": str(self.device),
                "mixed_precision": self.use_mixed_precision,
                "gradient_checkpointing": getattr(self.config, 'gradient_checkpointing', True),

                # Dataset
                "dataset": "LJSpeech",
                "dataset_size": len(self.dataset),
                "sample_rate": self.config.sample_rate,

                # Loss weights
                "duration_loss_weight": self.config.duration_loss_weight,
                "stop_token_loss_weight": self.config.stop_token_loss_weight,
            }

            # Get model parameter count
            model_info = self.model.get_model_info()
            wandb_config["total_parameters"] = model_info['total_parameters']
            wandb_config["model_size_mb"] = model_info['model_size_mb']

            # Initialize wandb
            self.wandb_run = wandb.init(
                project=getattr(self.config, 'wandb_project', 'kokoro-english-tts'),
                entity=getattr(self.config, 'wandb_entity', None),
                name=getattr(self.config, 'wandb_run_name', None),
                tags=getattr(self.config, 'wandb_tags', None),
                notes=getattr(self.config, 'wandb_notes', None),
                config=wandb_config,
                resume="allow"  # Allow resuming if run exists
            )

            # Watch model
            wandb.watch(self.model, log="all", log_freq=100)

            # Define metrics for proper chart grouping
            wandb.define_metric("epoch")
            wandb.define_metric("train/*", step_metric="epoch")
            wandb.define_metric("val/*", step_metric="epoch")

            logger.info(f"W&B initialized: {self.wandb_run.url}")
            logger.info("W&B metrics defined for train/* and val/* grouping")

        except Exception as e:
            logger.error(f"Failed to initialize W&B: {e}")
            self.use_wandb = False
            self.wandb_run = None

    def log_to_wandb(self, metrics: dict, step: int = None, commit: bool = True):
        """Log metrics to Weights & Biases"""
        if not self.use_wandb or not self.wandb_run:
            return

        try:
            if step is not None:
                wandb.log(metrics, step=step, commit=commit)
            else:
                # Let W&B use the step_metric defined in wandb.define_metric()
                wandb.log(metrics, commit=commit)
        except Exception as e:
            logger.warning(f"Failed to log to W&B: {e}")

    def train_epoch(self, epoch: int):
        """Override train_epoch to add per-batch W&B logging"""
        self.model.train()
        total_loss_epoch = 0.0
        mel_loss_epoch = 0.0
        dur_loss_epoch = 0.0
        stop_loss_epoch = 0.0
        skipped_batches = 0  # Track NaN/padding batches

        num_batches = len(self.dataloader)

        # Calculate base global step for this epoch
        base_global_step = epoch * num_batches

        is_profiling_epoch = (epoch == self.config.profile_epoch_start) and self.config.enable_profiling
        enable_interbatch_profiling = getattr(self.config, 'enable_interbatch_profiling', False)

        if is_profiling_epoch:
            logger.info(f"Starting profiler for epoch {epoch+1}")
            self.reset_profiling_stats()
            self.profiler = self.start_torch_profiler()
            self.profiler.__enter__()

        progress_bar = tqdm(self.dataloader, desc=f"Epoch {epoch+1}/{self.config.num_epochs}")
        for batch_idx, batch in enumerate(progress_bar):
            global_step = base_global_step + batch_idx

            try:
                # Adaptive memory cleanup
                cleanup_result = self.adaptive_memory_cleanup(batch_idx)

                # Move data to device
                with torch.profiler.record_function("Data_Loading"):
                    non_blocking = self.device.type == 'cuda'
                    mel_specs = batch['mel_specs'].to(self.device, non_blocking=non_blocking)
                    phoneme_indices = batch['phoneme_indices'].to(self.device, non_blocking=non_blocking)
                    phoneme_durations = batch['phoneme_durations'].to(self.device, non_blocking=non_blocking)
                    stop_token_targets = batch['stop_token_targets'].to(self.device, non_blocking=non_blocking)
                    mel_lengths = batch['mel_lengths'].to(self.device, non_blocking=non_blocking)
                    phoneme_lengths = batch['phoneme_lengths'].to(self.device, non_blocking=non_blocking)

                self.optimizer.zero_grad()

                # ========== Scheduled Sampling ==========
                # Gradually expose model to its own predictions to reduce exposure bias
                # Critical for preventing garbage audio at inference
                decoder_input_mels = None  # None = use ground truth (teacher forcing)
                use_gt_durs = (epoch < getattr(self.config, 'use_gt_durations_until_epoch', 0))

                if getattr(self.config, 'enable_scheduled_sampling', False):
                    # Calculate scheduled sampling probability based on global step
                    warmup = getattr(self.config, 'scheduled_sampling_warmup_batches', 500)
                    max_prob = getattr(self.config, 'scheduled_sampling_max_prob', 0.5)

                    if global_step < warmup:
                        # Pure teacher forcing during warmup
                        scheduled_sampling_prob = 0.0
                    elif global_step < warmup * 2:
                        # Linear ramp from 0 to max_prob over [warmup, warmup*2]
                        progress = (global_step - warmup) / warmup
                        scheduled_sampling_prob = progress * max_prob
                    else:
                        # Full scheduled sampling exposure
                        scheduled_sampling_prob = max_prob

                    # Apply scheduled sampling
                    sample_mode = torch.rand(1).item()
                    zero_ratio = getattr(self.config, 'scheduled_sampling_zero_input_ratio', 0.3)

                    if sample_mode < scheduled_sampling_prob * zero_ratio:
                        # Zero-input training (hardest - like inference start)
                        decoder_input_mels = torch.zeros_like(mel_specs)
                    elif sample_mode < scheduled_sampling_prob:
                        # Use model's predictions as input
                        with torch.no_grad():
                            if self.use_mixed_precision:
                                with self.get_autocast_context():
                                    # Model now returns 4 values: mel_coarse, mel_refined, durations, stop
                                    _, mel_pred_sample, _, _ = self.model(
                                        phoneme_indices, mel_specs, phoneme_durations,
                                        stop_token_targets, use_gt_durations=False
                                    )
                            else:
                                # Model now returns 4 values: mel_coarse, mel_refined, durations, stop
                                _, mel_pred_sample, _, _ = self.model(
                                    phoneme_indices, mel_specs, phoneme_durations,
                                    stop_token_targets, use_gt_durations=False
                                )
                        decoder_input_mels = mel_pred_sample.detach()
                    # else: decoder_input_mels stays None (teacher forcing with ground truth)

                # Forward pass with scheduled sampling
                # Model now returns BOTH mel_coarse and mel_refined for dual-loss training
                with torch.profiler.record_function("Model_Forward"):
                    if self.use_mixed_precision:
                        with self.get_autocast_context():
                            mel_coarse, mel_refined, predicted_log_durations, predicted_stop_logits = \
                                self.model(phoneme_indices, mel_specs, phoneme_durations, stop_token_targets,
                                          use_gt_durations=use_gt_durs, decoder_input_mels=decoder_input_mels)
                    else:
                        mel_coarse, mel_refined, predicted_log_durations, predicted_stop_logits = \
                            self.model(phoneme_indices, mel_specs, phoneme_durations, stop_token_targets,
                                      use_gt_durations=use_gt_durs, decoder_input_mels=decoder_input_mels)

                # Loss calculation with dual mel loss (pre-PostNet + post-PostNet)
                with torch.profiler.record_function("Loss_Calculation"):
                    if self.use_mixed_precision:
                        with self.get_autocast_context():
                            total_loss, loss_mel_coarse, loss_mel_refined, loss_duration, loss_stop_token = self._calculate_losses(
                                mel_coarse, mel_refined, predicted_log_durations, predicted_stop_logits,
                                mel_specs, phoneme_durations, stop_token_targets,
                                mel_lengths, phoneme_lengths
                            )
                    else:
                        total_loss, loss_mel_coarse, loss_mel_refined, loss_duration, loss_stop_token = self._calculate_losses(
                            mel_coarse, mel_refined, predicted_log_durations, predicted_stop_logits,
                            mel_specs, phoneme_durations, stop_token_targets,
                            mel_lengths, phoneme_lengths
                        )

                # Backward pass
                # ========== Backward + Optimizer Step  ==========
                # Track gradient norm for monitoring explosions
                grad_norm_val = 0.0

                with torch.profiler.record_function("Backward_Pass"):
                    if self.use_mixed_precision and self.autocast_dtype == torch.bfloat16:
                        # ✅ BF16 path (no GradScaler needed - inherently stable)
                        self.optimizer.zero_grad(set_to_none=True)
                        total_loss.backward()
                        grad_norm = torch.nn.utils.clip_grad_norm_(self.model.parameters(), self.config.max_grad_norm)
                        grad_norm_val = grad_norm.item() if torch.isfinite(grad_norm) else 0.0

                        # Check for gradient explosion BEFORE clipping corrupts direction
                        if not torch.isfinite(grad_norm):
                            logger.warning(f"[Batch {batch_idx}] Non-finite grad norm. Skipping batch.")
                            self.optimizer.zero_grad(set_to_none=True)
                            skipped_batches += 1
                            continue

                        # CRITICAL: Skip batch if gradients exploded (prevents weight corruption)
                        if grad_norm_val > 10.0:
                            logger.warning(f"[Batch {batch_idx}] Gradient explosion detected! "
                                         f"grad_norm={grad_norm_val:.2f} > 10.0. Skipping batch to prevent model corruption.")
                            self.optimizer.zero_grad(set_to_none=True)
                            skipped_batches += 1
                            continue
                        elif grad_norm_val > 5.0:
                            logger.warning(f"[Batch {batch_idx}] High gradient norm: {grad_norm_val:.2f}")

                        self.optimizer.step()

                    elif self.use_mixed_precision and self.scaler is not None:
                        # FP16 path with GradScaler (backward compatibility)
                        self.scaler.scale(total_loss).backward()
                        self.scaler.unscale_(self.optimizer)
                        grad_norm = torch.nn.utils.clip_grad_norm_(self.model.parameters(), self.config.max_grad_norm)
                        grad_norm_val = grad_norm.item() if torch.isfinite(grad_norm) else 0.0

                        if not torch.isfinite(grad_norm):
                            logger.warning(f"[Batch {batch_idx}] Non-finite grad norm. Skipping batch.")
                            self.optimizer.zero_grad(set_to_none=True)
                            skipped_batches += 1
                            self.scaler.update()
                            continue

                        # CRITICAL: Skip batch if gradients exploded (prevents weight corruption)
                        if grad_norm_val > 10.0:
                            logger.warning(f"[Batch {batch_idx}] Gradient explosion detected! "
                                         f"grad_norm={grad_norm_val:.2f} > 10.0. Skipping batch to prevent model corruption.")
                            self.optimizer.zero_grad(set_to_none=True)
                            skipped_batches += 1
                            self.scaler.update()
                            continue
                        elif grad_norm_val > 5.0:
                            logger.warning(f"[Batch {batch_idx}] High gradient norm: {grad_norm_val:.2f}")

                        self.scaler.step(self.optimizer)
                        old_scale = self.scaler.get_scale()
                        self.scaler.update()
                        new_scale = self.scaler.get_scale()

                        # Cap grad scale if needed (prevent unbounded growth)
                        if hasattr(self, 'max_grad_scale') and self.max_grad_scale is not None and new_scale > self.max_grad_scale:
                            try:
                                self.scaler._scale.fill_(self.max_grad_scale)
                                if batch_idx % 500 == 0:
                                    logger.info(f"Grad scale capped at {self.max_grad_scale} (was {float(new_scale):.0f})")
                            except Exception:
                                logger.warning("GradScaler._scale cap failed (internal API change)")

                    else:
                        # FP32 fallback (no mixed precision)
                        self.optimizer.zero_grad(set_to_none=True)
                        total_loss.backward()
                        grad_norm = torch.nn.utils.clip_grad_norm_(self.model.parameters(), self.config.max_grad_norm)
                        grad_norm_val = grad_norm.item() if torch.isfinite(grad_norm) else 0.0

                        if not torch.isfinite(grad_norm):
                            logger.warning(f"[Batch {batch_idx}] Non-finite grad norm. Skipping batch.")
                            self.optimizer.zero_grad(set_to_none=True)
                            skipped_batches += 1
                            continue

                        # CRITICAL: Skip batch if gradients exploded (prevents weight corruption)
                        if grad_norm_val > 10.0:
                            logger.warning(f"[Batch {batch_idx}] Gradient explosion detected! "
                                         f"grad_norm={grad_norm_val:.2f} > 10.0. Skipping batch to prevent model corruption.")
                            self.optimizer.zero_grad(set_to_none=True)
                            skipped_batches += 1
                            continue
                        elif grad_norm_val > 5.0:
                            logger.warning(f"[Batch {batch_idx}] High gradient norm: {grad_norm_val:.2f}")

                        self.optimizer.step()

                # Cache loss values (single .item() call per loss - no duplicate GPU syncs)
                loss_total_val = total_loss.item()
                loss_mel_coarse_val = loss_mel_coarse.item()
                loss_mel_refined_val = loss_mel_refined.item()
                loss_dur_val = loss_duration.item()
                loss_stop_val = loss_stop_token.item()

                # Combined mel loss for backward compatibility (unweighted average)
                loss_mel_combined = (loss_mel_coarse_val + loss_mel_refined_val) / 2.0

                # Accumulate losses using cached values
                total_loss_epoch += loss_total_val
                mel_loss_epoch += loss_mel_combined  # Use combined for epoch average
                dur_loss_epoch += loss_dur_val
                stop_loss_epoch += loss_stop_val

                # W&B logging per batch (every 50 batches to reduce queue pressure)
                # Use commit=False to prevent blocking on queue full
                if self.use_wandb and batch_idx % 50 == 0:
                    wandb_metrics = {
                        "train/batch_total_loss": loss_total_val,
                        "train/batch_mel_loss_coarse": loss_mel_coarse_val,
                        "train/batch_mel_loss_refined": loss_mel_refined_val,
                        "train/batch_mel_loss_combined": loss_mel_combined,
                        "train/batch_duration_loss": loss_dur_val,
                        "train/batch_stop_loss": loss_stop_val,
                        "train/learning_rate": self.optimizer.param_groups[0]['lr'],
                        "train/grad_norm": grad_norm_val,  # Monitor gradient explosions
                        "epoch": epoch + 1,
                    }

                    # Only log grad_scale if using FP16 with GradScaler
                    if self.use_mixed_precision and self.scaler is not None:
                        wandb_metrics["train/grad_scale"] = self.scaler.get_scale()

                    # commit=False prevents blocking on network I/O
                    # Don't specify step - W&B will use 'epoch' from metrics dict
                    self.log_to_wandb(wandb_metrics, commit=False)

                # Update progress bar using cached values
                # Show refined mel loss (final quality) and coarse (decoder quality)
                postfix_dict = {
                    'total_loss': loss_total_val,
                    'mel_refined': loss_mel_refined_val,
                    'mel_coarse': loss_mel_coarse_val,
                    'dur_loss': loss_dur_val,
                    'stop_loss': loss_stop_val,
                    'lr': self.optimizer.param_groups[0]['lr']
                }

                if self.use_mixed_precision:
                    if self.scaler is not None:
                        postfix_dict['scale'] = f"{self.scaler.get_scale():.0f}"
                    else:
                        postfix_dict['dtype'] = 'bf16'

                if self.enable_adaptive_memory:
                    postfix_dict['mem'] = cleanup_result.get('pressure_level', 'unknown')[:3]
                    if cleanup_result.get('cleaned', False):
                        postfix_dict['mem'] += '*'

                progress_bar.set_postfix(postfix_dict)

                # Step the learning rate scheduler after each batch
                self.scheduler.step()

            except RuntimeError as e:
                if "out of memory" in str(e).lower():
                    logger.error(f"OOM error at batch {batch_idx}: {e}")
                    can_continue = self.handle_oom_with_adaptive_cleanup(batch_idx, e)
                    if can_continue:
                        continue
                    else:
                        raise e
                else:
                    raise e

        # Calculate epoch averages
        avg_total_loss = total_loss_epoch / num_batches
        avg_mel_loss = mel_loss_epoch / num_batches
        avg_dur_loss = dur_loss_epoch / num_batches
        avg_stop_loss = stop_loss_epoch / num_batches

        # Log epoch summary to W&B
        if self.use_wandb:
            wandb_metrics = {
                "epoch": epoch + 1,
                "train/epoch_total_loss": avg_total_loss,
                "train/epoch_mel_loss": avg_mel_loss,
                "train/epoch_duration_loss": avg_dur_loss,
                "train/epoch_stop_loss": avg_stop_loss,
            }

            # Add memory stats if available
            if self.enable_adaptive_memory:
                memory_report = self.memory_manager.get_memory_report()
                wandb_metrics.update({
                    "memory/pressure": {
                        "low": 0, "moderate": 1, "high": 2, "critical": 3
                    }.get(memory_report['current_pressure'], 0),
                    "memory/cleanup_count": memory_report['cleanup_count'],
                    "memory/cleanup_overhead_percent": memory_report['cleanup_overhead_percent'],
                })

            # commit=True at epoch end to flush any pending logs
            # Don't specify step - W&B will use 'epoch' from metrics dict
            self.log_to_wandb(wandb_metrics, commit=True)

        # Cleanup profiler if it was started
        if self.profiler:
            self.profiler.__exit__(None, None, None)
            self.profiler = None

        return avg_total_loss, avg_mel_loss, avg_dur_loss, avg_stop_loss, skipped_batches

    def train(self):
        """Main training function with mixed precision support and W&B logging"""
        try:
            os.makedirs(self.config.output_dir, exist_ok=True)

            self.setup_checkpoint_resumption()
            save_phoneme_processor(self.dataset.phoneme_processor, self.config.output_dir)
            save_model_config(self.config, self.config.output_dir)

            logger.info(f"Starting training on device: {self.device} ({self.device_type})")
            logger.info(f"Mixed precision training: {'Enabled' if self.use_mixed_precision else 'Disabled'}")
            if self.use_mixed_precision:
                logger.info(f"Mixed precision dtype: {self.autocast_dtype}")
                if self.device_type == DeviceType.MPS.value:
                    logger.info("Using custom MPS gradient scaler (experimental)")
            logger.info(f"Adaptive memory management: {'Enabled' if self.enable_adaptive_memory else 'Disabled'}")
            logger.info(f"Total epochs: {self.config.num_epochs}, Starting from epoch: {self.start_epoch + 1}")
            logger.info(f"Model vocabulary size: {self.dataset.phoneme_processor.get_vocab_size()}")
            logger.info(f"Initial learning rate: {self.config.learning_rate}")
            logger.info(f"Scheduler: LinearLR warmup + CosineAnnealingLR (no restarts, eta_min={self.config.lr_eta_min})")
            logger.info(f"Loss weights: Mel Coarse={self.config.mel_coarse_loss_weight}, Mel Refined={self.config.mel_refined_loss_weight}, Duration={self.config.duration_loss_weight}, StopToken={self.config.stop_token_loss_weight}")

            # Log scheduled sampling configuration
            if getattr(self.config, 'enable_scheduled_sampling', False):
                warmup = getattr(self.config, 'scheduled_sampling_warmup_batches', 500)
                max_prob = getattr(self.config, 'scheduled_sampling_max_prob', 0.5)
                logger.info("Scheduled Sampling: ENABLED (critical for inference quality)")
                logger.info(f"  Warmup batches: {warmup}")
                logger.info(f"  Max probability: {max_prob}")
                logger.info(f"  Zero-input ratio: {getattr(self.config, 'scheduled_sampling_zero_input_ratio', 0.3)}")
                logger.info(f"  Schedule: 0-{warmup} batches (prob=0.0), {warmup}-{warmup*2} (linear ramp 0.0→{max_prob}), {warmup*2}+ (prob={max_prob})")
            else:
                logger.warning("⚠️  Scheduled Sampling: DISABLED - Model may produce garbage audio at inference!")
                logger.warning("   Enable with 'enable_scheduled_sampling: True' in config")

            # Log ground truth durations usage
            use_gt_durs_epochs = getattr(self.config, 'use_gt_durations_until_epoch', 0)
            if use_gt_durs_epochs > 0:
                logger.info(f"Ground Truth Durations: Using GT durations for first {use_gt_durs_epochs} epochs")
            else:
                logger.info("Ground Truth Durations: DISABLED (training duration predictor from start)")

            enable_profiling = getattr(self.config, 'enable_profiling', False)
            if enable_profiling:
                logger.info(f"Profiler logs will be saved to: {self.log_dir}")

            # Log interbatch profiling settings
            enable_interbatch_profiling = getattr(self.config, 'enable_interbatch_profiling', False)
            if enable_interbatch_profiling and enable_profiling:
                logger.info(f"Interbatch profiling enabled with report interval: {getattr(self.config, 'interbatch_report_interval', 100)}")

            # Log adaptive memory settings
            if self.enable_adaptive_memory:
                logger.info(f"Adaptive memory management enabled:")
                logger.info(f"  Memory report interval: {self.memory_report_interval} batches")
                thresholds = self.memory_manager.thresholds
                logger.info(f"  Memory thresholds: Low={thresholds.low_threshold*100:.0f}%, "
                           f"Moderate={thresholds.moderate_threshold*100:.0f}%, "
                           f"High={thresholds.high_threshold*100:.0f}%, "
                           f"Critical={thresholds.critical_threshold*100:.0f}%")

            # Run standalone profiling if requested
            if hasattr(self.config, 'run_standalone_profiling') and self.config.run_standalone_profiling:
                logger.info(f"Running standalone profiling before training on {self.device_type}...")
                self.profile_training_steps(self.config.profile_steps)

            for epoch in range(self.start_epoch, self.config.num_epochs):
                avg_total_loss, avg_mel_loss, avg_dur_loss, avg_stop_loss, skipped_batches = self.train_epoch(epoch)

                # Note: scheduler.step() is now called per batch, not per epoch
                current_lr = self.optimizer.param_groups[0]['lr']
                logger.info(f"Epoch {epoch+1} completed. "
                            f"Avg Total Loss: {avg_total_loss:.4f}, "
                            f"Avg Mel Loss: {avg_mel_loss:.4f}, "
                            f"Avg Dur Loss: {avg_dur_loss:.4f}, "
                            f"Avg Stop Loss: {avg_stop_loss:.4f}, "
                            f"Current LR: {current_lr:.8f}")

                # Log skipped batches if any
                if skipped_batches > 0:
                    total_batches = len(self.dataloader)
                    pct = (skipped_batches / total_batches) * 100
                    logger.info(f"Skipped {skipped_batches}/{total_batches} batches ({pct:.1f}%) due to NaN gradients (phoneme mismatches, padding samples)")

                # Run validation
                validate_every = getattr(self.config, 'validate_every', 1)
                if self.val_dataloader is not None and (epoch + 1) % validate_every == 0:
                    val_metrics = self.validate(epoch)

                    # Log validation metrics to W&B with epoch number
                    if self.use_wandb and val_metrics:
                        val_metrics['epoch'] = epoch + 1  # Add epoch for step_metric
                        self.log_to_wandb(val_metrics, commit=True)

                    # Track best validation loss
                    if val_metrics:
                        current_val_loss = val_metrics['val/total_loss']
                        if current_val_loss < self.best_val_loss:
                            self.best_val_loss = current_val_loss
                            logger.info(f"✓ New best validation loss: {self.best_val_loss:.4f}")

                            # Save best model checkpoint
                            if getattr(self.config, 'save_best_only', False):
                                self.save_checkpoint_with_scaler(epoch, current_val_loss, is_best=True)
                                logger.info(f"Best model checkpoint saved for epoch {epoch+1}")

                # Log memory management stats for this epoch
                if self.enable_adaptive_memory:
                    memory_report = self.memory_manager.get_memory_report()
                    logger.info(f"Memory Management Summary - Epoch {epoch+1}:")
                    logger.info(f"  Current Pressure: {memory_report['current_pressure']}")
                    logger.info(f"  Cleanups This Epoch: {memory_report['cleanup_count']}")
                    logger.info(f"  Memory Trend: {memory_report['memory_trend']:+.2f}%")
                    logger.info(f"  Cleanup Overhead: {memory_report['cleanup_overhead_percent']:.2f}%")

                # Save periodic checkpoints (if not using save_best_only)
                if (epoch + 1) % self.config.save_every == 0:
                    save_best_only = getattr(self.config, 'save_best_only', False)
                    if not save_best_only:
                        # save_checkpoint_with_scaler handles both FP16 (with scaler) and BF16/FP32 (without scaler)
                        self.save_checkpoint_with_scaler(epoch, avg_total_loss)
                        logger.info(f"Checkpoint saved for epoch {epoch+1}")

                # Strategic memory cleanup at epoch end
                if self.enable_adaptive_memory:
                    self.memory_manager.adaptive_cleanup(epoch * len(self.dataloader), force=True)
                else:
                    self.clear_device_cache()

            logger.info("Training finished. Saving final model.")
            save_final_model(self.model, self.config, self.config.output_dir)

            # Print final mixed precision statistics
            if self.use_mixed_precision:
                mp_stats = self.mixed_precision_stats
                total_steps = mp_stats['successful_steps'] + mp_stats.get('skipped_steps', 0) + mp_stats['overflow_count']
                if total_steps > 0:
                    success_rate = (mp_stats['successful_steps'] / total_steps) * 100
                    logger.info(f"Final Mixed Precision Statistics ({self.device_type.upper()}):")
                    logger.info(f"  Total Steps: {total_steps}")
                    logger.info(f"  Successful Steps: {mp_stats['successful_steps']}")
                    logger.info(f"  Skipped Steps: {mp_stats.get('skipped_steps', 0)}")
                    logger.info(f"  Overflow Count: {mp_stats['overflow_count']}")
                    logger.info(f"  Success Rate: {success_rate:.1f}%")
                    logger.info(f"  Scale Updates: {mp_stats['scale_updates']}")
                    logger.info(f"  Scale Decreases: {mp_stats['scale_decreases']}")

            # Print final memory management report
            if self.enable_adaptive_memory:
                logger.info("Final Memory Management Report:")
                self.print_memory_management_report()

            # Mark W&B run as finished (English-specific)
            if self.use_wandb and self.wandb_run:
                wandb.finish()
                logger.info("W&B run finished successfully")

        except Exception as e:
            # Ensure W&B run is finished even on error
            if self.use_wandb and self.wandb_run:
                wandb.finish(exit_code=1)
            raise e

    def get_autocast_context(self):
        """Get the appropriate autocast context for the device"""
        if not self.use_mixed_precision:
            return nullcontext()
        return torch.amp.autocast("cuda", dtype=self.autocast_dtype)

    def adaptive_memory_cleanup(self, batch_idx: int, force: bool = False):
        """Perform adaptive memory cleanup"""
        if self.enable_adaptive_memory:
            return self.memory_manager.adaptive_cleanup(batch_idx, force)
        else:
            # Fallback to original cleanup behavior
            if batch_idx % 200 == 0 and batch_idx > 0:
                self.clear_device_cache()
            return {'cleaned': False, 'pressure_level': 'disabled'}

    def handle_oom_with_adaptive_cleanup(self, batch_idx: int, error: Exception) -> bool:
        """
        Handle OOM error with adaptive cleanup
        Returns True if training should continue, False if unrecoverable
        """
        logger.error(f"OOM error at batch {batch_idx} on {self.device_type}: {error}")

        if self.enable_adaptive_memory:
            # Emergency cleanup
            cleanup_result = self.memory_manager.emergency_cleanup()

            # Log results
            if cleanup_result['success']:
                logger.info(f"Emergency cleanup freed {cleanup_result['memory_freed_mb']:.1f}MB")
                return True  # Try to continue
            else:
                logger.error("Emergency cleanup failed to free significant memory")
                return False  # Unrecoverable
        else:
            # Fallback emergency cleanup
            self.clear_device_cache()
            gc.collect()
            return True

    def clear_device_cache(self):
        """Clear device cache based on device type"""
        if self.device.type == DeviceType.CUDA.value:
            torch.cuda.empty_cache()
        elif self.device.type == DeviceType.MPS.value:
            torch.mps.empty_cache()

    def _calculate_losses(self, mel_coarse, mel_refined, predicted_log_durations, predicted_stop_logits,
                         mel_specs, phoneme_durations, stop_token_targets,
                         mel_lengths, phoneme_lengths):
        """
        Numerically stable loss calculation with masking.

        Implements dual mel loss (Tacotron 2 architecture):
        - loss_mel_coarse: Direct supervision of decoder output (pre-PostNet)
        - loss_mel_refined: Supervision of PostNet refinement (post-PostNet)

        Returns:
            total_loss, loss_mel_coarse, loss_mel_refined, loss_duration, loss_stop_token
        """
        eps = 1e-8

        # --- Dual Mel Spectrogram Loss (Pre-PostNet + Post-PostNet) ---
        max_mel_len_batch = mel_specs.size(1)
        mel_mask = (torch.arange(max_mel_len_batch, device=self.device)
                    .expand(len(mel_lengths), max_mel_len_batch)
                    < mel_lengths.unsqueeze(1))
        mel_mask = mel_mask.unsqueeze(-1).expand_as(mel_coarse).float()

        # Pre-PostNet loss (coarse mel from decoder)
        loss_mel_coarse_unreduced = self.criterion_mel(mel_coarse, mel_specs)
        loss_mel_coarse = (loss_mel_coarse_unreduced * mel_mask).sum() / (mel_mask.sum() + eps)

        # Post-PostNet loss (refined mel after PostNet)
        loss_mel_refined_unreduced = self.criterion_mel(mel_refined, mel_specs)
        loss_mel_refined = (loss_mel_refined_unreduced * mel_mask).sum() / (mel_mask.sum() + eps)

        # --- Duration Loss ---
        max_phoneme_len_batch = phoneme_durations.size(1)
        phoneme_mask = (torch.arange(max_phoneme_len_batch, device=self.device)
                        .expand(len(phoneme_lengths), max_phoneme_len_batch)
                        < phoneme_lengths.unsqueeze(1)).float()

        # Safe log of durations
        target_log_durations = torch.log(phoneme_durations.float().clamp(min=1e-5))
        loss_duration_unreduced = self.criterion_duration(
            predicted_log_durations.float(), target_log_durations
        )
        loss_duration = (loss_duration_unreduced * phoneme_mask).sum() / (phoneme_mask.sum() + eps)

        # --- Stop Token Loss ---
        stop_token_mask = mel_mask[:, :, 0]
        # Force FP32 for BCE loss to avoid numerical issues
        with torch.amp.autocast("cuda", enabled=False):
            loss_stop_token_unreduced = self.criterion_stop_token(
                predicted_stop_logits.float(), stop_token_targets.float()
            )
        loss_stop_token = (loss_stop_token_unreduced * stop_token_mask).sum() / (stop_token_mask.sum() + eps)

        # --- Combine with Dual Mel Loss ---
        # Apply separate weights to pre-PostNet and post-PostNet losses
        weighted_mel_coarse = loss_mel_coarse * self.config.mel_coarse_loss_weight
        weighted_mel_refined = loss_mel_refined * self.config.mel_refined_loss_weight

        total_loss = (
            weighted_mel_coarse +
            weighted_mel_refined +
            loss_duration * self.config.duration_loss_weight +
            loss_stop_token * self.config.stop_token_loss_weight
        )

        return total_loss, loss_mel_coarse, loss_mel_refined, loss_duration, loss_stop_token

    def validate(self, epoch: int) -> Dict[str, float]:
        """
        Run validation and return metrics.

        Returns:
            Dictionary with validation losses
        """
        if self.val_dataloader is None:
            return {}

        self.model.eval()

        val_total_loss = 0.0
        val_mel_coarse_loss = 0.0
        val_mel_refined_loss = 0.0
        val_duration_loss = 0.0
        val_stop_loss = 0.0
        val_batches = 0

        logger.info(f"Running validation...")

        with torch.no_grad():
            for batch_idx, batch in enumerate(self.val_dataloader):
                try:
                    # Access batch as dictionary (matching training loop)
                    non_blocking = self.device.type == 'cuda'
                    phoneme_indices = batch['phoneme_indices'].to(self.device, non_blocking=non_blocking)
                    mel_specs = batch['mel_specs'].to(self.device, non_blocking=non_blocking)
                    phoneme_durations = batch['phoneme_durations'].to(self.device, non_blocking=non_blocking)
                    stop_token_targets = batch['stop_token_targets'].to(self.device, non_blocking=non_blocking)
                    mel_lengths = batch['mel_lengths'].to(self.device, non_blocking=non_blocking)
                    phoneme_lengths = batch['phoneme_lengths'].to(self.device, non_blocking=non_blocking)

                    # Forward pass (no mixed precision for validation for stability)
                    mel_coarse, mel_refined, predicted_log_durations, predicted_stop_logits = \
                        self.model.forward_training(
                            phoneme_indices=phoneme_indices,
                            mel_specs=mel_specs,
                            phoneme_durations=phoneme_durations,
                            stop_token_targets=stop_token_targets,
                            text_padding_mask=None,
                            mel_padding_mask=None,
                            use_gt_durations=False,
                            decoder_input_mels=None  # Pure teacher forcing
                        )

                    # Calculate losses
                    total_loss, loss_mel_coarse, loss_mel_refined, loss_duration, loss_stop_token = \
                        self._calculate_losses(
                            mel_coarse, mel_refined, predicted_log_durations, predicted_stop_logits,
                            mel_specs, phoneme_durations, stop_token_targets,
                            mel_lengths, phoneme_lengths
                        )

                    # Accumulate
                    val_total_loss += total_loss.item()
                    val_mel_coarse_loss += loss_mel_coarse.item()
                    val_mel_refined_loss += loss_mel_refined.item()
                    val_duration_loss += loss_duration.item()
                    val_stop_loss += loss_stop_token.item()
                    val_batches += 1

                except Exception as e:
                    logger.warning(f"Validation batch {batch_idx} failed: {e}")
                    continue

        # Compute averages
        if val_batches > 0:
            val_metrics = {
                'val/total_loss': val_total_loss / val_batches,
                'val/mel_coarse_loss': val_mel_coarse_loss / val_batches,
                'val/mel_refined_loss': val_mel_refined_loss / val_batches,
                'val/mel_combined_loss': (val_mel_coarse_loss + val_mel_refined_loss) / (2 * val_batches),
                'val/duration_loss': val_duration_loss / val_batches,
                'val/stop_loss': val_stop_loss / val_batches,
            }

            logger.info(f"Validation - Epoch {epoch}: "
                       f"total={val_metrics['val/total_loss']:.4f}, "
                       f"mel_refined={val_metrics['val/mel_refined_loss']:.4f}, "
                       f"mel_coarse={val_metrics['val/mel_coarse_loss']:.4f}, "
                       f"dur={val_metrics['val/duration_loss']:.4f}, "
                       f"stop={val_metrics['val/stop_loss']:.4f}")
        else:
            val_metrics = {}

        self.model.train()
        return val_metrics

    def setup_checkpoint_resumption(self):
        """Handle checkpoint resumption with mixed precision state"""

        if not self.config.resume_checkpoint:
            logger.info("No resume checkpoint specified, starting from scratch.")
            return

        checkpoint_path = None
        if self.config.resume_checkpoint.lower() == 'auto':
            checkpoint_path = find_latest_checkpoint(self.config.output_dir)
            if not checkpoint_path:
                logger.info("No checkpoint found for auto-resume, starting from scratch.")
                return
        else:
            checkpoint_path = self.config.resume_checkpoint
            if not os.path.exists(checkpoint_path):
                logger.error(f"Checkpoint not found: {checkpoint_path}")
                raise FileNotFoundError(f"Checkpoint not found: {checkpoint_path}")

        logger.info(f"Resuming from checkpoint: {checkpoint_path}")
        self.start_epoch, self.best_loss, phoneme_processor = load_checkpoint(
            checkpoint_path, self.model, self.optimizer, self.scheduler, self.config.output_dir
        )

        # Load scaler state if available (only for FP16)
        if self.scaler is not None:
            try:
                checkpoint = torch.load(checkpoint_path, map_location=self.device)
                if 'scaler' in checkpoint:
                    self.scaler.load_state_dict(checkpoint['scaler'])
                    logger.info(f"Loaded {self.device_type.upper()} scaler state from checkpoint")
                else:
                    logger.info(f"No scaler state found in checkpoint, using default for {self.device_type}")
            except Exception as e:
                logger.warning(f"Could not load scaler state: {e}")

        self.dataset.phoneme_processor = phoneme_processor
        logger.info(f"Resumed from epoch {self.start_epoch}, best loss {self.best_loss:.4f}")

    def save_checkpoint_with_scaler(self, epoch: int, loss: float, is_best: bool = False):
        """Save checkpoint including scaler state with disk space check and cleanup"""

        # Check disk space before saving
        if not check_disk_space(self.config.output_dir, min_free_gb=5.0):
            logger.warning(f"Skipping checkpoint save for epoch {epoch+1} due to insufficient disk space")
            return

        checkpoint = {
            'epoch': epoch,
            'model_state_dict': self.model.state_dict(),
            'optimizer_state_dict': self.optimizer.state_dict(),
            'scheduler_state_dict': self.scheduler.state_dict(),
            'loss': loss,
            'best_val_loss': self.best_val_loss,  # Save best validation loss
            'config': self.config,
        }

        # Only save scaler state if using FP16 (BF16 doesn't need scaler)
        if self.scaler is not None:
            checkpoint['scaler'] = self.scaler.state_dict()
            checkpoint['device_type'] = self.device_type  # Store device type for proper restoration

        # Use different filename for best model
        if is_best:
            checkpoint_path = os.path.join(self.config.output_dir, 'checkpoint_best.pth')
        else:
            checkpoint_path = os.path.join(self.config.output_dir, f'checkpoint_epoch_{epoch+1}.pth')

        try:
            torch.save(checkpoint, checkpoint_path)
            logger.info(f"Checkpoint saved to {checkpoint_path}")

            # Cleanup old checkpoints if configured (never delete best checkpoint)
            if not is_best:
                keep_last_n = getattr(self.config, 'keep_last_n_checkpoints', 3)
                if keep_last_n > 0:
                    cleanup_old_checkpoints(self.config.output_dir, keep_last_n)
        except Exception as e:
            logger.error(f"Failed to save checkpoint: {e}")
            logger.error("Training will continue without this checkpoint")

    def print_memory_management_report(self):
        """Print comprehensive memory management report"""
        if self.enable_adaptive_memory:
            report = self.memory_manager.get_memory_report()

            print("\n" + "="*60)
            print("ADAPTIVE MEMORY MANAGEMENT REPORT")
            print("="*60)

            print(f"\nDevice: {report['device_type'].upper()}")
            print(f"Total Batches Processed: {report['total_batches']}")
            print(f"Total Cleanups Performed: {report['cleanup_count']}")
            print(f"Cleanup Frequency: {report['cleanup_frequency']:.4f} cleanups/batch")

            print(f"\nPerformance Impact:")
            print(f"  Total Cleanup Time: {report['total_cleanup_time_ms']:.1f}ms")
            print(f"  Average Cleanup Time: {report['avg_cleanup_time_ms']:.1f}ms")
            print(f"  Cleanup Overhead: {report['cleanup_overhead_percent']:.2f}%")

            print(f"\nMemory Status:")
            print(f"  Current Pressure Level: {report['current_pressure'].upper()}")
            print(f"  Current Usage: {report.get('current_memory_usage_percent', 0):.1f}%")
            print(f"  Average Usage: {report.get('avg_memory_usage_percent', 0):.1f}%")
            print(f"  Peak Usage: {report.get('max_memory_usage_percent', 0):.1f}%")
            print(f"  Memory Trend: {report['memory_trend']:+.2f}% (positive = increasing)")
            print(f"  Consecutive High Pressure Batches: {report['consecutive_high_pressure']}")

            print(f"\nRecommendations:")
            recommendations = []

            # Performance recommendations
            if report['cleanup_overhead_percent'] > 5.0:
                recommendations.append("• High cleanup overhead detected - consider optimizing cleanup frequency")

            if report['cleanup_frequency'] > 0.1:
                recommendations.append("• Very frequent cleanups - consider increasing batch size or reducing model size")

            # Memory recommendations
            if report.get('avg_memory_usage_percent', 0) > 85:
                recommendations.append("• High average memory usage - consider reducing batch size")
                if report['device_type'] == 'mps':
                    recommendations.append("• For MPS: Unified memory architecture may benefit from smaller batches")

            if report['memory_trend'] > 5.0:
                recommendations.append("• Memory usage increasing - potential memory leak or insufficient cleanup")

            if report['consecutive_high_pressure'] > 50:
                recommendations.append("• Sustained high memory pressure - consider model architecture optimization")

            # Device-specific recommendations
            if report['device_type'] == 'mps':
                recommendations.append("• MPS detected: Monitor for memory fragmentation in unified memory")
                if report.get('avg_memory_usage_percent', 0) > 70:
                    recommendations.append("• Consider using smaller batch sizes for MPS vs equivalent CUDA setup")
            elif report['device_type'] == 'cuda':
                if report['cleanup_frequency'] < 0.01:
                    recommendations.append("• CUDA: Low cleanup frequency may indicate room for batch size increase")

            if not recommendations:
                recommendations.append("• Memory management appears optimal for current configuration")

            for rec in recommendations:
                print(rec)

            print("="*60)
        else:
            logger.info("Adaptive memory management disabled")

    def reset_profiling_stats(self):
        """Reset profiling statistics"""
        self.profiling_stats = {
            'stage_stats': {},
            'memory_snapshots': [],
            'device_info': {
                'device_name': self._get_device_name(),
                'device_available': self._is_device_available(),
                'device_type': self.device.type,
                'mixed_precision_enabled': self.use_mixed_precision,
                'mixed_precision_dtype': str(self.autocast_dtype) if self.use_mixed_precision else None
            }
        }
        self.memory_snapshots = []
        self.interbatch_profiler.reset()

    def _get_device_name(self):
        """Get device name for different device types"""
        if self.device.type == DeviceType.CUDA.value:
            return torch.cuda.get_device_name()
        elif self.device.type == DeviceType.MPS.value:
            return 'Apple Silicon GPU'
        else:
            return 'CPU'

    def _is_device_available(self):
        """Check if device is available"""
        if self.device.type == DeviceType.CUDA.value:
            return torch.cuda.is_available()
        elif self.device.type == DeviceType.MPS.value:
            return torch.backends.mps.is_available()
        else:
            return True

    def start_torch_profiler(self, output_dir: str = None):
        """Start PyTorch profiler with comprehensive settings"""
        if output_dir is None:
            output_dir = self.log_dir

        os.makedirs(output_dir, exist_ok=True)

        profiler_kwargs = {
            'schedule': torch.profiler.schedule(
                wait=self.config.profile_wait_steps,
                warmup=self.config.profile_warmup_steps,
                active=self.config.profile_steps,
                repeat=1
            ),
            'on_trace_ready': torch.profiler.tensorboard_trace_handler(output_dir),
            'with_stack': True,
            'record_shapes': True,
        }

        # Add device-specific profiling options
        if self.device.type == DeviceType.CUDA.value:
            profiler_kwargs.update({
                'profile_memory': True,
                'with_flops': True
            })
        elif self.device.type == DeviceType.MPS.value:
            # MPS profiling capabilities are more limited
            profiler_kwargs.update({
                'profile_memory': False,  # Not supported on MPS
                'with_flops': False       # Not supported on MPS
            })

        self.profiler = torch.profiler.profile(**profiler_kwargs)
        logger.info(f"Started PyTorch profiler for {self.device.type}, output dir: {output_dir}")
        return self.profiler

    def stop_torch_profiler(self):
        """Stop PyTorch profiler"""
        if self.profiler:
            self.profiler.__exit__(None, None, None)
            self.profiler = None
            logger.info("PyTorch profiler stopped")

    def profile_step(self):
        """Step the profiler and log memory stats"""
        if self.profiler:
            self.profiler.step()

        # Log memory statistics based on device type
        current_memory = 0
        peak_memory = 0
        reserved_memory = 0
        total_memory = 0

        if self.device.type == DeviceType.CUDA.value:
            current_memory = torch.cuda.memory_allocated() / 1024**2  # MB
            peak_memory = torch.cuda.max_memory_allocated() / 1024**2  # MB
            reserved_memory = torch.cuda.memory_reserved() / 1024**2  # MB
            total_memory = torch.cuda.get_device_properties(self.device).total_memory / 1024**2  # MB
        elif self.device.type == DeviceType.MPS.value:
            # MPS doesn't have detailed memory stats, use approximations
            try:
                current_memory = torch.mps.current_allocated_memory() / 1024**2  # MB
                peak_memory = current_memory  # MPS doesn't track peak separately
                reserved_memory = current_memory
                # Estimate total memory (this is approximate for Apple Silicon)
                total_memory = 8192  # Default estimate, could be made configurable
            except:
                # Fallback if MPS memory functions aren't available
                current_memory = peak_memory = reserved_memory = total_memory = 0

        self.memory_snapshots.append({
            'timestamp': time.time(),
            'current_memory_mb': current_memory,
            'peak_memory_mb': peak_memory,
            'reserved_memory_mb': reserved_memory,
            'total_memory_mb': total_memory,
            'scaler_scale': self.scaler.get_scale() if self.scaler else None
        })

    def log_memory_stats(self, stage_name: str):
        """Log memory statistics for a specific stage"""
        current_memory = 0
        peak_memory = 0

        if self.device.type == DeviceType.CUDA.value:
            current_memory = torch.cuda.memory_allocated() / 1024**2
            peak_memory = torch.cuda.max_memory_allocated() / 1024**2
        elif self.device.type == DeviceType.MPS.value:
            try:
                current_memory = torch.mps.current_allocated_memory() / 1024**2
                peak_memory = current_memory
            except:
                current_memory = peak_memory = 0

        if stage_name not in self.profiling_stats.get('stage_stats', {}):
            self.profiling_stats.setdefault('stage_stats', {})[stage_name] = {
                'memory_used_mb': current_memory,
                'peak_memory_mb': peak_memory,
                'call_count': 1,
                'total_time_ms': 0
            }
        else:
            stats = self.profiling_stats['stage_stats'][stage_name]
            stats['memory_used_mb'] = max(stats['memory_used_mb'], current_memory)
            stats['peak_memory_mb'] = max(stats['peak_memory_mb'], peak_memory)
            stats['call_count'] += 1

    def get_profiling_report(self) -> Dict[str, Any]:
        """Generate comprehensive profiling report including mixed precision stats"""
        report = {
            'device_info': self.profiling_stats.get('device_info', {}),
            'stage_stats': self.profiling_stats.get('stage_stats', {}),
            'memory_snapshots': self.memory_snapshots,
            'interbatch_stats': self.interbatch_profiler.get_statistics(),
            'mixed_precision_stats': self.mixed_precision_stats.copy() if self.use_mixed_precision else None
        }

        # Memory summary
        if self.memory_snapshots:
            latest_snapshot = self.memory_snapshots[-1]
            report['memory_summary'] = {
                'current_memory_mb': latest_snapshot['current_memory_mb'],
                'peak_memory_mb': latest_snapshot['peak_memory_mb'],
                'reserved_memory_mb': latest_snapshot['reserved_memory_mb'],
                'total_memory_mb': latest_snapshot['total_memory_mb'],
                'stage_stats': self.profiling_stats.get('stage_stats', {}),
                'current_scaler_scale': latest_snapshot.get('scaler_scale')
            }

        # Memory analysis
        stage_stats = self.profiling_stats.get('stage_stats', {})
        if stage_stats:
            most_memory_intensive = max(stage_stats.keys(),
                                      key=lambda x: stage_stats[x]['memory_used_mb'])
            total_memory_used = sum(stats['memory_used_mb'] for stats in stage_stats.values())

            report['memory_analysis'] = {
                'most_memory_intensive_stage': most_memory_intensive,
                'total_memory_used_mb': total_memory_used
            }

        # Model info
        if hasattr(self.model, 'get_model_info'):
            report['model_info'] = self.model.get_model_info()

        return report

    def analyze_profiling_results(self, profiling_report: Dict[str, Any]):
        """Analyze and print profiling results in a readable format"""
        print("\n" + "="*60)
        print("GPU/MPS PROFILING ANALYSIS REPORT")
        print("="*60)

        # Device information
        device_info = profiling_report.get('device_info', {})
        print(f"\nDevice: {device_info.get('device_name', 'Unknown')}")
        print(f"Device Type: {device_info.get('device_type', 'Unknown')}")
        print(f"Device Available: {device_info.get('device_available', False)}")
        print(f"Mixed Precision: {device_info.get('mixed_precision_enabled', False)}")
        if device_info.get('mixed_precision_dtype'):
            print(f"Mixed Precision Dtype: {device_info.get('mixed_precision_dtype')}")

        # Mixed precision statistics
        mp_stats = profiling_report.get('mixed_precision_stats')
        if mp_stats:
            print(f"\nMixed Precision Statistics:")
            print(f"  Successful Steps: {mp_stats.get('successful_steps', 0)}")
            print(f"  Skipped Steps: {mp_stats.get('skipped_steps', 0)}")
            print(f"  Scale Updates: {mp_stats.get('scale_updates', 0)}")
            print(f"  Scale Decreases: {mp_stats.get('scale_decreases', 0)}")
            print(f"  Overflow Count: {mp_stats.get('overflow_count', 0)}")

            total_steps = mp_stats.get('successful_steps', 0) + mp_stats.get('skipped_steps', 0)
            if total_steps > 0:
                success_rate = (mp_stats.get('successful_steps', 0) / total_steps) * 100
                print(f"  Success Rate: {success_rate:.1f}%")

        # Memory analysis
        memory_summary = profiling_report.get('memory_summary', {})
        if memory_summary:
            print(f"\nMemory Usage:")
            print(f"  Current: {memory_summary.get('current_memory_mb', 0):.1f} MB")
            print(f"  Peak: {memory_summary.get('peak_memory_mb', 0):.1f} MB")
            print(f"  Reserved: {memory_summary.get('reserved_memory_mb', 0):.1f} MB")

            device_type = device_info.get('device_type', 'unknown')
            if device_type == DeviceType.CUDA.value:
                print(f"  Total GPU: {memory_summary.get('total_memory_mb', 0):.1f} MB")
            elif device_type == DeviceType.MPS.value:
                print(f"  Estimated Total: {memory_summary.get('total_memory_mb', 0):.1f} MB")

            # Memory efficiency
            total_memory = memory_summary.get('total_memory_mb', 1)
            peak_memory = memory_summary.get('peak_memory_mb', 0)
            if total_memory > 0:
                memory_efficiency = (peak_memory / total_memory) * 100
                print(f"  Memory Efficiency: {memory_efficiency:.1f}%")

            if memory_summary.get('current_scaler_scale'):
                print(f"  Current Scaler Scale: {memory_summary.get('current_scaler_scale'):.0f}")

        # Print interbatch profiling report
        self.interbatch_profiler.print_report()

    def profile_training_steps(self, num_steps: int = 10):
        """Profile a specific number of training steps with mixed precision support and adaptive memory management"""
        logger.info(f"Starting profiling for {num_steps} training steps on {self.device.type}")

        self.reset_profiling_stats()
        self.start_torch_profiler()

        self.model.train()
        total_time = 0
        step_count = 0

        for batch_idx, batch in enumerate(self.dataloader):
            if step_count >= num_steps:
                break

            start_time = time.time()

            try:
                # Start interbatch profiling
                self.interbatch_profiler.start_batch()

                # Adaptive memory cleanup check during profiling
                cleanup_result = self.adaptive_memory_cleanup(batch_idx)

                # Profile step
                self.profile_step()

                # Data loading profiling
                self.interbatch_profiler.start_data_loading()
                with torch.profiler.record_function("Data_Loading"):
                    mel_specs = batch['mel_specs'].to(self.device, non_blocking=self.device.type=='cuda')
                    phoneme_indices = batch['phoneme_indices'].to(self.device, non_blocking=self.device.type=='cuda')
                    phoneme_durations = batch['phoneme_durations'].to(self.device, non_blocking=self.device.type=='cuda')
                    stop_token_targets = batch['stop_token_targets'].to(self.device, non_blocking=self.device.type=='cuda')
                    mel_lengths = batch['mel_lengths'].to(self.device, non_blocking=self.device.type=='cuda')
                    phoneme_lengths = batch['phoneme_lengths'].to(self.device, non_blocking=self.device.type=='cuda')
                self.interbatch_profiler.end_data_loading()

                self.log_memory_stats("data_loading")

                with torch.profiler.record_function("Zero_Grad"):
                    self.optimizer.zero_grad()

                # Note: Scheduled sampling disabled during profiling for consistent measurements
                # (profiling is typically done for short runs, not full training)
                use_gt_durs = False  # Use duration predictor during profiling

                # Forward pass with mixed precision
                self.interbatch_profiler.start_forward_pass()
                with torch.profiler.record_function("Model_Forward"):
                    if self.use_mixed_precision:
                        with self.get_autocast_context():
                            mel_coarse, mel_refined, predicted_log_durations, predicted_stop_logits = \
                                self.model(phoneme_indices, mel_specs, phoneme_durations, stop_token_targets,
                                          use_gt_durations=use_gt_durs)
                    else:
                        mel_coarse, mel_refined, predicted_log_durations, predicted_stop_logits = \
                            self.model(phoneme_indices, mel_specs, phoneme_durations, stop_token_targets,
                                      use_gt_durations=use_gt_durs)
                self.interbatch_profiler.end_forward_pass()

                self.log_memory_stats("forward_pass")

                # Loss calculation with mixed precision
                with torch.profiler.record_function("Loss_Calculation"):
                    if self.use_mixed_precision:
                        with self.get_autocast_context():
                            total_loss, loss_mel_coarse, loss_mel_refined, loss_duration, loss_stop_token = self._calculate_losses(
                                mel_coarse, mel_refined, predicted_log_durations, predicted_stop_logits,
                                mel_specs, phoneme_durations, stop_token_targets,
                                mel_lengths, phoneme_lengths
                            )
                    else:
                        total_loss, loss_mel_coarse, loss_mel_refined, loss_duration, loss_stop_token = self._calculate_losses(
                            mel_coarse, mel_refined, predicted_log_durations, predicted_stop_logits,
                            mel_specs, phoneme_durations, stop_token_targets,
                            mel_lengths, phoneme_lengths
                        )

                self.log_memory_stats("loss_calculation")

                # Backward pass with profiling
                self.interbatch_profiler.start_backward_pass()

                # ========== Backward + Optimizer Step (Simplified) ==========
                with torch.profiler.record_function("Backward_Pass"):
                    if self.use_mixed_precision and self.autocast_dtype == torch.bfloat16:
                        # ✅ BF16 path (no GradScaler needed - inherently stable)
                        self.optimizer.zero_grad(set_to_none=True)
                        total_loss.backward()
                        grad_norm = torch.nn.utils.clip_grad_norm_(self.model.parameters(), 1.0)

                        if not torch.isfinite(grad_norm):
                            logger.warning(f"[Profiling Step {step_count}] Non-finite grad norm ({grad_norm:.2f}). Skipping batch.")
                            self.optimizer.zero_grad(set_to_none=True)
                            continue

                        self.optimizer.step()
                        self.mixed_precision_stats['successful_steps'] += 1

                    elif self.use_mixed_precision and self.scaler is not None:
                        # FP16 path with GradScaler (backward compatibility)
                        self.scaler.scale(total_loss).backward()
                        self.scaler.unscale_(self.optimizer)
                        grad_norm = torch.nn.utils.clip_grad_norm_(self.model.parameters(), 1.0)

                        if not torch.isfinite(grad_norm):
                            logger.warning(f"[Profiling Step {step_count}] Non-finite grad norm ({grad_norm:.2f}). Skipping batch.")
                            self.optimizer.zero_grad(set_to_none=True)
                            self.scaler.update()
                            continue

                        self.scaler.step(self.optimizer)
                        old_scale = self.scaler.get_scale()
                        self.scaler.update()
                        new_scale = self.scaler.get_scale()

                        # Cap grad scale if needed
                        if hasattr(self, 'max_grad_scale') and self.max_grad_scale is not None and new_scale > self.max_grad_scale:
                            try:
                                self.scaler._scale.fill_(self.max_grad_scale)
                            except Exception:
                                pass  # Ignore during profiling

                        # Update mixed precision stats
                        if new_scale != old_scale:
                            self.mixed_precision_stats['scale_updates'] += 1
                            if new_scale < old_scale:
                                self.mixed_precision_stats['scale_decreases'] += 1
                                self.mixed_precision_stats['overflow_count'] += 1
                            else:
                                self.mixed_precision_stats['successful_steps'] += 1
                        else:
                            self.mixed_precision_stats['successful_steps'] += 1

                    else:
                        # FP32 fallback (no mixed precision)
                        self.optimizer.zero_grad(set_to_none=True)
                        total_loss.backward()
                        torch.nn.utils.clip_grad_norm_(self.model.parameters(), 1.0)
                        self.optimizer.step()
                        self.mixed_precision_stats['successful_steps'] += 1

                self.interbatch_profiler.end_backward_pass()
                self.log_memory_stats("backward_pass")

                # End batch profiling
                batch_size = mel_specs.size(0)
                self.interbatch_profiler.end_batch(batch_size)

                step_time = time.time() - start_time
                total_time += step_time
                step_count += 1

                if step_count % 2 == 0:
                    memory_info = f", Mem: {cleanup_result.get('pressure_level', 'unknown')}" if self.enable_adaptive_memory else ""
                    logger.info(f"Profiling Step {step_count}, Time: {step_time:.3f}s{memory_info}")

            except Exception as e:
                logger.error(f"Error in profiling step {step_count}: {e}")
                if self.enable_adaptive_memory:
                    self.memory_manager.emergency_cleanup()
                else:
                    self.clear_device_cache()
                continue

        self.stop_torch_profiler()

        # Generate and analyze report
        report = self.get_profiling_report()
        logger.info(f"Training profiling completed. Total time: {total_time:.2f}s, "
                   f"Avg time per step: {total_time/step_count:.3f}s")

        # Print analysis
        self.analyze_profiling_results(report)

        # Print memory management report if enabled
        if self.enable_adaptive_memory:
            logger.info("Memory Management Report during profiling:")
            self.print_memory_management_report()

        return report
