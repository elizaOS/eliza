//! Hybrid search utilities for combining vector and keyword search results.

use std::collections::HashMap;

/// Result from vector similarity search
#[derive(Debug, Clone)]
pub struct HybridVectorResult {
    /// Unique identifier for this result
    pub id: String,
    /// File path where the match was found
    pub path: String,
    /// Starting line number of the match
    pub start_line: usize,
    /// Ending line number of the match
    pub end_line: usize,
    /// Source identifier (e.g., repository or collection name)
    pub source: String,
    /// Text snippet containing the match
    pub snippet: String,
    /// Vector similarity score (higher is more similar)
    pub vector_score: f64,
}

/// Result from keyword (BM25) search
#[derive(Debug, Clone)]
pub struct HybridKeywordResult {
    /// Unique identifier for this result
    pub id: String,
    /// File path where the match was found
    pub path: String,
    /// Starting line number of the match
    pub start_line: usize,
    /// Ending line number of the match
    pub end_line: usize,
    /// Source identifier (e.g., repository or collection name)
    pub source: String,
    /// Text snippet containing the match
    pub snippet: String,
    /// BM25 text relevance score (higher is more relevant)
    pub text_score: f64,
}

/// Merged result from hybrid search
#[derive(Debug, Clone)]
pub struct HybridMergedResult {
    /// File path where the match was found
    pub path: String,
    /// Starting line number of the match
    pub start_line: usize,
    /// Ending line number of the match
    pub end_line: usize,
    /// Combined weighted score from vector and keyword search
    pub score: f64,
    /// Text snippet containing the match
    pub snippet: String,
    /// Source identifier (e.g., repository or collection name)
    pub source: String,
}

/// Build an FTS (Full-Text Search) query from a raw search string.
/// Extracts alphanumeric tokens and joins them with AND for strict matching.
///
/// # Arguments
/// * `raw` - The raw search query string
///
/// # Returns
/// The FTS query string, or None if no valid tokens found
pub fn build_fts_query(raw: &str) -> Option<String> {
    let re = regex::Regex::new(r"[A-Za-z0-9_]+").unwrap();
    let tokens: Vec<String> = re
        .find_iter(raw)
        .map(|m| m.as_str().trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();

    if tokens.is_empty() {
        return None;
    }

    let quoted: Vec<String> = tokens
        .into_iter()
        .map(|t| format!("\"{}\"", t.replace('"', "")))
        .collect();

    Some(quoted.join(" AND "))
}

/// Convert BM25 rank to a normalized score between 0 and 1.
/// Lower rank = higher score.
///
/// # Arguments
/// * `rank` - The BM25 rank value
///
/// # Returns
/// A normalized score where 1 is best and 0 is worst
pub fn bm25_rank_to_score(rank: f64) -> f64 {
    let normalized = if rank.is_finite() {
        rank.max(0.0)
    } else {
        999.0
    };
    1.0 / (1.0 + normalized)
}

/// Merge vector similarity and keyword search results using weighted scoring.
///
/// This implements a hybrid search approach where results from both vector
/// similarity search and keyword (BM25) search are combined. Results that
/// appear in both searches get boosted scores.
///
/// # Arguments
/// * `vector` - Results from vector similarity search
/// * `keyword` - Results from keyword (BM25) search
/// * `vector_weight` - Weight for vector similarity scores (default: 0.7)
/// * `text_weight` - Weight for keyword/text scores (default: 0.3)
///
/// # Returns
/// Merged and sorted results with combined scores
pub fn merge_hybrid_results(
    vector: Vec<HybridVectorResult>,
    keyword: Vec<HybridKeywordResult>,
    vector_weight: f64,
    text_weight: f64,
) -> Vec<HybridMergedResult> {
    #[derive(Debug)]
    struct Entry {
        path: String,
        start_line: usize,
        end_line: usize,
        source: String,
        snippet: String,
        vector_score: f64,
        text_score: f64,
    }

    let mut by_id: HashMap<String, Entry> = HashMap::new();

    // Add vector search results
    for r in vector {
        by_id.insert(
            r.id.clone(),
            Entry {
                path: r.path,
                start_line: r.start_line,
                end_line: r.end_line,
                source: r.source,
                snippet: r.snippet,
                vector_score: r.vector_score,
                text_score: 0.0,
            },
        );
    }

    // Merge keyword search results
    for r in keyword {
        if let Some(existing) = by_id.get_mut(&r.id) {
            existing.text_score = r.text_score;
            // Prefer keyword snippet if available (may have highlights)
            if !r.snippet.is_empty() {
                existing.snippet = r.snippet;
            }
        } else {
            by_id.insert(
                r.id.clone(),
                Entry {
                    path: r.path,
                    start_line: r.start_line,
                    end_line: r.end_line,
                    source: r.source,
                    snippet: r.snippet,
                    vector_score: 0.0,
                    text_score: r.text_score,
                },
            );
        }
    }

    // Calculate weighted scores and create results
    let mut merged: Vec<HybridMergedResult> = by_id
        .into_values()
        .map(|entry| {
            let score = vector_weight * entry.vector_score + text_weight * entry.text_score;
            HybridMergedResult {
                path: entry.path,
                start_line: entry.start_line,
                end_line: entry.end_line,
                score,
                snippet: entry.snippet,
                source: entry.source,
            }
        })
        .collect();

    // Sort by score descending
    merged.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_fts_query() {
        assert_eq!(
            build_fts_query("hello world"),
            Some("\"hello\" AND \"world\"".to_string())
        );
        assert_eq!(
            build_fts_query("test_function"),
            Some("\"test_function\"".to_string())
        );
        assert_eq!(build_fts_query(""), None);
        assert_eq!(build_fts_query("   "), None);
    }

    #[test]
    fn test_bm25_rank_to_score() {
        assert!((bm25_rank_to_score(0.0) - 1.0).abs() < 0.001);
        assert!((bm25_rank_to_score(1.0) - 0.5).abs() < 0.001);
        assert!(bm25_rank_to_score(f64::INFINITY) < 0.01);
    }

    #[test]
    fn test_merge_hybrid_results() {
        let vector = vec![HybridVectorResult {
            id: "a".to_string(),
            path: "file.rs".to_string(),
            start_line: 1,
            end_line: 10,
            source: "test".to_string(),
            snippet: "hello".to_string(),
            vector_score: 0.8,
        }];

        let keyword = vec![HybridKeywordResult {
            id: "a".to_string(),
            path: "file.rs".to_string(),
            start_line: 1,
            end_line: 10,
            source: "test".to_string(),
            snippet: "hello world".to_string(),
            text_score: 0.6,
        }];

        let merged = merge_hybrid_results(vector, keyword, 0.7, 0.3);
        assert_eq!(merged.len(), 1);
        let expected_score = 0.7 * 0.8 + 0.3 * 0.6;
        assert!((merged[0].score - expected_score).abs() < 0.001);
        assert_eq!(merged[0].snippet, "hello world"); // Keyword snippet preferred
    }
}
