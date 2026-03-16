//! Skill Storage Abstraction
//!
//! Provides two storage backends:
//! - MemorySkillStore: For browser/WASM environments (skills in memory)
//! - FileSystemSkillStore: For native environments (skills on disk)
//!
//! Both implement the same trait for seamless switching.

use async_trait::async_trait;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use zip::ZipArchive;

use crate::error::Error;
use crate::parser::{parse_frontmatter, validate_frontmatter};
use crate::types::Skill;

// ============================================================
// STORAGE TYPES
// ============================================================

/// Skill file representation for in-memory storage.
#[derive(Clone, Debug)]
pub struct SkillFile {
    pub path: String,
    pub content: FileContent,
    pub is_text: bool,
}

/// File content - either text or binary.
#[derive(Clone, Debug)]
pub enum FileContent {
    Text(String),
    Binary(Vec<u8>),
}

impl FileContent {
    pub fn as_text(&self) -> Option<&str> {
        match self {
            FileContent::Text(s) => Some(s),
            FileContent::Binary(_) => None,
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        match self {
            FileContent::Text(s) => s.as_bytes(),
            FileContent::Binary(b) => b,
        }
    }
}

/// Skill package - all files for a skill.
#[derive(Clone, Debug)]
pub struct SkillPackage {
    pub slug: String,
    pub files: HashMap<String, SkillFile>,
}

// ============================================================
// STORAGE TRAIT
// ============================================================

/// Storage interface for skill management.
#[async_trait]
pub trait SkillStorage: Send + Sync {
    /// Storage type identifier.
    fn storage_type(&self) -> &'static str;

    /// Initialize storage.
    async fn initialize(&mut self) -> Result<(), Error>;

    /// List all installed skill slugs.
    async fn list_skills(&self) -> Result<Vec<String>, Error>;

    /// Check if a skill exists.
    async fn has_skill(&self, slug: &str) -> Result<bool, Error>;

    /// Load a skill's SKILL.md content.
    async fn load_skill_content(&self, slug: &str) -> Result<Option<String>, Error>;

    /// Load a specific file from a skill.
    async fn load_file(&self, slug: &str, relative_path: &str) -> Result<Option<FileContent>, Error>;

    /// List files in a skill directory.
    async fn list_files(&self, slug: &str, subdir: Option<&str>) -> Result<Vec<String>, Error>;

    /// Save a complete skill package.
    async fn save_skill(&mut self, pkg: SkillPackage) -> Result<(), Error>;

    /// Delete a skill.
    async fn delete_skill(&mut self, slug: &str) -> Result<bool, Error>;

    /// Get skill directory path (filesystem) or virtual path (memory).
    fn get_skill_path(&self, slug: &str) -> String;
}

// ============================================================
// MEMORY STORAGE
// ============================================================

/// In-memory skill storage for browser/WASM environments.
///
/// Skills are stored entirely in memory, making this suitable for:
/// - WASM environments without filesystem access
/// - Virtual FS scenarios
/// - Testing
/// - Ephemeral skill loading
pub struct MemorySkillStore {
    base_path: String,
    skills: HashMap<String, SkillPackage>,
}

impl MemorySkillStore {
    pub fn new(base_path: &str) -> Self {
        Self {
            base_path: base_path.to_string(),
            skills: HashMap::new(),
        }
    }

    /// Load a skill directly from content (no network/file needed).
    pub async fn load_from_content(
        &mut self,
        slug: &str,
        skill_md_content: &str,
        additional_files: Option<HashMap<String, FileContent>>,
    ) -> Result<(), Error> {
        let mut files = HashMap::new();

        // Add SKILL.md
        files.insert(
            "SKILL.md".to_string(),
            SkillFile {
                path: "SKILL.md".to_string(),
                content: FileContent::Text(skill_md_content.to_string()),
                is_text: true,
            },
        );

        // Add any additional files
        if let Some(extras) = additional_files {
            for (path, content) in extras {
                let is_text = matches!(content, FileContent::Text(_));
                files.insert(
                    path.clone(),
                    SkillFile {
                        path,
                        content,
                        is_text,
                    },
                );
            }
        }

        self.save_skill(SkillPackage {
            slug: slug.to_string(),
            files,
        })
        .await
    }

