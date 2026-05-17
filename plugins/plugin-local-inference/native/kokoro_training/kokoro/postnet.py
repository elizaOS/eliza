"""
PostNet: Convolutional network for mel spectrogram refinement

Based on Tacotron 2 architecture - adds fine detail to coarse mel predictions.
"""

import torch
import torch.nn as nn


class Postnet(nn.Module):
    """
    PostNet: Stack of 1-D convolution layers for mel spectrogram refinement

    The PostNet refines coarse mel spectrogram predictions by:
    1. Capturing temporal dependencies between frames (via convolutions)
    2. Modeling frequency-domain correlations (between mel bins)
    3. Adding fine harmonic structure (formants, pitch details)

    Architecture from Tacotron 2:
    - 5 convolutional layers (mel_dim → 512 → 512 → 512 → 512 → mel_dim)
    - Kernel size 5 (captures ~50ms context at 10ms frame rate)
    - Batch normalization + Tanh activation
    - Dropout for regularization

    Usage:
        mel_coarse = linear_projection(decoder_out)
        mel_residual = postnet(mel_coarse)
        mel_final = mel_coarse + mel_residual  # Residual connection
    """

    def __init__(
        self,
        mel_dim: int = 80,
        postnet_dim: int = 512,
        n_layers: int = 5,
        kernel_size: int = 5,
        dropout: float = 0.5
    ):
        """
        Initialize PostNet

        Args:
            mel_dim: Number of mel frequency bins (80 for standard mel spectrograms)
            postnet_dim: Hidden dimension for intermediate layers
            n_layers: Number of convolutional layers (typically 3-5)
            kernel_size: Convolution kernel size (5 captures good context)
            dropout: Dropout probability for regularization
        """
        super().__init__()

        self.mel_dim = mel_dim
        self.postnet_dim = postnet_dim
        self.n_layers = n_layers

        self.convolutions = nn.ModuleList()

        # First layer: mel_dim → postnet_dim
        # NOTE: Using BatchNorm (standard for TTS). Requires batch_size >= 2 for training.
        self.convolutions.append(
            nn.Sequential(
                nn.Conv1d(
                    mel_dim, postnet_dim,
                    kernel_size=kernel_size,
                    stride=1,
                    padding=(kernel_size - 1) // 2,
                    bias=False
                ),
                nn.BatchNorm1d(postnet_dim),
                nn.Tanh(),
                nn.Dropout(dropout)
            )
        )

        # Middle layers: postnet_dim → postnet_dim
        for _ in range(n_layers - 2):
            self.convolutions.append(
                nn.Sequential(
                    nn.Conv1d(
                        postnet_dim, postnet_dim,
                        kernel_size=kernel_size,
                        stride=1,
                        padding=(kernel_size - 1) // 2,
                        bias=False
                    ),
                    nn.BatchNorm1d(postnet_dim),
                    nn.Tanh(),
                    nn.Dropout(dropout)
                )
            )

        # Last layer: postnet_dim → mel_dim (no activation - residual addition)
        self.convolutions.append(
            nn.Sequential(
                nn.Conv1d(
                    postnet_dim, mel_dim,
                    kernel_size=kernel_size,
                    stride=1,
                    padding=(kernel_size - 1) // 2,
                    bias=False
                ),
                nn.BatchNorm1d(mel_dim),
                nn.Dropout(dropout)
            )
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """
        Forward pass through PostNet

        Args:
            x: Coarse mel spectrogram (batch, frames, mel_dim)

        Returns:
            Residual to add to coarse prediction (batch, frames, mel_dim)
        """
        # Conv1d expects: (batch, channels, length)
        # Input is: (batch, frames, mel_dim)
        x = x.transpose(1, 2)  # (batch, mel_dim, frames)

        # Apply convolutional layers
        for conv in self.convolutions:
            x = conv(x)

        # Transpose back: (batch, frames, mel_dim)
        x = x.transpose(1, 2)

        return x


class LightweightPostnet(nn.Module):
    """
    Lightweight PostNet with fewer layers and smaller hidden dim

    Faster training and less memory, but still much better than single linear layer.
    Good for:
    - Faster experimentation
    - Resource-constrained training
    - Models that already have strong decoder
    """

    def __init__(
        self,
        mel_dim: int = 80,
        postnet_dim: int = 256,
        n_layers: int = 3,
        kernel_size: int = 5,
        dropout: float = 0.3
    ):
        super().__init__()

        self.convolutions = nn.ModuleList()

        # All layers use same dimension for simplicity
        dims = [mel_dim] + [postnet_dim] * (n_layers - 1) + [mel_dim]

        for i in range(n_layers):
            in_dim = dims[i]
            out_dim = dims[i + 1]

            # Last layer has no activation
            if i == n_layers - 1:
                self.convolutions.append(
                    nn.Sequential(
                        nn.Conv1d(
                            in_dim, out_dim,
                            kernel_size=kernel_size,
                            padding=(kernel_size - 1) // 2
                        ),
                        nn.Dropout(dropout)
                    )
                )
            else:
                self.convolutions.append(
                    nn.Sequential(
                        nn.Conv1d(
                            in_dim, out_dim,
                            kernel_size=kernel_size,
                            padding=(kernel_size - 1) // 2
                        ),
                        nn.ReLU(),
                        nn.Dropout(dropout)
                    )
                )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Forward pass"""
        x = x.transpose(1, 2)  # (batch, mel_dim, frames)

        for conv in self.convolutions:
            x = conv(x)

        x = x.transpose(1, 2)  # (batch, frames, mel_dim)
        return x
