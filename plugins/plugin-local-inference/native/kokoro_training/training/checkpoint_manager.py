#!/usr/bin/env python3
"""
Checkpoint management utilities
"""

import os
import torch
import pickle
import json
from pathlib import Path
from typing import Optional, Tuple
import logging

from .config_english import EnglishTrainingConfig as TrainingConfig
from data.english_phoneme_processor import EnglishPhonemeProcessor

logger = logging.getLogger(__name__)


def save_model_config(config: TrainingConfig, output_dir: str):
    """Save model configuration as JSON file for inference"""
    config_dict = {
        # Audio parameters
        'sample_rate': config.sample_rate,
        'hop_length': config.hop_length,
        'win_length': config.win_length,
        'n_fft': config.n_fft,
        'n_mels': config.n_mels,
        'f_min': config.f_min,
        'f_max': config.f_max,

        # Model architecture parameters
        'hidden_dim': config.hidden_dim,
        'n_encoder_layers': config.n_encoder_layers,
        'n_decoder_layers': config.n_decoder_layers,
        'n_heads': config.n_heads,
        'encoder_ff_dim': config.encoder_ff_dim,
        'decoder_ff_dim': config.decoder_ff_dim,
        'encoder_dropout': config.encoder_dropout,
        'max_decoder_seq_len': config.max_decoder_seq_len,
    }

    config_path = os.path.join(output_dir, "model_config.json")
    with open(config_path, 'w') as f:
        json.dump(config_dict, f, indent=2)
    logger.info(f"Model config saved: {config_path}")


def save_phoneme_processor(processor: EnglishPhonemeProcessor, output_dir: str):
    """Save phoneme processor separately as pickle file"""
    processor_path = os.path.join(output_dir, "phoneme_processor.pkl")
    with open(processor_path, 'wb') as f:
        pickle.dump(processor.to_dict(), f)
    logger.info(f"Phoneme processor saved: {processor_path}")


def load_phoneme_processor(output_dir: str) -> EnglishPhonemeProcessor:
    """Load phoneme processor from pickle file"""
    processor_path = os.path.join(output_dir, "phoneme_processor.pkl")
    with open(processor_path, 'rb') as f:
        processor_data = pickle.load(f)
    processor = EnglishPhonemeProcessor.from_dict(processor_data)
    logger.info(f"Phoneme processor loaded: {processor_path}")
    return processor


def save_checkpoint(
    model: torch.nn.Module,
    optimizer: torch.optim.Optimizer,
    scheduler: torch.optim.lr_scheduler._LRScheduler,
    epoch: int,
    loss: float,
    config: TrainingConfig,
    output_dir: str
):
    """Save training checkpoint with disk space check and cleanup"""
    # Check disk space before saving
    if not check_disk_space(output_dir, min_free_gb=5.0):
        logger.warning(f"Skipping checkpoint save for epoch {epoch+1} due to insufficient disk space")
        return

    checkpoint = {
        'epoch': epoch,
        'model_state_dict': model.state_dict(),
        'optimizer_state_dict': optimizer.state_dict(),
        'scheduler_state_dict': scheduler.state_dict(),
        'loss': loss,
        'config': config
    }
    checkpoint_path = os.path.join(output_dir, f"checkpoint_epoch_{epoch+1}.pth")

    try:
        torch.save(checkpoint, checkpoint_path)
        logger.info(f"Checkpoint saved: {checkpoint_path}")

        # Cleanup old checkpoints if configured
        keep_last_n = getattr(config, 'keep_last_n_checkpoints', 3)
        if keep_last_n > 0:
            cleanup_old_checkpoints(output_dir, keep_last_n)
    except Exception as e:
        logger.error(f"Failed to save checkpoint: {e}")
        logger.error("Training will continue without this checkpoint")


def load_checkpoint(
    checkpoint_path: str,
    model: torch.nn.Module,
    optimizer: torch.optim.Optimizer,
    scheduler: torch.optim.lr_scheduler._LRScheduler,
    output_dir: str
) -> Tuple[int, float, EnglishPhonemeProcessor]:
    """Load checkpoint with robust error handling for optimizer/scheduler state"""
    logger.info(f"Loading checkpoint from {checkpoint_path}")

    # Add safe globals for our custom classes (PyTorch 2.6+ only)
    if hasattr(torch.serialization, 'add_safe_globals'):
        torch.serialization.add_safe_globals([TrainingConfig, EnglishPhonemeProcessor])

    try:
        # Try loading with weights_only=True first (new default in PyTorch 2.6+)
        checkpoint = torch.load(checkpoint_path, map_location='cpu', weights_only=True)

    except Exception as e:
        logger.warning(f"Loading with weights_only=True failed: {e}")
        logger.info("Trying to load with weights_only=False for compatibility...")

        try:
            # Try loading with weights_only=False for older checkpoints
            checkpoint = torch.load(checkpoint_path, map_location='cpu', weights_only=False)
        except Exception as e2:
            logger.error(f"Error loading checkpoint even with weights_only=False: {e2}")
            raise e2

    # At this point we have the checkpoint loaded
    # Load model weights
    try:
        model.load_state_dict(checkpoint['model_state_dict'], strict=False)
        logger.info("Model weights loaded successfully")
    except Exception as e:
        logger.error(f"Error loading model state dict: {e}")
        raise

    start_epoch = checkpoint['epoch'] + 1
    best_loss = checkpoint['loss']

    # Try to load optimizer state with error handling
    try:
        if 'optimizer_state_dict' in checkpoint:
            # The optimizer state dict might have issues, try to load it carefully
            optimizer_state = checkpoint['optimizer_state_dict']

            # Check if state dict is valid
            if optimizer_state and 'state' in optimizer_state:
                optimizer.load_state_dict(optimizer_state)
                logger.info("Optimizer state loaded successfully")
            else:
                logger.warning("Optimizer state dict is malformed, starting fresh optimizer")
        else:
            logger.warning("No optimizer state in checkpoint, starting fresh optimizer")
    except Exception as e:
        logger.warning(f"Failed to load optimizer state: {e}")
        logger.info("Continuing with fresh optimizer state (not a critical error)")

    # Try to load scheduler state with error handling
    try:
        if 'scheduler_state_dict' in checkpoint:
            scheduler_state = checkpoint['scheduler_state_dict']

            # Check if state dict is valid
            if scheduler_state:
                scheduler.load_state_dict(scheduler_state)
                logger.info("Scheduler state loaded successfully")
            else:
                logger.warning("Scheduler state dict is malformed, starting fresh scheduler")
        else:
            logger.warning("No scheduler state in checkpoint, starting fresh scheduler")
    except Exception as e:
        logger.warning(f"Failed to load scheduler state: {e}")
        logger.info("Continuing with fresh scheduler state (not a critical error)")

    # Load or create phoneme processor
    if 'phoneme_processor' in checkpoint:
        phoneme_processor = checkpoint['phoneme_processor']
        logger.info("Phoneme processor loaded from checkpoint")
    else:
        # Create fresh phoneme processor if not in checkpoint
        phoneme_processor = EnglishPhonemeProcessor()
        logger.info("Created fresh phoneme processor")

    logger.info(f"Resumed from epoch {start_epoch} with loss {best_loss:.4f}")
    return start_epoch, best_loss, phoneme_processor


