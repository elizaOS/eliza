#!/usr/bin/env python3
"""
Kokoro Text-To-Speech Training Script for English (LJSpeech)
Main entry point for English TTS training
"""

import os
import sys
import torch
import logging
import argparse
import warnings
from pathlib import Path

# Suppress known harmless warnings
warnings.filterwarnings('ignore', category=DeprecationWarning, module='click.parser')
warnings.filterwarnings('ignore', category=DeprecationWarning, module='spacy.cli._util')
warnings.filterwarnings('ignore', category=DeprecationWarning, module='weasel.util.config')
warnings.filterwarnings('ignore', category=DeprecationWarning, module='misaki.en')
warnings.filterwarnings('ignore', message='.*backend.*parameter is not used.*')

from training.config_english import EnglishTrainingConfig, get_default_config, get_small_config
from data.ljspeech_dataset import LJSpeechDataset, collate_fn, LengthBasedBatchSampler
from data.english_phoneme_processor import EnglishPhonemeProcessor
from training.english_trainer import EnglishTrainer

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def parse_arguments():
    """Parse command line arguments"""
    parser = argparse.ArgumentParser(
        description='Train Kokoro TTS model on English LJSpeech dataset'
    )

    # Dataset paths
    parser.add_argument(
        '--corpus', '-c',
        type=str,
        default='LJSpeech-1.1',
        help='Path to LJSpeech corpus directory (default: LJSpeech-1.1)'
    )
    parser.add_argument(
        '--output', '-o',
        type=str,
        default='./kokoro_english_model',
        help='Path to output model directory (default: ./kokoro_english_model)'
    )

    # Training parameters
    parser.add_argument(
        '--batch-size', '-b',
        type=int,
        default=None,
        help='Batch size for training (default: from config)'
    )
    parser.add_argument(
        '--epochs', '-e',
        type=int,
        default=None,
        help='Number of training epochs (default: from config)'
    )
    parser.add_argument(
        '--learning-rate', '-lr',
        type=float,
        default=None,
        help='Learning rate (default: from config)'
    )
    parser.add_argument(
        '--save-every',
        type=int,
        default=None,
        help='Save checkpoint every N epochs (default: from config)'
    )

    # Resume training
    parser.add_argument(
        '--resume', '-r',
        type=str,
        default=None,
        help='Resume from checkpoint (auto for latest, or path to .pth file)'
    )

    # Model size
    parser.add_argument(
        '--model-size',
        type=str,
        choices=['small', 'medium', 'default', 'large'],
        default='default',
        help='Model size: small (6M), medium (25M, recommended for LJSpeech), default (62M), large (120M)'
    )

    # Device
    parser.add_argument(
        '--device',
        type=str,
        choices=['auto', 'cuda', 'mps', 'cpu'],
        default='auto',
        help='Device to use for training (default: auto)'
    )

    # Memory optimization
    parser.add_argument(
        '--no-gradient-checkpointing',
        action='store_true',
        help='Disable gradient checkpointing (uses more memory)'
    )
    parser.add_argument(
        '--no-mixed-precision',
        action='store_true',
        help='Disable mixed precision training'
    )

    # Testing/debugging
    parser.add_argument(
        '--test-mode',
        action='store_true',
        help='Run in test mode (only load 100 samples, 5 epochs)'
    )
    parser.add_argument(
        '--enable-profiling',
        action='store_true',
        help='Enable GPU profiling for debugging'
    )

    # Weights & Biases logging
    parser.add_argument(
        '--wandb',
        action='store_true',
        help='Enable Weights & Biases logging'
    )
    parser.add_argument(
        '--wandb-project',
        type=str,
        default='kokoro-english-tts',
        help='W&B project name (default: kokoro-english-tts)'
    )
    parser.add_argument(
        '--wandb-entity',
        type=str,
        default=None,
        help='W&B entity (username or team)'
    )
    parser.add_argument(
        '--wandb-name',
        type=str,
        default=None,
        help='W&B run name (auto-generated if not specified)'
    )
    parser.add_argument(
        '--wandb-tags',
        type=str,
        nargs='*',
        default=None,
        help='W&B tags for the run (space-separated)'
    )

    return parser.parse_args()


def create_config_from_args(args) -> EnglishTrainingConfig:
    """
    Create training configuration from command line arguments.

    Args:
        args: Parsed command line arguments

    Returns:
        EnglishTrainingConfig instance
    """
    # Get base configuration based on model size
    if args.model_size == 'small':
        config = get_small_config()
    elif args.model_size == 'medium':
        from training.config_english import get_medium_config
        config = get_medium_config()
    elif args.model_size == 'large':
        from training.config_english import get_large_config
        config = get_large_config()
    else:
        config = get_default_config()

    # Override with command line arguments (only if explicitly provided)
    config.data_dir = args.corpus
    config.output_dir = args.output

    if args.batch_size is not None:
        config.batch_size = args.batch_size
    if args.epochs is not None:
        config.num_epochs = args.epochs
    if args.learning_rate is not None:
        config.learning_rate = args.learning_rate
    if args.save_every is not None:
        config.save_every = args.save_every

    if args.resume:
        config.resume_checkpoint = args.resume

    # Device configuration
    if args.device != 'auto':
        config.device = args.device
    # else: use auto-detected device from config

    # Memory optimization flags
    if args.no_gradient_checkpointing:
        config.gradient_checkpointing = False

    if args.no_mixed_precision:
        config.use_mixed_precision = False

    # Profiling
    if args.enable_profiling:
        config.enable_profiling = True

    # Weights & Biases configuration
    if args.wandb:
        config.use_wandb = True
        config.wandb_project = args.wandb_project
        config.wandb_entity = args.wandb_entity
        config.wandb_run_name = args.wandb_name
        config.wandb_tags = args.wandb_tags

    # Test mode adjustments
    if args.test_mode:
        logger.warning("Running in TEST MODE - limited data and epochs")
        config.num_epochs = 5
        config.save_every = 1
        config.batch_size = min(4, config.batch_size)
        # Add test-mode tag if using wandb
        if config.use_wandb:
            if config.wandb_tags is None:
                config.wandb_tags = []
            config.wandb_tags.append('test-mode')
        # Will limit dataset size in main()

    return config


