#!/usr/bin/env python3
"""
HiFi-GAN Vocoder Implementation
Neural vocoder for converting mel spectrograms to audio
"""

import torch
import torch.nn as nn
import torch.nn.functional as F
try:
    from torch.nn.utils.parametrizations import weight_norm
    from torch.nn.utils import remove_weight_norm
except ImportError:
    # Fallback for older PyTorch versions
    from torch.nn.utils import weight_norm, remove_weight_norm
import json
import logging
from pathlib import Path
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)


class AttrDict(dict):
    """Dictionary that allows attribute access"""
    def __init__(self, *args, **kwargs):
        super(AttrDict, self).__init__(*args, **kwargs)
        self.__dict__ = self


class ResBlock(nn.Module):
    """Residual Block for HiFi-GAN"""

    def __init__(self, channels: int, kernel_size: int = 3, dilation: tuple = (1, 3, 5)):
        super(ResBlock, self).__init__()
        self.convs1 = nn.ModuleList([
            weight_norm(nn.Conv1d(channels, channels, kernel_size, 1, dilation=dilation[0],
                     padding=self._get_padding(kernel_size, dilation[0]))),
            weight_norm(nn.Conv1d(channels, channels, kernel_size, 1, dilation=dilation[1],
                     padding=self._get_padding(kernel_size, dilation[1]))),
            weight_norm(nn.Conv1d(channels, channels, kernel_size, 1, dilation=dilation[2],
                     padding=self._get_padding(kernel_size, dilation[2])))
        ])
        self.convs1.apply(self._init_weights)

        self.convs2 = nn.ModuleList([
            weight_norm(nn.Conv1d(channels, channels, kernel_size, 1, dilation=1,
                     padding=self._get_padding(kernel_size, 1))),
            weight_norm(nn.Conv1d(channels, channels, kernel_size, 1, dilation=1,
                     padding=self._get_padding(kernel_size, 1))),
            weight_norm(nn.Conv1d(channels, channels, kernel_size, 1, dilation=1,
                     padding=self._get_padding(kernel_size, 1)))
        ])
        self.convs2.apply(self._init_weights)

    def _init_weights(self, m):
        if isinstance(m, nn.Conv1d):
            nn.init.normal_(m.weight.data, 0.0, 0.01)

    def _get_padding(self, kernel_size: int, dilation: int = 1) -> int:
        return int((kernel_size * dilation - dilation) / 2)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        for c1, c2 in zip(self.convs1, self.convs2):
            xt = F.leaky_relu(x, 0.1)
            xt = c1(xt)
            xt = F.leaky_relu(xt, 0.1)
            xt = c2(xt)
            x = xt + x
        return x

    def remove_weight_norm(self):
        for l in self.convs1:
            remove_weight_norm(l)
        for l in self.convs2:
            remove_weight_norm(l)


class HiFiGANGenerator(nn.Module):
    """HiFi-GAN Generator implementation"""

    def __init__(self, h: AttrDict):
        super(HiFiGANGenerator, self).__init__()
        self.num_kernels = len(h.resblock_kernel_sizes)
        self.num_upsamples = len(h.upsample_rates)
        self.conv_pre = weight_norm(nn.Conv1d(80, h.upsample_initial_channel, 7, 1, padding=3))

        self.ups = nn.ModuleList()
        for i, (u, k) in enumerate(zip(h.upsample_rates, h.upsample_kernel_sizes)):
            self.ups.append(weight_norm(nn.ConvTranspose1d(
                h.upsample_initial_channel // (2**i),
                h.upsample_initial_channel // (2**(i+1)),
                k, u, padding=(k-u)//2
            )))

        self.resblocks = nn.ModuleList()
        for i in range(len(self.ups)):
            ch = h.upsample_initial_channel // (2**(i+1))
            for j, (k, d) in enumerate(zip(h.resblock_kernel_sizes, h.resblock_dilation_sizes)):
                self.resblocks.append(ResBlock(ch, k, d))

        self.conv_post = weight_norm(nn.Conv1d(ch, 1, 7, 1, padding=3))
        self.ups.apply(self._init_weights)
        self.conv_post.apply(self._init_weights)

    def _init_weights(self, m):
        if isinstance(m, (nn.Conv1d, nn.ConvTranspose1d)):
            nn.init.normal_(m.weight.data, 0.0, 0.01)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # Handle input shape: expect [batch, mel_channels, time] but often get [batch, time, mel_channels]
        if x.dim() == 3 and x.size(1) != 80 and x.size(2) == 80:
            # Input is [batch, time, mel_channels], transpose to [batch, mel_channels, time]
            x = x.transpose(1, 2)
        elif x.dim() == 2:
            # Input is [time, mel_channels], add batch dimension and transpose
            x = x.unsqueeze(0).transpose(1, 2)

        x = self.conv_pre(x)
        for i in range(self.num_upsamples):
            x = F.leaky_relu(x, 0.1)
            x = self.ups[i](x)
            xs = None
            for j in range(self.num_kernels):
                if xs is None:
                    xs = self.resblocks[i*self.num_kernels+j](x)
                else:
                    xs += self.resblocks[i*self.num_kernels+j](x)
            x = xs / self.num_kernels
        x = F.leaky_relu(x)
        x = self.conv_post(x)
        x = torch.tanh(x)
        return x

    def remove_weight_norm(self):
        remove_weight_norm(self.conv_pre)
        for l in self.ups:
            remove_weight_norm(l)
        for l in self.resblocks:
            l.remove_weight_norm()
        remove_weight_norm(self.conv_post)


