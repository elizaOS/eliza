#![allow(missing_docs)]
//! Text chunking functionality.

use crate::types::ChunkResult;

/// Approximate characters per token.
const CHARS_PER_TOKEN: f64 = 3.5;

/// Text chunker for splitting documents into semantic chunks.
#[derive(Debug, Clone)]
pub struct TextChunker {
    /// Target tokens per chunk
    pub chunk_size: usize,
    /// Overlap tokens between chunks
    pub chunk_overlap: usize,
}


impl Default for TextChunker {
    fn default() -> Self {
        Self {
            chunk_size: 500,
            chunk_overlap: 100,
        }
    }
}

impl TextChunker {
    /// Create a new text chunker with specified parameters.
    pub fn new(chunk_size: usize, chunk_overlap: usize) -> Self {
        Self {
            chunk_size,
            chunk_overlap,
        }
    }

    /// Split text into semantic chunks.
    ///
    /// Attempts to break at sentence boundaries when possible.
    pub fn split(&self, text: &str) -> ChunkResult {
        let char_chunk_size = (self.chunk_size as f64 * CHARS_PER_TOKEN) as usize;
        let char_overlap = (self.chunk_overlap as f64 * CHARS_PER_TOKEN) as usize;

        let mut chunks = Vec::new();
        let text_len = text.len();
        let mut start = 0;

        while start < text_len {
            let mut end = (start + char_chunk_size).min(text_len);

            // Try to break at sentence boundary if not at end
            if end < text_len {
                let search_start = start + (char_chunk_size * 4 / 5);
                let search_region = &text[search_start..end];

                // Look for sentence endings
                if let Some(pos) = search_region.rfind(|c| c == '.' || c == '!' || c == '?' || c == '\n') {
                    end = search_start + pos + 1;
                }
            }

            let chunk = text[start..end].trim().to_string();
            if !chunk.is_empty() {
                chunks.push(chunk);
            }

            // Move start with overlap
            start = if end > char_overlap {
                end - char_overlap
            } else {
                end
            };

            if start >= text_len {
                break;
            }
        }

        let chunk_count = chunks.len();
        let total_tokens = (text.len() as f64 / CHARS_PER_TOKEN) as usize;

        ChunkResult {
            chunks,
            chunk_count,
            total_tokens,
        }
    }

    /// Estimate token count for text.
    pub fn estimate_tokens(&self, text: &str) -> usize {
        (text.len() as f64 / CHARS_PER_TOKEN) as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chunker_default() {
        let chunker = TextChunker::default();
        assert_eq!(chunker.chunk_size, 500);
        assert_eq!(chunker.chunk_overlap, 100);
    }

    #[test]
    fn test_chunker_new() {
        let chunker = TextChunker::new(200, 50);
        assert_eq!(chunker.chunk_size, 200);
        assert_eq!(chunker.chunk_overlap, 50);
    }

    #[test]
    fn test_split_basic() {
        let chunker = TextChunker::new(50, 10);
        let text = "This is a test sentence. ".repeat(20);

        let result = chunker.split(&text);

        assert!(!result.chunks.is_empty());
        assert_eq!(result.chunk_count, result.chunks.len());

        // All chunks should have content
        for chunk in &result.chunks {
            assert!(!chunk.is_empty());
        }
    }

    #[test]
    fn test_split_short_text() {
        let chunker = TextChunker::new(500, 100);
        let text = "Short text.";

        let result = chunker.split(text);

        assert_eq!(result.chunks.len(), 1);
        assert_eq!(result.chunks[0], "Short text.");
    }

    #[test]
    fn test_split_empty() {
        let chunker = TextChunker::default();
        let result = chunker.split("");

        assert!(result.chunks.is_empty());
        assert_eq!(result.chunk_count, 0);
    }

    #[test]
    fn test_split_whitespace_only() {
        let chunker = TextChunker::default();
        let result = chunker.split("   \n\t   ");

        assert!(result.chunks.is_empty());
    }

    #[test]
    fn test_estimate_tokens() {
        let chunker = TextChunker::default();
        let text = "Hello, world!"; // 13 chars

        let tokens = chunker.estimate_tokens(text);

        // 13 / 3.5 ≈ 3
        assert!(tokens >= 3 && tokens <= 4);
    }

    #[test]
    fn test_sentence_boundary_preservation() {
        let chunker = TextChunker::new(20, 5);
        let text = "First sentence. Second sentence. Third sentence.";

        let result = chunker.split(text);

        // Should try to break at sentence boundaries
        for chunk in &result.chunks {
            // Chunks should ideally end with sentence terminators (unless truncated)
            let ends_with_term = chunk.ends_with('.') || chunk.ends_with('!') || chunk.ends_with('?');
            let is_continuation = !chunk.starts_with(|c: char| c.is_uppercase());
            // Either ends properly or is a continuation
            assert!(ends_with_term || is_continuation || chunk.len() < 10);
        }
    }
}





