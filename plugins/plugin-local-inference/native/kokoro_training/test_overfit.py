#!/usr/bin/env python3
"""
Overfit Test - Train on a single sample to verify model can learn
This is a critical sanity check for debugging TTS training issues.

If the model can't overfit a single sample after 3000 iterations,
there's a fundamental bug in the architecture or training loop.
"""

import torch
import torch.nn as nn
import torch.optim as optim
import logging
import sys
from pathlib import Path
from tqdm import tqdm
import json

from data.ljspeech_dataset import LJSpeechDataset
from data.english_phoneme_processor import EnglishPhonemeProcessor
from kokoro.model import KokoroModel
from training.config_english import EnglishTrainingConfig

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class SingleSampleDataset:
    """Wrapper to return the same sample repeatedly"""
    def __init__(self, sample):
        self.sample = sample

    def __len__(self):
        return 1

    def __getitem__(self, idx):
        return self.sample


def test_overfit():
    """
    Overfit test: Train on a single sample for 3000 iterations
    """

    logger.info("="*70)
    logger.info("OVERFIT TEST - Single Sample Training")
    logger.info("="*70)
    logger.info("Goal: Achieve near-zero loss on one sample")
    logger.info("If this fails, there's a fundamental bug in the model/training")
    logger.info("="*70 + "\n")

    # Configuration
    device = torch.device('cuda' if torch.cuda.is_available() else
                         'mps' if torch.backends.mps.is_available() else 'cpu')
    logger.info(f"Device: {device}")

    # Load dataset and get ONE sample
    logger.info("\nLoading dataset...")

    # Create a minimal config for the dataset
    from dataclasses import dataclass

    @dataclass
    class MinimalConfig:
        sample_rate: int = 22050
        n_mels: int = 80
        hop_length: int = 256
        win_length: int = 1024
        n_fft: int = 1024
        f_min: float = 0.0
        f_max: float = 8000.0
        max_seq_length: int = 2500  # Maximum mel frame sequence length

    config = MinimalConfig()
    dataset = LJSpeechDataset(data_dir="LJSpeech-1.1", config=config)

    # Get phoneme processor from dataset
    phoneme_processor = dataset.phoneme_processor

    # Get a good sample (not too long, not too short)
    logger.info(f"Total samples in dataset: {len(dataset)}")

    # Find a sample with reasonable length
    sample_idx = None
    for i in range(100):
        sample = dataset[i]
        mel_frames = sample['mel_spec'].shape[1]
        phoneme_count = len(sample['phoneme_indices'])

        if 50 < mel_frames < 300 and 10 < phoneme_count < 50:
            sample_idx = i
            break

    if sample_idx is None:
        sample_idx = 0
        logger.warning("Could not find ideal sample, using first sample")

    sample = dataset[sample_idx]

    # Print sample info
    logger.info(f"\nSelected sample index: {sample_idx}")
    logger.info(f"Text: {sample['text']}")

    # Convert tensor indices to list if needed
    phoneme_indices_list = sample['phoneme_indices'].tolist() if isinstance(sample['phoneme_indices'], torch.Tensor) else sample['phoneme_indices']

    logger.info(f"Phoneme count: {len(phoneme_indices_list)}")
    logger.info(f"Phonemes: {' '.join([phoneme_processor.id_to_phoneme[i] for i in phoneme_indices_list])}")
    logger.info(f"Mel shape: {sample['mel_spec'].shape}")
    logger.info(f"Mel frames: {sample['mel_spec'].shape[0]}")  # First dim is frames

    # Convert durations to list for logging
    durations_list = sample['phoneme_durations'].tolist() if isinstance(sample['phoneme_durations'], torch.Tensor) else sample['phoneme_durations']
    logger.info(f"Durations (original): {durations_list}")
    logger.info(f"Duration sum: {sum(durations_list)}")
    logger.info(f"Mel frames: {sample['mel_spec'].shape[0]}")

    # Check for mismatch and FIX IT for overfit test
    if sum(durations_list) != sample['mel_spec'].shape[0]:
        mismatch = sample['mel_spec'].shape[0] - sum(durations_list)
        logger.warning(f"⚠️ MISMATCH: Duration sum ({sum(durations_list)}) != Mel frames ({sample['mel_spec'].shape[0]})")
        logger.warning(f"   Difference: {mismatch} frames")

        # CRITICAL FIX: Scale durations to match mel frames exactly
        # This is essential for overfitting - we need exact alignment
        scale_factor = sample['mel_spec'].shape[0] / sum(durations_list)
        durations_scaled = [max(1, int(d * scale_factor)) for d in durations_list]

        # Adjust last duration to make it exact
        diff = sample['mel_spec'].shape[0] - sum(durations_scaled)
        durations_scaled[-1] += diff

        logger.info(f"✓ SCALED durations by {scale_factor:.4f} to match mel frames exactly")
        logger.info(f"   New duration sum: {sum(durations_scaled)}")

        # Replace sample durations
        sample['phoneme_durations'] = torch.tensor(durations_scaled)
        durations_list = durations_scaled

    # Initialize model
    logger.info("\nInitializing model...")
    vocab_size = phoneme_processor.get_vocab_size()

    model = KokoroModel(
        vocab_size=vocab_size,
        mel_dim=80,
        hidden_dim=512,
        n_encoder_layers=6,
        n_heads=8,
        encoder_ff_dim=2048,
        encoder_dropout=0.1,
        n_decoder_layers=6,
        decoder_ff_dim=2048,
        max_decoder_seq_len=4000,
        enable_profiling=False
    ).to(device)

    # DISABLE gradient checkpointing for debugging
    model.gradient_checkpointing = False
    logger.info("Disabled gradient checkpointing for overfit test")

    # DISABLE all dropout for easier overfitting
    def disable_dropout(module):
        if isinstance(module, torch.nn.Dropout):
            module.p = 0.0
    model.apply(disable_dropout)
    logger.info("Disabled all dropout layers for overfit test")

    logger.info(f"Model parameters: {sum(p.numel() for p in model.parameters()):,}")

    # NO custom initialization - use model defaults!
    logger.info("Using default model initialization (no custom duration predictor init)")

    # Duration predictor: Keep it trainable for inference to work
    # We'll use very low loss weight to prevent it from dominating
    logger.info("\nDuration predictor: TRAINABLE (needed for inference)")
    logger.info("Using low duration loss weight to prevent gradient domination")

    # Optimizer - Use conservative learning rate for stability
    # High LR (3e-3) causes gradient explosion (294!) and divergence
    lr_overfit = 5e-4  # Conservative LR to prevent exploding gradients
    logger.info(f"Using LR={lr_overfit:.6e} (conservative - prevents gradient explosion)")
    optimizer = optim.AdamW(model.parameters(), lr=lr_overfit, weight_decay=0.0, betas=(0.9, 0.999))  # NO weight decay!

    # Mixed precision setup (match real training!)
    use_mixed_precision = device.type == 'cuda'
    if use_mixed_precision:
        if torch.cuda.is_bf16_supported():
            autocast_dtype = torch.bfloat16
            scaler = None
            logger.info("✓ Using bfloat16 (no scaler needed)")
        else:
            autocast_dtype = torch.float16
            scaler = torch.cuda.amp.GradScaler()
            logger.info("✓ Using float16 with GradScaler")
    else:
        autocast_dtype = torch.float32
        scaler = None
        logger.info("✓ Using float32 (no mixed precision)")

    # Prepare batch - CRITICAL: Use batch_size > 1 for BatchNorm to work!
    # Duplicate the sample 4 times to create a proper batch
    batch_size = 4

    # Handle both tensor and list phoneme indices
    if isinstance(sample['phoneme_indices'], torch.Tensor):
        phoneme_indices = sample['phoneme_indices'].unsqueeze(0).repeat(batch_size, 1).to(device)
    else:
        phoneme_indices = torch.tensor(sample['phoneme_indices']).unsqueeze(0).repeat(batch_size, 1).to(device)

    mel_spec = sample['mel_spec'].unsqueeze(0).repeat(batch_size, 1, 1).to(device)  # (batch_size, frames, mel_dim)

    # Handle durations
    if isinstance(sample['phoneme_durations'], torch.Tensor):
        durations = sample['phoneme_durations'].unsqueeze(0).repeat(batch_size, 1).to(device)
    else:
        durations = torch.tensor(sample['phoneme_durations']).unsqueeze(0).repeat(batch_size, 1).to(device)

    # Mel spec from dataset is (frames, mel_dim), after unsqueeze+repeat: (batch_size, frames, mel_dim)
    num_frames = mel_spec.shape[1]  # Shape is (batch_size, frames, mel_dim)

    # Generate stop tokens (0 for all frames except last)
    stop_tokens = torch.zeros(batch_size, num_frames).to(device)
    stop_tokens[:, -1] = 1.0  # Last frame should be 1

    logger.info(f"\nBatch shapes:")
    logger.info(f"  Phoneme indices: {phoneme_indices.shape}")
    logger.info(f"  Mel spec: {mel_spec.shape} (batch, frames, mel_dim)")
    logger.info(f"  Durations: {durations.shape}")
    logger.info(f"  Stop tokens: {stop_tokens.shape}")

    # Loss weights for overfit test (DUAL MEL LOSS - Tacotron 2 architecture)
    # Balance mel and duration to train both (needed for inference)
    mel_coarse_loss_weight = 0.5  # Pre-PostNet (decoder supervision)
    mel_refined_loss_weight = 1.0  # Post-PostNet (final quality)
    duration_loss_weight = 0.01  # Very small - just enough to train duration predictor
    stop_token_loss_weight = 0.1  # Small weight

    # Scheduled sampling: gradually increase probability of using predictions vs ground truth
    scheduled_sampling_prob = 0.0  # Start with full teacher forcing

    logger.info(f"Loss weights: mel_coarse={mel_coarse_loss_weight}, mel_refined={mel_refined_loss_weight}, duration={duration_loss_weight}, stop={stop_token_loss_weight}")
    logger.info(f"Scheduled sampling probability: {scheduled_sampling_prob:.2f}")
    logger.info("Using DUAL MEL LOSS (Tacotron 2): supervising both decoder (coarse) and PostNet (refined)")
    logger.info("Using teacher-forced mel (ground truth as decoder input) + training duration predictor")

    # Training loop - extended for better convergence
    num_iterations = 2000  # Increased from 3000 to get lower mel loss
    logger.info("\n" + "="*70)
    logger.info(f"Starting overfit training ({num_iterations} iterations)")
    logger.info("="*70 + "\n")

    model.train()

    # Verify model is trainable
    trainable_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total_params = sum(p.numel() for p in model.parameters())
    logger.info(f"Trainable parameters: {trainable_params:,} / {total_params:,}")
    if trainable_params == 0:
        logger.error("❌ NO TRAINABLE PARAMETERS!")
        return False

    losses = []
    mel_coarse_losses = []
    mel_refined_losses = []
    dur_losses = []
    stop_losses = []

    progress_bar = tqdm(range(num_iterations), desc="Overfitting")

    for iteration in progress_bar:
        optimizer.zero_grad(set_to_none=True)

        # Update scheduled sampling probability based on iteration
        if iteration < 500:
            scheduled_sampling_prob = 0.0  # Pure teacher forcing
        elif iteration < 1000:
            scheduled_sampling_prob = 0.1  # Gentle exposure
        elif iteration < 2000:
            scheduled_sampling_prob = 0.3  # Building robustness
        else:
            scheduled_sampling_prob = 0.5  # Full exposure

        # Scheduled sampling: mix ground truth, predictions, and zeros for decoder input
        # This helps the model learn to generate from scratch (like inference)
        sample_mode = torch.rand(1).item()

        if sample_mode < scheduled_sampling_prob * 0.3:  # 30% of sampling = zeros
            # Train with ZERO decoder input (hardest - like inference start)
            decoder_input_mels = torch.zeros_like(mel_spec)
        elif sample_mode < scheduled_sampling_prob:  # Remaining sampling = predictions
            # Use scheduled sampling: decoder sees its own predictions
            with torch.no_grad():
                # Get predictions without gradients for sampling
                # Model now returns 4 values: mel_coarse, mel_refined, duration, stop
                _, mel_refined_sample, _, _ = model.forward_training(
                    phoneme_indices=phoneme_indices,
                    mel_specs=mel_spec,
                    phoneme_durations=durations,
                    stop_token_targets=stop_tokens,
                    text_padding_mask=None,
                    mel_padding_mask=None,
                    use_gt_durations=False
                )
            # Use refined mel predictions as decoder input (detached to avoid double gradients)
            decoder_input_mels = mel_refined_sample.detach()
        else:
            # Use ground truth mels as decoder input (teacher forcing)
            decoder_input_mels = mel_spec

        # Forward pass with mixed precision (match real training!)
        # Model now returns BOTH mel_coarse and mel_refined for dual-loss training
        # Use ground truth durations for length regulation (teacher forcing for decoder)
        # But allow duration predictor to train so inference works
        if use_mixed_precision:
            with torch.amp.autocast("cuda", dtype=autocast_dtype):
                mel_coarse, mel_refined, dur_pred, stop_pred = model.forward_training(
                    phoneme_indices=phoneme_indices,
                    mel_specs=decoder_input_mels,  # Use scheduled sampling mels
                    phoneme_durations=durations,
                    stop_token_targets=stop_tokens,
                    text_padding_mask=None,
                    mel_padding_mask=None,
                    use_gt_durations=False  # Train duration predictor for inference
                )
        else:
            mel_coarse, mel_refined, dur_pred, stop_pred = model.forward_training(
                phoneme_indices=phoneme_indices,
                mel_specs=decoder_input_mels,  # Use scheduled sampling mels
                phoneme_durations=durations,
                stop_token_targets=stop_tokens,
                text_padding_mask=None,
                mel_padding_mask=None,
                use_gt_durations=False  # Train duration predictor for inference
            )

        # Compute DUAL MEL LOSSES (Tacotron 2 architecture)
        mel_coarse_loss = nn.L1Loss(reduction='mean')(mel_coarse, mel_spec)  # Pre-PostNet
        mel_refined_loss = nn.L1Loss(reduction='mean')(mel_refined, mel_spec)  # Post-PostNet

        # Duration loss (log space) - very small weight to train duration predictor
        dur_target_log = torch.log(durations.float().clamp(min=1e-5))
        dur_loss = nn.MSELoss(reduction='mean')(dur_pred, dur_target_log)

        # Stop token loss
        stop_loss = nn.BCEWithLogitsLoss()(stop_pred.squeeze(-1), stop_tokens)

        # Weighted loss with DUAL MEL LOSS
        total_loss = (mel_coarse_loss_weight * mel_coarse_loss +
                      mel_refined_loss_weight * mel_refined_loss +
                      duration_loss_weight * dur_loss +
                      stop_token_loss_weight * stop_loss)

        # Backward pass - simplified since duration predictor is frozen
        if use_mixed_precision and autocast_dtype == torch.bfloat16:
            # BF16 path (no scaler)
            total_loss.backward()
            # Aggressive gradient clipping - gradients were reaching 294!
            grad_norm_before_clip = torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimizer.step()
        elif use_mixed_precision and scaler is not None:
            # FP16 path with scaler
            scaler.scale(total_loss).backward()
            scaler.unscale_(optimizer)
            grad_norm_before_clip = torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            scaler.step(optimizer)
            scaler.update()
        else:
            # FP32 path
            total_loss.backward()
            grad_norm_before_clip = torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimizer.step()

        # DEBUG: Log gradient norm at key iterations
        if iteration in [10, 50, 100]:
            logger.info(f"\n🔍 Iteration {iteration} gradient check:")
            logger.info(f"  Total gradient norm (before clip): {grad_norm_before_clip:.6f}")
            logger.info(f"  Total loss: {total_loss.item():.6f}")
            if grad_norm_before_clip < 1e-6:
                logger.error(f"  ❌ VANISHING GRADIENTS! Norm = {grad_norm_before_clip:.10f}")

            # Verify duration predictor is training
            if iteration == 10:
                dur_has_grad = any(p.grad is not None for p in model.duration_predictor.parameters())
                if dur_has_grad:
                    logger.info(f"  ✓ Duration predictor has gradients (training correctly)")
                else:
                    logger.error(f"  ❌ WARNING: Duration predictor has NO gradients!")

        # Check for divergence and stop early
        if torch.isnan(total_loss) or total_loss.item() > 1e6:
            logger.error(f"❌ DIVERGENCE at iteration {iteration}!")
            logger.error(f"  Total loss: {total_loss.item()}")
            logger.error(f"  Duration loss: {dur_loss.item()}")
            logger.error(f"  Duration pred range: [{dur_pred.min().item()}, {dur_pred.max().item()}]")
            break

        # Log
        losses.append(total_loss.item())
        mel_coarse_losses.append(mel_coarse_loss.item())
        mel_refined_losses.append(mel_refined_loss.item())
        dur_losses.append(dur_loss.item())
        stop_losses.append(stop_loss.item())

        # Log first iteration to see initial state
        if iteration == 0:
            logger.info(f"\nIteration 0 (initial):")
            logger.info(f"  Total Loss: {total_loss.item():.6f}")
            logger.info(f"  Mel Coarse Loss (pre-PostNet): {mel_coarse_loss.item():.6f}")
            logger.info(f"  Mel Refined Loss (post-PostNet): {mel_refined_loss.item():.6f}")
            logger.info(f"  Duration Loss: {dur_loss.item():.6f}")
            logger.info(f"  Stop Loss: {stop_loss.item():.6f}")
            logger.info(f"  Mel coarse mean: {mel_coarse.mean().item():.6f}")
            logger.info(f"  Mel refined mean: {mel_refined.mean().item():.6f}")
            logger.info(f"  Mel target mean: {mel_spec.mean().item():.6f}")

            # Store initial state for debugging
            initial_mel_proj_weight = model.mel_projection_coarse.weight.data.clone()
            initial_postnet_weight = model.postnet.convolutions[0][0].weight.data.clone()
            initial_decoder_weight = model.decoder.layers[0].self_attn.w_q.weight.data.clone()

        # Check parameter updates at iteration 50
        if iteration == 50:
            mel_proj_change = (model.mel_projection_coarse.weight.data - initial_mel_proj_weight).abs().mean().item()
            postnet_change = (model.postnet.convolutions[0][0].weight.data - initial_postnet_weight).abs().mean().item()
            decoder_change = (model.decoder.layers[0].self_attn.w_q.weight.data - initial_decoder_weight).abs().mean().item()

            logger.info(f"\n🔍 PARAMETER UPDATE CHECK (iteration 0→50):")
            logger.info(f"  Mel projection avg weight change: {mel_proj_change:.8f}")
            logger.info(f"  PostNet avg weight change: {postnet_change:.8f}")
            logger.info(f"  Decoder avg weight change: {decoder_change:.8f}")
            logger.info(f"  Learning rate: {optimizer.param_groups[0]['lr']:.6e}")

            if mel_proj_change < 1e-5:
                logger.error(f"  ❌ PARAMETERS BARELY UPDATING! Avg change = {mel_proj_change:.8f}")
                logger.error(f"     This suggests optimizer is not working correctly!")
            else:
                logger.info(f"  ✓ Parameters are updating")

        # Update progress bar
        if iteration % 10 == 0:
            progress_bar.set_postfix({
                'total': f'{total_loss.item():.4f}',
                'mel_c': f'{mel_coarse_loss.item():.4f}',
                'mel_r': f'{mel_refined_loss.item():.4f}',
                'dur': f'{dur_loss.item():.4f}',
                'stop': f'{stop_loss.item():.4f}'
            })

        # Detailed logging every 200 iterations
        if iteration % 200 == 0 and iteration > 0:
            logger.info(f"\nIteration {iteration}:")
            logger.info(f"  Total Loss: {total_loss.item():.6f}")
            logger.info(f"  Mel Coarse Loss (decoder): {mel_coarse_loss.item():.6f}")
            logger.info(f"  Mel Refined Loss (PostNet): {mel_refined_loss.item():.6f}")
            logger.info(f"  Duration Loss: {dur_loss.item():.6f}")
            logger.info(f"  Stop Loss: {stop_loss.item():.6f}")
            logger.info(f"  Scheduled sampling prob: {scheduled_sampling_prob:.2f}")

            # Check mel prediction statistics (use refined for final quality)
            logger.info(f"  Mel coarse range: [{mel_coarse.min().item():.3f}, {mel_coarse.max().item():.3f}]")
            logger.info(f"  Mel refined range: [{mel_refined.min().item():.3f}, {mel_refined.max().item():.3f}]")
            logger.info(f"  Mel target range: [{mel_spec.min().item():.3f}, {mel_spec.max().item():.3f}]")
            logger.info(f"  Mel refined std: {mel_refined.std().item():.3f}")
            logger.info(f"  Mel target std: {mel_spec.std().item():.3f}")

            # Duration predictor is being trained (needed for inference)
            logger.info(f"  Duration predictor: TRAINING (dur_loss={dur_loss.item():.6f})")

            # Check gradient flow to decoder/PostNet instead
            if hasattr(model, 'mel_projection_coarse') and model.mel_projection_coarse.weight.grad is not None:
                mel_proj_grad_norm = model.mel_projection_coarse.weight.grad.norm().item()
                logger.info(f"  Mel projection gradient norm: {mel_proj_grad_norm:.6f}")

            if hasattr(model, 'postnet') and model.postnet.convolutions[0][0].weight.grad is not None:
                postnet_grad_norm = model.postnet.convolutions[0][0].weight.grad.norm().item()
                logger.info(f"  PostNet gradient norm: {postnet_grad_norm:.6f}")

            # Check prediction quality with correlation (use refined for final quality)
            mel_refined_flat = mel_refined.detach().flatten()
            mel_target_flat = mel_spec.flatten()
            correlation = torch.corrcoef(torch.stack([mel_refined_flat, mel_target_flat]))[0, 1].item()
            logger.info(f"  Refined prediction-target correlation: {correlation:.4f}")

            # Check if predictions are stuck at a constant value
            refined_variance = mel_refined.var().item()
            target_variance = mel_spec.var().item()
            logger.info(f"  Refined prediction variance: {refined_variance:.4f}")
            logger.info(f"  Target variance: {target_variance:.4f}")
            if refined_variance < 0.1:
                logger.warning(f"  ⚠️  Refined predictions have very low variance - model might be outputting constants!")

            # CHECK GRADIENTS on mel projection (decoder output) - now has coarse + postnet
            if model.mel_projection_coarse.weight.grad is not None:
                mel_coarse_grad_norm = model.mel_projection_coarse.weight.grad.norm().item()
                logger.info(f"  Mel projection (coarse) gradient norm: {mel_coarse_grad_norm:.6f}")
            else:
                logger.error(f"  ❌ NO GRADIENT on mel projection coarse!")

            # Check postnet gradients too
            if hasattr(model, 'postnet') and model.postnet.convolutions[0][0].weight.grad is not None:
                postnet_grad_norm = model.postnet.convolutions[0][0].weight.grad.norm().item()
                logger.info(f"  Postnet (first layer) gradient norm: {postnet_grad_norm:.6f}")
            else:
                logger.error(f"  ❌ NO GRADIENT on postnet!")

    progress_bar.close()

    # Final results
    logger.info("\n" + "="*70)
    logger.info("OVERFIT TEST RESULTS")
    logger.info("="*70)

    final_total_loss = losses[-1]
    final_mel_coarse_loss = mel_coarse_losses[-1]
    final_mel_refined_loss = mel_refined_losses[-1]
    final_dur_loss = dur_losses[-1]
    final_stop_loss = stop_losses[-1]

    logger.info(f"\nFinal losses after {num_iterations} iterations:")
    logger.info(f"  Total Loss: {final_total_loss:.6f}")
    logger.info(f"  Mel Coarse Loss (decoder): {final_mel_coarse_loss:.6f}")
    logger.info(f"  Mel Refined Loss (PostNet): {final_mel_refined_loss:.6f}")
    logger.info(f"  Duration Loss: {final_dur_loss:.6f}")
    logger.info(f"  Stop Loss: {final_stop_loss:.6f}")

    # Check if overfitting succeeded (use refined loss for final quality check)
    success = final_mel_refined_loss < 0.1 and final_dur_loss < 0.5

    if success:
        logger.info("\n✅ SUCCESS: Model successfully overfitted to single sample!")
        logger.info("This means the model architecture and training loop are working correctly.")
    else:
        logger.error("\n❌ FAILURE: Model failed to overfit single sample!")
        logger.error("This indicates a fundamental problem in:")
        logger.error("  - Model architecture")
        logger.error("  - Training loop")
        logger.error("  - Data preprocessing")
        logger.error("  - Loss computation")

    # Save model for inference test
    logger.info("\nSaving overfitted model...")
    output_dir = Path("overfit_test_output")
    output_dir.mkdir(exist_ok=True)

    # Save model checkpoint
    checkpoint = {
        'model_state_dict': model.state_dict(),
        'iteration': num_iterations,
        'loss': final_total_loss,
        'sample_idx': sample_idx,
        'sample_text': sample['text']
    }
    torch.save(checkpoint, output_dir / "overfit_model.pth")

    # Save phoneme processor
    import pickle
    with open(output_dir / "phoneme_processor.pkl", 'wb') as f:
        pickle.dump(phoneme_processor.to_dict(), f)

    # Save model config
    config = {
        'vocab_size': vocab_size,
        'mel_dim': 80,
        'hidden_dim': 512,
        'n_encoder_layers': 6,
        'n_heads': 8,
        'encoder_ff_dim': 2048,
        'encoder_dropout': 0.1,
        'n_decoder_layers': 6,
        'decoder_ff_dim': 2048,
        'max_decoder_seq_len': 4000,
        'sample_rate': 22050,
        'hop_length': 256,
        'win_length': 1024,
        'n_fft': 1024,
        'n_mels': 80,
        'f_min': 0.0,
        'f_max': 8000.0
    }
    with open(output_dir / "model_config.json", 'w') as f:
        json.dump(config, f, indent=2)

    # Save training sample for reference
    torch.save({
        'text': sample['text'],
        'phoneme_indices': sample['phoneme_indices'],
        'mel_spec': sample['mel_spec'],
        'phoneme_durations': sample['phoneme_durations']
    }, output_dir / "training_sample.pt")

    logger.info(f"Model saved to: {output_dir}")

    # Test inference on the same text
    logger.info("\n" + "="*70)
    logger.info("TESTING INFERENCE ON TRAINING SAMPLE")
    logger.info("="*70)

    model.eval()

    with torch.no_grad():
        logger.info(f"\nGenerating audio for: '{sample['text']}'")

        # FIRST: Generate audio from GROUND TRUTH mel (reference quality)
        logger.info("\n--- Ground Truth Mel (Reference) ---")
        phoneme_indices_single = phoneme_indices[:1]
        durations_single = durations[:1]
        mel_spec_single = mel_spec[:1]
        stop_tokens_single = stop_tokens[:1]

        logger.info(f"Ground truth mel shape: {mel_spec_single.shape}")
        logger.info(f"Ground truth mel range: [{mel_spec_single.min().item():.3f}, {mel_spec_single.max().item():.3f}]")

        # Generate audio from ground truth mels
        logger.info("\nGenerating audio from ground truth mels (reference quality)...")
        mel_for_vocoder_gt = mel_spec_single.squeeze(0).transpose(0, 1).cpu()  # (mel_dim, frames)

        from audio.vocoder_manager import VocoderManager
        vocoder_manager = VocoderManager(vocoder_type="hifigan", device=device.type)
        audio_gt = vocoder_manager.mel_to_audio(mel_for_vocoder_gt)

        output_path_gt = output_dir / "ground_truth_audio.wav"
        import torchaudio
        torchaudio.save(str(output_path_gt), audio_gt.unsqueeze(0), 22050)
        logger.info(f"✓ Ground truth audio saved to: {output_path_gt}")
        logger.info(f"Audio duration: {len(audio_gt) / 22050:.2f}s")

        # SECOND: Test with teacher-forced forward pass (should be near-perfect)
        logger.info("\n--- Teacher-Forced Pass (using ground truth durations) ---")

        mel_coarse_tf, mel_refined_tf, dur_pred_tf, stop_pred_tf = model.forward_training(
            phoneme_indices=phoneme_indices_single,
            mel_specs=mel_spec_single,
            phoneme_durations=durations_single,
            stop_token_targets=stop_tokens_single,
            text_padding_mask=None,
            mel_padding_mask=None,
            use_gt_durations=False
        )

        # Check teacher-forced quality (use refined for final quality)
        tf_mel_loss = nn.L1Loss()(mel_refined_tf, mel_spec_single).item()
        tf_correlation = torch.corrcoef(torch.stack([
            mel_refined_tf.flatten(),
            mel_spec_single.flatten()
        ]))[0, 1].item()

        logger.info(f"Teacher-forced mel coarse loss: {nn.L1Loss()(mel_coarse_tf, mel_spec_single).item():.6f}")
        logger.info(f"Teacher-forced mel refined loss: {tf_mel_loss:.6f}")
        logger.info(f"Teacher-forced correlation: {tf_correlation:.4f}")
        logger.info(f"Teacher-forced mel refined range: [{mel_refined_tf.min().item():.3f}, {mel_refined_tf.max().item():.3f}]")

        # Generate audio from teacher-forced mels (use refined for final quality)
        logger.info("\nGenerating audio from teacher-forced mels (refined)...")
        mel_for_vocoder_tf = mel_refined_tf.squeeze(0).transpose(0, 1).cpu()  # (mel_dim, frames)

        # Reuse the same vocoder instance
        audio_tf = vocoder_manager.mel_to_audio(mel_for_vocoder_tf)

        output_path_tf = output_dir / "overfit_teacher_forced.wav"
        import torchaudio
        torchaudio.save(str(output_path_tf), audio_tf.unsqueeze(0), 22050)
        logger.info(f"✓ Teacher-forced audio saved to: {output_path_tf}")
        logger.info(f"Audio duration: {len(audio_tf) / 22050:.2f}s")

        # SECOND: Test with ground truth durations (best case scenario)
        logger.info("\n--- Inference with Ground Truth Durations ---")
        logger.info("Using GT durations but zero-initialized decoder input...")

        # Use GROUND TRUTH durations for best case
        logger.info(f"Using ground truth durations: {durations_single[0].cpu().tolist()[:10]}...")

        # Generate using parallel decoding - try iterative refinement
        # Start with zeros, then refine
        decoder_input_iter = torch.zeros_like(mel_spec_single)

        num_refinement_steps = 5
        logger.info(f"Performing {num_refinement_steps} refinement steps...")

        for refine_step in range(num_refinement_steps):
            with torch.no_grad():
                _, mel_refined_iter, _, _ = model.forward_training(
                    phoneme_indices=phoneme_indices_single,
                    mel_specs=decoder_input_iter,
                    phoneme_durations=durations_single,  # Use GT durations
                    stop_token_targets=stop_tokens_single,
                    text_padding_mask=None,
                    mel_padding_mask=None,
                    use_gt_durations=False
                )
                # Use refined prediction as next input (iterative refinement)
                decoder_input_iter = mel_refined_iter.detach()

                if refine_step == 0:
                    mel_loss_iter = nn.L1Loss()(mel_refined_iter, mel_spec_single).item()
                    logger.info(f"  Step {refine_step}: mel_loss={mel_loss_iter:.4f}")

        # Final refinement
        mel_coarse_parallel, mel_refined_parallel, _, _ = model.forward_training(
            phoneme_indices=phoneme_indices_single,
            mel_specs=decoder_input_iter,
            phoneme_durations=durations_single,  # Use GT durations
            stop_token_targets=stop_tokens_single,
            text_padding_mask=None,
            mel_padding_mask=None,
            use_gt_durations=False
        )

        mel_loss_final = nn.L1Loss()(mel_refined_parallel, mel_spec_single).item()
        logger.info(f"  Final: mel_loss={mel_loss_final:.4f}")
        logger.info(f"Parallel generated mel shape: {mel_refined_parallel.shape}")
        logger.info(f"Parallel mel refined range: [{mel_refined_parallel.min().item():.3f}, {mel_refined_parallel.max().item():.3f}]")

        # Generate audio from parallel inference (use refined)
        logger.info("\nGenerating audio from iterative refinement (refined)...")
        mel_for_vocoder_parallel = mel_refined_parallel.squeeze(0).transpose(0, 1).cpu()
        audio_parallel = vocoder_manager.mel_to_audio(mel_for_vocoder_parallel)

        output_path_parallel = output_dir / "overfit_parallel.wav"
        torchaudio.save(str(output_path_parallel), audio_parallel.unsqueeze(0), 22050)
        logger.info(f"✓ Parallel inference audio saved to: {output_path_parallel}")
        logger.info(f"Audio duration: {len(audio_parallel) / 22050:.2f}s")

        # THIRD: Test with autoregressive inference (for comparison)
        logger.info("\n--- Autoregressive Inference (Original) ---")
        mel_output = model.forward_inference(
            phoneme_indices=phoneme_indices_single,
            max_len=400,
            stop_threshold=0.5,
            text_padding_mask=None
        )

        logger.info(f"Autoregressive mel shape: {mel_output.shape}")
        logger.info(f"Target mel shape: {mel_spec.shape}")
        logger.info(f"Autoregressive mel range: [{mel_output.min().item():.3f}, {mel_output.max().item():.3f}]")
        logger.info(f"Target mel range: [{mel_spec.min().item():.3f}, {mel_spec.max().item():.3f}]")

        # Remove batch dimension and transpose for vocoder
        mel_output_cpu = mel_output.squeeze(0).cpu()
        mel_output_cpu = mel_output_cpu.transpose(0, 1)  # (frames, mel_dim) -> (mel_dim, frames)

        logger.info(f"Mel for vocoder shape: {mel_output_cpu.shape}")

        # Save mel output
        torch.save(mel_output_cpu, output_dir / "generated_mel.pt")

        # Use vocoder to generate audio
        try:
            from audio.vocoder_manager import VocoderManager
            from audio.audio_utils import AudioUtils

            logger.info("\nGenerating audio with HiFi-GAN vocoder...")

            vocoder_manager = VocoderManager('hifigan', None, 'cpu')
            audio = vocoder_manager.mel_to_audio(mel_output_cpu)

            # Save audio
            audio_utils = AudioUtils(22050)
            output_path = output_dir / "overfit_test_output.wav"
            audio_utils.save_audio(audio, str(output_path))

            logger.info(f"✓ Audio saved to: {output_path}")
            logger.info(f"Audio duration: {len(audio) / 22050:.2f}s")
            logger.info(f"Audio range: [{audio.min():.3f}, {audio.max():.3f}]")

            logger.info("\n" + "="*70)
            logger.info("OVERFIT TEST COMPLETE!")
            logger.info("="*70)
            logger.info(f"\nListen to the generated audio: {output_path}")
            logger.info(f"Compare with training text: '{sample['text']}'")
            logger.info("\nIf the audio matches the text (even if robotic), the model CAN learn!")
            logger.info("If audio is garbage, check mel statistics above for clues.")

        except Exception as e:
            logger.error(f"Error generating audio with vocoder: {e}")
            logger.error("Mel spectrogram was saved, but audio generation failed.")
            import traceback
            traceback.print_exc()

    return success


if __name__ == "__main__":
    try:
        success = test_overfit()
        sys.exit(0 if success else 1)
    except Exception as e:
        logger.error(f"Fatal error in overfit test: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
