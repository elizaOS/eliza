#![allow(missing_docs)]
//! ScratchpadService – file-based CRUD with markdown frontmatter and TF-IDF search.

use crate::config::ScratchpadConfig;
use crate::error::{Result, ScratchpadError};
use crate::types::{
    ScratchpadEntry, ScratchpadReadOptions, ScratchpadSearchOptions, ScratchpadSearchResult,
    ScratchpadWriteOptions,
};
use chrono::{DateTime, Utc};
use regex::Regex;
use std::path::{Path, PathBuf};
use tokio::fs;
use tracing::{error, info, warn};

/// Service for managing file-based scratchpad memories.
///
/// Provides write, read, search, list, and delete operations
/// on markdown files stored in a configurable directory.
pub struct ScratchpadService {
    config: ScratchpadConfig,
}

impl ScratchpadService {
    /// Create a new ScratchpadService with the given configuration.
    pub fn new(config: ScratchpadConfig) -> Self {
        Self { config }
    }

    /// Ensure the scratchpad directory exists.
    async fn ensure_directory(&self) -> Result<()> {
        fs::create_dir_all(&self.config.base_path)
            .await
            .map_err(|e| {
                error!(
                    "[ScratchpadService] Failed to create directory: {}",
                    e
                );
                ScratchpadError::from(e)
            })
    }

    /// Generate a safe filename from a title.
    fn sanitize_filename(title: &str) -> String {
        let lower = title.to_lowercase();
        let re_special = Regex::new(r"[^a-z0-9\s-]").unwrap();
        let re_spaces = Regex::new(r"\s+").unwrap();
        let re_dashes = Regex::new(r"-+").unwrap();

        let cleaned = re_special.replace_all(&lower, "");
        let cleaned = re_spaces.replace_all(&cleaned, "-");
        let cleaned = re_dashes.replace_all(&cleaned, "-");

        let result: String = cleaned.chars().take(100).collect();
        result
    }

    /// Get the full path for a scratchpad entry.
    fn get_file_path(&self, id: &str) -> PathBuf {
        let filename = if id.ends_with(".md") {
            id.to_string()
        } else {
            format!("{}.md", id)
        };
        PathBuf::from(&self.config.base_path).join(filename)
    }