    /// Load a skill from a zip buffer (for registry downloads).
    pub async fn load_from_zip(&mut self, slug: &str, zip_data: &[u8]) -> Result<(), Error> {
        let cursor = std::io::Cursor::new(zip_data);
        let mut archive = ZipArchive::new(cursor)?;

        let mut files = HashMap::new();

        for i in 0..archive.len() {
            let mut file = archive.by_index(i)?;
            let file_name = file.name().to_string();

            if file_name.ends_with('/') {
                continue;
            }

            // Sanitize path
            let parts: Vec<&str> = file_name
                .split('/')
                .filter(|p| !p.is_empty() && *p != ".." && *p != ".")
                .collect();

            if parts.is_empty() {
                continue;
            }

            let relative_path = parts.join("/");
            let is_text = is_text_file(&relative_path);

            let mut data = Vec::new();
            std::io::Read::read_to_end(&mut file, &mut data)?;

            let content = if is_text {
                FileContent::Text(String::from_utf8_lossy(&data).to_string())
            } else {
                FileContent::Binary(data)
            };

            files.insert(
                relative_path.clone(),
                SkillFile {
                    path: relative_path,
                    content,
                    is_text,
                },
            );
        }

        self.save_skill(SkillPackage {
            slug: slug.to_string(),
            files,
        })
        .await
    }

    /// Get the full skill package (for export/transfer).
    pub fn get_package(&self, slug: &str) -> Option<&SkillPackage> {
        self.skills.get(slug)
    }

    /// Get all skills in memory.
    pub fn get_all_packages(&self) -> &HashMap<String, SkillPackage> {
        &self.skills
    }
}

#[async_trait]
impl SkillStorage for MemorySkillStore {
    fn storage_type(&self) -> &'static str {
        "memory"
    }

    async fn initialize(&mut self) -> Result<(), Error> {
        Ok(())
    }

    async fn list_skills(&self) -> Result<Vec<String>, Error> {
        Ok(self.skills.keys().cloned().collect())
    }

    async fn has_skill(&self, slug: &str) -> Result<bool, Error> {
        Ok(self.skills.contains_key(slug))
    }

    async fn load_skill_content(&self, slug: &str) -> Result<Option<String>, Error> {
        let pkg = match self.skills.get(slug) {
            Some(p) => p,
            None => return Ok(None),
        };

        let skill_md = match pkg.files.get("SKILL.md") {
            Some(f) if f.is_text => f,
            _ => return Ok(None),
        };

        Ok(skill_md.content.as_text().map(|s| s.to_string()))
    }

    async fn load_file(&self, slug: &str, relative_path: &str) -> Result<Option<FileContent>, Error> {
        let pkg = match self.skills.get(slug) {
            Some(p) => p,
            None => return Ok(None),
        };

        Ok(pkg.files.get(relative_path).map(|f| f.content.clone()))
    }

    async fn list_files(&self, slug: &str, subdir: Option<&str>) -> Result<Vec<String>, Error> {
        let pkg = match self.skills.get(slug) {
            Some(p) => p,
            None => return Ok(vec![]),
        };

        let prefix = subdir.map(|s| format!("{}/", s)).unwrap_or_default();
        let mut files = vec![];

        for path in pkg.files.keys() {
            if let Some(sub) = subdir {
                if path.starts_with(&prefix) {
                    let rest = &path[prefix.len()..];
                    if !rest.contains('/') {
                        files.push(rest.to_string());
                    }
                }
            } else if !path.contains('/') {
                files.push(path.clone());
            }
        }

        Ok(files)
    }

    async fn save_skill(&mut self, pkg: SkillPackage) -> Result<(), Error> {
        self.skills.insert(pkg.slug.clone(), pkg);
        Ok(())
    }

    async fn delete_skill(&mut self, slug: &str) -> Result<bool, Error> {
        Ok(self.skills.remove(slug).is_some())
    }

    fn get_skill_path(&self, slug: &str) -> String {
        format!("{}/{}", self.base_path, slug)
    }
}

