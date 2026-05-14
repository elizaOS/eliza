#!/usr/bin/env python3
"""
Kokoro English TTS Inference Script with HiFi-GAN Vocoder
Convert English text to speech using trained Kokoro model with neural vocoder
"""

import torch
import argparse
import pickle
import json
from pathlib import Path
from typing import List, Optional
import logging

# Import our training configuration, model and phoneme processor
from kokoro.model import KokoroModel
from data.english_phoneme_processor import EnglishPhonemeProcessor
from audio.vocoder_manager import VocoderManager
from audio.audio_utils import AudioUtils, PhonemeProcessorUtils

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class KokoroEnglishTTS:
    """Main TTS inference class for English with neural vocoder support."""

    def __init__(self, model_dir: str, device: str = None, vocoder_type: str = "hifigan", vocoder_path: str = None):
        self.model_dir = Path(model_dir)

        # Determine device
        self.device = AudioUtils.validate_device(device)
        logger.info(f"Using device: {self.device}")

        # Load configuration from model_config.json if available
        self._load_config()

        # Initialize utility classes
        self.audio_utils = AudioUtils(self.sample_rate)

        # Load phoneme processor
        self.phoneme_processor = self._load_phoneme_processor()

        # Load model
        self.model = self._load_model()

        # Initialize vocoder
        self.vocoder_manager = VocoderManager(vocoder_type, vocoder_path, self.device)

    def _load_config(self):
        """Load model configuration from JSON file"""
        config_path = self.model_dir / "model_config.json"

        if config_path.exists():
            try:
                with open(config_path, 'r') as f:
                    config = json.load(f)

                # Audio parameters
                self.sample_rate = config.get('sample_rate', 22050)
                self.hop_length = config.get('hop_length', 256)
                self.win_length = config.get('win_length', 1024)
                self.n_fft = config.get('n_fft', 1024)
                self.n_mels = config.get('n_mels', 80)
                self.f_min = config.get('f_min', 0.0)
                self.f_max = config.get('f_max', 8000.0)

                # Model architecture parameters
                self.hidden_dim = config.get('hidden_dim', 512)
                self.n_encoder_layers = config.get('n_encoder_layers', 6)
                self.n_decoder_layers = config.get('n_decoder_layers', 6)
                self.n_heads = config.get('n_heads', 8)
                self.encoder_ff_dim = config.get('encoder_ff_dim', 2048)
                self.decoder_ff_dim = config.get('decoder_ff_dim', 2048)
                self.encoder_dropout = config.get('encoder_dropout', 0.1)
                self.max_decoder_seq_len = config.get('max_decoder_seq_len', 4000)

                logger.info(f"Loaded model config from: {config_path}")
            except Exception as e:
                logger.warning(f"Error loading model config from {config_path}: {e}")
                logger.warning("Using default configuration values")
                self._set_default_config()
        else:
            logger.warning(f"Model config not found at {config_path}. Using default values.")
            logger.warning("This may cause issues if the model was trained with different parameters!")
            self._set_default_config()

    def _set_default_config(self):
        """Set default configuration values as fallback"""
        # Audio configuration (defaults)
        self.sample_rate = 22050
        self.hop_length = 256
        self.win_length = 1024
        self.n_fft = 1024
        self.n_mels = 80
        self.f_min = 0.0
        self.f_max = 8000.0

        # Model architecture (defaults)
        self.hidden_dim = 512
        self.n_encoder_layers = 6
        self.n_decoder_layers = 6
        self.n_heads = 8
        self.encoder_ff_dim = 2048
        self.decoder_ff_dim = 2048
        self.encoder_dropout = 0.1
        self.max_decoder_seq_len = 4000

    def _load_phoneme_processor(self) -> EnglishPhonemeProcessor:
        """Loads the English phoneme processor from the model directory."""
        processor_path = self.model_dir / "phoneme_processor.pkl"

        if processor_path.exists():
            try:
                with open(processor_path, 'rb') as f:
                    processor_data = pickle.load(f)
                processor = EnglishPhonemeProcessor.from_dict(processor_data)
                logger.info(f"Loaded English phoneme processor from: {processor_path}")
            except Exception as e:
                logger.error(f"Error loading phoneme processor from {processor_path}: {e}")
                raise
        else:
            logger.warning("Phoneme processor not found at expected path. Creating a new one. This might lead to issues if the model was trained with a different vocabulary.")
            processor = EnglishPhonemeProcessor()

        return processor

    def _load_model(self) -> KokoroModel:
        """Loads the trained Kokoro model with robust error handling."""
        final_model_path = self.model_dir / "kokoro_english_final.pth"
        checkpoint_files = sorted(list(self.model_dir.glob("checkpoint_epoch_*.pth")),
                                  key=lambda x: int(x.stem.split('_')[-1]))

        model_path = None
        if final_model_path.exists():
            model_path = final_model_path
            logger.info(f"Attempting to load final model: {model_path}")
        elif checkpoint_files:
            model_path = checkpoint_files[-1] # Use the latest checkpoint
            logger.info(f"Final model not found, loading latest checkpoint: {model_path}")
        else:
            raise FileNotFoundError(f"No model files found in {self.model_dir}. Ensure 'kokoro_english_final.pth' or 'checkpoint_epoch_*.pth' exists.")

        checkpoint = None
        try_methods = [
            lambda: torch.load(model_path, map_location='cpu', weights_only=True),
            lambda: torch.load(model_path, map_location='cpu', weights_only=False),
        ]

        # Try loading with various methods
        for i, load_func in enumerate(try_methods):
            try:
                checkpoint = load_func()
                logger.info(f"Successfully loaded checkpoint using method {i+1}.")
                break
            except Exception as e:
                logger.warning(f"Checkpoint load attempt {i+1} failed: {e}")

        if checkpoint is None:
            raise RuntimeError(f"Failed to load checkpoint from {model_path} with any attempted method. It might be corrupted or incompatible.")

        # Extract model state dictionary
        state_dict_to_load = None
        if 'model_state_dict' in checkpoint:
            state_dict_to_load = checkpoint['model_state_dict']
        elif 'model' in checkpoint:
            state_dict_to_load = checkpoint['model']
        elif isinstance(checkpoint, dict): # If the checkpoint itself is the state_dict
            state_dict_to_load = checkpoint

        if state_dict_to_load is None:
            raise RuntimeError("Checkpoint does not contain a recognized model state dictionary (expected 'model_state_dict' or 'model' key, or raw state dict).")

        # Use model parameters loaded from model_config.json
        vocab_size = len(self.phoneme_processor.phoneme_to_id)
        model = KokoroModel(
            vocab_size=vocab_size,
            mel_dim=self.n_mels,
            hidden_dim=self.hidden_dim,
            n_encoder_layers=self.n_encoder_layers,
            n_heads=self.n_heads,
            encoder_ff_dim=self.encoder_ff_dim,
            encoder_dropout=self.encoder_dropout,
            n_decoder_layers=self.n_decoder_layers,
            decoder_ff_dim=self.decoder_ff_dim,
            max_decoder_seq_len=self.max_decoder_seq_len,
            enable_profiling=getattr(self, 'enable_profiling', False)
        )

        # Filter and load state dict
        filtered_state_dict = {}
        model_keys = set(model.state_dict().keys())

        for k, v in state_dict_to_load.items():
            if k in model_keys:
                if model.state_dict()[k].shape == v.shape:
                    filtered_state_dict[k] = v
                else:
                    logger.warning(f"Skipping parameter '{k}' due to shape mismatch: checkpoint shape {v.shape}, model shape {model.state_dict()[k].shape}.")
            else:
                logger.warning(f"Skipping unknown key '{k}' from checkpoint. It might be an optimizer state or a deprecated parameter.")

        try:
            model.load_state_dict(filtered_state_dict, strict=True)
            logger.info("Model state dictionary loaded successfully (strict=True).")
        except RuntimeError as e:
            logger.warning(f"Failed to load model state dict strictly: {e}. Attempting non-strict load. This may indicate a mismatch between the model architecture and the loaded weights.")
            model.load_state_dict(filtered_state_dict, strict=False)
            logger.info("Model state dictionary loaded with strict=False.")

        model.to(self.device)
        model.eval() # Set model to evaluation mode

        logger.info(f"Model '{model_path.name}' loaded successfully with vocab_size={vocab_size}.")
        return model

    def text_to_speech(self, text: str, output_path: Optional[str] = None, debug: bool = False) -> torch.Tensor:
        """
        Convert English text to speech using the trained model.

        Args:
            text: Input text to convert
            output_path: Optional path to save audio
            debug: Enable detailed debugging output
        """
        if not text:
            logger.warning("Received empty text for conversion. Returning empty audio.")
            return torch.empty(0)

        logger.info(f"Converting text: '{text}'")

        try:
            # Step 1: Process text into phoneme sequence
            logger.info("=" * 60)
            logger.info("STEP 1: Text to Phonemes")
            logger.info("=" * 60)

            raw_processor_output = self.phoneme_processor.process_text(text)
            phoneme_sequence = PhonemeProcessorUtils.flatten_phoneme_output(raw_processor_output)

            if not phoneme_sequence:
                logger.error(f"Phoneme processor produced no phonemes for text: '{text}'. Conversion aborted.")
                raise ValueError("No phonemes generated from the input text.")

            logger.info(f"✓ Generated {len(phoneme_sequence)} phonemes")
            logger.info(f"Phonemes: {' '.join(phoneme_sequence)}")

            if debug:
                logger.info(f"Raw processor output structure: {type(raw_processor_output)}")
                logger.info(f"Phoneme sequence (full): {phoneme_sequence}")

            # Step 2: Convert phonemes to numerical indices
            logger.info("=" * 60)
            logger.info("STEP 2: Phonemes to Indices")
            logger.info("=" * 60)

            phoneme_indices = PhonemeProcessorUtils.phonemes_to_indices(
                phoneme_sequence, self.phoneme_processor.phoneme_to_id
            )
            logger.info(f"✓ Converted to {len(phoneme_indices)} indices")
            logger.info(f"Index range: [{min(phoneme_indices)}, {max(phoneme_indices)}]")
            logger.info(f"Vocab size: {len(self.phoneme_processor.phoneme_to_id)}")

            if debug:
                logger.info(f"Phoneme indices (full): {phoneme_indices}")
                # Check for unknown phonemes (index 1 = <unk>)
                unk_count = phoneme_indices.count(1)
                if unk_count > 0:
                    logger.warning(f"⚠ Found {unk_count} unknown phonemes (<unk>)!")

            # Convert to tensor and add batch dimension
            phoneme_tensor = torch.tensor(phoneme_indices, dtype=torch.long).unsqueeze(0).to(self.device)
            logger.info(f"Phoneme tensor shape: {phoneme_tensor.shape}")

            # Step 3: Generate mel spectrogram
            logger.info("=" * 60)
            logger.info("STEP 3: Model Inference (Phonemes → Mel)")
            logger.info("=" * 60)
            logger.info(f"Max length: 400 frames")
            logger.info(f"Stop threshold: 0.01")

            with torch.no_grad():
                mel_spec = self.model.forward_inference(
                    phoneme_indices=phoneme_tensor,
                    max_len=400,  # Conservative value for stability
                    stop_threshold=0.01,
                    text_padding_mask=None
                )

            # Remove batch dimension and move to CPU for vocoder
            mel_spec = mel_spec.squeeze(0).cpu()

            # CRITICAL: Transpose mel from (frames, mel_dim) to (mel_dim, frames) for vocoder
            # Model outputs (batch, frames, mel_dim), after squeeze we get (frames, mel_dim)
            # But vocoder expects (mel_dim, frames) - standard mel spectrogram format
            mel_spec = mel_spec.transpose(0, 1)

            logger.info(f"✓ Generated mel spectrogram")
            logger.info(f"Mel shape: {mel_spec.shape} (channels={mel_spec.shape[0]}, frames={mel_spec.shape[1]})")
            logger.info(f"Mel range: [{mel_spec.min().item():.3f}, {mel_spec.max().item():.3f}]")
            logger.info(f"Mel mean: {mel_spec.mean().item():.3f}, std: {mel_spec.std().item():.3f}")

            # Check for problematic mel values
            if debug:
                if torch.isnan(mel_spec).any():
                    logger.error("❌ CRITICAL: Mel spectrogram contains NaN values!")
                if torch.isinf(mel_spec).any():
                    logger.error("❌ CRITICAL: Mel spectrogram contains Inf values!")
                if mel_spec.max() > 5.0 or mel_spec.min() < -15.0:
                    logger.warning(f"⚠ WARNING: Mel range unusual! Expected [-11.5, 0.0], got [{mel_spec.min().item():.3f}, {mel_spec.max().item():.3f}]")

                # Check if mel is all zeros or constant
                if mel_spec.std() < 0.01:
                    logger.error(f"❌ CRITICAL: Mel spectrogram is nearly constant (std={mel_spec.std().item():.6f})! This will produce garbage audio.")

            # Step 4: Convert mel spectrogram to audio using the neural vocoder
            logger.info("=" * 60)
            logger.info("STEP 4: Vocoder (Mel → Audio)")
            logger.info("=" * 60)
            logger.info(f"Vocoder type: {self.vocoder_manager.vocoder_type}")

            audio = self.vocoder_manager.mel_to_audio(mel_spec)

            logger.info(f"✓ Generated audio")
            logger.info(f"Audio shape: {audio.shape}")
            logger.info(f"Audio duration: {len(audio) / self.sample_rate:.2f}s")
            logger.info(f"Audio range: [{audio.min():.3f}, {audio.max():.3f}]")

            if debug:
                if torch.isnan(audio).any():
                    logger.error("❌ CRITICAL: Audio contains NaN values!")
                if torch.isinf(audio).any():
                    logger.error("❌ CRITICAL: Audio contains Inf values!")
                if audio.abs().max() < 0.001:
                    logger.warning("⚠ WARNING: Audio amplitude very low (< 0.001)! May be silent.")
                if audio.std() < 0.001:
                    logger.warning("⚠ WARNING: Audio has very low variance (std < 0.001)! Likely garbage.")

            # Save audio if an output path is provided
            if output_path:
                self.audio_utils.save_audio(audio, output_path)
                logger.info(f"✓ Audio saved to: {output_path}")

            logger.info("=" * 60)
            logger.info("INFERENCE COMPLETE")
            logger.info("=" * 60)

            return audio

        except Exception as e:
            logger.error(f"❌ Error in text_to_speech: {e}")
            import traceback
            logger.error(traceback.format_exc())
            raise

    def batch_text_to_speech(self, texts: List[str], output_dir: str, debug: bool = False):
        """Converts multiple texts to speech, saving each to the specified output directory."""
        output_dir_path = Path(output_dir)
        output_dir_path.mkdir(parents=True, exist_ok=True)

        for i, text in enumerate(texts):
            output_path = output_dir_path / f"output_{i:03d}.wav"
            try:
                self.text_to_speech(text, str(output_path), debug=debug)
                logger.info(f"Successfully converted text {i+1} to {output_path}")
            except Exception as e:
                logger.error(f"Failed to convert text '{text}' (item {i+1}): {e}")

