//! Prose service for OpenProse VM operations

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, RwLock};

use chrono::Utc;
use rand::Rng;
use tokio::fs;
use tracing::info;

use crate::error::Result;
use crate::types::{ProseConfig, ProseSkillFile, ProseStateMode};

// Module-level skill content cache
static SKILL_CONTENT: LazyLock<RwLock<HashMap<String, String>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// Set embedded skill content (for bundled deployment)
pub fn set_skill_content(skills: HashMap<String, String>) {
    if let Ok(mut content) = SKILL_CONTENT.write() {
        *content = skills;
    }
}

/// Get all skill content
pub fn get_skill_content() -> HashMap<String, String> {
    SKILL_CONTENT
        .read()
        .map(|c| c.clone())
        .unwrap_or_default()
}

/// Generate a unique run ID in format YYYYMMDD-HHMMSS-random6
fn generate_run_id() -> String {
    let now = Utc::now();
    let random: String = rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(6)
        .map(char::from)
        .collect();
    format!("{}-{}", now.format("%Y%m%d-%H%M%S"), random)
}

/// Service for OpenProse VM operations
pub struct ProseService {
    config: ProseConfig,
    skills_dir: Option<PathBuf>,
}

impl ProseService {
    /// Create a new ProseService with the given configuration
    pub fn new(config: ProseConfig) -> Self {
        info!("Prose service initialized");
        Self {
            skills_dir: config.skills_dir.as_ref().map(PathBuf::from),
            config,
        }
    }

    /// Create a new ProseService with default configuration
    pub fn with_defaults() -> Self {
        Self::new(ProseConfig::default())
    }

    /// Initialize the service by loading skill files
    pub async fn init(&mut self, skills_dir: Option<&str>) -> Result<()> {
        if let Some(dir) = skills_dir {
            self.skills_dir = Some(PathBuf::from(dir));
            self.load_skill_files(Path::new(dir)).await?;
        }
        info!("Prose service initialization complete");
        Ok(())
    }

    /// Load skill files from a directory
    async fn load_skill_files(&self, base_dir: &Path) -> Result<()> {
        let files = [
            "SKILL.md",
            "prose.md",
            "help.md",
            "compiler.md",
            "state/filesystem.md",
            "state/in-context.md",
            "state/sqlite.md",
            "state/postgres.md",
            "guidance/patterns.md",
            "guidance/antipatterns.md",
            "primitives/session.md",
        ];

        for file in files {
            let file_path = base_dir.join(file);
            if file_path.exists() {
                if let Ok(content) = fs::read_to_string(&file_path).await {
                    if let Ok(mut skills) = SKILL_CONTENT.write() {
                        skills.insert(file.to_string(), content);
                    }
                    tracing::debug!("Loaded skill file: {}", file);
                }
            }
        }

        Ok(())
    }

    /// Get the VM specification (prose.md)
    pub fn get_vm_spec(&self) -> Option<String> {
        SKILL_CONTENT
            .read()
            .ok()
            .and_then(|c| c.get("prose.md").cloned())
    }

    /// Get the skill description (SKILL.md)
    pub fn get_skill_spec(&self) -> Option<String> {
        SKILL_CONTENT
            .read()
            .ok()
            .and_then(|c| c.get("SKILL.md").cloned())
    }

    /// Get the help documentation
    pub fn get_help(&self) -> Option<String> {
        SKILL_CONTENT
            .read()
            .ok()
            .and_then(|c| c.get("help.md").cloned())
    }

    /// Get the compiler/validation spec
    pub fn get_compiler_spec(&self) -> Option<String> {
        SKILL_CONTENT
            .read()
            .ok()
            .and_then(|c| c.get("compiler.md").cloned())
    }

    /// Get state management spec for a given mode
    pub fn get_state_spec(&self, mode: ProseStateMode) -> Option<String> {
        let filename = match mode {
            ProseStateMode::Filesystem => "state/filesystem.md",
            ProseStateMode::InContext => "state/in-context.md",
            ProseStateMode::Sqlite => "state/sqlite.md",
            ProseStateMode::Postgres => "state/postgres.md",
        };

        SKILL_CONTENT
            .read()
            .ok()
            .and_then(|c| c.get(filename).cloned())
    }

    /// Get authoring guidance (patterns and antipatterns)
    pub fn get_authoring_guidance(&self) -> (Option<String>, Option<String>) {
        let content = SKILL_CONTENT.read().ok();
        (
            content.as_ref().and_then(|c| c.get("guidance/patterns.md").cloned()),
            content.as_ref().and_then(|c| c.get("guidance/antipatterns.md").cloned()),
        )
    }