    /// Extract entry ID from a filename.
    fn get_entry_id(filename: &str) -> String {
        Path::new(filename)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| filename.to_string())
    }

    /// Write or append content to a scratchpad entry.
    pub async fn write(
        &self,
        title: &str,
        content: &str,
        options: &ScratchpadWriteOptions,
    ) -> Result<ScratchpadEntry> {
        self.ensure_directory().await?;

        let id = Self::sanitize_filename(title);
        let file_path = self.get_file_path(&id);
        let now = Utc::now();

        let mut created_at = now;
        let final_content: String;

        let entry_exists = self.exists(&id).await;
        if entry_exists && options.append {
            let existing = self.read(&id, &ScratchpadReadOptions::default()).await?;
            final_content = format!("{}\n\n---\n\n{}", existing.content, content);
            created_at = existing.created_at;
        } else {
            let mut fm_lines = vec![
                "---".to_string(),
                format!("title: \"{}\"", title),
                format!("created: {}", now.to_rfc3339()),
                format!("modified: {}", now.to_rfc3339()),
            ];
            if let Some(tags) = &options.tags {
                if !tags.is_empty() {
                    fm_lines.push(format!("tags: [{}]", tags.join(", ")));
                }
            }
            fm_lines.push("---".to_string());
            fm_lines.push(String::new());

            let frontmatter = fm_lines.join("\n");
            final_content = format!("{}\n{}", frontmatter, content);
        }

        // Check file size
        if final_content.len() > self.config.max_file_size {
            return Err(ScratchpadError::file_size(format!(
                "Content exceeds maximum file size of {} bytes",
                self.config.max_file_size
            )));
        }

        fs::write(&file_path, &final_content).await?;

        info!("[ScratchpadService] Wrote entry: {}", id);

        Ok(ScratchpadEntry {
            id,
            path: file_path.to_string_lossy().into_owned(),
            title: title.to_string(),
            content: final_content,
            created_at,
            modified_at: now,
            tags: options.tags.clone().unwrap_or_default(),
        })
    }

    /// Read a scratchpad entry by ID.
    pub async fn read(
        &self,
        id: &str,
        options: &ScratchpadReadOptions,
    ) -> Result<ScratchpadEntry> {
        let file_path = self.get_file_path(id);

        let metadata = fs::metadata(&file_path).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                ScratchpadError::not_found(format!("Scratchpad entry not found: {}", id))
            } else {
                ScratchpadError::from(e)
            }
        })?;

        let mut content = fs::read_to_string(&file_path).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                ScratchpadError::not_found(format!("Scratchpad entry not found: {}", id))
            } else {
                ScratchpadError::from(e)
            }
        })?;

        // Handle line range reading
        if options.from.is_some() || options.lines.is_some() {
            let all_lines: Vec<&str> = content.split('\n').collect();
            let from_idx = options.from.unwrap_or(1).max(1) - 1; // 0-indexed
            let num_lines = options.lines.unwrap_or(all_lines.len() - from_idx);
            let end_idx = (from_idx + num_lines).min(all_lines.len());
            content = all_lines[from_idx..end_idx].join("\n");
        }

        // Parse frontmatter for metadata
        let mut title = id.to_string();
        let mut tags: Vec<String> = Vec::new();
        let mut created_at: DateTime<Utc> = metadata
            .created()
            .ok()
            .and_then(|t| {
                let duration = t.duration_since(std::time::UNIX_EPOCH).ok()?;
                DateTime::from_timestamp(duration.as_secs() as i64, 0)
            })
            .unwrap_or_else(Utc::now);

        let fm_re = Regex::new(r"^---\n([\s\S]*?)\n---").unwrap();
        if let Some(caps) = fm_re.captures(&content) {
            let frontmatter = &caps[1];

            let title_re = Regex::new(r#"title:\s*"?([^"\n]+)"?"#).unwrap();
            if let Some(t_caps) = title_re.captures(frontmatter) {
                title = t_caps[1].to_string();
            }

            let tags_re = Regex::new(r"tags:\s*\[([^\]]+)\]").unwrap();
            if let Some(t_caps) = tags_re.captures(frontmatter) {
                tags = t_caps[1]
                    .split(',')
                    .map(|t| t.trim().to_string())
                    .collect();
            }

            let created_re = Regex::new(r"created:\s*(.+)").unwrap();
            if let Some(c_caps) = created_re.captures(frontmatter) {
                if let Ok(dt) = c_caps[1].trim().parse::<DateTime<Utc>>() {
                    created_at = dt;
                }
            }
        }

        let modified_at: DateTime<Utc> = metadata
            .modified()
            .ok()
            .and_then(|t| {
                let duration = t.duration_since(std::time::UNIX_EPOCH).ok()?;
                DateTime::from_timestamp(duration.as_secs() as i64, 0)
            })
            .unwrap_or_else(Utc::now);

        Ok(ScratchpadEntry {
            id: id.to_string(),
            path: file_path.to_string_lossy().into_owned(),
            title,
            content,
            created_at,
            modified_at,
            tags,
        })
    }

    /// Check if a scratchpad entry exists.
    pub async fn exists(&self, id: &str) -> bool {
        let file_path = self.get_file_path(id);
        fs::metadata(&file_path).await.is_ok()
    }

    /// List all scratchpad entries, sorted by modified date (most recent first).
    pub async fn list(&self) -> Vec<ScratchpadEntry> {
        if self.ensure_directory().await.is_err() {
            return Vec::new();
        }

        let mut entries = Vec::new();
        let mut dir = match fs::read_dir(&self.config.base_path).await {
            Ok(d) => d,
            Err(e) => {
                error!("[ScratchpadService] Failed to list entries: {}", e);
                return Vec::new();
            }
        };

        while let Ok(Some(entry)) = dir.next_entry().await {
            let filename = entry.file_name().to_string_lossy().into_owned();
            let ext = Path::new(&filename)
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();

            if !self.config.allowed_extensions.contains(&ext) {
                continue;
            }

            let id = Self::get_entry_id(&filename);
            match self.read(&id, &ScratchpadReadOptions::default()).await {
                Ok(e) => entries.push(e),
                Err(e) => {
                    warn!(
                        "[ScratchpadService] Failed to read entry {}: {}",
                        filename, e
                    );
                }
            }
        }

        // Sort by modified date, most recent first
        entries.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
        entries
    }

    /// Search scratchpad entries using TF-based text matching.
    ///
    /// Tokenises the query, counts term occurrences in each entry,
    /// scores with `min(1.0, match_count / (terms.len() * 3))`, and
    /// returns the best-matching snippets.
    pub async fn search(
        &self,
        query: &str,
        options: &ScratchpadSearchOptions,
    ) -> Vec<ScratchpadSearchResult> {
        let entries = self.list().await;
        let mut results = Vec::new();

        // Tokenize and lowercase the query (filter terms <= 2 chars)
        let query_terms: Vec<String> = query
            .to_lowercase()
            .split_whitespace()
            .filter(|t| t.len() > 2)
            .map(String::from)
            .collect();

        if query_terms.is_empty() {
            return results;
        }

        for entry in &entries {
            let lines: Vec<&str> = entry.content.split('\n').collect();
            let content_lower = entry.content.to_lowercase();

            // Calculate relevance score based on term frequency
            let mut match_count: usize = 0;
            for term in &query_terms {
                match_count += content_lower.matches(term.as_str()).count();
            }

            if match_count == 0 {
                continue;
            }

            // Simple TF-based scoring
            let score = (match_count as f64 / (query_terms.len() as f64 * 3.0)).min(1.0);
            if score < options.min_score {
                continue;
            }

            // Find the best matching snippet
            let mut best_start: usize = 0;
            let mut best_end: usize = lines.len().min(5);

            for (i, line) in lines.iter().enumerate() {
                let line_lower = line.to_lowercase();
                let mut found = false;
                for term in &query_terms {
                    if line_lower.contains(term.as_str()) {
                        best_start = i.saturating_sub(2);
                        best_end = lines.len().min(i + 3);
                        found = true;
                        break;
                    }
                }
                if found {
                    break;
                }
            }

            let snippet = lines[best_start..best_end].join("\n");

            results.push(ScratchpadSearchResult {
                path: entry.path.clone(),
                start_line: best_start + 1,
                end_line: best_end,
                score,
                snippet,
                entry_id: entry.id.clone(),
            });
        }

        // Sort by score descending and limit results
        results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        results.truncate(options.max_results);
        results
    }

    /// Delete a scratchpad entry.
    pub async fn delete(&self, id: &str) -> Result<bool> {
        let file_path = self.get_file_path(id);
        match fs::remove_file(&file_path).await {
            Ok(()) => {
                info!("[ScratchpadService] Deleted entry: {}", id);
                Ok(true)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(ScratchpadError::from(e)),
        }
    }

    /// Get a summary of all scratchpad content.
    pub async fn get_summary(&self) -> String {
        let entries = self.list().await;

        if entries.is_empty() {
            return "No scratchpad entries found.".to_string();
        }

        let mut parts = vec![
            format!("**Scratchpad Summary** ({} entries)", entries.len()),
            String::new(),
        ];

        let fm_re = Regex::new(r"^---[\s\S]*?---\n*").unwrap();

        for entry in entries.iter().take(10) {
            let content_no_fm = fm_re.replace(&entry.content, "").trim().to_string();
            let preview: String = content_no_fm.chars().take(100).collect();
            let preview = preview.replace('\n', " ");

            parts.push(format!("- **{}** ({})", entry.title, entry.id));
            parts.push(format!(
                "  {}{}",
                preview,
                if content_no_fm.len() > 100 { "..." } else { "" }
            ));
            parts.push(format!(
                "  _Modified: {}_",
                entry.modified_at.format("%Y-%m-%d")
            ));
        }

        if entries.len() > 10 {
            parts.push(format!(
                "\n_...and {} more entries_",
                entries.len() - 10
            ));
        }

        parts.join("\n")
    }

    /// Get the base path for scratchpad files.
    pub fn get_base_path(&self) -> &str {
        &self.config.base_path
    }
}

/// Factory function to create a ScratchpadService instance.
pub fn create_scratchpad_service(config: ScratchpadConfig) -> ScratchpadService {
    ScratchpadService::new(config)
}
