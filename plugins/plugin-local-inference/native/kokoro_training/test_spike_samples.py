#!/usr/bin/env python3
"""
Identify samples that cause mel loss spikes during training.
Simulates training and records samples with abnormally high losses.
"""

import sys
import torch
from pathlib import Path
import logging
from collections import defaultdict

# Set logging
logging.basicConfig(level=logging.INFO, format='%(message)s')
logger = logging.getLogger(__name__)

sys.path.insert(0, str(Path(__file__).parent))

from data.ljspeech_dataset import LJSpeechDataset, collate_fn, LengthBasedBatchSampler
from training.config_english import EnglishTrainingConfig
from torch.utils.data import DataLoader
from kokoro.model import KokoroModel

# Create config
config = EnglishTrainingConfig()
config.batch_size = 32  # Same as training

logger.info("=" * 80)
logger.info("MEL LOSS SPIKE ANALYSIS")
logger.info("=" * 80)

# Create dataset
logger.info("\nLoading dataset...")
dataset = LJSpeechDataset(config.data_dir, config)
logger.info(f"Total samples: {len(dataset)}")

# Create sampler and dataloader
logger.info("Creating dataloader...")
batch_sampler = LengthBasedBatchSampler(dataset, batch_size=config.batch_size, shuffle=False)
dataloader = DataLoader(
    dataset,
    batch_sampler=batch_sampler,
    num_workers=0,
    collate_fn=collate_fn,
    pin_memory=False
)

# Create model (FIXED: mel_dim instead of n_mels)
logger.info("Initializing model...")
model = KokoroModel(
    vocab_size=96,
    mel_dim=config.n_mels,  # FIXED
    hidden_dim=config.hidden_dim,
    n_encoder_layers=config.n_encoder_layers,
    n_decoder_layers=config.n_decoder_layers,
    n_heads=config.n_heads,
    encoder_ff_dim=config.encoder_ff_dim,
    decoder_ff_dim=config.decoder_ff_dim,
    encoder_dropout=config.encoder_dropout,
    max_decoder_seq_len=config.max_decoder_seq_len,
    gradient_checkpointing=False,  # Disable for speed
)
model = model.to(config.device)
model.eval()  # Eval mode, no training

logger.info(f"\nTesting {min(100, len(dataloader))} batches...")
logger.info("Looking for samples with abnormally high mel reconstruction loss...\n")

spike_threshold = 1.5  # Loss above this is considered a spike
spike_batches = []
spike_samples = defaultdict(list)

with torch.no_grad():
    for batch_idx, batch in enumerate(dataloader):
        if batch_idx >= 100:
            break

        # Move batch to device
        phoneme_indices = batch['phoneme_indices'].to(config.device)
        phoneme_lengths = batch['phoneme_lengths'].to(config.device)
        mel_specs = batch['mel_specs'].to(config.device)
        mel_lengths = batch['mel_lengths'].to(config.device)
        phoneme_durations = batch['phoneme_durations'].to(config.device)

        try:
            # Get stop token targets
            stop_token_targets = batch['stop_token_targets'].to(config.device)

            # Forward pass (returns tuple: mel_output, duration_output, stop_output)
            mel_output, duration_output, stop_token_output = model(
                phoneme_indices=phoneme_indices,
                mel_specs=mel_specs,
                phoneme_durations=phoneme_durations,
                stop_token_targets=stop_token_targets,
                use_gt_durations=True
            )

            # Calculate per-sample mel loss
            batch_size = mel_specs.size(0)
            for i in range(batch_size):
                # Get actual length for this sample
                actual_len = mel_lengths[i].item()

                # Calculate MSE loss for this sample
                pred_mel = mel_output[i, :actual_len, :]
                target_mel = mel_specs[i, :actual_len, :]

                sample_mel_loss = torch.nn.functional.mse_loss(pred_mel, target_mel).item()

                # Check if this is a spike
                if sample_mel_loss > spike_threshold:
                    # Get sample index from batch sampler
                    sample_idx = batch_sampler.batches[batch_idx][i] if batch_idx < len(batch_sampler.batches) else None

                    if sample_idx is not None and sample_idx < len(dataset.samples):
                        sample_info = dataset.samples[sample_idx]

                        spike_samples[sample_idx].append({
                            'batch_idx': batch_idx,
                            'sample_in_batch': i,
                            'mel_loss': sample_mel_loss,
                            'audio_file': sample_info['audio_file'],
                            'text': sample_info['text'],
                            'mel_length': actual_len,
                            'phoneme_count': phoneme_lengths[i].item()
                        })

            # Calculate average batch loss
            avg_batch_loss = sum(
                torch.nn.functional.mse_loss(
                    mel_output[i, :mel_lengths[i], :],
                    mel_specs[i, :mel_lengths[i], :]
                ).item()
                for i in range(batch_size)
            ) / batch_size

            if avg_batch_loss > spike_threshold:
                spike_batches.append({
                    'batch_idx': batch_idx,
                    'avg_mel_loss': avg_batch_loss,
                    'max_mel_loss': max(
                        torch.nn.functional.mse_loss(
                            mel_output[i, :mel_lengths[i], :],
                            mel_specs[i, :mel_lengths[i], :]
                        ).item()
                        for i in range(batch_size)
                    )
                })

        except Exception as e:
            logger.warning(f"Batch {batch_idx} failed: {e}")
            continue

        # Progress
        if (batch_idx + 1) % 20 == 0:
            logger.info(f"  Tested {batch_idx + 1} batches... ({len(spike_samples)} spike samples found)")

