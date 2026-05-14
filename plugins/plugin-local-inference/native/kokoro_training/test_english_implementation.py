#!/usr/bin/env python3
"""
Test script for English TTS implementation
Validates that all components work before training
"""

import sys
import os
import logging
from pathlib import Path

# Set environment variable to suppress config printing during tests
os.environ['TESTING'] = '1'

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Suppress verbose logging from other modules during testing
logging.getLogger('training.config_english').setLevel(logging.WARNING)
logging.getLogger('training.checkpoint_manager').setLevel(logging.WARNING)
logging.getLogger('data.english_phoneme_processor').setLevel(logging.WARNING)


def test_imports():
    """Test that all required modules can be imported"""
    logger.info("Testing imports...")

    errors = []

    # Core dependencies
    try:
        import torch
        logger.info(f"✓ PyTorch {torch.__version__}")
    except ImportError as e:
        errors.append(f"✗ PyTorch: {e}")

    try:
        import torchaudio
        logger.info(f"✓ torchaudio {torchaudio.__version__}")
    except ImportError as e:
        errors.append(f"✗ torchaudio: {e}")

    try:
        import numpy
        logger.info(f"✓ numpy {numpy.__version__}")
    except ImportError as e:
        errors.append(f"✗ numpy: {e}")

    try:
        import tqdm
        logger.info(f"✓ tqdm {tqdm.__version__}")
    except ImportError as e:
        errors.append(f"✗ tqdm: {e}")

    # Optional but recommended
    try:
        from misaki import text_to_ipa
        logger.info("✓ Misaki (G2P)")
    except ImportError as e:
        logger.warning(f"⚠ Misaki not found: {e}")
        logger.warning("  Install with: pip install 'misaki[en]'")
        logger.warning("  Fallback mode will be used (lower quality)")

    try:
        import textgrid
        logger.info("✓ textgrid (MFA parsing)")
    except ImportError as e:
        logger.warning(f"⚠ textgrid not found: {e}")
        logger.warning("  Install with: pip install textgrid")
        logger.warning("  MFA alignments won't be loadable")

    # Custom modules
    try:
        from data.english_phoneme_processor import EnglishPhonemeProcessor
        logger.info("✓ EnglishPhonemeProcessor")
    except ImportError as e:
        errors.append(f"✗ EnglishPhonemeProcessor: {e}")

    try:
        from data.ljspeech_dataset import LJSpeechDataset
        logger.info("✓ LJSpeechDataset")
    except ImportError as e:
        errors.append(f"✗ LJSpeechDataset: {e}")

    try:
        from training.config_english import EnglishTrainingConfig
        logger.info("✓ EnglishTrainingConfig")
    except ImportError as e:
        errors.append(f"✗ EnglishTrainingConfig: {e}")

    if errors:
        logger.error("\nImport errors found:")
        for error in errors:
            logger.error(f"  {error}")
        return False

    logger.info("\n✓ All imports successful!")
    return True


