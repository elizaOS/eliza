//! File utilities for SWE-agent

use crate::exceptions::{Result, SWEAgentError};
use std::fs;
use std::path::Path;

/// Load a file's contents as a string
pub fn load_file(path: &Path) -> Result<String> {
    fs::read_to_string(path)
        .map_err(|e| SWEAgentError::FileNotFound(format!("{}: {}", path.display(), e)))
}

/// Write contents to a file
pub fn write_file(path: &Path, contents: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, contents)?;
    Ok(())
}

/// Check if a file exists
pub fn file_exists(path: &Path) -> bool {
    path.exists() && path.is_file()
}

/// Check if a directory exists
pub fn dir_exists(path: &Path) -> bool {
    path.exists() && path.is_dir()
}

/// Create a directory and all parent directories
pub fn ensure_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    Ok(())
}

/// Get the extension of a file
pub fn get_extension(path: &Path) -> Option<String> {
    path.extension().and_then(|e| e.to_str()).map(String::from)
}

/// Read a JSON file and deserialize it
pub fn load_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let contents = load_file(path)?;
    serde_json::from_str(&contents).map_err(|e| {
        SWEAgentError::SerializationError(format!(
            "Failed to parse JSON from {}: {}",
            path.display(),
            e
        ))
    })
}

/// Read a YAML file and deserialize it
pub fn load_yaml<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let contents = load_file(path)?;
    serde_yaml::from_str(&contents).map_err(|e| {
        SWEAgentError::SerializationError(format!(
            "Failed to parse YAML from {}: {}",
            path.display(),
            e
        ))
    })
}

/// Save an object as JSON to a file
pub fn save_json<T: serde::Serialize>(path: &Path, data: &T) -> Result<()> {
    let contents = serde_json::to_string_pretty(data)?;
    write_file(path, &contents)
}

/// Save an object as YAML to a file
pub fn save_yaml<T: serde::Serialize>(path: &Path, data: &T) -> Result<()> {
    let contents = serde_yaml::to_string(data)?;
    write_file(path, &contents)
}

/// Find files matching a glob pattern
pub fn find_files(base_dir: &Path, pattern: &str) -> Result<Vec<std::path::PathBuf>> {
    let full_pattern = base_dir.join(pattern);
    let pattern_str = full_pattern.to_string_lossy();

    glob::glob(&pattern_str)
        .map_err(|e| SWEAgentError::IoError(format!("Invalid glob pattern: {}", e)))?
        .filter_map(|entry| entry.ok())
        .collect::<Vec<_>>()
        .pipe(Ok)
}

trait Pipe: Sized {
    fn pipe<T, F: FnOnce(Self) -> T>(self, f: F) -> T {
        f(self)
    }
}

impl<T> Pipe for T {}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_write_and_load_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.txt");

        write_file(&path, "hello world").unwrap();
        let contents = load_file(&path).unwrap();

        assert_eq!(contents, "hello world");
    }

    #[test]
    fn test_file_exists() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.txt");

        assert!(!file_exists(&path));
        write_file(&path, "test").unwrap();
        assert!(file_exists(&path));
    }

    #[test]
    fn test_get_extension() {
        assert_eq!(
            get_extension(Path::new("file.txt")),
            Some("txt".to_string())
        );
        assert_eq!(
            get_extension(Path::new("file.tar.gz")),
            Some("gz".to_string())
        );
        assert_eq!(get_extension(Path::new("file")), None);
    }
}
