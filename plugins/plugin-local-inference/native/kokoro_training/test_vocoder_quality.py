#!/usr/bin/env python3
"""
Test if vocoder works correctly by converting ground truth mel → audio.
If ground truth sounds good but model output is noise, the problem is the model.
"""

import sys
import torch
from pathlib import Path
import logging

logging.basicConfig(level=logging.INFO, format='%(message)s')
logger = logging.getLogger(__name__)

sys.path.insert(0, str(Path(__file__).parent))

from data.ljspeech_dataset import LJSpeechDataset
from training.config_english import EnglishTrainingConfig
from audio.vocoder_manager import VocoderManager

logger.info("=" * 80)
logger.info("VOCODER QUALITY TEST")
logger.info("=" * 80)

# Load config
config = EnglishTrainingConfig()

# Load dataset
logger.info("\nLoading dataset...")
dataset = LJSpeechDataset(config.data_dir, config)

# Get first sample
logger.info("Getting ground truth mel spectrogram from sample 0...")
sample = dataset[0]

mel_spec = sample['mel_spec']  # [time, n_mels]
text = sample['text']

logger.info(f"\nText: '{text}'")
logger.info(f"Mel shape: {mel_spec.shape}")
logger.info(f"Mel range: [{mel_spec.min():.3f}, {mel_spec.max():.3f}]")
logger.info(f"Mel mean: {mel_spec.mean():.3f}, std: {mel_spec.std():.3f}")

# Load vocoder
logger.info("\nLoading HiFi-GAN vocoder...")
vocoder_manager = VocoderManager(vocoder_type='hifigan', device=config.device)
vocoder = vocoder_manager.vocoder

# Convert mel to audio
logger.info("\nConverting ground truth mel → audio...")

# HiFi-GAN expects [batch, n_mels, time]
mel_input = mel_spec.T.unsqueeze(0).to(config.device)  # [1, 80, time]

with torch.no_grad():
    audio = vocoder(mel_input).squeeze(0).squeeze(0).cpu()

logger.info(f"\nAudio generated:")
logger.info(f"  Shape: {audio.shape}")
logger.info(f"  Duration: {len(audio) / 22050:.2f}s")
logger.info(f"  Range: [{audio.min():.3f}, {audio.max():.3f}]")

# Save
output_file = "test_vocoder_gt.wav"
import soundfile as sf
sf.write(output_file, audio.numpy(), 22050)

logger.info(f"\n✓ Audio saved to: {output_file}")

logger.info("\n" + "=" * 80)
logger.info("TEST INTERPRETATION")
logger.info("=" * 80)
logger.info("\nListen to the generated audio:")
logger.info(f"  {output_file}")
logger.info("\nExpected result:")
logger.info("  ✓ GOOD: Clear, intelligible speech matching the text")
logger.info("  ✗ BAD:  Noise, distortion, or unintelligible")
logger.info("\nIf the audio is GOOD:")
logger.info("  → Vocoder works correctly")
logger.info("  → Problem is your MODEL (needs more training)")
logger.info("  → Continue training to mel_loss < 0.3")
logger.info("\nIf the audio is BAD:")
logger.info("  → Vocoder or mel processing is broken")
logger.info("  → Need to fix vocoder/mel normalization")
logger.info("\n" + "=" * 80)
