import torch
import torch.nn as nn
import torch.nn.functional as F
from typing import Optional, Tuple, Union
from torch.utils.checkpoint import checkpoint
import logging
import torch.profiler
import time
import os

from .positional_encoding import PositionalEncoding
from .model_transformers import TransformerDecoder, TransformerEncoderBlock
from .postnet import Postnet

logger = logging.getLogger(__name__)


# Simple GPU Profiler stub (full version was removed to simplify codebase)
class GPUProfiler:
    """Lightweight profiler for memory tracking"""
    def __init__(self, enabled=False):
        self.enabled = enabled
        self.memory_stats = {}
        self.device_name = "Unknown"
        if torch.cuda.is_available():
            self.device_name = torch.cuda.get_device_name(0)

    def log_memory_stats(self, stage_name: str):
        if not self.enabled:
            return
        if torch.cuda.is_available():
            memory_allocated = torch.cuda.memory_allocated() / 1024**2
            self.memory_stats[stage_name] = {
                'memory_used_mb': memory_allocated,
                'peak_memory_mb': torch.cuda.max_memory_allocated() / 1024**2
            }

    def get_memory_summary(self):
        if torch.cuda.is_available():
            return {
                'allocated_mb': torch.cuda.memory_allocated() / 1024**2,
                'reserved_mb': torch.cuda.memory_reserved() / 1024**2,
                'max_allocated_mb': torch.cuda.max_memory_allocated() / 1024**2
            }
        return {}

    def reset_peak_memory_stats(self):
        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()


