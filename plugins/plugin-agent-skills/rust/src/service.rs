//! Agent Skills Service
//!
//! Core service for discovering, loading, and managing Agent Skills.
//! Implements the Agent Skills specification with Otto compatibility.
//!
//! See: <https://agentskills.io/specification>

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use regex::Regex;
use reqwest::Client;
use zip::ZipArchive;

use crate::error::{Error, Result};
use crate::parser::{
    estimate_tokens, extract_body, generate_skills_xml, parse_frontmatter, validate_frontmatter,
};
use crate::types::{
    Skill, SkillCatalogEntry, SkillDetails, SkillFrontmatter, SkillInstructions,
    SkillMetadataEntry, SkillSearchResult,
};

// ============================================================
// CONSTANTS
// ============================================================

const CLAWHUB_API: &str = "https://clawhub.ai";

/// Cache TTL in milliseconds.
struct CacheTtl;

impl CacheTtl {
    const CATALOG: u64 = 60 * 60 * 1000; // 1 hour
    const SKILL_DETAILS: u64 = 30 * 60 * 1000; // 30 min
    const SEARCH: u64 = 5 * 60 * 1000; // 5 min
}

const MAX_PACKAGE_SIZE: usize = 10 * 1024 * 1024; // 10MB

// ============================================================
// CACHE ENTRY
// ============================================================

struct CacheEntry<T> {
    data: T,
    cached_at: u64,
}

// ============================================================
// SERVICE
// ============================================================

/// Agent Skills Service.
///
/// Manages skill discovery, loading, validation, and registry integration.
pub struct AgentSkillsService {
    skills_dir: PathBuf,
    cache_dir: PathBuf,
    api_base: String,
    http_client: Client,

    // In-memory caches
    loaded_skills: HashMap<String, Skill>,
    catalog_cache: Option<CacheEntry<Vec<SkillCatalogEntry>>>,
    search_cache: HashMap<String, CacheEntry<Vec<SkillSearchResult>>>,
    details_cache: HashMap<String, CacheEntry<SkillDetails>>,
}

impl AgentSkillsService {
    /// Create a new service instance.
    pub fn new(skills_dir: Option<&str>, api_base: Option<&str>) -> Self {
        let skills_dir = PathBuf::from(skills_dir.unwrap_or("./skills"));
        let cache_dir = skills_dir.join(".cache");

        Self {
            skills_dir,
            cache_dir,
            api_base: api_base.unwrap_or(CLAWHUB_API).to_string(),
            http_client: Client::new(),
            loaded_skills: HashMap::new(),
            catalog_cache: None,
            search_cache: HashMap::new(),
            details_cache: HashMap::new(),
        }
    }

    /// Initialize the service.
    pub async fn initialize(&mut self) -> Result<()> {
        // Ensure directories exist
        fs::create_dir_all(&self.skills_dir)?;
        fs::create_dir_all(&self.cache_dir)?;

        // Load installed skills
        self.load_installed_skills().await?;

        // Load cached catalog from disk
        self.load_catalog_from_disk();

        Ok(())
    }

    // ============================================================
    // SKILL DISCOVERY (Progressive Disclosure Level 1)
    // ============================================================

    /// Get skill metadata for all loaded skills.
    pub fn get_skills_metadata(&self) -> Vec<SkillMetadataEntry> {
        self.loaded_skills
            .values()
            .map(|skill| SkillMetadataEntry {
                name: skill.name.clone(),
                description: skill.description.clone(),
                location: format!("{}/SKILL.md", skill.path),
            })
            .collect()
    }

    /// Generate XML for available skills (for system prompts).
    pub fn generate_skills_prompt_xml(&self, include_location: bool) -> String {
        let metadata = self.get_skills_metadata();
        generate_skills_xml(&metadata, include_location)
    }

    // ============================================================
    // SKILL LOADING (Progressive Disclosure Level 2)
    // ============================================================

    /// Load all installed skills from disk.
    pub async fn load_installed_skills(&mut self) -> Result<()> {
        if !self.skills_dir.exists() {
            return Ok(());
        }

        for entry in fs::read_dir(&self.skills_dir)? {
            let entry = entry?;
            let path = entry.path();

            if path.is_dir() {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !name.starts_with('.') {
                    if let Err(e) = self.load_skill(name, true).await {
                        eprintln!("Failed to load skill {}: {}", name, e);
                    }
                }
            }
        }

        Ok(())
    }

