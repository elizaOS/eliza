from typing import Literal

AudioMimeType = Literal[
    "audio/wav",
    "audio/mpeg",
    "audio/ogg",
    "audio/flac",
    "audio/mp4",
    "audio/webm",
    "application/octet-stream",
]

_MAGIC_BYTES = {
    "wav_riff": bytes([0x52, 0x49, 0x46, 0x46]),  # "RIFF"
    "wav_wave": bytes([0x57, 0x41, 0x56, 0x45]),  # "WAVE"
    "mp3_id3": bytes([0x49, 0x44, 0x33]),  # "ID3"
    "ogg": bytes([0x4F, 0x67, 0x67, 0x53]),  # "OggS"
    "flac": bytes([0x66, 0x4C, 0x61, 0x43]),  # "fLaC"
    "ftyp": bytes([0x66, 0x74, 0x79, 0x70]),  # "ftyp" (mp4/m4a)
    "webm_ebml": bytes([0x1A, 0x45, 0xDF, 0xA3]),  # EBML header
}

_MIN_DETECTION_SIZE = 12


def detect_audio_mime_type(data: bytes) -> AudioMimeType:
    """
    Detect audio MIME type from binary data by checking magic bytes.

    Supports detection of:
    - WAV (RIFF/WAVE)
    - MP3 (ID3 tag or MPEG sync)
    - OGG (OggS container)
    - FLAC (fLaC)
    - M4A/MP4 (ftyp atom)
    - WebM (EBML header)

    Args:
        data: The audio data to analyze.

    Returns:
        The detected MIME type or 'application/octet-stream' if unknown.
    """
    if len(data) < _MIN_DETECTION_SIZE:
        return "application/octet-stream"

    # WAV: "RIFF" + size + "WAVE"
    if data[:4] == _MAGIC_BYTES["wav_riff"] and data[8:12] == _MAGIC_BYTES["wav_wave"]:
        return "audio/wav"

    # MP3: ID3 tag or MPEG frame sync
    if data[:3] == _MAGIC_BYTES["mp3_id3"]:
        return "audio/mpeg"
    if data[0] == 0xFF and (data[1] & 0xE0) == 0xE0:
        return "audio/mpeg"

    # OGG: "OggS"
    if data[:4] == _MAGIC_BYTES["ogg"]:
        return "audio/ogg"

    # FLAC: "fLaC"
    if data[:4] == _MAGIC_BYTES["flac"]:
        return "audio/flac"

    # M4A/MP4: "ftyp" at offset 4
    if data[4:8] == _MAGIC_BYTES["ftyp"]:
        return "audio/mp4"

    # WebM: EBML header
    if data[:4] == _MAGIC_BYTES["webm_ebml"]:
        return "audio/webm"

    return "application/octet-stream"


def get_extension_for_mime_type(mime_type: AudioMimeType) -> str:
    """
    Get the appropriate file extension for an audio MIME type.

    Args:
        mime_type: The MIME type.

    Returns:
        The file extension (without dot).
    """
    extensions: dict[AudioMimeType, str] = {
        "audio/wav": "wav",
        "audio/mpeg": "mp3",
        "audio/ogg": "ogg",
        "audio/flac": "flac",
        "audio/mp4": "m4a",
        "audio/webm": "webm",
        "application/octet-stream": "bin",
    }
    return extensions.get(mime_type, "bin")


def get_filename_for_data(data: bytes, base_name: str = "audio") -> str:
    """
    Generate a filename with appropriate extension based on audio data.

    Args:
        data: The audio data.
        base_name: Base name for the file.

    Returns:
        Filename with extension.
    """
    mime_type = detect_audio_mime_type(data)
    extension = get_extension_for_mime_type(mime_type)
    return f"{base_name}.{extension}"
