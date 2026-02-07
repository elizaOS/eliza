//! MIME type detection and media utilities for Eliza.
//!
//! Provides robust MIME type detection from file buffers, headers, and extensions.

use std::collections::HashMap;

/// Media kind categories
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MediaKind {
    /// Image media (JPEG, PNG, GIF, etc.)
    Image,
    /// Audio media (MP3, OGG, WAV, etc.)
    Audio,
    /// Video media (MP4, MOV, etc.)
    Video,
    /// Document media (PDF, DOC, TXT, etc.)
    Document,
    /// Unknown or unrecognized media type
    Unknown,
}

impl std::fmt::Display for MediaKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MediaKind::Image => write!(f, "image"),
            MediaKind::Audio => write!(f, "audio"),
            MediaKind::Video => write!(f, "video"),
            MediaKind::Document => write!(f, "document"),
            MediaKind::Unknown => write!(f, "unknown"),
        }
    }
}

lazy_static::lazy_static! {
    /// Map common MIME types to preferred file extensions
    static ref EXT_BY_MIME: HashMap<&'static str, &'static str> = {
        let mut m = HashMap::new();
        m.insert("image/heic", ".heic");
        m.insert("image/heif", ".heif");
        m.insert("image/jpeg", ".jpg");
        m.insert("image/png", ".png");
        m.insert("image/webp", ".webp");
        m.insert("image/gif", ".gif");
        m.insert("audio/ogg", ".ogg");
        m.insert("audio/mpeg", ".mp3");
        m.insert("audio/x-m4a", ".m4a");
        m.insert("audio/mp4", ".m4a");
        m.insert("video/mp4", ".mp4");
        m.insert("video/quicktime", ".mov");
        m.insert("application/pdf", ".pdf");
        m.insert("application/json", ".json");
        m.insert("application/zip", ".zip");
        m.insert("application/gzip", ".gz");
        m.insert("application/x-tar", ".tar");
        m.insert("application/x-7z-compressed", ".7z");
        m.insert("application/vnd.rar", ".rar");
        m.insert("application/msword", ".doc");
        m.insert("application/vnd.ms-excel", ".xls");
        m.insert("application/vnd.ms-powerpoint", ".ppt");
        m.insert("application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx");
        m.insert("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx");
        m.insert("application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx");
        m.insert("text/csv", ".csv");
        m.insert("text/plain", ".txt");
        m.insert("text/markdown", ".md");
        m
    };

    /// Reverse map: extension to MIME
    static ref MIME_BY_EXT: HashMap<&'static str, &'static str> = {
        let mut m: HashMap<&'static str, &'static str> = EXT_BY_MIME
            .iter()
            .map(|(k, v)| (*v, *k))
            .collect();
        m.insert(".jpeg", "image/jpeg");
        m
    };
}

/// Audio file extensions
const AUDIO_FILE_EXTENSIONS: &[&str] = &[
    ".aac", ".flac", ".m4a", ".mp3", ".oga", ".ogg", ".opus", ".wav",
];

/// Voice-compatible audio extensions (Opus/Ogg)
const VOICE_AUDIO_EXTENSIONS: &[&str] = &[".oga", ".ogg", ".opus"];

/// Normalize a MIME type from HTTP headers.
fn normalize_header_mime(mime: Option<&str>) -> Option<String> {
    mime.map(|m| m.split(';').next().unwrap_or("").trim().to_lowercase())
        .filter(|m| !m.is_empty())
}

/// Get the file extension from a path or URL.
pub fn get_file_extension(file_path: Option<&str>) -> Option<String> {
    let path = file_path?;

    // Try parsing as URL
    if path.to_lowercase().starts_with("http://") || path.to_lowercase().starts_with("https://") {
        if let Ok(url) = url::Url::parse(path) {
            let path_str = url.path();
            if let Some(ext) = path_str.rsplit('.').next() {
                if !ext.contains('/') {
                    return Some(format!(".{}", ext.to_lowercase()));
                }
            }
        }
    }

    // Plain path parsing
    let parts: Vec<&str> = path.split('.').collect();
    if parts.len() < 2 {
        return None;
    }
    Some(format!(".{}", parts.last()?.to_lowercase()))
}

/// Check if a MIME type is generic/container type.
fn is_generic_mime(mime: Option<&str>) -> bool {
    match mime {
        None => true,
        Some(m) => {
            let lower = m.to_lowercase();
            lower == "application/octet-stream" || lower == "application/zip"
        }
    }
}