// ============================================================
// FILESYSTEM STORAGE
// ============================================================

/// Filesystem-based skill storage for native environments.
///
/// Skills are stored on disk, making this suitable for:
/// - Native server environments
/// - CLI tools
/// - Persistent skill installations
pub struct FileSystemSkillStore {
    base_path: PathBuf,
}

impl FileSystemSkillStore {
    pub fn new(base_path: &str) -> Self {
        Self {
            base_path: PathBuf::from(base_path),
        }
    }

    /// Save a skill from a zip buffer.
    pub async fn save_from_zip(&mut self, slug: &str, zip_data: &[u8]) -> Result<(), Error> {
        let cursor = std::io::Cursor::new(zip_data);
        let mut archive = ZipArchive::new(cursor)?;

        let mut files = HashMap::new();

        for i in 0..archive.len() {
            let mut file = archive.by_index(i)?;
            let file_name = file.name().to_string();

            if file_name.ends_with('/') {
                continue;
            }

            let parts: Vec<&str> = file_name
                .split('/')
                .filter(|p| !p.is_empty() && *p != ".." && *p != ".")
                .collect();

            if parts.is_empty() {
                continue;
            }

            let relative_path = parts.join("/");
            let is_text = is_text_file(&relative_path);

            let mut data = Vec::new();
            std::io::Read::read_to_end(&mut file, &mut data)?;

            let content = if is_text {
                FileContent::Text(String::from_utf8_lossy(&data).to_string())
            } else {
                FileContent::Binary(data)
            };

            files.insert(
                relative_path.clone(),
                SkillFile {
                    path: relative_path,
                    content,
                    is_text,
                },
            );
        }

        self.save_skill(SkillPackage {
            slug: slug.to_string(),
            files,
        })
        .await
    }
}

#[async_trait]
impl SkillStorage for FileSystemSkillStore {
    fn storage_type(&self) -> &'static str {
        "filesystem"
    }

    async fn initialize(&mut self) -> Result<(), Error> {
        std::fs::create_dir_all(&self.base_path)?;
        Ok(())
    }

    async fn list_skills(&self) -> Result<Vec<String>, Error> {
        if !self.base_path.exists() {
            return Ok(vec![]);
        }

        let entries = std::fs::read_dir(&self.base_path)?;

        let skills: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();

        Ok(skills)
    }

    async fn has_skill(&self, slug: &str) -> Result<bool, Error> {
        let skill_path = self.base_path.join(slug).join("SKILL.md");
        Ok(skill_path.exists())
    }

    async fn load_skill_content(&self, slug: &str) -> Result<Option<String>, Error> {
        let skill_path = self.base_path.join(slug).join("SKILL.md");
        if !skill_path.exists() {
            return Ok(None);
        }

        let content = std::fs::read_to_string(skill_path)?;
        Ok(Some(content))
    }

    async fn load_file(&self, slug: &str, relative_path: &str) -> Result<Option<FileContent>, Error> {
        // Sanitize path
        let safe_parts: Vec<&str> = relative_path
            .split('/')
            .filter(|p| !p.is_empty() && *p != ".." && *p != ".")
            .collect();

        if safe_parts.is_empty() {
            return Ok(None);
        }

        let mut full_path = self.base_path.join(slug);
        for part in safe_parts {
            full_path = full_path.join(part);
        }

        if !full_path.exists() {
            return Ok(None);
        }

        if is_text_file(relative_path) {
            let content = std::fs::read_to_string(&full_path)?;
            Ok(Some(FileContent::Text(content)))
        } else {
            let data = std::fs::read(&full_path)?;
            Ok(Some(FileContent::Binary(data)))
        }
    }

    async fn list_files(&self, slug: &str, subdir: Option<&str>) -> Result<Vec<String>, Error> {
        let dir_path = match subdir {
            Some(s) => self.base_path.join(slug).join(s),
            None => self.base_path.join(slug),
        };

        if !dir_path.exists() {
            return Ok(vec![]);
        }

        let entries = std::fs::read_dir(dir_path)?;

        let files: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();

        Ok(files)
    }

    async fn save_skill(&mut self, pkg: SkillPackage) -> Result<(), Error> {
        let skill_dir = self.base_path.join(&pkg.slug);
        std::fs::create_dir_all(&skill_dir)?;

        for (relative_path, file) in pkg.files {
            let full_path = skill_dir.join(&relative_path);

            if let Some(parent) = full_path.parent() {
                std::fs::create_dir_all(parent)?;
            }

            match &file.content {
                FileContent::Text(s) => {
                    std::fs::write(&full_path, s)?;
                }
                FileContent::Binary(b) => {
                    std::fs::write(&full_path, b)?;
                }
            }
        }

        Ok(())
    }

    async fn delete_skill(&mut self, slug: &str) -> Result<bool, Error> {
        let skill_dir = self.base_path.join(slug);
        if !skill_dir.exists() {
            return Ok(false);
        }

        std::fs::remove_dir_all(skill_dir)?;
        Ok(true)
    }

    fn get_skill_path(&self, slug: &str) -> String {
        self.base_path
            .join(slug)
            .canonicalize()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| self.base_path.join(slug).to_string_lossy().to_string())
    }
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/// Determine if a file is text-based by extension.
fn is_text_file(file_path: &str) -> bool {
    let text_extensions = [
        ".md", ".txt", ".json", ".yaml", ".yml", ".toml",
        ".js", ".ts", ".py", ".rs", ".sh", ".bash",
        ".html", ".css", ".xml", ".svg",
        ".env", ".gitignore", ".dockerignore",
    ];

    let path = Path::new(file_path);
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let ext_with_dot = format!(".{}", ext.to_lowercase());

    text_extensions.contains(&ext_with_dot.as_str()) || !file_path.contains('.')
}

