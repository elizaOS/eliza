import logging
import struct
from typing import Protocol

from ..sam_engine import SamEngine
from ..types import DEFAULT_SAM_OPTIONS, SamTTSOptions

logger = logging.getLogger(__name__)


class HardwareBridge(Protocol):
    async def send_audio_data(self, audio_buffer: bytes) -> None: ...


class Runtime(Protocol):
    def get_service(self, service_type: str) -> object | None: ...


class SamTTSService:
    service_type = "SAM_TTS"

    def __init__(self, runtime: Runtime | None = None):
        self.runtime = runtime

    @classmethod
    async def start(cls, runtime: Runtime) -> "SamTTSService":
        logger.info("[SAM-TTS] Service initialized")
        return cls(runtime)

    async def stop(self) -> None:
        logger.info("[SAM-TTS] Service stopped")

    def generate_audio(self, text: str, options: SamTTSOptions | None = None) -> bytes:
        opts = options or DEFAULT_SAM_OPTIONS

        logger.info(f'[SAM-TTS] Synthesizing: "{text[:50]}{"..." if len(text) > 50 else ""}"')

        sam = SamEngine(
            speed=opts.speed,
            pitch=opts.pitch,
            throat=opts.throat,
            mouth=opts.mouth,
        )

        audio = sam.buf8(text)
        logger.info(f"[SAM-TTS] Generated {len(audio)} bytes")
        return audio

    async def speak_text(self, text: str, options: SamTTSOptions | None = None) -> bytes:
        audio = self.generate_audio(text, options)
        wav = self.create_wav_buffer(audio)

        if self.runtime:
            bridge = self.runtime.get_service("hardwareBridge")
            if bridge and hasattr(bridge, "send_audio_data"):
                logger.info("[SAM-TTS] Sending to hardware bridge...")
                await bridge.send_audio_data(wav)  # type: ignore
                logger.info("[SAM-TTS] Audio sent")

        return audio

    def create_wav_buffer(self, audio_data: bytes, sample_rate: int = 22050) -> bytes:
        data_size = len(audio_data)

        header = bytearray()
        header.extend(b"RIFF")
        header.extend(struct.pack("<I", 36 + data_size))
        header.extend(b"WAVE")
        header.extend(b"fmt ")
        header.extend(struct.pack("<I", 16))
        header.extend(struct.pack("<H", 1))
        header.extend(struct.pack("<H", 1))
        header.extend(struct.pack("<I", sample_rate))
        header.extend(struct.pack("<I", sample_rate))
        header.extend(struct.pack("<H", 1))
        header.extend(struct.pack("<H", 8))
        header.extend(b"data")
        header.extend(struct.pack("<I", data_size))

        return bytes(header) + audio_data

    @property
    def capability_description(self) -> str:
        return "SAM TTS: Retro 1980s text-to-speech synthesis"
