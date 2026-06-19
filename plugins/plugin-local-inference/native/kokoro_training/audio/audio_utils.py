#!/usr/bin/env python3
"""
AudioUtils - Utilities for audio processing and saving
Handles multiple audio saving backends with fallbacks
"""

import torch
import torchaudio
import numpy as np
import soundfile as sf
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


class AudioUtils:
    """Utility class for audio processing operations"""

    def __init__(self, sample_rate: int = 22050):
        self.sample_rate = sample_rate

    @staticmethod
    def normalize_audio(audio: torch.Tensor) -> torch.Tensor:
        """Normalize audio to prevent clipping"""
        return audio / torch.max(torch.abs(audio))

    @staticmethod
    def ensure_mono(audio: torch.Tensor) -> torch.Tensor:
        """Ensure audio is mono (1D tensor)"""
        if len(audio.shape) == 3:  # Remove batch dimension if present
            audio = audio.squeeze(0)
        if len(audio.shape) == 2:  # Remove channel dimension if present
            audio = audio.squeeze(0)
        return audio

    def save_audio(self, audio: torch.Tensor, output_path: str) -> bool:
        """Save audio with multiple fallback methods"""
        # Ensure audio is properly formatted
        audio = self.ensure_mono(audio)
        audio = self.normalize_audio(audio)
        
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        # Try multiple saving methods
        success = (
            self._save_with_torchaudio(audio, output_path) or
            self._save_with_soundfile(audio, output_path) or
            self._save_with_scipy(audio, output_path) or
            self._save_as_numpy(audio, output_path)
        )

        if not success:
            logger.error("All audio saving methods failed")
            raise RuntimeError("Could not save audio file with any method")

        return success

    def _save_with_torchaudio(self, audio: torch.Tensor, output_path: Path) -> bool:
        """Try saving with torchaudio"""
        try:
            torchaudio.save(str(output_path), audio.unsqueeze(0), self.sample_rate, format="wav")
            logger.info(f"Audio saved using torchaudio: {output_path}")
            return True
        except Exception as e:
            logger.warning(f"torchaudio.save failed: {e}")
            return False

    def _save_with_soundfile(self, audio: torch.Tensor, output_path: Path) -> bool:
        """Try saving with soundfile"""
        try:
            audio_np = audio.numpy()
            sf.write(str(output_path), audio_np, self.sample_rate)
            logger.info(f"Audio saved using soundfile: {output_path}")
            return True
        except Exception as e:
            logger.warning(f"soundfile failed: {e}")
            return False

    def _save_with_scipy(self, audio: torch.Tensor, output_path: Path) -> bool:
        """Try saving with scipy"""
        try:
            from scipy.io import wavfile
            # Convert to 16-bit integer
            audio_np = audio.numpy()
            audio_int16 = (audio_np * 32767).astype(np.int16)
            wavfile.write(str(output_path), self.sample_rate, audio_int16)
            logger.info(f"Audio saved using scipy: {output_path}")
            return True
        except Exception as e:
            logger.warning(f"scipy failed: {e}")
            return False

    def _save_as_numpy(self, audio: torch.Tensor, output_path: Path) -> bool:
        """Save as numpy array (debugging fallback)"""
        try:
            audio_np = audio.numpy()
            numpy_path = output_path.with_suffix('.npy')
            np.save(numpy_path, audio_np)
            logger.info(f"Audio saved as numpy array: {numpy_path}")
            logger.info("Note: You can convert the .npy file to WAV using external tools")
            return True
        except Exception as e:
            logger.warning(f"numpy save failed: {e}")
            return False

    @staticmethod
    def detect_device() -> str:
        """Auto-detect the best available device"""
        if torch.backends.mps.is_available():
            return "mps"
        elif torch.cuda.is_available():
            return "cuda"
        else:
            return "cpu"

    @staticmethod
    def validate_device(device: Optional[str]) -> str:
        """Validate and return appropriate device"""
        if device is None:
            return AudioUtils.detect_device()
        
        if device == "cuda" and not torch.cuda.is_available():
            logger.warning("CUDA requested but not available, falling back to CPU")
            return "cpu"
        elif device == "mps" and not torch.backends.mps.is_available():
            logger.warning("MPS requested but not available, falling back to CPU")
            return "cpu"
        
        return device


class PhonemeProcessorUtils:
    """Helper class for phoneme processing operations"""

    @staticmethod
    def flatten_phoneme_output(raw_output) -> list:
        """Flatten phoneme processor output into a single list of phoneme strings"""
        phoneme_sequence = []
        
        if isinstance(raw_output, list):
            for item in raw_output:
                if isinstance(item, str):
                    # Single phoneme string
                    phoneme_sequence.append(item)
                elif isinstance(item, list):
                    # List of phonemes
                    for sub_item in item:
                        if isinstance(sub_item, str):
                            phoneme_sequence.append(sub_item)
                        elif isinstance(sub_item, list):
                            # Handle deeper nesting
                            for deepest_item in sub_item:
                                if isinstance(deepest_item, str):
                                    phoneme_sequence.append(deepest_item)
                                else:
                                    logger.warning(f"Unexpected item type in deepest level: {type(deepest_item)} - {deepest_item}")
                        else:
                            logger.warning(f"Unexpected item type in sub_item: {type(sub_item)} - {sub_item}")
                elif isinstance(item, tuple) and len(item) == 3:
                    # Tuple format: (word, word_phonemes, stress_info)
                    if isinstance(item[1], list):
                        for sub_phoneme in item[1]:
                            if isinstance(sub_phoneme, str):
                                phoneme_sequence.append(sub_phoneme)
                            else:
                                logger.warning(f"Unexpected phoneme type in tuple's phoneme list: {type(sub_phoneme)} - {sub_phoneme}")
                    else:
                        logger.warning(f"Unexpected type for word_phonemes in tuple: {type(item[1])} - {item[1]}")
                else:
                    logger.warning(f"Unexpected item type from phoneme processor: {type(item)} - {item}")
        else:
            logger.error(f"Phoneme processor returned unexpected top-level type: {type(raw_output)}. Expected a list.")
            raise TypeError("Phoneme processor output is not a list.")

        return phoneme_sequence

    @staticmethod
    def phonemes_to_indices(phoneme_sequence: list, phoneme_to_id: dict) -> list:
        """Convert phoneme strings to indices using vocabulary"""
        phoneme_indices = [
            phoneme_to_id[p]
            for p in phoneme_sequence
            if p in phoneme_to_id
        ]
        
        if not phoneme_indices:
            logger.error("No valid phoneme indices generated. Check phoneme processor and vocabulary.")
            raise ValueError("No valid phoneme indices generated.")
        
        return phoneme_indices
