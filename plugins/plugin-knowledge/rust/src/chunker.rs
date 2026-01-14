#![allow(missing_docs)]

use crate::types::ChunkResult;

const CHARS_PER_TOKEN: f64 = 3.5;

#[derive(Debug, Clone)]
pub struct TextChunker {
    pub chunk_size: usize,
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

    pub fn split(&self, text: &str) -> ChunkResult {
        let char_chunk_size = (self.chunk_size as f64 * CHARS_PER_TOKEN) as usize;
        let char_overlap = (self.chunk_overlap as f64 * CHARS_PER_TOKEN) as usize;

        let mut chunks = Vec::new();
        let text_len = text.len();
        let mut start = 0;

        while start < text_len {
            let mut end = (start + char_chunk_size).min(text_len);

            if end < text_len {
                let search_start = start + (char_chunk_size * 4 / 5);
                if search_start < end {
                    let search_region = &text[search_start..end];

                    if let Some(pos) = search_region.rfind(['.', '!', '?', '\n']) {
                        end = search_start + pos + 1;
                    }
                }
            }

            let chunk = text[start..end].trim().to_string();
            if !chunk.is_empty() {
                chunks.push(chunk);
            }

            // If we've reached the end of the text, break
            if end >= text_len {
                break;
            }

            // Calculate next start position, ensuring we always make forward progress
            let next_start = if end > char_overlap {
                end - char_overlap
            } else {
                end
            };

            // Ensure we always make forward progress to avoid infinite loops
            if next_start <= start {
                start = end;
            } else {
                start = next_start;
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
        assert!((3..=4).contains(&tokens));
    }

    #[test]
    fn test_sentence_boundary_preservation() {
        let chunker = TextChunker::new(20, 5);
        let text = "First sentence. Second sentence. Third sentence.";

        let result = chunker.split(text);

        for chunk in &result.chunks {
            let ends_with_term =
                chunk.ends_with('.') || chunk.ends_with('!') || chunk.ends_with('?');
            let is_continuation = !chunk.starts_with(|c: char| c.is_uppercase());
            assert!(ends_with_term || is_continuation || chunk.len() < 10);
        }
    }
}