    /// Load a single skill from disk.
    pub async fn load_skill(&mut self, slug_or_path: &str, validate: bool) -> Result<Option<Skill>> {
        // Determine if it's a path or slug
        let (skill_dir, slug) = if Path::new(slug_or_path).is_absolute()
            || slug_or_path.contains('/')
        {
            let path = PathBuf::from(slug_or_path);
            let slug = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            (path, slug)
        } else {
            let slug = sanitize_slug(slug_or_path)?;
            (self.skills_dir.join(&slug), slug)
        };

        let skill_md_path = skill_dir.join("SKILL.md");

        if !skill_md_path.exists() {
            return Ok(None);
        }

        let content = fs::read_to_string(&skill_md_path)?;
        let (frontmatter, _body, _) = parse_frontmatter(&content);

        let frontmatter = match frontmatter {
            Some(fm) => fm,
            None => return Ok(None),
        };

        // Validate if requested
        if validate {
            let result = validate_frontmatter(&frontmatter, Some(&slug));
            if !result.valid {
                let errors: Vec<String> = result.errors.iter().map(|e| e.message.clone()).collect();
                eprintln!("Validation failed for {}: {}", slug, errors.join(", "));
            }
        }

        // Collect resource files
        let scripts = list_dir_files(&skill_dir.join("scripts"));
        let references = list_dir_files(&skill_dir.join("references"));
        let assets = list_dir_files(&skill_dir.join("assets"));

        // Get version
        let version = self.get_skill_version(&slug, &frontmatter);

        let skill = Skill {
            slug: slug.clone(),
            name: frontmatter.name.clone(),
            description: frontmatter.description.clone(),
            version,
            content,
            frontmatter,
            path: skill_dir.to_string_lossy().to_string(),
            scripts,
            references,
            assets,
            loaded_at: now_millis(),
        };

        self.loaded_skills.insert(slug, skill.clone());
        Ok(Some(skill))
    }

    /// Get skill instructions (body without frontmatter).
    pub fn get_skill_instructions(&self, slug: &str) -> Option<SkillInstructions> {
        let slug = sanitize_slug(slug).ok()?;
        let skill = self.loaded_skills.get(&slug)?;
        let body = extract_body(&skill.content);

        Some(SkillInstructions {
            slug: skill.slug.clone(),
            body: body.clone(),
            estimated_tokens: estimate_tokens(&body),
        })
    }

    // ============================================================
    // RESOURCE ACCESS (Progressive Disclosure Level 3)
    // ============================================================

    /// Read a reference file from a skill.
    pub fn read_reference(&self, slug: &str, filename: &str) -> Option<String> {
        let slug = sanitize_slug(slug).ok()?;
        let skill = self.loaded_skills.get(&slug)?;

        let safe_name = Path::new(filename).file_name()?.to_str()?;
        let file_path = PathBuf::from(&skill.path).join("references").join(safe_name);

        fs::read_to_string(file_path).ok()
    }

    /// Get the path to a script file.
    pub fn get_script_path(&self, slug: &str, filename: &str) -> Option<String> {
        let slug = sanitize_slug(slug).ok()?;
        let skill = self.loaded_skills.get(&slug)?;

        let safe_name = Path::new(filename).file_name()?.to_str()?;
        let file_path = PathBuf::from(&skill.path).join("scripts").join(safe_name);

        if file_path.exists() {
            Some(file_path.to_string_lossy().to_string())
        } else {
            None
        }
    }

    /// Get the path to an asset file.
    pub fn get_asset_path(&self, slug: &str, filename: &str) -> Option<String> {
        let slug = sanitize_slug(slug).ok()?;
        let skill = self.loaded_skills.get(&slug)?;

        let safe_name = Path::new(filename).file_name()?.to_str()?;
        let file_path = PathBuf::from(&skill.path).join("assets").join(safe_name);

        if file_path.exists() {
            Some(file_path.to_string_lossy().to_string())
        } else {
            None
        }
    }

    // ============================================================
    // SKILL RETRIEVAL
    // ============================================================

    /// Get all loaded skills.
    pub fn get_loaded_skills(&self) -> Vec<&Skill> {
        self.loaded_skills.values().collect()
    }

    /// Get a specific loaded skill.
    pub fn get_loaded_skill(&self, slug: &str) -> Option<&Skill> {
        let slug = sanitize_slug(slug).ok()?;
        self.loaded_skills.get(&slug)
    }

    /// Check if a skill is installed.
    pub fn is_installed(&self, slug: &str) -> bool {
        sanitize_slug(slug)
            .map(|s| self.loaded_skills.contains_key(&s))
            .unwrap_or(false)
    }

    // ============================================================
    // REGISTRY OPERATIONS
    // ============================================================