class KokoroModel(nn.Module):
    """
    Enhanced Kokoro-style model architecture with gradient checkpointing enabled by default.
    Optimized for MPS (Metal Performance Shaders) acceleration with GPU profiling
    """

    def __init__(self, vocab_size: int, mel_dim: int = 80, hidden_dim: int = 512,
                 n_encoder_layers: int = 6, n_heads: int = 8, encoder_ff_dim: int = 2048,
                 encoder_dropout: float = 0.1, n_decoder_layers: int = 6, decoder_ff_dim: int = 2048,
                 max_decoder_seq_len: int = 4000, enable_profiling: bool = False,
                 gradient_checkpointing: bool = True, checkpoint_segments: int = 2):
        """
        Initialize the Kokoro model with Transformer encoder and decoder

        Args:
            gradient_checkpointing: Enable gradient checkpointing by default (True)
            checkpoint_segments: Number of segments to divide layers into for checkpointing
        """
        super().__init__()
        self.vocab_size = vocab_size
        self.mel_dim = mel_dim
        self.hidden_dim = hidden_dim
        self.max_decoder_seq_len = max_decoder_seq_len

        # Gradient checkpointing configuration
        self.gradient_checkpointing = gradient_checkpointing
        self.checkpoint_segments = checkpoint_segments

        # Initialize profiler
        self.profiler = GPUProfiler(enabled=enable_profiling)
        self.enable_profiling = enable_profiling

        # Text encoder: Embedding + Positional Encoding + Stack of Transformer Blocks
        self.text_embedding = nn.Embedding(vocab_size, hidden_dim)
        self.encoder_positional_encoding = PositionalEncoding(
            hidden_dim, dropout=encoder_dropout, max_len=max_decoder_seq_len
        )

        self.transformer_encoder_layers = nn.ModuleList([
            TransformerEncoderBlock(hidden_dim, n_heads, encoder_ff_dim, encoder_dropout)
            for _ in range(n_encoder_layers)
        ])

        # Duration Predictor
        self.duration_predictor = nn.Sequential(
            nn.Linear(hidden_dim, hidden_dim),
            nn.ReLU(),
            nn.Dropout(encoder_dropout),
            nn.Linear(hidden_dim, hidden_dim // 2),
            nn.ReLU(),
            nn.Dropout(encoder_dropout),
            nn.Linear(hidden_dim // 2, 1)
        )

        # Mel feature projection to match hidden dimension for decoder input
        self.mel_projection_in = nn.Linear(mel_dim, hidden_dim)

        self.decoder = TransformerDecoder(
            d_model=hidden_dim,
            nhead=n_heads,
            dim_feedforward=decoder_ff_dim,
            dropout=encoder_dropout,
            num_layers=n_decoder_layers
        )

        # Output projection for Mel Spectrogram
        # CRITICAL FIX: Add PostNet for mel refinement!
        # Previous architecture used only a single linear layer, which was too weak
        # to capture fine mel structure (formants, harmonics, transitions).
        # PostNet adds convolutional layers to refine coarse predictions.
        self.mel_projection_coarse = nn.Linear(hidden_dim, mel_dim)  # Coarse prediction

        # CRITICAL: Initialize mel projection bias to match typical mel range
        # Log-mel spectrograms typically have mean ~-3.5, range [-11.5, 0.0]
        # Without this, model starts predicting around 0, creating large initial error
        with torch.no_grad():
            # Initialize bias to -3.5 (typical mel mean)
            self.mel_projection_coarse.bias.fill_(-3.5)
            # Scale weights down to prevent large initial predictions
            self.mel_projection_coarse.weight.mul_(0.1)

        self.postnet = Postnet(
            mel_dim=mel_dim,
            postnet_dim=512,
            n_layers=5,
            kernel_size=5,
            dropout=0.5
        )

        # End-of-Speech (Stop Token) Predictor
        self.stop_token_predictor = nn.Linear(hidden_dim, 1)

        # General dropout
        self.dropout = nn.Dropout(encoder_dropout)

        # Log gradient checkpointing status
        if self.gradient_checkpointing:
            logger.info(f"Gradient checkpointing enabled with {checkpoint_segments} segments")
            logger.info(f"Encoder layers: {n_encoder_layers}, Decoder layers: {n_decoder_layers}")

    def enable_gradient_checkpointing(self, segments: int = None):
        """Enable gradient checkpointing"""
        self.gradient_checkpointing = True
        if segments is not None:
            self.checkpoint_segments = segments
        logger.info(f"Gradient checkpointing enabled with {self.checkpoint_segments} segments")

    def disable_gradient_checkpointing(self):
        """Disable gradient checkpointing"""
        self.gradient_checkpointing = False
        logger.info("Gradient checkpointing disabled")

    def _checkpoint_encoder_layers(self, x: torch.Tensor, layers: nn.ModuleList,
                                 mask: Optional[torch.Tensor] = None) -> torch.Tensor:
        """
        Apply gradient checkpointing to encoder layers in segments with external logging
        """
        if not self.gradient_checkpointing or not self.training:
            # Standard forward pass without checkpointing - log at layer boundaries
            for i, layer in enumerate(layers):
                with torch.profiler.record_function(f"encoder_layer_{i}"):
                    # Log memory before layer (outside profiling context)
                    if self.enable_profiling and i % 2 == 0:
                        self.profiler.log_memory_stats(f"encoder_layer_{i}_start")

                    if mask is not None:
                        x = layer(x, src_key_padding_mask=mask.to(torch.bool))
                    else:
                        x = layer(x)

                    # Log memory after layer (outside profiling context)
                    if self.enable_profiling and i % 2 == 0:
                        self.profiler.log_memory_stats(f"encoder_layer_{i}_end")
            return x

        # Gradient checkpointing enabled - log at segment boundaries only
        num_layers = len(layers)
        segment_size = max(1, num_layers // self.checkpoint_segments)

        for segment_idx in range(0, num_layers, segment_size):
            segment_end = min(segment_idx + segment_size, num_layers)
            segment_layers = layers[segment_idx:segment_end]

            # Log memory before segment (outside checkpoint)
            if self.enable_profiling:
                segment_name = f"encoder_segment_{segment_idx//segment_size}"
                self.profiler.log_memory_stats(f"{segment_name}_start")

            def create_segment_forward(segment_layers_list, segment_start_idx):
                def segment_forward(x_seg, mask_seg=None):
                    # NO LOGGING INSIDE CHECKPOINTED REGION
                    for i, layer in enumerate(segment_layers_list):
                        layer_idx = segment_start_idx + i
                        if mask_seg is not None:
                            x_seg = layer(x_seg, src_key_padding_mask=mask_seg.to(torch.bool))
                        else:
                            x_seg = layer(x_seg)
                    return x_seg
                return segment_forward

            segment_forward_fn = create_segment_forward(segment_layers, segment_idx)

            # Execute checkpointed segment
            if mask is not None:
                x = checkpoint(segment_forward_fn, x, mask, use_reentrant=False)
            else:
                x = checkpoint(segment_forward_fn, x, use_reentrant=False)

            # Log memory after segment (outside checkpoint)
            if self.enable_profiling:
                self.profiler.log_memory_stats(f"{segment_name}_end")
                logger.debug(f"Completed {segment_name} (layers {segment_idx}-{segment_end-1})")

        return x

    def _checkpoint_decoder_forward(self, decoder_input: torch.Tensor, memory: torch.Tensor,
                                  tgt_mask: Optional[torch.Tensor] = None,
                                  memory_key_padding_mask: Optional[torch.Tensor] = None,
                                  tgt_key_padding_mask: Optional[torch.Tensor] = None) -> torch.Tensor:
        """
        Apply gradient checkpointing to decoder layers with external logging
        """
        if not self.gradient_checkpointing or not self.training:
            # Standard forward pass without checkpointing
            if self.enable_profiling:
                self.profiler.log_memory_stats("decoder_start")

            result = self.decoder(
                tgt=decoder_input,
                memory=memory,
                tgt_mask=tgt_mask,
                memory_key_padding_mask=memory_key_padding_mask,
                tgt_key_padding_mask=tgt_key_padding_mask
            )

            if self.enable_profiling:
                self.profiler.log_memory_stats("decoder_end")

            return result

        # Log before checkpointed decoder (outside checkpoint)
        if self.enable_profiling:
            self.profiler.log_memory_stats("decoder_checkpoint_start")

        def create_decoder_forward():
            def decoder_forward(tgt, mem, t_mask, mem_mask, tgt_mask_pad):
                # NO LOGGING INSIDE CHECKPOINTED REGION
                return self.decoder(
                    tgt=tgt,
                    memory=mem,
                    tgt_mask=t_mask,
                    memory_key_padding_mask=mem_mask,
                    tgt_key_padding_mask=tgt_mask_pad
                )
            return decoder_forward

        decoder_forward_fn = create_decoder_forward()

        result = checkpoint(
            decoder_forward_fn,
            decoder_input, memory, tgt_mask, memory_key_padding_mask, tgt_key_padding_mask,
            use_reentrant=False
        )

        # Log after checkpointed decoder (outside checkpoint)
        if self.enable_profiling:
            self.profiler.log_memory_stats("decoder_checkpoint_end")
            logger.debug("Completed decoder checkpoint")

        return result

    def encode_text(self, phoneme_indices: torch.Tensor,
                    mask: Optional[torch.Tensor] = None) -> torch.Tensor:
        """Encode text with gradient checkpointing and proper scaling"""
        with torch.profiler.record_function("encode_text"):
            # Log before text embedding (outside any checkpointed regions)
            if self.enable_profiling:
                self.profiler.log_memory_stats("text_embedding_start")

            text_emb = self.text_embedding(phoneme_indices) * (self.hidden_dim ** 0.5)
            text_emb = self.encoder_positional_encoding(text_emb, seq_offset=0)

            if self.enable_profiling:
                self.profiler.log_memory_stats("text_embedding_end")

            # Use checkpointed encoder layers (logging handled internally)
            x = self._checkpoint_encoder_layers(text_emb, self.transformer_encoder_layers, mask)

            return x

    def _predict_durations(self, text_encoded: torch.Tensor) -> torch.Tensor:
        """
        Predicts log durations for each phoneme with optional checkpointing

        CRITICAL FIX: Clamps log-durations to prevent catastrophic expansion
        - log(0.1) ≈ -2.3 → min 0.1 frames
        - log(100) ≈ 4.6 → max 100 frames
        Without this, predicted durations can explode to 11,000+ frames per phoneme!
        """
        with torch.profiler.record_function("predict_durations"):
            # Log before duration prediction (outside any checkpointed regions)
            if self.enable_profiling:
                self.profiler.log_memory_stats("duration_prediction_start")

            if self.gradient_checkpointing and self.training:
                # Apply checkpointing to duration predictor
                log_durations_raw = checkpoint(self.duration_predictor, text_encoded, use_reentrant=False).squeeze(-1)
            else:
                log_durations_raw = self.duration_predictor(text_encoded).squeeze(-1)

            # CRITICAL: Return raw predictions for loss computation!
            # Only apply clamping during inference for safety
            # During training, duration loss is computed on raw predictions
            # This allows full gradient flow for learning

            if not self.training:
                # Hard clamp during inference ONLY
                log_durations_raw = torch.clamp(log_durations_raw, min=-2.3, max=4.6)

            # Log after duration prediction (outside any checkpointed regions)
            if self.enable_profiling:
                self.profiler.log_memory_stats("duration_prediction_end")

            return log_durations_raw

    def _length_regulate(self, encoder_outputs, durations, text_padding_mask):
        """
        Fixed length regulation with proper tensor dimension handling.
        """
        with torch.profiler.record_function("length_regulate"):
            # Log before length regulation (no checkpointing here)
            if self.enable_profiling:
                self.profiler.log_memory_stats("length_regulation_start")

            batch_size, max_text_len, hidden_dim = encoder_outputs.shape
            device = encoder_outputs.device

            # Ensure durations are positive and properly clamped
            durations = torch.clamp(durations, min=1.0)

            expanded_encoder_outputs_list = []
            encoder_output_padding_mask_list = []
            max_expanded_len = 0

            for i in range(batch_size):
                current_encoder_output = encoder_outputs[i]  # (L_text, D)
                current_durations = durations[i]             # (L_text,)
                current_text_padding_mask = text_padding_mask[i].to(torch.bool)  # (L_text,)

                # Select non-padded elements
                non_padded_indices = ~current_text_padding_mask

                if not torch.any(non_padded_indices):
                    logger.warning(f"Batch {i}: All tokens are padding, creating empty sequence")
                    expanded_encoder_output = torch.empty(0, hidden_dim, device=device)
                    expanded_padding_mask = torch.empty(0, dtype=torch.bool, device=device)
                else:
                    filtered_encoder_output = current_encoder_output[non_padded_indices]
                    filtered_durations = current_durations[non_padded_indices]

                    # CRITICAL: Keep as float during training for gradient flow!
                    # Only convert to long for repeat_interleave (which requires int)
                    # Use .detach() on the integer version so gradients flow to float version
                    filtered_durations_float = torch.clamp(filtered_durations, min=1.0)
                    filtered_durations_int = filtered_durations_float.long()

                    try:
                        expanded_encoder_output = torch.repeat_interleave(
                            filtered_encoder_output, filtered_durations_int, dim=0
                        )
                        expanded_padding_mask = torch.zeros(
                            expanded_encoder_output.shape[0], dtype=torch.bool, device=device
                        )
                    except Exception as e:
                        logger.error(f"Error in repeat_interleave for batch {i}: {e}")
                        expanded_encoder_output = torch.empty(0, hidden_dim, device=device)
                        expanded_padding_mask = torch.empty(0, dtype=torch.bool, device=device)

                expanded_encoder_outputs_list.append(expanded_encoder_output)
                encoder_output_padding_mask_list.append(expanded_padding_mask)
                max_expanded_len = max(max_expanded_len, expanded_encoder_output.shape[0])

            if max_expanded_len == 0:
                logger.warning("All sequences resulted in empty expansion, creating dummy output for stability.")
                max_expanded_len = 1
                dummy_output = torch.zeros(1, hidden_dim, device=device, dtype=encoder_outputs.dtype)
                dummy_mask = torch.ones(1, dtype=torch.bool, device=device)
                expanded_encoder_outputs_list = [dummy_output] * batch_size
                encoder_output_padding_mask_list = [dummy_mask] * batch_size

            # Pad all sequences to the same length
            final_expanded_outputs = []
            final_padding_masks = []

            for i in range(batch_size):
                current_output = expanded_encoder_outputs_list[i]
                current_mask = encoder_output_padding_mask_list[i]
                current_len = current_output.shape[0]

                padding_needed = max_expanded_len - current_len

                if padding_needed > 0:
                    padding_tensor = torch.zeros(
                        padding_needed, hidden_dim, device=device, dtype=current_output.dtype
                    )
                    current_output = torch.cat([current_output, padding_tensor], dim=0)

                    padding_mask_fill = torch.ones(padding_needed, dtype=torch.bool, device=device)
                    current_mask = torch.cat([current_mask, padding_mask_fill], dim=0)

                final_expanded_outputs.append(current_output)
                final_padding_masks.append(current_mask)

            expanded_encoder_outputs = torch.stack(final_expanded_outputs, dim=0)
            encoder_output_padding_mask = torch.stack(final_padding_masks, dim=0)

            # Log after length regulation (no checkpointing here)
            if self.enable_profiling:
                self.profiler.log_memory_stats("length_regulation_end")

            logger.debug(f"Length regulation completed: {encoder_outputs.shape} -> {expanded_encoder_outputs.shape}")

            return expanded_encoder_outputs, encoder_output_padding_mask

    @staticmethod
    def _generate_square_subsequent_mask(sz: int, device: torch.device) -> torch.Tensor:
        """Generates an upper-triangular matrix of -inf, used for masked self-attention."""
        mask = torch.triu(torch.full((sz, sz), float('-inf'), device=device, dtype=torch.float32), diagonal=1)
        return mask

    def forward_training(
        self,
        phoneme_indices: torch.Tensor,
        mel_specs: torch.Tensor,
        phoneme_durations: torch.Tensor,
        stop_token_targets: torch.Tensor,
        text_padding_mask: Optional[torch.Tensor] = None,
        mel_padding_mask: Optional[torch.Tensor] = None,
        use_gt_durations: bool = False,
        decoder_input_mels: Optional[torch.Tensor] = None
    ) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        """
        Enhanced training forward pass with gradient checkpointing enabled by default

        Returns:
            Tuple containing:
                - mel_coarse: Coarse mel prediction from decoder (pre-PostNet)
                - mel_refined: Refined mel prediction (post-PostNet)
                - predicted_log_durations: Log durations
                - predicted_stop_logits: Stop token logits

        Args:
            decoder_input_mels: Optional mel spectrograms to use as decoder input.
                              If None, uses mel_specs with teacher forcing (standard training).
                              For scheduled sampling, pass model predictions or zeros.
                              Shape: (batch, mel_seq_len, mel_dim)

        Note:
            Returns BOTH mel_coarse and mel_refined for dual-loss training.
            This enables direct supervision of decoder (mel_coarse) while also
            supervising the PostNet refinement (mel_refined).
        """
        with torch.profiler.record_function("forward_training"):
            batch_size, mel_seq_len = mel_specs.shape[0], mel_specs.shape[1]
            device = mel_specs.device

            # Log at the very beginning (outside any checkpointed regions)
            if self.enable_profiling:
                self.profiler.log_memory_stats("training_start")

            # Log gradient checkpointing status
            if self.gradient_checkpointing and self.training:
                logger.debug("Using gradient checkpointing for forward pass")

            if text_padding_mask is None:
                text_padding_mask = (phoneme_indices == 0).to(torch.bool)
            else:
                text_padding_mask = text_padding_mask.to(torch.bool)

            try:
                # Encode text using checkpointed Transformer encoder (logging handled internally)
                text_encoded = self.encode_text(phoneme_indices, mask=text_padding_mask)

                # Predict durations with checkpointing (logging handled internally)
                # Skip during overfit test when use_gt_durations=True
                if use_gt_durations:
                    # Use ground truth durations directly, skip prediction entirely
                    predicted_log_durations = torch.log(phoneme_durations.float().clamp(min=1e-5))
                else:
                    predicted_log_durations = self._predict_durations(text_encoded)

                # Length regulate (logging handled internally)
                expanded_encoder_outputs, encoder_output_padding_mask = self._length_regulate(
                    text_encoded, phoneme_durations.float(), text_padding_mask
                )

                # Adjust sequence length to match mel_seq_len
                with torch.profiler.record_function("mel_length_adjust"):
                    if self.enable_profiling:
                        self.profiler.log_memory_stats("mel_length_adjust_start")

                    current_expanded_len = expanded_encoder_outputs.shape[1]
                    if current_expanded_len != mel_seq_len:
                        if current_expanded_len > mel_seq_len:
                            expanded_encoder_outputs = expanded_encoder_outputs[:, :mel_seq_len, :]
                            encoder_output_padding_mask = encoder_output_padding_mask[:, :mel_seq_len]
                        else:
                            pad_len = mel_seq_len - current_expanded_len
                            padding_tensor = torch.zeros(
                                batch_size, pad_len, self.hidden_dim,
                                device=device, dtype=expanded_encoder_outputs.dtype
                            )
                            expanded_encoder_outputs = torch.cat(
                                [expanded_encoder_outputs, padding_tensor], dim=1
                            )
                            padding_mask_tensor = torch.ones(
                                batch_size, pad_len, dtype=torch.bool, device=device
                            )
                            encoder_output_padding_mask = torch.cat(
                                [encoder_output_padding_mask, padding_mask_tensor], dim=1
                            )

                    if self.enable_profiling:
                        self.profiler.log_memory_stats("mel_length_adjust_end")

                with torch.profiler.record_function("decoder_input_prep"):
                    if self.enable_profiling:
                        self.profiler.log_memory_stats("decoder_input_prep_start")

                    # Prepare decoder input with checkpointing
                    # Use provided decoder_input_mels if available (for scheduled sampling),
                    # otherwise use mel_specs with teacher forcing (standard training)
                    if decoder_input_mels is None:
                        decoder_input_mels = mel_specs

                    # Shift right by 1 position (teacher forcing / scheduled sampling)
                    decoder_input_mels = F.pad(decoder_input_mels[:, :-1, :], (0, 0, 1, 0), "constant", 0.0)

                    if self.gradient_checkpointing and self.training:
                        decoder_input_projected = checkpoint(
                            self.mel_projection_in, decoder_input_mels, use_reentrant=False
                        )
                    else:
                        decoder_input_projected = self.mel_projection_in(decoder_input_mels)

                    # Apply positional encoding
                    decoder_input_projected_with_pe = self.encoder_positional_encoding(
                        decoder_input_projected, seq_offset=0
                    )

                    # Generate causal mask for decoder self-attention
                    tgt_mask = self._generate_square_subsequent_mask(mel_seq_len, device)

                    if mel_padding_mask is not None:
                        mel_padding_mask = mel_padding_mask.to(torch.bool)

                    if self.enable_profiling:
                        self.profiler.log_memory_stats("decoder_input_prep_end")

                with torch.profiler.record_function("transformer_decoder_forward"):
                    # Pass through Transformer Decoder with checkpointing (logging handled internally)
                    decoder_outputs = self._checkpoint_decoder_forward(
                        decoder_input_projected_with_pe,
                        expanded_encoder_outputs,
                        tgt_mask=tgt_mask,
                        memory_key_padding_mask=encoder_output_padding_mask,
                        tgt_key_padding_mask=mel_padding_mask
                    )

                with torch.profiler.record_function("output_projections"):
                    if self.enable_profiling:
                        self.profiler.log_memory_stats("output_projections_start")

                    # Project decoder outputs with checkpointing
                    # DUAL-LOSS ARCHITECTURE: Return both coarse and refined predictions
                    # This enables direct supervision of both decoder and PostNet
                    if self.gradient_checkpointing and self.training:
                        # Coarse mel prediction (pre-PostNet)
                        mel_coarse = checkpoint(
                            self.mel_projection_coarse, decoder_outputs, use_reentrant=False
                        )
                        # Refine with postnet (residual connection)
                        mel_residual = checkpoint(
                            self.postnet, mel_coarse, use_reentrant=False
                        )
                        # Refined mel (post-PostNet) - full residual without scaling
                        mel_refined = mel_coarse + mel_residual

                        predicted_stop_logits = checkpoint(
                            self.stop_token_predictor, decoder_outputs, use_reentrant=False
                        ).squeeze(-1)
                    else:
                        # Coarse mel prediction (pre-PostNet)
                        mel_coarse = self.mel_projection_coarse(decoder_outputs)
                        # Refine with postnet (residual connection)
                        mel_residual = self.postnet(mel_coarse)
                        # Refined mel (post-PostNet) - full residual without scaling
                        mel_refined = mel_coarse + mel_residual

                        predicted_stop_logits = self.stop_token_predictor(decoder_outputs).squeeze(-1)

                    if self.enable_profiling:
                        self.profiler.log_memory_stats("output_projections_end")

                # Log at the very end (outside any checkpointed regions)
                if self.enable_profiling:
                    self.profiler.log_memory_stats("training_end")

                # Return BOTH coarse and refined for dual-loss training
                return mel_coarse, mel_refined, predicted_log_durations, predicted_stop_logits

            except Exception as e:
                logger.error(f"Error in forward_training: {e}")
                logger.error(f"Input shapes - phoneme_indices: {phoneme_indices.shape}, mel_specs: {mel_specs.shape}")
                logger.error(f"phoneme_durations: {phoneme_durations.shape}")
                if self.enable_profiling:
                    logger.error(f"GPU Memory at error: {self.profiler.get_memory_summary()}")
                raise e

    def forward_inference(self, phoneme_indices: torch.Tensor, max_len: int = 4000,
                         stop_threshold: float = 0.5,
                         text_padding_mask: Optional[torch.Tensor] = None) -> torch.Tensor:
        """
        Inference mode (gradient checkpointing automatically disabled)
        """
        with torch.profiler.record_function("forward_inference"):
            if phoneme_indices.size(0) > 1:
                logger.warning("Inference with stop token is most reliable with batch_size=1.")

            batch_size = phoneme_indices.size(0)
            device = phoneme_indices.device

            self.eval()  # This will disable gradient checkpointing automatically

            # Log at beginning of inference (no checkpointing in eval mode)
            if self.enable_profiling:
                self.profiler.log_memory_stats("inference_start")

            with torch.no_grad():
                try:
                    if text_padding_mask is None:
                        text_padding_mask = (phoneme_indices == 0).to(torch.bool)
                    else:
                        text_padding_mask = text_padding_mask.to(torch.bool)

                    with torch.profiler.record_function("inference_encode_text"):
                        # Text encoding (no checkpointing in eval mode, logging handled internally)
                        text_encoded = self.encode_text(phoneme_indices, mask=text_padding_mask)

                    with torch.profiler.record_function("inference_predict_durations"):
                        # Duration prediction (no checkpointing in eval mode, logging handled internally)
                        predicted_log_durations = self._predict_durations(text_encoded)
                        durations_for_length_regulate = torch.exp(predicted_log_durations)
                        durations_for_length_regulate = torch.clamp(durations_for_length_regulate, min=1.0).long()

                    with torch.profiler.record_function("inference_length_regulate"):
                        # Length regulation (logging handled internally)
                        expanded_encoder_outputs, encoder_output_padding_mask = self._length_regulate(
                            text_encoded, durations_for_length_regulate, text_padding_mask
                        )

                    expected_length = expanded_encoder_outputs.shape[1]
                    logger.info(f"Starting inference with expanded encoder outputs shape: {expanded_encoder_outputs.shape}")

                    if self.enable_profiling:
                        self.profiler.log_memory_stats("inference_pre_generation")

                    min_expected_length = max(10, expected_length // 3)
                    max_expected_length = min(max_len, expected_length * 2, 800)

                    logger.info(f"Generation bounds: min={min_expected_length}, max={max_expected_length}")

                    # Initialize generation
                    generated_mels = []
                    decoder_input_mel = torch.zeros(batch_size, 1, self.mel_dim, device=device)

                    # Generation loop (no checkpointing needed in eval mode)
                    generation_start_time = time.time()
                    for t in range(max_expected_length):
                        step_start_time = time.time()

                        with torch.profiler.record_function(f"inference_decode_step_{t}"):
                            try:
                                mel_projected_t = self.mel_projection_in(decoder_input_mel)

                                if t == 0:
                                    decoder_input_seq = mel_projected_t
                                else:
                                    previous_mels = torch.cat(generated_mels, dim=1)
                                    previous_projected = self.mel_projection_in(previous_mels)
                                    decoder_input_seq = torch.cat([previous_projected, mel_projected_t], dim=1)

                                decoder_input_seq_with_pe = self.encoder_positional_encoding(
                                    decoder_input_seq, seq_offset=0
                                )

                                current_seq_len = decoder_input_seq.shape[1]
                                tgt_mask = self._generate_square_subsequent_mask(current_seq_len, device)

                                decoder_outputs = self.decoder(
                                    tgt=decoder_input_seq_with_pe,
                                    memory=expanded_encoder_outputs,
                                    tgt_mask=tgt_mask,
                                    memory_key_padding_mask=encoder_output_padding_mask,
                                    tgt_key_padding_mask=None
                                )

                                decoder_out_t = decoder_outputs[:, -1:, :]
                                # Generate COARSE mel only (no PostNet yet)
                                # PostNet will be applied to complete sequence at the end
                                mel_coarse_t = self.mel_projection_coarse(decoder_out_t)

                                # Clamp coarse prediction for stability
                                mel_coarse_t = torch.clamp(mel_coarse_t, min=-11.5, max=0.0)

                                generated_mels.append(mel_coarse_t)

                                stop_token_logit_t = self.stop_token_predictor(decoder_out_t)
                                stop_probability = torch.sigmoid(stop_token_logit_t).item()

                                if t >= min_expected_length:
                                    if stop_probability > stop_threshold:
                                        logger.info(f"Stopping at frame {t} (stop_prob: {stop_probability:.4f})")
                                        break

                                    if t >= expected_length and stop_probability > 0.1:
                                        logger.info(f"Stopping at expected length {t} (stop_prob: {stop_probability:.4f})")
                                        break

                                decoder_input_mel = mel_coarse_t

                                # Log every 50 steps during inference (outside any checkpointed regions)
                                if self.enable_profiling and t % 50 == 0:
                                    step_time = (time.time() - step_start_time) * 1000
                                    logger.debug(f"Generated frame {t}, stop_prob: {stop_probability:.6f}, "
                                               f"step_time: {step_time:.2f}ms")
                                    self.profiler.log_memory_stats(f"inference_step_{t}")

                            except Exception as e:
                                logger.error(f"Error at generation step {t}: {e}")
                                if self.enable_profiling:
                                    logger.error(f"GPU Memory at step {t}: {self.profiler.get_memory_summary()}")
                                break

                    generation_time = time.time() - generation_start_time

                    if generated_mels:
                        # Concatenate coarse mel predictions
                        mel_coarse_sequence = torch.cat(generated_mels, dim=1)
                        logger.info(f"Generated {mel_coarse_sequence.shape[1]} coarse mel frames in {generation_time:.2f}s "
                                   f"({mel_coarse_sequence.shape[1]/generation_time:.1f} frames/s)")

                        # Apply PostNet to COMPLETE sequence (not frame-by-frame)
                        # This is the key fix: PostNet uses Conv1D with kernel_size=5
                        # It needs full sequence context to work properly
                        with torch.profiler.record_function("inference_postnet"):
                            mel_residual = self.postnet(mel_coarse_sequence)
                            # CRITICAL: Must match training! Training uses full residual (1.0x)
                            mel_output = mel_coarse_sequence + mel_residual  # Fixed from 0.5x to 1.0x

                            # Final clamp to vocoder range
                            mel_output = torch.clamp(mel_output, min=-11.5, max=0.0)

                        logger.info(f"Applied PostNet to complete sequence")
                    else:
                        logger.warning("No mel frames were generated.")
                        mel_output = torch.empty(batch_size, 0, self.mel_dim, device=device)

                    # Log at end of inference (outside any checkpointed regions)
                    if self.enable_profiling:
                        self.profiler.log_memory_stats("inference_end")

                    return mel_output

                except Exception as e:
                    logger.error(f"Error in forward_inference: {e}")
                    if self.enable_profiling:
                        logger.error(f"GPU Memory at error: {self.profiler.get_memory_summary()}")
                    return torch.empty(batch_size, 0, self.mel_dim, device=device)

    def forward(
        self,
        phoneme_indices: torch.Tensor,
        mel_specs: Optional[torch.Tensor] = None,
        phoneme_durations: Optional[torch.Tensor] = None,
        stop_token_targets: Optional[torch.Tensor] = None,
        text_padding_mask: Optional[torch.Tensor] = None,
        mel_padding_mask: Optional[torch.Tensor] = None,
        use_gt_durations: bool = False,
        decoder_input_mels: Optional[torch.Tensor] = None
    ) -> Union[torch.Tensor, Tuple[torch.Tensor, torch.Tensor, torch.Tensor]]:
        """
        Main forward pass that dispatches to training or inference mode.

        Args:
            use_gt_durations: If True, bypass duration predictor and use ground truth durations
            decoder_input_mels: Optional mel spectrograms for decoder input (scheduled sampling)
        """
        if mel_specs is not None:
            self.train()
            if phoneme_durations is None or stop_token_targets is None:
                raise ValueError("phoneme_durations and stop_token_targets must be provided for training mode.")
            return self.forward_training(
                phoneme_indices, mel_specs, phoneme_durations,
                stop_token_targets, text_padding_mask, mel_padding_mask,
                use_gt_durations, decoder_input_mels
            )
        else:
            self.eval()
            return self.forward_inference(
                phoneme_indices, max_len=self.max_decoder_seq_len,
                text_padding_mask=text_padding_mask
            )

    def get_model_info(self) -> dict:
        """Get model information and parameter count."""
        total_params = sum(p.numel() for p in self.parameters())
        trainable_params = sum(p.numel() for p in self.parameters() if p.requires_grad)

        info = {
            'vocab_size': self.vocab_size,
            'mel_dim': self.mel_dim,
            'hidden_dim': self.hidden_dim,
            'n_encoder_layers': len(self.transformer_encoder_layers),
            'n_decoder_layers': len(self.decoder.layers),
            'total_parameters': total_params,
            'trainable_parameters': trainable_params,
            'model_size_mb': total_params * 4 / (1024 * 1024),
            'gradient_checkpointing': {
                'enabled': self.gradient_checkpointing,
                'segments': self.checkpoint_segments,
                'memory_savings_estimated': f"{(self.checkpoint_segments - 1) / self.checkpoint_segments * 100:.1f}%"
            }
        }

        # Add GPU profiling info if available
        if self.enable_profiling:
            info['gpu_info'] = self.profiler.get_memory_summary()

        return info

    def get_profiling_report(self) -> dict:
        """Get comprehensive profiling report"""
        if not self.enable_profiling:
            return {"error": "Profiling is disabled"}

        report = {
            'device_info': {
                'device_name': self.profiler.device_name,
                'cuda_available': torch.cuda.is_available(),
                'device_count': torch.cuda.device_count() if torch.cuda.is_available() else 0
            },
            'memory_summary': self.profiler.get_memory_summary(),
            'model_info': self.get_model_info(),
            'gradient_checkpointing': {
                'enabled': self.gradient_checkpointing,
                'segments': self.checkpoint_segments,
                'estimated_memory_reduction': f"{(self.checkpoint_segments - 1) / self.checkpoint_segments * 100:.1f}%",
                'logging_strategy': 'segment_boundaries' if self.gradient_checkpointing else 'layer_boundaries'
            }
        }

        # Add memory efficiency analysis
        if self.profiler.memory_stats:
            total_memory_used = sum(
                stage['memory_used_mb'] for stage in self.profiler.memory_stats.values()
                if stage['memory_used_mb'] > 0
            )
            report['memory_analysis'] = {
                'total_memory_used_mb': total_memory_used,
                'peak_memory_mb': max(
                    stage['peak_memory_mb'] for stage in self.profiler.memory_stats.values()
                ),
                'most_memory_intensive_stage': max(
                    self.profiler.memory_stats.items(),
                    key=lambda x: x[1]['memory_used_mb']
                )[0] if self.profiler.memory_stats else None
            }

        return report

    def start_torch_profiler(self, output_dir: str = "./profiler_logs"):
        """Start PyTorch profiler for detailed analysis"""
        if not self.enable_profiling:
            logger.warning("Profiling is disabled, cannot start torch profiler")
            return None

        os.makedirs(output_dir, exist_ok=True)

        self.torch_profiler = torch.profiler.profile(
            activities=[
                torch.profiler.ProfilerActivity.CPU,
                torch.profiler.ProfilerActivity.CUDA,
            ] if torch.cuda.is_available() else [torch.profiler.ProfilerActivity.CPU],
            schedule=torch.profiler.schedule(wait=1, warmup=1, active=3, repeat=2),
            on_trace_ready=torch.profiler.tensorboard_trace_handler(output_dir),
            record_shapes=True,
            profile_memory=True,
            with_stack=True
        )

        self.torch_profiler.start()
        logger.info(f"Started PyTorch profiler, logs will be saved to {output_dir}")
        return self.torch_profiler

    def stop_torch_profiler(self):
        """Stop PyTorch profiler"""
        if hasattr(self, 'torch_profiler') and self.torch_profiler is not None:
            self.torch_profiler.stop()
            logger.info("Stopped PyTorch profiler")

    def profile_step(self):
        """Call this after each training/inference step when using torch profiler"""
        if hasattr(self, 'torch_profiler') and self.torch_profiler is not None:
            self.torch_profiler.step()

    def enable_profiling_mode(self):
        """Enable profiling mode"""
        self.enable_profiling = True
        self.profiler.enabled = True
        logger.info("Profiling mode enabled")

    def disable_profiling_mode(self):
        """Disable profiling mode"""
        self.enable_profiling = False
        self.profiler.enabled = False
        logger.info("Profiling mode disabled")

    def reset_profiling_stats(self):
        """Reset all profiling statistics"""
        self.profiler.memory_stats.clear()
        self.profiler.reset_peak_memory_stats()
        logger.info("Profiling statistics reset")

    def get_memory_usage_report(self) -> dict:
        """Get detailed memory usage report with gradient checkpointing analysis"""
        if not torch.cuda.is_available():
            return {"error": "CUDA not available for memory analysis"}

        current_memory = torch.cuda.memory_allocated() / 1024**2  # MB
        peak_memory = torch.cuda.max_memory_allocated() / 1024**2  # MB
        reserved_memory = torch.cuda.memory_reserved() / 1024**2  # MB
        total_memory = torch.cuda.get_device_properties(0).total_memory / 1024**2  # MB

        # Estimate memory savings from gradient checkpointing
        model_params = sum(p.numel() * 4 for p in self.parameters()) / 1024**2  # MB (assuming float32)

        if self.gradient_checkpointing:
            estimated_activation_memory_without_gc = model_params * 2  # Rough estimate
            estimated_activation_memory_with_gc = estimated_activation_memory_without_gc / self.checkpoint_segments
            estimated_savings = estimated_activation_memory_without_gc - estimated_activation_memory_with_gc
        else:
            estimated_savings = 0
            estimated_activation_memory_with_gc = model_params * 2

        return {
            'current_memory_mb': current_memory,
            'peak_memory_mb': peak_memory,
            'reserved_memory_mb': reserved_memory,
            'total_memory_mb': total_memory,
            'model_parameters_mb': model_params,
            'memory_utilization_pct': (current_memory / total_memory) * 100,
            'gradient_checkpointing': {
                'enabled': self.gradient_checkpointing,
                'segments': self.checkpoint_segments,
                'estimated_memory_savings_mb': estimated_savings,
                'estimated_activation_memory_mb': estimated_activation_memory_with_gc,
                'logging_optimization': 'segment_boundaries_only' if self.gradient_checkpointing else 'all_layers'
            }
        }

    def optimize_checkpoint_segments(self, target_memory_mb: float = None) -> int:
        """
        Suggest optimal number of checkpoint segments based on available memory

        Args:
            target_memory_mb: Target memory usage in MB. If None, uses 80% of available GPU memory

        Returns:
            Recommended number of segments
        """
        if not torch.cuda.is_available():
            logger.warning("CUDA not available, cannot optimize checkpoint segments")
            return self.checkpoint_segments

        total_memory = torch.cuda.get_device_properties(0).total_memory / 1024**2  # MB
        if target_memory_mb is None:
            target_memory_mb = total_memory * 0.8  # Use 80% of available memory

        # Rough estimation of memory requirements
        model_params_mb = sum(p.numel() * 4 for p in self.parameters()) / 1024**2

        # Estimate activation memory per layer (very rough approximation)
        n_layers = len(self.transformer_encoder_layers) + len(self.decoder.layers)
        estimated_activation_per_layer = model_params_mb * 0.5  # Rough estimate

        # Calculate segments needed to fit in target memory
        max_activation_memory = target_memory_mb - model_params_mb - 1000  # Reserve 1GB for other ops
        if max_activation_memory <= 0:
            logger.warning("Target memory too low for model parameters alone")
            return max(2, n_layers // 4)  # Conservative fallback

        segments_needed = max(1, int(estimated_activation_per_layer * n_layers / max_activation_memory))
        optimal_segments = min(segments_needed, n_layers)  # Don't exceed number of layers

        logger.info(f"Memory optimization analysis:")
        logger.info(f"  Total GPU memory: {total_memory:.1f} MB")
        logger.info(f"  Target memory usage: {target_memory_mb:.1f} MB")
        logger.info(f"  Model parameters: {model_params_mb:.1f} MB")
        logger.info(f"  Estimated activation memory per layer: {estimated_activation_per_layer:.1f} MB")
        logger.info(f"  Recommended segments: {optimal_segments}")
        logger.info(f"  Logging strategy: segment boundaries only (reduces profiling overhead)")

        return optimal_segments

    def benchmark_checkpointing(self, sample_batch_size: int = 8, num_iterations: int = 5) -> dict:
        """
        Benchmark gradient checkpointing vs no checkpointing with optimized logging

        Args:
            sample_batch_size: Batch size for benchmarking
            num_iterations: Number of iterations to average over

        Returns:
            Dictionary with benchmark results including logging overhead analysis
        """
        if not torch.cuda.is_available():
            logger.warning("CUDA not available, benchmark may not be accurate")

        logger.info(f"Benchmarking gradient checkpointing with batch_size={sample_batch_size}, iterations={num_iterations}")
        logger.info("Using optimized logging (segment boundaries only for checkpointing)")

        # Create sample inputs
        device = next(self.parameters()).device
        sample_phonemes = torch.randint(1, self.vocab_size, (sample_batch_size, 50), device=device)
        sample_mels = torch.randn(sample_batch_size, 200, self.mel_dim, device=device)
        sample_durations = torch.randint(1, 5, (sample_batch_size, 50), device=device)
        sample_stop_targets = torch.zeros(sample_batch_size, 200, device=device)

        results = {}

        # Benchmark with checkpointing (optimized logging)
        original_checkpointing = self.gradient_checkpointing
        self.enable_gradient_checkpointing()
        self.train()

        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()

        times_with_gc = []
        for i in range(num_iterations):
            start_time = time.time()

            try:
                outputs = self.forward_training(
                    sample_phonemes, sample_mels, sample_durations.float(), sample_stop_targets
                )
                # Simulate backward pass
                loss = outputs[0].mean() + outputs[1].mean() + outputs[2].mean()
                loss.backward()
                torch.cuda.synchronize()

                times_with_gc.append(time.time() - start_time)

            except Exception as e:
                logger.error(f"Error in checkpointing benchmark iteration {i}: {e}")
                break

        memory_with_gc = torch.cuda.max_memory_allocated() / 1024**2

        # Benchmark without checkpointing (standard logging)
        self.disable_gradient_checkpointing()

        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()

        times_without_gc = []
        for i in range(num_iterations):
            start_time = time.time()

            try:
                outputs = self.forward_training(
                    sample_phonemes, sample_mels, sample_durations.float(), sample_stop_targets
                )
                loss = outputs[0].mean() + outputs[1].mean() + outputs[2].mean()
                loss.backward()
                torch.cuda.synchronize()

                times_without_gc.append(time.time() - start_time)

            except Exception as e:
                logger.error(f"Error in non-checkpointing benchmark iteration {i}: {e}")
                break

        memory_without_gc = torch.cuda.max_memory_allocated() / 1024**2

        # Restore original setting
        if original_checkpointing:
            self.enable_gradient_checkpointing()
        else:
            self.disable_gradient_checkpointing()

        # Calculate results
        avg_time_with_gc = sum(times_with_gc) / len(times_with_gc) if times_with_gc else float('inf')
        avg_time_without_gc = sum(times_without_gc) / len(times_without_gc) if times_without_gc else float('inf')

        results = {
            'gradient_checkpointing': {
                'avg_time_seconds': avg_time_with_gc,
                'peak_memory_mb': memory_with_gc,
                'successful_iterations': len(times_with_gc),
                'logging_strategy': 'segment_boundaries_only'
            },
            'no_checkpointing': {
                'avg_time_seconds': avg_time_without_gc,
                'peak_memory_mb': memory_without_gc,
                'successful_iterations': len(times_without_gc),
                'logging_strategy': 'all_layer_boundaries'
            },
            'comparison': {
                'time_overhead_pct': ((avg_time_with_gc - avg_time_without_gc) / avg_time_without_gc * 100) if avg_time_without_gc > 0 else 0,
                'memory_savings_mb': memory_without_gc - memory_with_gc,
                'memory_savings_pct': ((memory_without_gc - memory_with_gc) / memory_without_gc * 100) if memory_without_gc > 0 else 0,
                'logging_overhead_reduced': True
            },
            'optimization_notes': {
                'checkpointing_logging': 'Logs only at segment boundaries to reduce overhead',
                'standard_logging': 'Logs at individual layer boundaries (more detailed but higher overhead)',
                'profiling_impact': 'Reduced logging frequency in checkpointed regions improves performance'
            }
        }

        # Log results
        logger.info("Gradient Checkpointing Benchmark Results (Optimized Logging):")
        logger.info(f"  With Checkpointing: {avg_time_with_gc:.3f}s avg, {memory_with_gc:.1f} MB peak")
        logger.info(f"  Without Checkpointing: {avg_time_without_gc:.3f}s avg, {memory_without_gc:.1f} MB peak")
        logger.info(f"  Time Overhead: {results['comparison']['time_overhead_pct']:.1f}%")
        logger.info(f"  Memory Savings: {results['comparison']['memory_savings_mb']:.1f} MB ({results['comparison']['memory_savings_pct']:.1f}%)")
        logger.info(f"  Logging Optimization: Segment boundaries only (reduced overhead)")

        return results

    def get_logging_strategy_info(self) -> dict:
        """Get information about current logging strategy based on checkpointing state"""
        strategy_info = {
            'gradient_checkpointing_enabled': self.gradient_checkpointing,
            'checkpoint_segments': self.checkpoint_segments,
            'profiling_enabled': self.enable_profiling
        }

        if self.gradient_checkpointing:
            strategy_info.update({
                'encoder_logging': 'segment_boundaries',
                'decoder_logging': 'checkpoint_boundaries',
                'logging_frequency': f'Every {len(self.transformer_encoder_layers) // self.checkpoint_segments} encoder layers',
                'memory_overhead': 'minimal',
                'profiling_impact': 'reduced_overhead'
            })
        else:
            strategy_info.update({
                'encoder_logging': 'individual_layers',
                'decoder_logging': 'start_and_end',
                'logging_frequency': 'Every 2 encoder layers',
                'memory_overhead': 'standard',
                'profiling_impact': 'detailed_tracking'
            })

        return strategy_info