def parse_arguments():
    """Parses command line arguments for the TTS inference script."""
    parser = argparse.ArgumentParser(
        description="Kokoro English TTS Inference Script with Neural Vocoder",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Convert a single text with the default HiFi-GAN vocoder (recommended for quality)
  python inference_english.py --model ./kokoro_english_model --text "Hello, how are you today?" --output hello.wav

  # Use a custom HiFi-GAN model path
  python inference_english.py --model ./kokoro_english_model --text "Hello world" --vocoder-path ./my_hifigan_model.pth

  # Fallback to Griffin-Lim vocoder (lower quality, but doesn't require vocoder model)
  python inference_english.py --model ./kokoro_english_model --text "Hello world" --vocoder griffin_lim

  # Convert text from a file
  python inference_english.py --model ./kokoro_english_model --text-file input.txt --output file_output.wav

  # Run in interactive mode
  python inference_english.py --model ./kokoro_english_model --interactive
        """
    )

    parser.add_argument(
        '--model', '-m',
        type=str,
        required=True,
        help='Path to the trained Kokoro model directory (containing .pth and phoneme_processor.pkl).'
    )

    parser.add_argument(
        '--text', '-t',
        type=str,
        help='Single text string to convert to speech.'
    )

    parser.add_argument(
        '--text-file', '-f',
        type=str,
        help='Path to a file containing text(s) to convert. Each line will be processed if batch mode is used.'
    )

    parser.add_argument(
        '--output', '-o',
        type=str,
        default='output.wav',
        help='Output audio file path for single text conversion (default: output.wav). For --text-file, this will be overridden by batch naming.'
    )

    parser.add_argument(
        '--interactive', '-i',
        action='store_true',
        help='Enable interactive mode, allowing manual text input for continuous conversion.'
    )

    parser.add_argument(
        '--device',
        type=str,
        choices=['cpu', 'cuda', 'mps'],
        help='Explicit device to use for inference (e.g., "cuda", "cpu", "mps"). Auto-detected if not specified.'
    )

    parser.add_argument(
        '--vocoder',
        type=str,
        choices=['hifigan', 'griffin_lim'],
        default='hifigan',
        help='Type of vocoder to use: "hifigan" (neural) or "griffin_lim" (algorithmic). Default is hifigan.'
    )

    parser.add_argument(
        '--vocoder-path',
        type=str,
        help='Path to a custom HiFi-GAN vocoder model checkpoint (.pt or .pth) if not using the default or if a specific one is required.'
    )

    parser.add_argument(
        '--debug',
        action='store_true',
        help='Enable detailed debugging output showing mel statistics, phoneme analysis, etc.'
    )

    return parser.parse_args()

def main():
    """Main execution function for the Kokoro English TTS inference script."""
    args = parse_arguments()

    try:
        tts = KokoroEnglishTTS(
            model_dir=args.model,
            device=args.device,
            vocoder_type=args.vocoder,
            vocoder_path=args.vocoder_path
        )
    except Exception as e:
        logger.critical(f"Fatal error during TTS system initialization: {e}")
        exit(1)

    if args.interactive:
        logger.info("\n--- Interactive Mode ---")
        logger.info("Enter English text to convert to speech. Type 'quit' or 'exit' to end.")
        while True:
            try:
                text_input = input("\nEnter English text: ").strip()
                if text_input.lower() in ['quit', 'exit', 'q']:
                    logger.info("Exiting interactive mode.")
                    break
                if not text_input:
                    continue

                # Generate a unique output filename for interactive mode
                output_path_interactive = f"interactive_output_{abs(hash(text_input)) % 10000}.wav"
                tts.text_to_speech(text_input, output_path_interactive, debug=args.debug)
                print(f"Audio saved to: {output_path_interactive}")

            except KeyboardInterrupt:
                logger.info("Interactive mode interrupted by user (Ctrl+C). Exiting.")
                break
            except ValueError as ve:
                logger.error(f"Input Error: {ve}")
            except RuntimeError as re:
                logger.error(f"Runtime Error during conversion: {re}")
            except Exception as e:
                logger.error(f"An unexpected error occurred during interactive conversion: {e}")

    elif args.text:
        # Single text conversion
        try:
            tts.text_to_speech(args.text, args.output, debug=args.debug)
            logger.info(f"Successfully converted text to {args.output}")
        except ValueError as ve:
            logger.error(f"Error converting text '{args.text}': {ve}")
        except RuntimeError as re:
            logger.error(f"Runtime Error during conversion of '{args.text}': {re}")
        except Exception as e:
            logger.error(f"An unexpected error occurred during single text conversion: {e}")

    elif args.text_file:
        # Text file conversion
        try:
            with open(args.text_file, 'r', encoding='utf-8') as f:
                texts_from_file = [line.strip() for line in f if line.strip()]

            if not texts_from_file:
                logger.warning(f"Text file '{args.text_file}' is empty or contains no valid lines.")
                return

            output_dir_for_batch = Path(args.output).parent if Path(args.output).suffix else args.output
            if not Path(output_dir_for_batch).is_dir():
                output_dir_for_batch = Path("./batch_outputs") # Default to a directory if not specified properly
                logger.info(f"Output for batch text will be saved to '{output_dir_for_batch}'")

            tts.batch_text_to_speech(texts_from_file, str(output_dir_for_batch), debug=args.debug)
            logger.info(f"Batch conversion complete. Audio files saved to {output_dir_for_batch}")

        except FileNotFoundError:
            logger.error(f"Error: Text file not found at '{args.text_file}'")
        except Exception as e:
            logger.error(f"An error occurred during text file processing: {e}")

    else:
        logger.error("No input provided. Please use --text, --text-file, or --interactive.")
        parse_arguments().print_help()

if __name__ == "__main__":
    main()