def find_latest_checkpoint(output_dir: str) -> Optional[str]:
    """Find the latest checkpoint in the output directory"""
    checkpoint_dir = Path(output_dir)
    if not checkpoint_dir.exists():
        return None

    checkpoint_files = list(checkpoint_dir.glob("checkpoint_epoch_*.pth"))
    if not checkpoint_files:
        return None

    # Sort by epoch number
    checkpoint_files.sort(key=lambda x: int(x.stem.split('_')[-1]))
    latest_checkpoint = checkpoint_files[-1]

    logger.info(f"Found latest checkpoint: {latest_checkpoint}")
    return str(latest_checkpoint)


def cleanup_old_checkpoints(output_dir: str, keep_last_n: int = 3):
    """
    Delete old checkpoints, keeping only the last N checkpoints.

    Args:
        output_dir: Directory containing checkpoints
        keep_last_n: Number of most recent checkpoints to keep (default: 3)
    """
    if keep_last_n <= 0:
        logger.warning("keep_last_n must be positive, skipping cleanup")
        return

    checkpoint_dir = Path(output_dir)
    if not checkpoint_dir.exists():
        return

    # Find all checkpoint files
    checkpoint_files = list(checkpoint_dir.glob("checkpoint_epoch_*.pth"))
    if not checkpoint_files:
        return

    # Sort by epoch number (oldest first)
    checkpoint_files.sort(key=lambda x: int(x.stem.split('_')[-1]))

    # Calculate how many to delete
    num_checkpoints = len(checkpoint_files)
    num_to_delete = num_checkpoints - keep_last_n

    if num_to_delete <= 0:
        logger.debug(f"Only {num_checkpoints} checkpoints exist, no cleanup needed (keeping last {keep_last_n})")
        return

    # Delete old checkpoints
    deleted_count = 0
    total_size_freed = 0

    for checkpoint_file in checkpoint_files[:num_to_delete]:
        try:
            file_size = checkpoint_file.stat().st_size
            checkpoint_file.unlink()
            total_size_freed += file_size
            deleted_count += 1
            logger.info(f"Deleted old checkpoint: {checkpoint_file.name} ({file_size / 1024**2:.1f} MB)")
        except Exception as e:
            logger.warning(f"Failed to delete checkpoint {checkpoint_file}: {e}")

    if deleted_count > 0:
        logger.info(f"Cleanup complete: Deleted {deleted_count} old checkpoint(s), "
                   f"freed {total_size_freed / 1024**2:.1f} MB, "
                   f"keeping last {keep_last_n} checkpoint(s)")


def check_disk_space(output_dir: str, min_free_gb: float = 5.0) -> bool:
    """
    Check if there's enough disk space before saving checkpoint.

    Args:
        output_dir: Directory where checkpoint will be saved
        min_free_gb: Minimum free space required in GB (default: 5.0)

    Returns:
        True if enough space available, False otherwise
    """
    import shutil

    try:
        stats = shutil.disk_usage(output_dir)
        free_gb = stats.free / (1024**3)

        if free_gb < min_free_gb:
            logger.error(f"Insufficient disk space: {free_gb:.2f} GB free, need at least {min_free_gb} GB")
            logger.error("Please free up disk space or reduce checkpoint frequency")
            return False

        logger.debug(f"Disk space check passed: {free_gb:.2f} GB free")
        return True

    except Exception as e:
        logger.warning(f"Could not check disk space: {e}")
        return True  # Proceed anyway if check fails


def save_final_model(model: torch.nn.Module, config: TrainingConfig, output_dir: str):
    """Save final model"""
    final_model_path = os.path.join(output_dir, "kokoro_russian_final.pth")
    torch.save({
        'model_state_dict': model.state_dict(),
        'config': config
    }, final_model_path)
    logger.info(f"Final model saved: {final_model_path}")