def test_phoneme_processor():
    """Test the English phoneme processor"""
    logger.info("\nTesting English Phoneme Processor...")

    try:
        from data.english_phoneme_processor import EnglishPhonemeProcessor

        processor = EnglishPhonemeProcessor('en-us')
        logger.info(f"✓ Processor initialized (vocab size: {processor.get_vocab_size()})")

        # Test texts - just verify they work, don't print details
        test_cases = [
            "Hello, world!",
            "The quick brown fox jumps over the lazy dog.",
            "Text to speech synthesis is amazing!",
        ]

        for text in test_cases:
            phonemes = processor.text_to_phonemes(text)
            indices = processor.text_to_indices(text)

            if len(phonemes) == 0:
                logger.warning(f"⚠ Empty phonemes for: '{text}'")
                continue

            if len(indices) != len(phonemes):
                logger.error(f"✗ Length mismatch: {len(indices)} indices vs {len(phonemes)} phonemes")
                return False

        logger.info(f"✓ Text-to-phoneme conversion works ({len(test_cases)} test cases)")

        # Test serialization
        data = processor.to_dict()
        processor2 = EnglishPhonemeProcessor.from_dict(data)

        test_text = "Test serialization"
        if processor.text_to_indices(test_text) == processor2.text_to_indices(test_text):
            logger.info("✓ Serialization works correctly")
        else:
            logger.error("✗ Serialization failed")
            return False

        logger.info("✓ Phoneme processor tests passed!")
        return True

    except Exception as e:
        logger.error(f"✗ Phoneme processor test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def test_config():
    """Test configuration"""
    logger.info("\nTesting Configuration...")

    try:
        from training.config_english import EnglishTrainingConfig, get_small_config

        config = EnglishTrainingConfig()
        logger.info(f"✓ Default config created (device: {config.device})")

        small_config = get_small_config()
        logger.info(f"✓ Small config created")

        # Test serialization
        config_dict = config.to_dict()
        config2 = EnglishTrainingConfig.from_dict(config_dict)
        logger.info("✓ Config serialization works")

        logger.info("✓ Configuration tests passed!")
        return True

    except Exception as e:
        logger.error(f"✗ Configuration test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def test_dataset():
    """Test dataset (without actual data)"""
    logger.info("\nTesting Dataset (structure only)...")

    try:
        from data.ljspeech_dataset import LJSpeechDataset, collate_fn
        from training.config_english import EnglishTrainingConfig
        import torch

        # We can't test with real data unless it's available
        # Just check that the class can be instantiated
        logger.info("✓ Dataset class imports successfully")

        # Test collate function with dummy data
        dummy_batch = [
            {
                'phoneme_indices': torch.tensor([1, 2, 3, 4], dtype=torch.long),
                'mel_spec': torch.randn(10, 80),
                'phoneme_durations': torch.tensor([2, 3, 2, 3], dtype=torch.long),
                'stop_token_targets': torch.zeros(10),
                'audio_file': 'test1',
                'text': 'Test one'
            },
            {
                'phoneme_indices': torch.tensor([5, 6], dtype=torch.long),
                'mel_spec': torch.randn(8, 80),
                'phoneme_durations': torch.tensor([4, 4], dtype=torch.long),
                'stop_token_targets': torch.zeros(8),
                'audio_file': 'test2',
                'text': 'Test two'
            }
        ]

        batched = collate_fn(dummy_batch)

        logger.info("✓ Collate function works")
        logger.info(f"  Batch phoneme shape: {batched['phoneme_indices'].shape}")
        logger.info(f"  Batch mel shape: {batched['mel_specs'].shape}")
        logger.info(f"  Batch durations shape: {batched['phoneme_durations'].shape}")

        # Validate batch
        batch_size = len(dummy_batch)
        if batched['phoneme_indices'].shape[0] != batch_size:
            logger.error("✗ Batch size mismatch")
            return False

        logger.info("\n✓ Dataset tests passed!")
        return True

    except Exception as e:
        logger.error(f"✗ Dataset test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def test_model_compatibility():
    """Test that model can work with English phoneme processor"""
    logger.info("\nTesting Model Compatibility...")

    try:
        from kokoro.model import KokoroModel
        from data.english_phoneme_processor import EnglishPhonemeProcessor
        import torch

        processor = EnglishPhonemeProcessor('en-us')
        vocab_size = processor.get_vocab_size()

        # Create small model for testing
        model = KokoroModel(
            vocab_size=vocab_size,
            mel_dim=80,
            hidden_dim=256,
            n_encoder_layers=2,
            n_decoder_layers=2,
            n_heads=4,
            encoder_ff_dim=512,
            enable_profiling=False,
            gradient_checkpointing=False
        )

        model_info = model.get_model_info()
        logger.info(f"✓ Model created ({model_info['total_parameters']:,} params, {model_info['model_size_mb']:.1f} MB)")

        # Test forward pass with dummy data
        batch_size = 2
        text_len = 10
        mel_len = 20

        phoneme_indices = torch.randint(0, vocab_size, (batch_size, text_len))
        mel_specs = torch.randn(batch_size, mel_len, 80)
        phoneme_durations = torch.randint(1, 5, (batch_size, text_len)).float()
        stop_token_targets = torch.zeros(batch_size, mel_len)

        model.eval()
        with torch.no_grad():
            predicted_mel, predicted_durations, predicted_stop = model(
                phoneme_indices,
                mel_specs,
                phoneme_durations,
                stop_token_targets
            )

        logger.info(f"✓ Forward pass successful")
        logger.info("✓ Model compatibility tests passed!")
        return True

    except Exception as e:
        logger.error(f"✗ Model compatibility test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def test_training_loop():
    """Test training loop with single forward and backward pass using actual trainer"""
    logger.info("\nTesting Training Loop (single iteration)...")

    try:
        import torch
        from training.config_english import EnglishTrainingConfig
        from data.english_phoneme_processor import EnglishPhonemeProcessor
        from data.ljspeech_dataset import collate_fn
        from kokoro.model import KokoroModel

        # Create minimal config for testing
        config = EnglishTrainingConfig()
        config.batch_size = 2
        config.hidden_dim = 128
        config.n_encoder_layers = 2
        config.n_decoder_layers = 2
        config.encoder_ff_dim = 256
        config.decoder_ff_dim = 256
        config.gradient_checkpointing = False

        # Create processor and model
        processor = EnglishPhonemeProcessor('en-us')
        vocab_size = processor.get_vocab_size()

        model = KokoroModel(
            vocab_size=vocab_size,
            mel_dim=config.n_mels,
            hidden_dim=config.hidden_dim,
            n_encoder_layers=config.n_encoder_layers,
            n_decoder_layers=config.n_decoder_layers,
            n_heads=config.n_heads,
            encoder_ff_dim=config.encoder_ff_dim,
            decoder_ff_dim=config.decoder_ff_dim,
            enable_profiling=False,
            gradient_checkpointing=config.gradient_checkpointing
        )
        model.to(config.device)
        model.train()

        logger.info(f"✓ Created test model (vocab size: {vocab_size})")

        # Create optimizer
        optimizer = torch.optim.AdamW(model.parameters(), lr=config.learning_rate)

        # Create loss criterions (same as trainer)
        criterion_mel = torch.nn.MSELoss(reduction='none')
        criterion_duration = torch.nn.MSELoss(reduction='none')
        criterion_stop_token = torch.nn.BCEWithLogitsLoss(reduction='none')

        # Create dummy batch
        dummy_batch = [
            {
                'phoneme_indices': torch.randint(0, vocab_size, (10,), dtype=torch.long),
                'mel_spec': torch.randn(20, config.n_mels),
                'phoneme_durations': torch.randint(1, 5, (10,), dtype=torch.long),
                'stop_token_targets': torch.zeros(20),
                'audio_file': 'test1',
                'text': 'Test one'
            },
            {
                'phoneme_indices': torch.randint(0, vocab_size, (8,), dtype=torch.long),
                'mel_spec': torch.randn(15, config.n_mels),
                'phoneme_durations': torch.randint(1, 5, (8,), dtype=torch.long),
                'stop_token_targets': torch.zeros(15),
                'audio_file': 'test2',
                'text': 'Test two'
            }
        ]

        batch = collate_fn(dummy_batch)

        # Move batch to device
        phoneme_indices = batch['phoneme_indices'].to(config.device)
        mel_specs = batch['mel_specs'].to(config.device)
        phoneme_durations = batch['phoneme_durations'].to(config.device)
        stop_token_targets = batch['stop_token_targets'].to(config.device)
        phoneme_lengths = batch['phoneme_lengths'].to(config.device)
        mel_lengths = batch['mel_lengths'].to(config.device)

        # Forward pass
        optimizer.zero_grad()

        predicted_mel, predicted_log_durations, predicted_stop_logits = model(
            phoneme_indices,
            mel_specs,
            phoneme_durations.float(),
            stop_token_targets
        )

        logger.info(f"✓ Forward pass successful")

        # Calculate losses using the same logic as trainer._calculate_losses()
        # Mel Spectrogram Loss with masking
        max_mel_len_batch = mel_specs.size(1)
        mel_mask = torch.arange(max_mel_len_batch, device=config.device).expand(
            len(mel_lengths), max_mel_len_batch) < mel_lengths.unsqueeze(1)
        mel_mask = mel_mask.unsqueeze(-1).expand_as(predicted_mel).float()

        loss_mel_unreduced = criterion_mel(predicted_mel, mel_specs)
        loss_mel = (loss_mel_unreduced * mel_mask).sum() / mel_mask.sum()

        # Duration Loss with masking
        max_phoneme_len_batch = phoneme_durations.size(1)
        phoneme_mask = torch.arange(max_phoneme_len_batch, device=config.device).expand(
            len(phoneme_lengths), max_phoneme_len_batch) < phoneme_lengths.unsqueeze(1)
        phoneme_mask = phoneme_mask.float()

        target_log_durations = torch.log(phoneme_durations.float() + 1e-5)
        loss_duration_unreduced = criterion_duration(predicted_log_durations, target_log_durations)
        loss_duration = (loss_duration_unreduced * phoneme_mask).sum() / phoneme_mask.sum()

        # Stop Token Loss with masking
        stop_token_mask = mel_mask[:, :, 0]
        loss_stop_token_unreduced = criterion_stop_token(predicted_stop_logits, stop_token_targets)
        loss_stop_token = (loss_stop_token_unreduced * stop_token_mask).sum() / stop_token_mask.sum()

        # Total loss (same as trainer)
        total_loss = (loss_mel +
                     loss_duration * config.duration_loss_weight +
                     loss_stop_token * config.stop_token_loss_weight)

        logger.info(f"✓ Loss calculation (total: {total_loss.item():.4f})")

        # Backward pass
        total_loss.backward()
        logger.info(f"✓ Backward pass successful")

        # Check gradients
        has_gradients = False
        gradient_norms = []
        for name, param in model.named_parameters():
            if param.grad is not None:
                has_gradients = True
                grad_norm = param.grad.norm().item()
                gradient_norms.append(grad_norm)

        if not has_gradients:
            logger.error("✗ No gradients computed!")
            return False

        avg_grad_norm = sum(gradient_norms) / len(gradient_norms)
        logger.info(f"✓ Gradients computed ({len(gradient_norms)} params, avg norm: {avg_grad_norm:.4f})")

        # Optimizer step
        optimizer.step()
        logger.info(f"✓ Optimizer step successful")

        logger.info("✓ Training loop test passed!")
        return True

    except Exception as e:
        logger.error(f"✗ Training loop test failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def check_dataset_availability():
    """Check if LJSpeech dataset is available"""
    logger.info("\nChecking for LJSpeech dataset...")

    dataset_paths = [
        "LJSpeech-1.1",
        "./LJSpeech-1.1",
        "../LJSpeech-1.1",
    ]

    for path in dataset_paths:
        dataset_path = Path(path)
        if dataset_path.exists():
            metadata = dataset_path / "metadata.csv"
            wavs = dataset_path / "wavs"
            textgrid = dataset_path / "TextGrid"

            if metadata.exists() and wavs.exists():
                logger.info(f"✓ Found LJSpeech at: {dataset_path}")

                with open(metadata, 'r') as f:
                    num_samples = sum(1 for _ in f)
                logger.info(f"  Samples: {num_samples}")

                if textgrid.exists():
                    num_alignments = len(list(textgrid.glob("*.TextGrid")))
                    logger.info(f"  ✓ MFA alignments: {num_alignments} files")
                else:
                    logger.warning(f"  ⚠ No MFA alignments found")
                    logger.info("    Run: python setup_ljspeech.py --align-only")

                return True

    logger.warning("✗ LJSpeech dataset not found")
    logger.info("  Download with: python setup_ljspeech.py")
    return False


def main():
    """Run all tests"""
    print("\n" + "="*70)
    print("English TTS Implementation Test Suite")
    print("="*70 + "\n")

    results = {}

    # Run tests
    results['imports'] = test_imports()
    results['phoneme_processor'] = test_phoneme_processor()
    results['config'] = test_config()
    results['dataset'] = test_dataset()
    results['model'] = test_model_compatibility()
    results['training_loop'] = test_training_loop()

    # Check dataset (informational only)
    dataset_available = check_dataset_availability()

    # Summary
    print("\n" + "="*70)
    print("Test Results Summary")
    print("="*70 + "\n")

    all_passed = True
    for test_name, passed in results.items():
        status = "✓ PASS" if passed else "✗ FAIL"
        print(f"{status:10} {test_name}")
        if not passed:
            all_passed = False

    print(f"\nDataset: {'✓ Available' if dataset_available else '⚠ Not found'}")

    print("\n" + "="*70)

    if all_passed:
        print("\n✓ All tests passed!")

        if dataset_available:
            print("\n🎉 Ready to start training!")
            print("\nRun:")
            print("  python training_english.py --test-mode")
        else:
            print("\n📥 Download dataset first:")
            print("  python setup_ljspeech.py")

    else:
        print("\n✗ Some tests failed!")
        print("\nPlease fix the errors above before training.")
        sys.exit(1)

    print()


if __name__ == "__main__":
    main()
