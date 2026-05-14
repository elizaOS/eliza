#!/usr/bin/env python3
"""
Diagnostic to check training health and identify bottlenecks.
"""

import sys
import torch
from pathlib import Path
import logging

logging.basicConfig(level=logging.INFO, format='%(message)s')
logger = logging.getLogger(__name__)

sys.path.insert(0, str(Path(__file__).parent))

from data.ljspeech_dataset import LJSpeechDataset, collate_fn, LengthBasedBatchSampler
from training.config_english import EnglishTrainingConfig
from torch.utils.data import DataLoader
from kokoro.model import KokoroModel

logger.info("=" * 80)
logger.info("TRAINING HEALTH DIAGNOSTIC")
logger.info("=" * 80)

# Load config
config = EnglishTrainingConfig()

# Load dataset
logger.info("\nLoading dataset...")
dataset = LJSpeechDataset(config.data_dir, config)
logger.info(f"Total samples: {len(dataset)}")

# Create dataloader
batch_sampler = LengthBasedBatchSampler(dataset, batch_size=config.batch_size, shuffle=False)
dataloader = DataLoader(
    dataset,
    batch_sampler=batch_sampler,
    num_workers=0,
    collate_fn=collate_fn,
    pin_memory=False
)

# Load model
logger.info("\nInitializing model...")
model = KokoroModel(
    vocab_size=96,
    mel_dim=config.n_mels,
    hidden_dim=config.hidden_dim,
    n_encoder_layers=config.n_encoder_layers,
    n_decoder_layers=config.n_decoder_layers,
    n_heads=config.n_heads,
    encoder_ff_dim=config.encoder_ff_dim,
    decoder_ff_dim=config.decoder_ff_dim,
    encoder_dropout=config.encoder_dropout,
    max_decoder_seq_len=config.max_decoder_seq_len,
    gradient_checkpointing=False,
)
model = model.to(config.device)
model.eval()

# Test 10 batches
logger.info("\nTesting 10 random batches...")
logger.info("=" * 80)

mel_losses = []
dur_losses = []
stop_losses = []

with torch.no_grad():
    for batch_idx, batch in enumerate(dataloader):
        if batch_idx >= 10:
            break

        # Move to device
        phoneme_indices = batch['phoneme_indices'].to(config.device)
        phoneme_lengths = batch['phoneme_lengths'].to(config.device)
        mel_specs = batch['mel_specs'].to(config.device)
        mel_lengths = batch['mel_lengths'].to(config.device)
        phoneme_durations = batch['phoneme_durations'].to(config.device)
        stop_token_targets = batch['stop_token_targets'].to(config.device)

        try:
            # Forward pass (returns tuple: mel_output, duration_output, stop_output)
            mel_output, duration_output, stop_token_output = model(
                phoneme_indices=phoneme_indices,
                mel_specs=mel_specs,
                phoneme_durations=phoneme_durations,
                stop_token_targets=stop_token_targets,
                use_gt_durations=True
            )

            # Calculate losses per sample
            batch_size = mel_specs.size(0)

            for i in range(batch_size):
                actual_len = mel_lengths[i].item()

                # Mel loss
                pred_mel = mel_output[i, :actual_len, :]
                target_mel = mel_specs[i, :actual_len, :]
                mel_loss = torch.nn.functional.mse_loss(pred_mel, target_mel).item()
                mel_losses.append(mel_loss)

                # Duration loss
                phoneme_len = phoneme_lengths[i].item()
                pred_dur = duration_output[i, :phoneme_len]
                target_dur = phoneme_durations[i, :phoneme_len].float()
                dur_loss = torch.nn.functional.mse_loss(pred_dur, target_dur).item()
                dur_losses.append(dur_loss)

                # Stop loss
                pred_stop = stop_token_output[i, :actual_len]
                target_stop = stop_token_targets[i, :actual_len]
                stop_loss = torch.nn.functional.binary_cross_entropy_with_logits(
                    pred_stop, target_stop
                ).item()
                stop_losses.append(stop_loss)

        except Exception as e:
            logger.error(f"Batch {batch_idx} failed: {e}")
            continue

# Analysis
logger.info("\n" + "=" * 80)
logger.info("RESULTS - Untrained Model Performance")
logger.info("=" * 80)
logger.info(f"\nTested {len(mel_losses)} samples")
logger.info(f"\nMel Loss (MSE):")
logger.info(f"  Mean: {sum(mel_losses)/len(mel_losses):.4f}")
logger.info(f"  Min:  {min(mel_losses):.4f}")
logger.info(f"  Max:  {max(mel_losses):.4f}")

logger.info(f"\nDuration Loss (MSE):")
logger.info(f"  Mean: {sum(dur_losses)/len(dur_losses):.4f}")
logger.info(f"  Min:  {min(dur_losses):.4f}")
logger.info(f"  Max:  {max(dur_losses):.4f}")

logger.info(f"\nStop Token Loss (BCE):")
logger.info(f"  Mean: {sum(stop_losses)/len(stop_losses):.4f}")
logger.info(f"  Min:  {min(stop_losses):.4f}")
logger.info(f"  Max:  {max(stop_losses):.4f}")

logger.info("\n" + "=" * 80)
logger.info("INTERPRETATION")
logger.info("=" * 80)

avg_mel = sum(mel_losses)/len(mel_losses)

logger.info(f"\nUntrained baseline mel loss: {avg_mel:.4f}")
logger.info(f"Your epoch 100 mel loss: ~0.5")
logger.info(f"Improvement: {(avg_mel - 0.5) / avg_mel * 100:.1f}%")

if avg_mel - 0.5 < 0.5:
    logger.info("\n⚠️  WARNING: Model has learned very little!")
    logger.info("   Expected untrained loss ~2.0-3.0, yours is {:.2f}".format(avg_mel))
    logger.info("   With only {:.1f}% improvement, training is very slow.".format((avg_mel - 0.5) / avg_mel * 100))
else:
    logger.info("\n✓ Model is learning, but slowly.")
    logger.info(f"   From {avg_mel:.2f} → 0.5 shows {(avg_mel - 0.5) / avg_mel * 100:.1f}% improvement")

logger.info("\n" + "=" * 80)
logger.info("RECOMMENDATIONS")
logger.info("=" * 80)

if avg_mel - 0.5 < 1.0:
    logger.info("\n1. Training is very slow. Possible causes:")
    logger.info("   - Learning rate too low")
    logger.info("   - Loss spikes preventing convergence")
    logger.info("   - Data quality issues")
    logger.info("\n2. Check your training logs:")
    logger.info("   - Is mel_loss decreasing smoothly?")
    logger.info("   - How often do you see loss spikes > 1.5?")
    logger.info("   - What's your current learning rate?")
else:
    logger.info("\n1. Continue training - you need mel_loss < 0.3 minimum")
    logger.info("   Current: 0.5 (random noise)")
    logger.info("   Target:  0.3 (barely intelligible)")
    logger.info("   Goal:    0.15-0.2 (good quality)")
    logger.info("\n2. Expected epochs:")
    logger.info("   ~150-180 epochs to reach 0.3")
    logger.info("   ~200-250 epochs to reach 0.2")
    logger.info("   ~300+ epochs for 0.15")

logger.info("\n" + "=" * 80)