    /// Get all loaded skill files
    pub fn get_loaded_skills(&self) -> Vec<ProseSkillFile> {
        SKILL_CONTENT
            .read()
            .map(|c| {
                c.iter()
                    .map(|(name, content)| ProseSkillFile {
                        name: name.clone(),
                        path: name.clone(),
                        content: content.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Check if a .prose file exists
    pub async fn file_exists(&self, file_path: &str) -> bool {
        fs::metadata(file_path).await.is_ok()
    }

    /// Read a .prose file
    pub async fn read_prose_file(&self, file_path: &str) -> Result<String> {
        fs::read_to_string(file_path).await.map_err(Into::into)
    }

    /// Create the workspace directory structure
    pub async fn ensure_workspace(&self, base_dir: &str) -> Result<String> {
        let workspace_dir = Path::new(base_dir).join(&self.config.workspace_dir);

        fs::create_dir_all(&workspace_dir).await?;
        fs::create_dir_all(workspace_dir.join("runs")).await?;
        fs::create_dir_all(workspace_dir.join("agents")).await?;

        Ok(workspace_dir.display().to_string())
    }

    /// Create a new run directory
    pub async fn create_run_directory(
        &self,
        workspace_dir: &str,
        program_content: &str,
    ) -> Result<(String, String)> {
        let run_id = generate_run_id();
        let run_dir = Path::new(workspace_dir).join("runs").join(&run_id);

        fs::create_dir_all(&run_dir).await?;
        fs::create_dir_all(run_dir.join("bindings")).await?;
        fs::create_dir_all(run_dir.join("agents")).await?;
        fs::create_dir_all(run_dir.join("imports")).await?;

        // Write the program copy
        fs::write(run_dir.join("program.prose"), program_content).await?;

        // Initialize state.md
        let initial_state = format!(
            r#"# Run State

run_id: {}
status: initializing
position: 0

## Program

```prose
{}
```

## Execution Log

| Time | Position | Action | Status |
|------|----------|--------|--------|
"#,
            run_id, program_content
        );
        fs::write(run_dir.join("state.md"), initial_state).await?;

        Ok((run_id, run_dir.display().to_string()))
    }

    /// List available example programs
    pub async fn list_examples(&self) -> Vec<String> {
        let Some(skills_dir) = &self.skills_dir else {
            return Vec::new();
        };

        let examples_dir = skills_dir.join("examples");
        if !examples_dir.exists() {
            return Vec::new();
        }

        let mut entries = match fs::read_dir(&examples_dir).await {
            Ok(e) => e,
            Err(_) => return Vec::new(),
        };

        let mut examples = Vec::new();
        while let Ok(Some(entry)) = entries.next_entry().await {
            if let Some(name) = entry.file_name().to_str() {
                if name.ends_with(".prose") {
                    examples.push(name.to_string());
                }
            }
        }

        examples.sort();
        examples
    }

    /// Read an example program
    pub async fn read_example(&self, name: &str) -> Option<String> {
        let skills_dir = self.skills_dir.as_ref()?;
        let examples_dir = skills_dir.join("examples");

        let file_name = if name.ends_with(".prose") {
            name.to_string()
        } else {
            format!("{}.prose", name)
        };

        let file_path = examples_dir.join(&file_name);
        fs::read_to_string(&file_path).await.ok()
    }

    /// Build the VM context for the agent
    pub fn build_vm_context(
        &self,
        state_mode: ProseStateMode,
        include_compiler: bool,
        include_guidance: bool,
    ) -> String {
        let mut parts = Vec::new();

        // VM banner
        parts.push(
            r#"┌─────────────────────────────────────┐
│         ◇ OpenProse VM ◇            │
│       A new kind of computer        │
└─────────────────────────────────────┘"#
                .to_string(),
        );

        // Core VM spec
        if let Some(vm_spec) = self.get_vm_spec() {
            parts.push("\n## VM Specification\n".to_string());
            parts.push(vm_spec);
        }

        // State management spec
        if let Some(state_spec) = self.get_state_spec(state_mode) {
            parts.push(format!("\n## State Management ({})\n", state_mode));
            parts.push(state_spec);
        }

        // Compiler spec if needed
        if include_compiler {
            if let Some(compiler_spec) = self.get_compiler_spec() {
                parts.push("\n## Compiler/Validator\n".to_string());
                parts.push(compiler_spec);
            }
        }

        // Authoring guidance if needed
        if include_guidance {
            let (patterns, antipatterns) = self.get_authoring_guidance();
            if let Some(p) = patterns {
                parts.push("\n## Authoring Patterns\n".to_string());
                parts.push(p);
            }
            if let Some(ap) = antipatterns {
                parts.push("\n## Authoring Antipatterns\n".to_string());
                parts.push(ap);
            }
        }

        parts.join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_run_id() {
        let id = generate_run_id();
        assert!(!id.is_empty());
        assert!(id.contains('-'));
    }

    #[test]
    fn test_prose_service_creation() {
        let service = ProseService::with_defaults();
        assert!(service.get_vm_spec().is_none()); // No skills loaded
    }

    #[test]
    fn test_build_vm_context() {
        let service = ProseService::with_defaults();
        let context = service.build_vm_context(ProseStateMode::Filesystem, false, false);
        assert!(context.contains("OpenProse VM"));
    }
}