    /// Get the full skill catalog from the registry.
    pub async fn get_catalog(&mut self, force_refresh: bool) -> Result<Vec<SkillCatalogEntry>> {
        // Check cache
        if !force_refresh {
            if let Some(ref cache) = self.catalog_cache {
                if now_millis() - cache.cached_at < CacheTtl::CATALOG {
                    return Ok(cache.data.clone());
                }
            }
        }

        // Fetch from API
        let mut entries = Vec::new();
        let mut cursor: Option<String> = None;

        loop {
            let url = match &cursor {
                Some(c) => format!("{}/api/v1/skills?limit=100&cursor={}", self.api_base, c),
                None => format!("{}/api/v1/skills?limit=100", self.api_base),
            };

            let response = self.http_client.get(&url).send().await?;
            let data: serde_json::Value = response.json().await?;

            if let Some(items) = data.get("items").and_then(|v| v.as_array()) {
                for item in items {
                    if let Ok(entry) = serde_json::from_value::<SkillCatalogEntry>(item.clone()) {
                        entries.push(entry);
                    }
                }
            }

            cursor = data
                .get("nextCursor")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            if cursor.is_none() {
                break;
            }
        }

        self.catalog_cache = Some(CacheEntry {
            data: entries.clone(),
            cached_at: now_millis(),
        });

        self.save_catalog_to_disk();

        Ok(entries)
    }