class HiFiGANConfig:
    """HiFi-GAN configuration manager"""
    
    @staticmethod
    def get_default_config() -> AttrDict:
        """Get default HiFi-GAN configuration"""
        config = {
            "resblock": "1",
            "num_gpus": 0,
            "batch_size": 16,
            "learning_rate": 0.0002,
            "adam_b1": 0.8,
            "adam_b2": 0.99,
            "lr_decay": 0.999,
            "seed": 1234,
            "upsample_rates": [8, 8, 2, 2],
            "upsample_kernel_sizes": [16, 16, 4, 4],
            "upsample_initial_channel": 512,
            "resblock_kernel_sizes": [3, 7, 11],
            "resblock_dilation_sizes": [[1, 3, 5], [1, 3, 5], [1, 3, 5]],
            "segment_size": 8192,
            "num_mels": 80,
            "num_freq": 1025,
            "n_fft": 1024,
            "hop_size": 256,
            "win_size": 1024,
            "sampling_rate": 22050,
            "fmin": 0,
            "fmax": 8000,
            "fmax_for_loss": None
        }
        return AttrDict(config)
    
    @staticmethod
    def load_config(config_path: Path) -> AttrDict:
        """Load configuration from JSON file"""
        try:
            with open(config_path, 'r') as f:
                config_dict = json.load(f)
            return AttrDict(config_dict)
        except Exception as e:
            logger.warning(f"Failed to load config from {config_path}: {e}")
            logger.info("Using default configuration")
            return HiFiGANConfig.get_default_config()


def load_hifigan_model(
    model_path: Path, 
    config_path: Optional[Path] = None,
    device: str = "cpu"
) -> HiFiGANGenerator:
    """
    Load HiFi-GAN model from checkpoint
    
    Args:
        model_path: Path to the model checkpoint
        config_path: Optional path to config file (uses default if not provided)
        device: Device to load model on
        
    Returns:
        Loaded HiFiGANGenerator model
    """
    # Load configuration
    if config_path and config_path.exists():
        config = HiFiGANConfig.load_config(config_path)
    else:
        config = HiFiGANConfig.get_default_config()
        if config_path:
            logger.warning(f"Config file not found: {config_path}, using default")

    # Initialize generator
    generator = HiFiGANGenerator(config)

    # Load state dict
    state_dict = None

    # Try loading with weights_only=True first (PyTorch 2.6+ default)
    try:
        state_dict = torch.load(model_path, map_location=device, weights_only=True)
    except Exception as e:
        logger.warning(f"Failed to load with weights_only=True: {e}")
        logger.info("Attempting to load with weights_only=False...")

        try:
            # Fallback to weights_only=False for older checkpoints
            state_dict = torch.load(model_path, map_location=device, weights_only=False)
        except Exception as e2:
            logger.error(f"Failed to load checkpoint: {e2}")
            raise e2

    # Load the state dict into the generator
    try:
        if 'generator' in state_dict:
            generator.load_state_dict(state_dict['generator'])
        else:
            generator.load_state_dict(state_dict)
    except RuntimeError as e:
        if "weight_g" in str(e) or "weight_v" in str(e):
            # If still getting weight norm errors, try loading with strict=False
            logger.warning("Loading with strict=False due to weight normalization mismatch")
            if 'generator' in state_dict:
                generator.load_state_dict(state_dict['generator'], strict=False)
            else:
                generator.load_state_dict(state_dict, strict=False)
        else:
            raise e

    generator.eval()
    generator.to(device)
    
    logger.info(f"Loaded HiFi-GAN model from: {model_path}")
    return generator