/// Create the appropriate storage based on type.
pub fn create_storage(
    storage_type: &str,
    base_path: Option<&str>,
) -> Box<dyn SkillStorage> {
    match storage_type {
        "memory" => Box::new(MemorySkillStore::new(base_path.unwrap_or("/virtual/skills"))),
        "filesystem" => Box::new(FileSystemSkillStore::new(base_path.unwrap_or("./skills"))),
        _ => {
            // Auto-detect: In Rust we default to filesystem
            Box::new(FileSystemSkillStore::new(base_path.unwrap_or("./skills")))
        }
    }
}

/// Install a skill from a GitHub repository.
///
/// Supports both full repo paths and shorthand:
/// - "owner/repo" - Uses repo root
/// - "owner/repo/path/to/skill" - Uses specific subdirectory
/// - "https://github.com/owner/repo" - Full URL
///
/// Downloads SKILL.md and any additional files.
pub async fn install_from_github(
    storage: &mut dyn SkillStorage,
    repo: &str,
    path: Option<&str>,
    branch: Option<&str>,
) -> Result<Option<Skill>, Error> {
    let branch = branch.unwrap_or("main");

    // Parse repo string
    let (owner, repo_name, skill_path): (String, String, Option<String>) = if repo.starts_with("http") {
        // Handle full URL
        let url = url::Url::parse(repo)?;
        let url_path = url.path();
        let parts: Vec<&str> = url_path.split('/').filter(|p: &&str| !p.is_empty()).collect();

        if parts.len() < 2 {
            return Err(Error::Parse("Invalid GitHub URL".to_string()));
        }

        let owner = parts[0].to_string();
        let repo_name = parts[1].to_string();
        let skill_path: Option<String> = if parts.len() > 2 {
            let tree_idx = parts.iter().position(|&p| p == "tree");
            if let Some(idx) = tree_idx {
                if parts.len() > idx + 2 {
                    Some(parts[idx + 2..].join("/"))
                } else {
                    None
                }
            } else {
                Some(parts[2..].join("/"))
            }
        } else {
            path.map(|s| s.to_string())
        };

        (owner, repo_name, skill_path)
    } else {
        // Handle shorthand: owner/repo or owner/repo/path
        let parts: Vec<&str> = repo.split('/').collect();

        if parts.len() < 2 {
            return Err(Error::Parse("Invalid repo format. Use owner/repo or owner/repo/path".to_string()));
        }

        let owner = parts[0].to_string();
        let repo_name = parts[1].to_string();
        let skill_path: Option<String> = if parts.len() > 2 {
            Some(parts[2..].join("/"))
        } else {
            path.map(|s| s.to_string())
        };

        (owner, repo_name, skill_path)
    };

    // Derive slug from path or repo name
    let slug: String = skill_path
        .as_ref()
        .and_then(|p: &String| p.split('/').last().map(|s| s.to_string()))
        .unwrap_or_else(|| repo_name.clone());

    // Construct raw GitHub URLs
    let base_path = skill_path.as_ref().map(|p| format!("{}/", p)).unwrap_or_default();
    let raw_base = format!(
        "https://raw.githubusercontent.com/{}/{}/{}/{}",
        owner, repo_name, branch, base_path
    );

    // Download SKILL.md
    let skill_md_url = format!("{}SKILL.md", raw_base);
    let client = reqwest::Client::new();

    let response: reqwest::Response = client.get(&skill_md_url).send().await
        .map_err(|e| Error::Parse(format!("Failed to fetch SKILL.md: {}", e)))?;

    if !response.status().is_success() {
        eprintln!("Failed to fetch SKILL.md from {}: {}", skill_md_url, response.status());
        return Ok(None);
    }

    let skill_md_content: String = response.text().await
        .map_err(|e| Error::Parse(format!("Failed to read SKILL.md: {}", e)))?;

    // Create skill package
    let mut files = HashMap::new();
    files.insert(
        "SKILL.md".to_string(),
        SkillFile {
            path: "SKILL.md".to_string(),
            content: FileContent::Text(skill_md_content),
            is_text: true,
        },
    );

    // Try to fetch README.md (optional)
    let readme_url = format!("{}README.md", raw_base);
    if let Ok(response) = client.get(&readme_url).send().await {
        if response.status().is_success() {
            if let Ok(readme_content) = response.text().await {
                files.insert(
                    "README.md".to_string(),
                    SkillFile {
                        path: "README.md".to_string(),
                        content: FileContent::Text(readme_content),
                        is_text: true,
                    },
                );
            }
        }
    }

    // Save to storage
    storage.save_skill(SkillPackage {
        slug: slug.clone(),
        files,
    }).await?;

    // Load and return
    load_skill_from_storage(storage, &slug, true).await
}

