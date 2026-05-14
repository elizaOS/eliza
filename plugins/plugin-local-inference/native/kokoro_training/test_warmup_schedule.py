#!/usr/bin/env python3
"""
Test the LR warmup schedule to verify it works correctly.
Simulates the scheduler over epochs and prints/plots the learning rate curve.
"""

import sys
import torch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from training.config_english import EnglishTrainingConfig

# Create config
config = EnglishTrainingConfig()

print("=" * 70)
print("LEARNING RATE WARMUP SCHEDULE TEST")
print("=" * 70)

# Simulate dataset size
num_samples = 13100
batch_size = config.batch_size
num_batches_per_epoch = (num_samples + batch_size - 1) // batch_size

print(f"\nConfiguration:")
print(f"  Dataset samples: {num_samples}")
print(f"  Batch size: {batch_size}")
print(f"  Batches per epoch: {num_batches_per_epoch}")
print(f"  Base learning rate: {config.learning_rate}")
print(f"  Warmup epochs: {config.warmup_epochs}")
print(f"  Cosine T_0: {config.lr_T_0} epochs")
print(f"  Cosine T_mult: {config.lr_T_mult}")
print(f"  Cosine eta_min: {config.lr_eta_min}")

# Create dummy model and optimizer
model = torch.nn.Linear(10, 10)
optimizer = torch.optim.AdamW(model.parameters(), lr=config.learning_rate)

# Setup warmup + cosine scheduler (same as trainer)
warmup_epochs = config.warmup_epochs
warmup_batches = warmup_epochs * num_batches_per_epoch

T_0_epochs = config.lr_T_0
T_0_batches = T_0_epochs * num_batches_per_epoch

# Create warmup scheduler
warmup_scheduler = torch.optim.lr_scheduler.LinearLR(
    optimizer,
    start_factor=1e-10,
    end_factor=1.0,
    total_iters=warmup_batches
)

# Create cosine annealing scheduler
cosine_scheduler = torch.optim.lr_scheduler.CosineAnnealingWarmRestarts(
    optimizer,
    T_0=T_0_batches,
    T_mult=config.lr_T_mult,
    eta_min=config.lr_eta_min
)

# Chain them
scheduler = torch.optim.lr_scheduler.SequentialLR(
    optimizer,
    schedulers=[warmup_scheduler, cosine_scheduler],
    milestones=[warmup_batches]
)

print(f"\nSchedule milestones:")
print(f"  Warmup: batches 0-{warmup_batches} (epochs 0-{warmup_epochs})")
print(f"  Cosine: batches {warmup_batches}+ (epochs {warmup_epochs}+)")

# Simulate training and collect LR values
print(f"\n" + "=" * 70)
print("LEARNING RATE SCHEDULE")
print("=" * 70)

lrs = []
epochs_to_test = min(100, config.num_epochs)  # Test first 100 epochs

for epoch in range(epochs_to_test):
    epoch_lrs = []
    for batch in range(num_batches_per_epoch):
        current_lr = optimizer.param_groups[0]['lr']
        epoch_lrs.append(current_lr)
        lrs.append(current_lr)
        scheduler.step()

    # Print every 5 epochs or first/last of warmup
    if epoch == 0 or epoch == warmup_epochs - 1 or epoch == warmup_epochs or (epoch + 1) % 5 == 0:
        avg_lr = sum(epoch_lrs) / len(epoch_lrs)
        print(f"Epoch {epoch + 1:3d}: LR = {avg_lr:.8f} (min: {min(epoch_lrs):.8f}, max: {max(epoch_lrs):.8f})")

# Key checkpoints
print(f"\n" + "=" * 70)
print("KEY CHECKPOINTS")
print("=" * 70)
print(f"Initial LR (epoch 1, batch 1): {lrs[0]:.10f}")
print(f"End of warmup (epoch {warmup_epochs}): {lrs[warmup_batches - 1]:.10f}")
print(f"After warmup (epoch {warmup_epochs + 1}): {lrs[warmup_batches]:.10f}")

# Expected values
expected_initial = config.learning_rate * 1e-10
expected_warmup_end = config.learning_rate

print(f"\nExpected values:")
print(f"  Initial LR should be ≈ {expected_initial:.10f}")
print(f"  Warmup end should be ≈ {expected_warmup_end:.10f}")

# Verify correctness
assert lrs[0] < 1e-8, f"Initial LR too high: {lrs[0]}"
assert abs(lrs[warmup_batches - 1] - expected_warmup_end) < 1e-6, f"Warmup end LR incorrect: {lrs[warmup_batches - 1]}"

print(f"\n✓ Warmup schedule looks correct!")

# Optional: Create visualization if matplotlib available
try:
    import matplotlib.pyplot as plt
    import numpy as np

    plt.figure(figsize=(12, 6))

    # Convert batch indices to epoch indices
    batch_indices = np.arange(len(lrs))
    epoch_indices = batch_indices / num_batches_per_epoch

    plt.plot(epoch_indices, lrs, linewidth=1.5)
    plt.axvline(x=warmup_epochs, color='r', linestyle='--', label=f'Warmup end (epoch {warmup_epochs})')
    plt.xlabel('Epoch')
    plt.ylabel('Learning Rate')
    plt.title('Learning Rate Schedule: LinearLR Warmup + CosineAnnealingWarmRestarts')
    plt.grid(True, alpha=0.3)
    plt.legend()
    plt.tight_layout()

    output_file = 'lr_schedule_visualization.png'
    plt.savefig(output_file, dpi=150)
    print(f"\n✓ Visualization saved to: {output_file}")

except ImportError:
    print("\nNote: matplotlib not available, skipping visualization")

print("\n" + "=" * 70)
