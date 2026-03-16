#![allow(missing_docs)]
//! SCRATCHPAD_SEARCH action – search entries by content using TF-IDF.

use crate::service::ScratchpadService;
use crate::types::{ScratchpadSearchOptions, ScratchpadSearchResult};
use tracing::{error, info};

/// Result of the search action.
pub struct SearchActionResult {
    /// Whether the action succeeded.
    pub success: bool,
    /// Result text.
    pub text: String,
    /// Search results.
    pub results: Vec<ScratchpadSearchResult>,
}

/// SCRATCHPAD_SEARCH action.
pub struct ScratchpadSearchAction;

impl ScratchpadSearchAction {
    /// Action name.
    pub const NAME: &'static str = "SCRATCHPAD_SEARCH";

    /// Action description.
    pub const DESCRIPTION: &'static str =
        "Search scratchpad entries by content using TF-IDF text matching.";

    /// Similar action names.
    pub const SIMILES: &'static [&'static str] = &[
        "SCRATCHPAD_SEARCH",
        "SEARCH_NOTES",
        "FIND_NOTE",
        "LOOKUP_SCRATCHPAD",
        "FIND_IN_NOTES",
    ];

    /// Handle the search action.
    ///
    /// # Arguments
    ///
    /// * `service` - The scratchpad service
    /// * `query` - Search query string
    /// * `options` - Search options (max_results, min_score)
    pub async fn handle(
        service: &ScratchpadService,
        query: &str,
        options: &ScratchpadSearchOptions,
    ) -> SearchActionResult {
        info!("Handling SCRATCHPAD_SEARCH action for \"{}\"", query);

        if query.trim().is_empty() {
            return SearchActionResult {
                success: false,
                text: "Search query is required.".to_string(),
                results: Vec::new(),
            };
        }

        let results = service.search(query, options).await;

        if results.is_empty() {
            return SearchActionResult {
                success: true,
                text: format!("No scratchpad entries found matching \"{}\".", query),
                results: Vec::new(),
            };
        }

        let result_lines: Vec<String> = results
            .iter()
            .enumerate()
            .map(|(i, r)| {
                let score_pct = (r.score * 100.0).round() as u32;
                let snippet_preview: String = r.snippet.chars().take(200).collect();
                let ellipsis = if r.snippet.len() > 200 { "..." } else { "" };
                format!(
                    "**{}. {}** ({}% match, lines {}-{})\n```\n{}{}\n```",
                    i + 1,
                    r.entry_id,
                    score_pct,
                    r.start_line,
                    r.end_line,
                    snippet_preview,
                    ellipsis
                )
            })
            .collect();

        let result_text = result_lines.join("\n\n");
        let text = format!(
            "Found {} matching scratchpad entries for \"{}\":\n\n{}\n\nUse SCRATCHPAD_READ with an entry ID to view the full content.",
            results.len(),
            query,
            result_text
        );

        SearchActionResult {
            success: true,
            text,
            results,
        }
    }
}