/// Detect MIME type from buffer, headers, and/or file path.
/// Prioritizes sniffed types over extension-based detection.
pub fn detect_mime(
    buffer: Option<&[u8]>,
    header_mime: Option<&str>,
    file_path: Option<&str>,
) -> Option<String> {
    let ext = get_file_extension(file_path);
    let ext_mime = ext
        .as_ref()
        .and_then(|e| MIME_BY_EXT.get(e.as_str()).copied());
    let normalized_header = normalize_header_mime(header_mime);

    // Try to sniff MIME type from buffer using infer crate
    let sniffed = buffer.and_then(|b| infer::get(b).map(|kind| kind.mime_type().to_string()));

    // Prefer sniffed types, but don't let generic container types override
    // a more specific extension mapping (e.g., XLSX vs ZIP)
    if let Some(ref s) = sniffed {
        if !is_generic_mime(Some(s)) || ext_mime.is_none() {
            return Some(s.clone());
        }
    }
    if let Some(e) = ext_mime {
        return Some(e.to_string());
    }
    if let Some(ref h) = normalized_header {
        if !is_generic_mime(Some(h)) {
            return Some(h.clone());
        }
    }
    if sniffed.is_some() {
        return sniffed;
    }
    normalized_header
}

/// Get the file extension for a MIME type.
pub fn extension_for_mime(mime: Option<&str>) -> Option<&'static str> {
    mime.and_then(|m| EXT_BY_MIME.get(m.to_lowercase().as_str()).copied())
}

/// Check if a file appears to be an audio file by extension.
pub fn is_audio_filename(filename: Option<&str>) -> bool {
    get_file_extension(filename)
        .map(|ext| AUDIO_FILE_EXTENSIONS.contains(&ext.as_str()))
        .unwrap_or(false)
}

/// Check if media is a GIF.
pub fn is_gif_media(content_type: Option<&str>, filename: Option<&str>) -> bool {
    if let Some(ct) = content_type {
        if ct.to_lowercase() == "image/gif" {
            return true;
        }
    }
    get_file_extension(filename)
        .map(|ext| ext == ".gif")
        .unwrap_or(false)
}

/// Check if audio is voice-compatible (Opus/Ogg format).
pub fn is_voice_compatible_audio(content_type: Option<&str>, filename: Option<&str>) -> bool {
    if let Some(mime) = content_type {
        let lower = mime.to_lowercase();
        if lower.contains("ogg") || lower.contains("opus") {
            return true;
        }
    }
    get_file_extension(filename)
        .map(|ext| VOICE_AUDIO_EXTENSIONS.contains(&ext.as_str()))
        .unwrap_or(false)
}

/// Get media kind from MIME type.
pub fn media_kind_from_mime(mime: Option<&str>) -> MediaKind {
    match mime {
        None => MediaKind::Unknown,
        Some(m) => {
            let lower = m.to_lowercase();
            if lower.starts_with("image/") {
                MediaKind::Image
            } else if lower.starts_with("audio/") {
                MediaKind::Audio
            } else if lower.starts_with("video/") {
                MediaKind::Video
            } else if lower.starts_with("application/pdf")
                || lower.starts_with("application/msword")
                || lower.starts_with("application/vnd.ms-")
                || lower.starts_with("application/vnd.openxmlformats")
                || lower.starts_with("text/")
            {
                MediaKind::Document
            } else {
                MediaKind::Unknown
            }
        }
    }
}

/// Get image MIME type from format name.
pub fn image_mime_from_format(format_name: Option<&str>) -> Option<&'static str> {
    format_name.and_then(|fmt| match fmt.to_lowercase().as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "heic" => Some("image/heic"),
        "heif" => Some("image/heif"),
        "png" => Some("image/png"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_file_extension() {
        assert_eq!(
            get_file_extension(Some("test.jpg")),
            Some(".jpg".to_string())
        );
        assert_eq!(
            get_file_extension(Some("path/to/file.PNG")),
            Some(".png".to_string())
        );
        assert_eq!(get_file_extension(Some("noext")), None);
        assert_eq!(get_file_extension(None), None);
    }

    #[test]
    fn test_media_kind_from_mime() {
        assert_eq!(media_kind_from_mime(Some("image/jpeg")), MediaKind::Image);
        assert_eq!(media_kind_from_mime(Some("audio/mp3")), MediaKind::Audio);
        assert_eq!(media_kind_from_mime(Some("video/mp4")), MediaKind::Video);
        assert_eq!(
            media_kind_from_mime(Some("application/pdf")),
            MediaKind::Document
        );
        assert_eq!(
            media_kind_from_mime(Some("text/plain")),
            MediaKind::Document
        );
        assert_eq!(
            media_kind_from_mime(Some("application/octet-stream")),
            MediaKind::Unknown
        );
        assert_eq!(media_kind_from_mime(None), MediaKind::Unknown);
    }

    #[test]
    fn test_is_audio_filename() {
        assert!(is_audio_filename(Some("song.mp3")));
        assert!(is_audio_filename(Some("voice.ogg")));
        assert!(!is_audio_filename(Some("image.jpg")));
        assert!(!is_audio_filename(None));
    }
}