logger.info("\n" + "=" * 80)
logger.info("RESULTS")
logger.info("=" * 80)
logger.info(f"Tested batches: {min(100, len(dataloader))}")
logger.info(f"Spike threshold: {spike_threshold}")
logger.info(f"Batches with spikes: {len(spike_batches)}")
logger.info(f"Unique spike samples: {len(spike_samples)}")

if spike_samples:
    output_file = "spike_samples_report.txt"
    logger.info(f"\nSaving detailed report to: {output_file}")

    with open(output_file, 'w', encoding='utf-8') as f:
        f.write("=" * 80 + "\n")
        f.write("MEL LOSS SPIKE ANALYSIS\n")
        f.write("=" * 80 + "\n\n")

        f.write(f"Spike threshold: {spike_threshold}\n")
        f.write(f"Batches with spikes: {len(spike_batches)}\n")
        f.write(f"Unique samples causing spikes: {len(spike_samples)}\n\n")

        f.write("=" * 80 + "\n")
        f.write("SPIKE SAMPLES (sorted by mel loss)\n")
        f.write("=" * 80 + "\n\n")

        # Sort by mel loss
        all_spikes = []
        for sample_idx, occurrences in spike_samples.items():
            max_loss = max(occ['mel_loss'] for occ in occurrences)
            all_spikes.append((sample_idx, max_loss, occurrences))

        all_spikes.sort(key=lambda x: x[1], reverse=True)

        for sample_idx, max_loss, occurrences in all_spikes:
            f.write(f"Sample Index: {sample_idx}\n")
            f.write(f"Max Mel Loss: {max_loss:.4f}\n")
            f.write(f"Audio File: {occurrences[0]['audio_file']}\n")
            f.write(f"Text: {occurrences[0]['text'][:200]}{'...' if len(occurrences[0]['text']) > 200 else ''}\n")
            f.write(f"Mel Length: {occurrences[0]['mel_length']}\n")
            f.write(f"Phoneme Count: {occurrences[0]['phoneme_count']}\n")
            f.write(f"Occurrences: {len(occurrences)}\n")
            f.write("-" * 80 + "\n")

    logger.info(f"✓ Report saved to {output_file}")

    # Show top 10
    logger.info("\nTop 10 worst samples (highest mel loss):")
    for sample_idx, max_loss, occurrences in all_spikes[:10]:
        logger.info(f"\n  [{sample_idx}] {occurrences[0]['audio_file']}")
        logger.info(f"    Mel Loss: {max_loss:.4f}")
        logger.info(f"    Mel Length: {occurrences[0]['mel_length']}, Phonemes: {occurrences[0]['phoneme_count']}")
        logger.info(f"    Text: {occurrences[0]['text'][:100]}...")

    # Statistics
    all_losses = [max_loss for _, max_loss, _ in all_spikes]
    logger.info(f"\nSpike Statistics:")
    logger.info(f"  Mean spike loss: {sum(all_losses)/len(all_losses):.4f}")
    logger.info(f"  Max spike loss: {max(all_losses):.4f}")
    logger.info(f"  Min spike loss: {min(all_losses):.4f}")

else:
    logger.info("\n✓ No spike samples found!")
    logger.info(f"  All samples have mel loss < {spike_threshold}")

logger.info("\n" + "=" * 80)
