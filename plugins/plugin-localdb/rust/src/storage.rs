#![allow(missing_docs)]

use anyhow::{Context, Result};
use serde::{de::DeserializeOwned, Serialize};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter};
use std::path::{Path, PathBuf};
use std::sync::RwLock;

pub struct JsonStorage {
    data_dir: PathBuf,
    ready: RwLock<bool>,
}

impl JsonStorage {
    pub fn new<P: AsRef<Path>>(data_dir: P) -> Result<Self> {
        Ok(Self {
            data_dir: data_dir.as_ref().to_path_buf(),
            ready: RwLock::new(false),
        })
    }

    pub async fn init(&self) -> Result<()> {
        fs::create_dir_all(&self.data_dir).context("Failed to create data directory")?;
        *self.ready.write().unwrap() = true;
        Ok(())
    }

    pub async fn close(&self) -> Result<()> {
        *self.ready.write().unwrap() = false;
        Ok(())
    }

    pub fn is_ready(&self) -> bool {
        *self.ready.read().unwrap()
    }

    fn collection_dir(&self, collection: &str) -> PathBuf {
        self.data_dir.join(collection)
    }

    fn file_path(&self, collection: &str, id: &str) -> PathBuf {
        let safe_id: String = id
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        self.collection_dir(collection)
            .join(format!("{}.json", safe_id))
    }

    pub fn get<T: DeserializeOwned>(&self, collection: &str, id: &str) -> Result<Option<T>> {
        let path = self.file_path(collection, id);
        if !path.exists() {
            return Ok(None);
        }

        let file = File::open(&path).context("Failed to open file")?;
        let reader = BufReader::new(file);
        let item: T = serde_json::from_reader(reader).context("Failed to deserialize")?;
        Ok(Some(item))
    }

    pub fn get_all<T: DeserializeOwned>(&self, collection: &str) -> Result<Vec<T>> {
        let dir = self.collection_dir(collection);
        if !dir.exists() {
            return Ok(Vec::new());
        }

        let mut items = Vec::new();
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "json") {
                if let Ok(file) = File::open(&path) {
                    let reader = BufReader::new(file);
                    if let Ok(item) = serde_json::from_reader::<_, T>(reader) {
                        items.push(item);
                    }
                }
            }
        }
        Ok(items)
    }

    pub fn get_where<T, F>(&self, collection: &str, predicate: F) -> Result<Vec<T>>
    where
        T: DeserializeOwned,
        F: Fn(&T) -> bool,
    {
        let all = self.get_all::<T>(collection)?;
        Ok(all.into_iter().filter(predicate).collect())
    }

    pub fn set<T: Serialize>(&self, collection: &str, id: &str, data: &T) -> Result<()> {
        let dir = self.collection_dir(collection);
        fs::create_dir_all(&dir).context("Failed to create collection directory")?;

        let path = self.file_path(collection, id);
        let file = File::create(&path).context("Failed to create file")?;
        let writer = BufWriter::new(file);
        serde_json::to_writer_pretty(writer, data).context("Failed to serialize")?;
        Ok(())
    }

    pub fn delete(&self, collection: &str, id: &str) -> Result<bool> {
        let path = self.file_path(collection, id);
        if !path.exists() {
            return Ok(false);
        }
        fs::remove_file(&path).context("Failed to delete file")?;
        Ok(true)
    }

    pub fn delete_many(&self, collection: &str, ids: &[&str]) -> Result<()> {
        for id in ids {
            self.delete(collection, id)?;
        }
        Ok(())
    }

    pub fn count(&self, collection: &str) -> Result<usize> {
        let dir = self.collection_dir(collection);
        if !dir.exists() {
            return Ok(0);
        }

        let count = fs::read_dir(&dir)?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "json"))
            .count();
        Ok(count)
    }

    pub fn save_raw(&self, filename: &str, data: &str) -> Result<()> {
        let path = self.data_dir.join(filename);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, data)?;
        Ok(())
    }

    pub fn load_raw(&self, filename: &str) -> Result<Option<String>> {
        let path = self.data_dir.join(filename);
        if !path.exists() {
            return Ok(None);
        }
        let data = fs::read_to_string(&path)?;
        Ok(Some(data))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use tempfile::tempdir;

    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
    struct TestItem {
        id: String,
        name: String,
        value: i32,
    }

    #[tokio::test]
    async fn test_basic_operations() {
        let dir = tempdir().unwrap();
        let storage = JsonStorage::new(dir.path()).unwrap();
        storage.init().await.unwrap();

        let item = TestItem {
            id: "test-1".to_string(),
            name: "Test Item".to_string(),
            value: 42,
        };

        storage.set("items", &item.id, &item).unwrap();

        let retrieved: Option<TestItem> = storage.get("items", "test-1").unwrap();
        assert_eq!(retrieved, Some(item.clone()));

        let all: Vec<TestItem> = storage.get_all("items").unwrap();
        assert_eq!(all.len(), 1);

        let deleted = storage.delete("items", "test-1").unwrap();
        assert!(deleted);

        let retrieved: Option<TestItem> = storage.get("items", "test-1").unwrap();
        assert_eq!(retrieved, None);
    }
}