def validate_dataset(data_dir: str) -> bool:
    """
    Validate that LJSpeech dataset exists and is properly structured.

    Args:
        data_dir: Path to dataset directory

    Returns:
        True if valid, False otherwise
    """
    data_path = Path(data_dir)

    if not data_path.exists():
        logger.error(f"Dataset directory not found: {data_dir}")
        return False

    metadata_file = data_path / "metadata.csv"
    if not metadata_file.exists():
        logger.error(f"Metadata file not found: {metadata_file}")
        logger.info("Expected LJSpeech structure:")
        logger.info(f"  {data_dir}/")
        logger.info(f"    metadata.csv")
        logger.info(f"    wavs/")
        logger.info(f"    TextGrid/ (optional, from MFA)")
        return False

    wavs_dir = data_path / "wavs"
    if not wavs_dir.exists() or not wavs_dir.is_dir():
        logger.error(f"Audio directory not found: {wavs_dir}")
        return False

    # Check for MFA alignments
    textgrid_dir = data_path / "TextGrid"
    if textgrid_dir.exists():
        logger.info(f"Found MFA alignments at: {textgrid_dir}")
    else:
        logger.warning(f"No MFA alignments found at {textgrid_dir}")
        logger.warning("Will use uniform duration fallback (lower quality)")
        logger.info("To get better results, run Montreal Forced Aligner:")
        logger.info("  See ENGLISH_TRAINING_GUIDE.md for instructions")

    return True


def test_phoneme_processor():
    """Test the English phoneme processor"""
    logger.info("Testing English phoneme processor...")

    processor = EnglishPhonemeProcessor('en-us')
    logger.info(f"Processor: {processor}")

    test_texts = [
        "Hello, world!",
        "The quick brown fox jumps over the lazy dog.",
    ]

    for text in test_texts:
        phonemes = processor.text_to_phonemes(text)
        indices = processor.text_to_indices(text)
        logger.info(f"Text: '{text}'")
        logger.info(f"  Phonemes ({len(phonemes)}): {phonemes[:20]}...")
        logger.info(f"  Indices ({len(indices)}): {indices[:20]}...")


def main():
    """Main training function"""
    # Print header
    print("\n" + "="*70)
    print("Kokoro English TTS Training")
    print("Using LJSpeech Dataset with Misaki G2P")
    print("="*70 + "\n")

    # Parse arguments
    args = parse_arguments()

    # Check device availability
    if torch.cuda.is_available():
        logger.info(f"CUDA available: {torch.cuda.get_device_name(0)}")
        logger.info(f"CUDA version: {torch.version.cuda}")
    elif torch.backends.mps.is_available():
        logger.info("MPS (Metal Performance Shaders) available - using Apple Silicon GPU")
    else:
        logger.warning("No GPU acceleration available - training will be slow")
        logger.info("Consider using a GPU for faster training")

    # Create configuration
    config = create_config_from_args(args)

    # Validate dataset
    logger.info(f"Validating dataset at: {config.data_dir}")
    if not validate_dataset(config.data_dir):
        logger.error("Dataset validation failed. Please check the dataset structure.")
        logger.info("\nTo download LJSpeech:")
        logger.info("  wget https://data.keithito.com/data/speech/LJSpeech-1.1.tar.bz2")
        logger.info("  tar -xjf LJSpeech-1.1.tar.bz2")
        logger.info("\nOr run: python setup_ljspeech.py")
        sys.exit(1)

    # Create output directory
    os.makedirs(config.output_dir, exist_ok=True)
    logger.info(f"Output directory: {config.output_dir}")

    # Test phoneme processor
    test_phoneme_processor()

    # Initialize trainer
    logger.info("\nInitializing English trainer...")
    try:
        # Use our custom English trainer
        trainer = EnglishTrainer(config)

        logger.info(f"✓ Trainer initialized with {len(trainer.dataset)} samples")

    except Exception as e:
        logger.error(f"Error initializing trainer: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

    # Start training
    logger.info("\n" + "="*70)
    logger.info("Starting training...")
    logger.info("="*70 + "\n")

    try:
        trainer.train()
    except KeyboardInterrupt:
        logger.info("\nTraining interrupted by user")
        logger.info("Saving checkpoint...")
        # The trainer should handle checkpoint saving
    except Exception as e:
        logger.error(f"Error during training: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

    logger.info("\nTraining completed successfully!")
    logger.info(f"Models saved to: {config.output_dir}")


if __name__ == "__main__":
    main()