    /// Search the registry for skills.
    pub async fn search(
        &mut self,
        query: &str,
        limit: usize,
        force_refresh: bool,
    ) -> Result<Vec<SkillSearchResult>> {
        let cache_key = format!("{}:{}", query, limit);

        // Check cache
        if !force_refresh {
            if let Some(cache) = self.search_cache.get(&cache_key) {
                if now_millis() - cache.cached_at < CacheTtl::SEARCH {
                    return Ok(cache.data.clone());
                }
            }
        }

        let url = format!(
            "{}/api/v1/search?q={}&limit={}",
            self.api_base, query, limit
        );

        let response = self.http_client.get(&url).send().await?;
        let data: serde_json::Value = response.json().await?;

        let results: Vec<SkillSearchResult> = data
            .get("results")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| serde_json::from_value(item.clone()).ok())
                    .collect()
            })
            .unwrap_or_default();

        self.search_cache.insert(
            cache_key,
            CacheEntry {
                data: results.clone(),
                cached_at: now_millis(),
            },
        );

        Ok(results)
    }

    /// Get skill details from the registry.
    pub async fn get_skill_details(
        &mut self,
        slug: &str,
        force_refresh: bool,
    ) -> Result<Option<SkillDetails>> {
        let safe_slug = sanitize_slug(slug)?;

        // Check cache
        if !force_refresh {
            if let Some(cache) = self.details_cache.get(&safe_slug) {
                if now_millis() - cache.cached_at < CacheTtl::SKILL_DETAILS {
                    return Ok(Some(cache.data.clone()));
                }
            }
        }

        let url = format!("{}/api/v1/skills/{}", self.api_base, safe_slug);
        let response = self.http_client.get(&url).send().await?;

        if response.status() == 404 {
            return Ok(None);
        }

        let details: SkillDetails = response.json().await?;

        self.details_cache.insert(
            safe_slug,
            CacheEntry {
                data: details.clone(),
                cached_at: now_millis(),
            },
        );

        Ok(Some(details))
    }

    // ============================================================
    // INSTALLATION
    // ============================================================

    /// Install a skill from the registry.
    pub async fn install(&mut self, slug: &str, version: Option<&str>, force: bool) -> Result<bool> {
        let safe_slug = sanitize_slug(slug)?;
        let version = version.unwrap_or("latest");

        // Check if already installed
        if !force && self.is_installed(&safe_slug) {
            return Ok(true);
        }

        // Get skill details
        let details = self
            .get_skill_details(&safe_slug, false)
            .await?
            .ok_or_else(|| Error::NotFound(safe_slug.clone()))?;

        let resolved_version = if version == "latest" {
            details.latest_version.version.clone()
        } else {
            version.to_string()
        };

        // Download
        let download_url = format!(
            "{}/api/v1/download?slug={}&version={}",
            self.api_base, safe_slug, resolved_version
        );

        let response = self.http_client.get(&download_url).send().await?;
        let bytes = response.bytes().await?;

        if bytes.len() > MAX_PACKAGE_SIZE {
            return Err(Error::PackageTooLarge {
                size: bytes.len(),
                max: MAX_PACKAGE_SIZE,
            });
        }

        // Extract
        let skill_dir = self.skills_dir.join(&safe_slug);
        fs::create_dir_all(&skill_dir)?;

        let cursor = std::io::Cursor::new(&bytes);
        let mut archive = ZipArchive::new(cursor)?;

        for i in 0..archive.len() {
            let mut file = archive.by_index(i)?;
            let name = file.name().to_string();

            // Skip directories
            if name.ends_with('/') {
                continue;
            }

            // Sanitize path
            let parts: Vec<&str> = name
                .split('/')
                .filter(|p| !p.is_empty() && *p != ".." && *p != ".")
                .collect();

            if parts.is_empty() {
                continue;
            }

            let mut safe_path = skill_dir.clone();
            for part in parts {
                safe_path = safe_path.join(part);
            }

            if let Some(parent) = safe_path.parent() {
                fs::create_dir_all(parent)?;
            }

            let mut contents = Vec::new();
            file.read_to_end(&mut contents)?;

            let mut out_file = fs::File::create(&safe_path)?;
            out_file.write_all(&contents)?;
        }

        // Update lockfile
        self.update_lockfile(&safe_slug, &resolved_version)?;

        // Load the skill
        self.load_skill(&safe_slug, true).await?;

        Ok(true)
    }

    // ============================================================
    // SYNC OPERATIONS
    // ============================================================

    /// Sync the skill catalog from the registry.
    pub async fn sync_catalog(&mut self) -> Result<(usize, usize)> {
        let old_count = self
            .catalog_cache
            .as_ref()
            .map(|c| c.data.len())
            .unwrap_or(0);

        self.get_catalog(true).await?;

        let new_count = self
            .catalog_cache
            .as_ref()
            .map(|c| c.data.len())
            .unwrap_or(0);

        Ok((new_count.saturating_sub(old_count), new_count))
    }

    // ============================================================
    // PRIVATE HELPERS
    // ============================================================

    fn get_skill_version(&self, slug: &str, frontmatter: &SkillFrontmatter) -> String {
        // Try metadata.version first
        if let Some(ref metadata) = frontmatter.metadata {
            if let Some(ref version) = metadata.version {
                return version.clone();
            }
        }

        // Try lockfile
        if let Some(version) = self.get_lockfile_version(slug) {
            return version;
        }

        "local".to_string()
    }

    fn get_lockfile_version(&self, slug: &str) -> Option<String> {
        let lockfile_path = self.cache_dir.join("lock.json");
        if !lockfile_path.exists() {
            return None;
        }

        let content = fs::read_to_string(lockfile_path).ok()?;
        let lockfile: serde_json::Value = serde_json::from_str(&content).ok()?;

        lockfile
            .get(slug)?
            .get("version")?
            .as_str()
            .map(|s| s.to_string())
    }

    fn update_lockfile(&self, slug: &str, version: &str) -> Result<()> {
        let lockfile_path = self.cache_dir.join("lock.json");

        let mut lockfile: serde_json::Value = if lockfile_path.exists() {
            let content = fs::read_to_string(&lockfile_path)?;
            serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
        } else {
            serde_json::json!({})
        };

        lockfile[slug] = serde_json::json!({
            "version": version,
            "installed_at": chrono::Utc::now().to_rfc3339()
        });

        let content = serde_json::to_string_pretty(&lockfile)?;
        fs::write(lockfile_path, content)?;

        Ok(())
    }

    fn load_catalog_from_disk(&mut self) {
        let catalog_path = self.cache_dir.join("catalog.json");
        if !catalog_path.exists() {
            return;
        }

        if let Ok(content) = fs::read_to_string(&catalog_path) {
            if let Ok(cached) = serde_json::from_str::<serde_json::Value>(&content) {
                if let (Some(data), Some(cached_at)) = (
                    cached.get("data").and_then(|v| v.as_array()),
                    cached.get("cached_at").and_then(|v| v.as_u64()),
                ) {
                    let entries: Vec<SkillCatalogEntry> = data
                        .iter()
                        .filter_map(|item| serde_json::from_value(item.clone()).ok())
                        .collect();

                    self.catalog_cache = Some(CacheEntry {
                        data: entries,
                        cached_at,
                    });
                }
            }
        }
    }

    fn save_catalog_to_disk(&self) {
        if let Some(ref cache) = self.catalog_cache {
            let catalog_path = self.cache_dir.join("catalog.json");

            let data = serde_json::json!({
                "data": cache.data,
                "cached_at": cache.cached_at
            });

            if let Ok(content) = serde_json::to_string_pretty(&data) {
                let _ = fs::write(catalog_path, content);
            }
        }
    }
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

fn sanitize_slug(slug: &str) -> Result<String> {
    let re = Regex::new(r"[^a-zA-Z0-9_-]").unwrap();
    let sanitized = re.replace_all(slug, "").to_string();

    if sanitized != slug || sanitized.is_empty() || sanitized.len() > 100 {
        return Err(Error::InvalidSlug(slug.to_string()));
    }

    Ok(sanitized)
}

fn list_dir_files(path: &Path) -> Vec<String> {
    if !path.exists() {
        return Vec::new();
    }

    fs::read_dir(path)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    if name.starts_with('.') {
                        None
                    } else {
                        Some(name)
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
