#!/usr/bin/env python3
"""
VocoderManager - Handles different vocoder backends for TTS inference
Supports HiFi-GAN and Griffin-Lim vocoders
"""

import torch
import torchaudio
import requests
import logging
from pathlib import Path
from typing import Optional, Dict
from urllib.parse import urlparse

# Import vocoder modules
from .hifigan_vocoder import load_hifigan_model

logger = logging.getLogger(__name__)


class VocoderManager:
    """Manages different vocoder backends"""

    HIFIGAN_URLS = {
        # Universal HiFi-GAN models (22kHz) - using direct download links
        "universal_v1": {
            "model": "https://drive.usercontent.google.com/download?id=1qpgI41wNXFcH-iKq1Y42JlBC9j0je8PW&confirm=t",
            "config": "https://drive.usercontent.google.com/download?id=1pAB2kQunkDuv6W5fcJiQ0CY8xcJKB22e&confirm=t"
        },
        # LJ Speech model (good for general purpose)
        "ljspeech": {
            "model": "https://drive.usercontent.google.com/download?id=1-EdH0t0loc6vPiuVtXdhsDtzygWNSNZx&confirm=t",
            "config": "https://drive.usercontent.google.com/download?id=1Jt_imitfckTfM9TPhT4TQKPUgkcGhv5f&confirm=t"
        }
    }

    def __init__(self, vocoder_type: str = "hifigan", vocoder_path: Optional[str] = None, device: str = "cpu"):
        self.vocoder_type = vocoder_type.lower()
        self.device = device
        self.vocoder = None

        if vocoder_type == "hifigan":
            self.vocoder = self._load_hifigan(vocoder_path)
        elif vocoder_type == "griffin_lim":
            self.vocoder = self._setup_griffin_lim()
        else:
            raise ValueError(f"Unsupported vocoder type: {vocoder_type}")

    def _download_file(self, url: str, filepath: Path):
        """Download file with progress"""
        logger.info(f"Downloading {filepath.name}...")
        response = requests.get(url, stream=True)
        response.raise_for_status()

        total_size = int(response.headers.get('content-length', 0))
        with open(filepath, 'wb') as f:
            downloaded = 0
            for chunk in response.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total_size > 0:
                        percent = (downloaded / total_size) * 100
                        print(f"\rProgress: {percent:.1f}%", end='')
        print()  # New line after progress

    def _load_hifigan(self, vocoder_path: Optional[str] = None) -> torch.nn.Module:
        """Load HiFi-GAN vocoder using the separated module"""
        if vocoder_path and Path(vocoder_path).exists():
            # Load custom HiFi-GAN model
            model_path = Path(vocoder_path)
            if model_path.is_dir():
                generator_path = model_path / "generator.pth"
                config_path = model_path / "config.json"
            else:
                generator_path = model_path
                config_path = model_path.parent / "config.json"

            try:
                generator = load_hifigan_model(generator_path, config_path, self.device)
                logger.info(f"Loaded custom HiFi-GAN from: {vocoder_path}")
                return generator
            except Exception as e:
                logger.warning(f"Failed to load custom HiFi-GAN: {e}")
                logger.info("Falling back to pre-trained model")

        # Try to load pre-trained model or download
        vocoder_dir = Path("./vocoder_models/hifigan")
        vocoder_dir.mkdir(parents=True, exist_ok=True)

        model_name = "universal_v1"  # Default to universal model
        model_file = vocoder_dir / f"generator_{model_name}.pth"
        config_file = vocoder_dir / f"config_{model_name}.json"

        # Download if not exists
        if not model_file.exists() or not config_file.exists():
            logger.info(f"Downloading HiFi-GAN {model_name} model...")
            try:
                if not model_file.exists():
                    self._download_file(self.HIFIGAN_URLS[model_name]["model"], model_file)
                if not config_file.exists():
                    self._download_file(self.HIFIGAN_URLS[model_name]["config"], config_file)
            except Exception as e:
                logger.warning(f"Failed to download HiFi-GAN model: {e}")
                logger.info("Falling back to Griffin-Lim")
                return self._setup_griffin_lim()

        # Load downloaded model
        try:
            generator = load_hifigan_model(model_file, config_file, self.device)
            logger.info(f"Loaded pre-trained HiFi-GAN {model_name}")
            return generator
        except Exception as e:
            logger.warning(f"Failed to load HiFi-GAN: {e}")
            logger.info("Falling back to Griffin-Lim")
            return self._setup_griffin_lim()

    def _setup_griffin_lim(self):
        """Setup Griffin-Lim as fallback with device compatibility"""
        logger.info("Using Griffin-Lim vocoder")

        # For MPS device compatibility, create Griffin-Lim on CPU initially
        # and move to device later if supported
        griffin_lim = torchaudio.transforms.GriffinLim(
            n_fft=1024,
            hop_length=256,
            win_length=1024,
            power=2.0,
            n_iter=60  # More iterations for better quality
        )

        # Try to move to target device, fallback to CPU if not supported
        try:
            griffin_lim = griffin_lim.to(self.device)
        except Exception as e:
            logger.warning(f"Griffin-Lim not fully compatible with {self.device}, using CPU fallback for some operations: {e}")
            griffin_lim = griffin_lim.to("cpu")

        return griffin_lim

    def mel_to_audio(self, mel_spec: torch.Tensor) -> torch.Tensor:
        """Convert mel spectrogram to audio"""
        if self.vocoder_type == "hifigan":
            return self._hifigan_inference(mel_spec)
        elif self.vocoder_type == "griffin_lim":
            return self._griffin_lim_inference(mel_spec)
        else:
            raise ValueError(f"Unknown vocoder type: {self.vocoder_type}")

    def _hifigan_inference(self, mel_spec: torch.Tensor) -> torch.Tensor:
        """HiFi-GAN inference"""
        if isinstance(self.vocoder, torchaudio.transforms.GriffinLim):
            # Fallback to Griffin-Lim if HiFi-GAN failed to load
            return self._griffin_lim_inference(mel_spec)

        with torch.no_grad():
            # Ensure mel_spec is on the right device and has the right shape
            mel_spec = mel_spec.to(self.device)

            if len(mel_spec.shape) == 2:  # (n_mels, time)
                mel_spec = mel_spec.unsqueeze(0)  # (1, n_mels, time)
            elif len(mel_spec.shape) == 3 and mel_spec.shape[0] != 1:  # (batch, time, n_mels)
                mel_spec = mel_spec.transpose(1, 2)  # (batch, n_mels, time)

            # Generate audio
            audio = self.vocoder(mel_spec)

            if len(audio.shape) == 3:  # Remove batch dimension if present
                audio = audio.squeeze(0)
            if len(audio.shape) == 2:  # Remove channel dimension if present
                audio = audio.squeeze(0)

        return audio.cpu()

    def _griffin_lim_inference(self, mel_spec: torch.Tensor) -> torch.Tensor:
        """Griffin-Lim inference with device compatibility handling"""
        # Convert log mel to linear scale
        mel_spec = torch.exp(mel_spec)

        # Transpose to get correct shape: (time, n_mels) -> (n_mels, time)
        if len(mel_spec.shape) == 2 and mel_spec.shape[1] == 80:
            mel_spec = mel_spec.transpose(0, 1)

        # Handle MPS device incompatibility with InverseMelScale
        device_for_mel_ops = "cpu" if self.device == "mps" else self.device

        # Convert mel spectrogram back to linear magnitude spectrogram
        inverse_mel_scale = torchaudio.transforms.InverseMelScale(
            n_stft=513,
            n_mels=80,
            sample_rate=22050,
            f_min=0.0,
            f_max=8000.0
        ).to(device_for_mel_ops)

        # Move mel_spec to compatible device for inverse transform
        mel_spec_for_inverse = mel_spec.to(device_for_mel_ops)
        linear_spec = inverse_mel_scale(mel_spec_for_inverse)

        # Move back to original device for Griffin-Lim if needed
        if device_for_mel_ops != self.device:
            linear_spec = linear_spec.to(self.device)

        # Convert linear magnitude spectrogram to audio using Griffin-Lim
        audio = self.vocoder(linear_spec)

        return audio.cpu()
