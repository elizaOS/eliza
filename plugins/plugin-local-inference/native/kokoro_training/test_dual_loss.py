#!/usr/bin/env python3
"""
Test the dual mel loss implementation.
Verifies that model returns both mel_coarse and mel_refined,
and that losses are computed correctly.
"""

import sys
import torch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from kokoro.model import KokoroModel
from training.config_english import EnglishTrainingConfig

print("=" * 70)
print("DUAL MEL LOSS IMPLEMENTATION TEST")
print("=" * 70)

# Create config
config = EnglishTrainingConfig()
print(f"\nDual Mel Loss Configuration:")
print(f"  mel_coarse_loss_weight: {config.mel_coarse_loss_weight}")
print(f"  mel_refined_loss_weight: {config.mel_refined_loss_weight}")

# Create model
print(f"\nInitializing model...")
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
model.train()

# Create dummy batch
batch_size = 4
phoneme_len = 20
mel_len = 100

print(f"\nCreating dummy batch:")
print(f"  Batch size: {batch_size}")
print(f"  Phoneme length: {phoneme_len}")
print(f"  Mel length: {mel_len}")

phoneme_indices = torch.randint(1, 96, (batch_size, phoneme_len)).to(config.device)
phoneme_durations = torch.randint(1, 10, (batch_size, phoneme_len)).to(config.device)
mel_specs = torch.randn(batch_size, mel_len, config.n_mels).to(config.device)
stop_token_targets = torch.zeros(batch_size, mel_len).to(config.device)
stop_token_targets[:, -1] = 1.0  # Mark end

# Test forward pass
print(f"\n" + "=" * 70)
print("TESTING FORWARD PASS")
print("=" * 70)

try:
    with torch.no_grad():
        result = model.forward_training(
            phoneme_indices=phoneme_indices,
            mel_specs=mel_specs,
            phoneme_durations=phoneme_durations,
            stop_token_targets=stop_token_targets,
            use_gt_durations=True
        )

    # Verify we get 4 outputs
    assert len(result) == 4, f"Expected 4 outputs, got {len(result)}"
    mel_coarse, mel_refined, duration_pred, stop_pred = result

    print(f"✓ Model returns 4 outputs (mel_coarse, mel_refined, duration, stop)")
    print(f"\nOutput shapes:")
    print(f"  mel_coarse:  {mel_coarse.shape} (pre-PostNet)")
    print(f"  mel_refined: {mel_refined.shape} (post-PostNet)")
    print(f"  duration:    {duration_pred.shape}")
    print(f"  stop:        {stop_pred.shape}")

    # Verify shapes
    assert mel_coarse.shape == (batch_size, mel_len, config.n_mels), f"Wrong mel_coarse shape: {mel_coarse.shape}"
    assert mel_refined.shape == (batch_size, mel_len, config.n_mels), f"Wrong mel_refined shape: {mel_refined.shape}"
    print(f"\n✓ All output shapes correct")

    # Verify mels are different (PostNet changed something)
    mel_diff = torch.abs(mel_refined - mel_coarse).mean().item()
    print(f"\n✓ mel_refined differs from mel_coarse (mean diff: {mel_diff:.4f})")
    assert mel_diff > 0.001, f"PostNet didn't change anything! Diff: {mel_diff}"

except Exception as e:
    print(f"✗ Forward pass failed: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

# Test loss calculation
print(f"\n" + "=" * 70)
print("TESTING LOSS CALCULATION")
print("=" * 70)

try:
    # Compute L1 losses
    criterion = torch.nn.L1Loss()
    loss_mel_coarse = criterion(mel_coarse, mel_specs)
    loss_mel_refined = criterion(mel_refined, mel_specs)

    print(f"\nComputed losses (unweighted):")
    print(f"  loss_mel_coarse:  {loss_mel_coarse.item():.4f}")
    print(f"  loss_mel_refined: {loss_mel_refined.item():.4f}")

    # Apply weights
    weighted_coarse = loss_mel_coarse * config.mel_coarse_loss_weight
    weighted_refined = loss_mel_refined * config.mel_refined_loss_weight
    total_mel_loss = weighted_coarse + weighted_refined

    print(f"\nWeighted losses:")
    print(f"  weighted_coarse:  {weighted_coarse.item():.4f} (× {config.mel_coarse_loss_weight})")
    print(f"  weighted_refined: {weighted_refined.item():.4f} (× {config.mel_refined_loss_weight})")
    print(f"  total_mel_loss:   {total_mel_loss.item():.4f}")

    print(f"\n✓ Dual loss calculation successful")

except Exception as e:
    print(f"✗ Loss calculation failed: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

# Test backward pass (check gradients)
print(f"\n" + "=" * 70)
print("TESTING BACKWARD PASS")
print("=" * 70)

try:
    # Enable gradients
    model.zero_grad()

    # Forward pass
    mel_coarse, mel_refined, duration_pred, stop_pred = model.forward_training(
        phoneme_indices=phoneme_indices,
        mel_specs=mel_specs,
        phoneme_durations=phoneme_durations,
        stop_token_targets=stop_token_targets,
        use_gt_durations=True
    )

    # Compute dual loss
    loss_mel_coarse = criterion(mel_coarse, mel_specs)
    loss_mel_refined = criterion(mel_refined, mel_specs)
    total_loss = (config.mel_coarse_loss_weight * loss_mel_coarse +
                  config.mel_refined_loss_weight * loss_mel_refined)

    # Backward
    total_loss.backward()

    # Check gradients exist
    has_decoder_grad = False
    has_postnet_grad = False

    for name, param in model.named_parameters():
        if param.grad is not None:
            grad_norm = param.grad.norm().item()
            if 'decoder' in name.lower():
                has_decoder_grad = True
            if 'postnet' in name.lower():
                has_postnet_grad = True

    assert has_decoder_grad, "Decoder has no gradients!"
    assert has_postnet_grad, "PostNet has no gradients!"

    print(f"✓ Decoder receives gradients (from mel_coarse)")
    print(f"✓ PostNet receives gradients (from mel_refined)")
    print(f"✓ Dual loss backward pass successful")

except Exception as e:
    print(f"✗ Backward pass failed: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

print(f"\n" + "=" * 70)
print("ALL TESTS PASSED!")
print("=" * 70)
print(f"\nDual mel loss implementation is working correctly:")
print(f"  ✓ Model returns mel_coarse and mel_refined")
print(f"  ✓ Both mels have correct shapes")
print(f"  ✓ PostNet modifies the output")
print(f"  ✓ Losses are computed with correct weights")
print(f"  ✓ Gradients flow to both decoder and PostNet")
print(f"\nReady for training with faster convergence!")
print("=" * 70)