/// Install a skill from a direct URL to a SKILL.md file or zip package.
pub async fn install_from_url(
    storage: &mut dyn SkillStorage,
    url_str: &str,
    slug: Option<&str>,
) -> Result<Option<Skill>, Error> {
    let client = reqwest::Client::new();

    let response: reqwest::Response = client.get(url_str).send().await
        .map_err(|e| Error::Parse(format!("Failed to fetch: {}", e)))?;

    if !response.status().is_success() {
        eprintln!("Failed to fetch: {}", response.status());
        return Ok(None);
    }

    let content_type: String = response.headers()
        .get("content-type")
        .and_then(|v: &reqwest::header::HeaderValue| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    // Derive slug from URL
    let url = url::Url::parse(url_str)?;
    let url_path = url.path();
    let path_segments: Vec<&str> = url_path.split('/').filter(|s: &&str| !s.is_empty()).collect();
    let default_slug = path_segments.last()
        .map(|s: &&str| s.trim_end_matches(".md").trim_end_matches(".zip"))
        .unwrap_or("skill");
    let derived_slug = slug.unwrap_or(default_slug);

    if content_type.contains("application/zip") || url_str.ends_with(".zip") {
        // Handle zip package
        let zip_data = response.bytes().await
            .map_err(|e| Error::Parse(format!("Failed to read zip: {}", e)))?;

        // Save based on storage type
        let slug_str = derived_slug.to_string();
        let pkg = {
            let cursor = std::io::Cursor::new(&zip_data[..]);
            let mut archive = ZipArchive::new(cursor)?;

            let mut files = HashMap::new();

            for i in 0..archive.len() {
                let mut file = archive.by_index(i)?;
                let file_name = file.name().to_string();

                if file_name.ends_with('/') {
                    continue;
                }

                let parts: Vec<&str> = file_name
                    .split('/')
                    .filter(|p: &&str| !p.is_empty() && *p != ".." && *p != ".")
                    .collect();

                if parts.is_empty() {
                    continue;
                }

                let relative_path = parts.join("/");
                let is_text = is_text_file(&relative_path);

                let mut data = Vec::new();
                std::io::Read::read_to_end(&mut file, &mut data)?;

                let content = if is_text {
                    FileContent::Text(String::from_utf8_lossy(&data).to_string())
                } else {
                    FileContent::Binary(data)
                };

                files.insert(
                    relative_path.clone(),
                    SkillFile {
                        path: relative_path,
                        content,
                        is_text,
                    },
                );
            }

            SkillPackage {
                slug: slug_str.clone(),
                files,
            }
        };

        storage.save_skill(pkg).await?;
        return load_skill_from_storage(storage, &slug_str, true).await;
    }

    // Assume it's a SKILL.md file
    let content: String = response.text().await
        .map_err(|e| Error::Parse(format!("Failed to read: {}", e)))?;

    let mut files = HashMap::new();
    files.insert(
        "SKILL.md".to_string(),
        SkillFile {
            path: "SKILL.md".to_string(),
            content: FileContent::Text(content),
            is_text: true,
        },
    );

    storage.save_skill(SkillPackage {
        slug: derived_slug.to_string(),
        files,
    }).await?;

    load_skill_from_storage(storage, derived_slug, true).await
}

/// Load a skill from storage into a Skill struct.
pub async fn load_skill_from_storage(
    storage: &dyn SkillStorage,
    slug: &str,
    validate: bool,
) -> Result<Option<Skill>, Error> {
    let content = match storage.load_skill_content(slug).await? {
        Some(c) => c,
        None => return Ok(None),
    };

    let (frontmatter, _body, _raw) = parse_frontmatter(&content);
    let frontmatter = match frontmatter {
        Some(f) => f,
        None => return Ok(None),
    };

    // Validate if requested
    if validate {
        let validation = validate_frontmatter(&frontmatter, Some(slug));
        if !validation.valid {
            eprintln!(
                "Skill {} validation failed: {:?}",
                slug, validation.errors
            );
        }
    }

    // List resource files
    let scripts = storage.list_files(slug, Some("scripts")).await?;
    let references = storage.list_files(slug, Some("references")).await?;
    let assets = storage.list_files(slug, Some("assets")).await?;

    // Get version
    let version = frontmatter
        .metadata
        .as_ref()
        .and_then(|m| m.version.clone())
        .unwrap_or_else(|| "local".to_string());

    Ok(Some(Skill {
        slug: slug.to_string(),
        name: frontmatter.name.clone(),
        description: frontmatter.description.clone(),
        version,
        content,
        frontmatter,
        path: storage.get_skill_path(slug),
        scripts,
        references,
        assets,
        loaded_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_memory_storage_basic() {
        let mut store = MemorySkillStore::new("/virtual/skills");
        store.initialize().await.unwrap();

        assert_eq!(store.storage_type(), "memory");
        assert!(store.list_skills().await.unwrap().is_empty());

        let content = r#"---
name: test-skill
description: A test skill
---
# Test
"#;

        store.load_from_content("test-skill", content, None).await.unwrap();

        assert!(store.has_skill("test-skill").await.unwrap());
        assert_eq!(store.list_skills().await.unwrap(), vec!["test-skill"]);

        let loaded = store.load_skill_content("test-skill").await.unwrap();
        assert!(loaded.is_some());
        assert!(loaded.unwrap().contains("test-skill"));
    }

    #[tokio::test]
    async fn test_create_storage() {
        let mem_storage = create_storage("memory", None);
        assert_eq!(mem_storage.storage_type(), "memory");

        let fs_storage = create_storage("filesystem", Some("/tmp/test-skills"));
        assert_eq!(fs_storage.storage_type(), "filesystem");

        let auto_storage = create_storage("auto", None);
        assert_eq!(auto_storage.storage_type(), "filesystem");
    }
}
