#![allow(missing_docs)]

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioMimeType {
    Wav,
    Mpeg,
    Ogg,
    Flac,
    Mp4,
    Webm,
    Unknown,
}

impl AudioMimeType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Wav => "audio/wav",
            Self::Mpeg => "audio/mpeg",
            Self::Ogg => "audio/ogg",
            Self::Flac => "audio/flac",
            Self::Mp4 => "audio/mp4",
            Self::Webm => "audio/webm",
            Self::Unknown => "application/octet-stream",
        }
    }

    pub fn extension(&self) -> &'static str {
        match self {
            Self::Wav => "wav",
            Self::Mpeg => "mp3",
            Self::Ogg => "ogg",
            Self::Flac => "flac",
            Self::Mp4 => "m4a",
            Self::Webm => "webm",
            Self::Unknown => "bin",
        }
    }
}

/// Minimum buffer size for format detection.
const MIN_DETECTION_SIZE: usize = 12;

/// Magic bytes for WAV files.
const WAV_RIFF: &[u8] = &[0x52, 0x49, 0x46, 0x46]; // "RIFF"
const WAV_WAVE: &[u8] = &[0x57, 0x41, 0x56, 0x45]; // "WAVE"

/// Magic bytes for MP3 ID3 tag.
const MP3_ID3: &[u8] = &[0x49, 0x44, 0x33]; // "ID3"

/// Magic bytes for OGG.
const OGG_HEADER: &[u8] = &[0x4F, 0x67, 0x67, 0x53]; // "OggS"

/// Magic bytes for FLAC.
const FLAC_HEADER: &[u8] = &[0x66, 0x4C, 0x61, 0x43]; // "fLaC"

/// Magic bytes for MP4/M4A ftyp.
const FTYP_HEADER: &[u8] = &[0x66, 0x74, 0x79, 0x70]; // "ftyp"

/// Magic bytes for WebM EBML header.
const WEBM_EBML: &[u8] = &[0x1A, 0x45, 0xDF, 0xA3];

/// Detect audio MIME type from binary data by checking magic bytes.
///
/// Supports detection of:
/// - WAV (RIFF/WAVE)
/// - MP3 (ID3 tag or MPEG sync)
/// - OGG (OggS container)
/// - FLAC (fLaC)
/// - M4A/MP4 (ftyp atom)
/// - WebM (EBML header)
///
/// # Arguments
///
/// * `data` - The audio data to analyze.
///
/// # Returns
///
/// The detected MIME type.
pub fn detect_audio_mime_type(data: &[u8]) -> AudioMimeType {
    if data.len() < MIN_DETECTION_SIZE {
        return AudioMimeType::Unknown;
    }

    // WAV: "RIFF" + size + "WAVE"
    if data[..4] == *WAV_RIFF && data[8..12] == *WAV_WAVE {
        return AudioMimeType::Wav;
    }

    // MP3: ID3 tag or MPEG frame sync
    if data[..3] == *MP3_ID3 || (data[0] == 0xFF && (data[1] & 0xE0) == 0xE0) {
        return AudioMimeType::Mpeg;
    }

    // OGG: "OggS"
    if data[..4] == *OGG_HEADER {
        return AudioMimeType::Ogg;
    }

    // FLAC: "fLaC"
    if data[..4] == *FLAC_HEADER {
        return AudioMimeType::Flac;
    }

    // M4A/MP4: "ftyp" at offset 4
    if data[4..8] == *FTYP_HEADER {
        return AudioMimeType::Mp4;
    }

    // WebM: EBML header
    if data[..4] == *WEBM_EBML {
        return AudioMimeType::Webm;
    }

    AudioMimeType::Unknown
}

pub fn get_filename_for_data(data: &[u8], base_name: &str) -> String {
    let mime_type = detect_audio_mime_type(data);
    format!("{}.{}", base_name, mime_type.extension())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wav_detection() {
        // RIFF....WAVE header
        let data = [
            0x52, 0x49, 0x46, 0x46, // RIFF
            0x00, 0x00, 0x00, 0x00, // size
            0x57, 0x41, 0x56, 0x45, // WAVE
        ];
        assert_eq!(detect_audio_mime_type(&data), AudioMimeType::Wav);
    }

    #[test]
    fn test_mp3_id3_detection() {
        // ID3 header
        let data = [
            0x49, 0x44, 0x33, // ID3
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ];
        assert_eq!(detect_audio_mime_type(&data), AudioMimeType::Mpeg);
    }

    #[test]
    fn test_ogg_detection() {
        // OggS header
        let data = [
            0x4F, 0x67, 0x67, 0x53, // OggS
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ];
        assert_eq!(detect_audio_mime_type(&data), AudioMimeType::Ogg);
    }

    #[test]
    fn test_unknown_detection() {
        let data = [0x00; 12];
        assert_eq!(detect_audio_mime_type(&data), AudioMimeType::Unknown);
    }
}
