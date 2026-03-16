#![allow(missing_docs)]
//! High-performance caching manager with LRU eviction and TTL support.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use tracing::debug;
use uuid::Uuid;

/// A cached entry with metadata.
#[derive(Clone)]
pub struct CacheEntry<T> {
    /// The cached data
    pub data: T,
    /// When the entry was created
    pub timestamp: Instant,
    /// Time to live
    pub ttl: Duration,
    /// Number of times accessed
    pub access_count: u64,
    /// Last access time
    pub last_accessed: Instant,
}

/// Cache statistics.
#[derive(Debug, Clone)]
pub struct CacheStats {
    /// Total entries in cache
    pub total_entries: usize,
    /// Cache hit rate
    pub hit_rate: f64,
    /// Cache miss rate
    pub miss_rate: f64,
    /// Estimated memory usage
    pub memory_usage: usize,
    /// Total hits
    pub total_hits: u64,
    /// Total misses
    pub total_misses: u64,
}

/// High-performance caching manager with LRU eviction and TTL support.
pub struct CacheManager {
    cache: Arc<RwLock<HashMap<String, CacheEntry<serde_json::Value>>>>,
    max_size: usize,
    default_ttl: Duration,
    hits: Arc<RwLock<u64>>,
    misses: Arc<RwLock<u64>>,
    evictions: Arc<RwLock<u64>>,
}

impl Default for CacheManager {
    fn default() -> Self {
        Self::new(1000, Duration::from_secs(300))
    }
}

impl CacheManager {
    /// Create a new cache manager.
    ///
    /// # Arguments
    ///
    /// * `max_size` - Maximum number of entries
    /// * `default_ttl` - Default time to live
    pub fn new(max_size: usize, default_ttl: Duration) -> Self {
        Self {
            cache: Arc::new(RwLock::new(HashMap::new())),
            max_size,
            default_ttl,
            hits: Arc::new(RwLock::new(0)),
            misses: Arc::new(RwLock::new(0)),
            evictions: Arc::new(RwLock::new(0)),
        }
    }

    /// Create from milliseconds configuration.
    pub fn from_ms(max_size: usize, default_ttl_ms: u64) -> Self {
        Self::new(max_size, Duration::from_millis(default_ttl_ms))
    }

    /// Check if an entry is expired.
    fn is_expired(entry: &CacheEntry<serde_json::Value>) -> bool {
        entry.timestamp.elapsed() > entry.ttl
    }

    /// Evict the least recently used entry.
    async fn evict_lru(&self) {
        let mut cache = self.cache.write().await;

        if cache.is_empty() {
            return;
        }

        let oldest_key = cache
            .iter()
            .min_by_key(|(_, v)| v.last_accessed)
            .map(|(k, _)| k.clone());

        if let Some(key) = oldest_key {
            cache.remove(&key);
            *self.evictions.write().await += 1;
        }
    }

    /// Get a value from the cache.
    ///
    /// # Arguments
    ///
    /// * `key` - Cache key
    ///
    /// # Returns
    ///
    /// Cached value or None if not found/expired
    pub async fn get(&self, key: &str) -> Option<serde_json::Value> {
        let mut cache = self.cache.write().await;

        if let Some(entry) = cache.get_mut(key) {
            if Self::is_expired(entry) {
                cache.remove(key);
                drop(cache);
                *self.misses.write().await += 1;
                return None;
            }

            entry.access_count += 1;
            entry.last_accessed = Instant::now();
            let data = entry.data.clone();
            drop(cache);
            *self.hits.write().await += 1;
            return Some(data);
        }

        drop(cache);
        *self.misses.write().await += 1;
        None
    }

    /// Set a value in the cache.
    ///
    /// # Arguments
    ///
    /// * `key` - Cache key
    /// * `data` - Value to cache
    /// * `ttl` - Optional TTL
    pub async fn set(&self, key: &str, data: serde_json::Value, ttl: Option<Duration>) {
        let now = Instant::now();
        let entry_ttl = ttl.unwrap_or(self.default_ttl);

        // Check if we need to evict
        {
            let cache = self.cache.read().await;
            if cache.len() >= self.max_size && !cache.contains_key(key) {
                drop(cache);
                self.evict_lru().await;
            }
        }

        let entry = CacheEntry {
            data,
            timestamp: now,
            ttl: entry_ttl,
            access_count: 1,
            last_accessed: now,
        };

        let mut cache = self.cache.write().await;
        cache.insert(key.to_string(), entry);
    }

    /// Delete a key from the cache.
    ///
    /// # Arguments
    ///
    /// * `key` - Cache key
    ///
    /// # Returns
    ///
    /// True if key was deleted
    pub async fn delete(&self, key: &str) -> bool {
        let mut cache = self.cache.write().await;
        cache.remove(key).is_some()
    }

    /// Check if a key exists and is not expired.
    ///
    /// # Arguments
    ///
    /// * `key` - Cache key
    ///
    /// # Returns
    ///
    /// True if key exists and is valid
    pub async fn has(&self, key: &str) -> bool {
        let cache = self.cache.read().await;

        if let Some(entry) = cache.get(key) {
            if Self::is_expired(entry) {
                drop(cache);
                let mut cache = self.cache.write().await;
                cache.remove(key);
                return false;
            }
            return true;
        }

        false
    }

    /// Clear all entries from the cache.
    pub async fn clear(&self) {
        let mut cache = self.cache.write().await;
        cache.clear();
        *self.hits.write().await = 0;
        *self.misses.write().await = 0;
    }

    /// Get cache statistics.
    pub async fn get_stats(&self) -> CacheStats {
        let cache = self.cache.read().await;
        let hits = *self.hits.read().await;
        let misses = *self.misses.read().await;
        let total = hits + misses;

        CacheStats {
            total_entries: cache.len(),
            hit_rate: if total > 0 {
                hits as f64 / total as f64
            } else {
                0.0
            },
            miss_rate: if total > 0 {
                misses as f64 / total as f64
            } else {
                0.0
            },
            memory_usage: 0, // Would need proper estimation
            total_hits: hits,
            total_misses: misses,
        }
    }

    /// Cleanup expired entries.
    pub async fn cleanup(&self) {
        let mut cache = self.cache.write().await;
        let keys_to_remove: Vec<String> = cache
            .iter()
            .filter(|(_, v)| Self::is_expired(v))
            .map(|(k, _)| k.clone())
            .collect();

        for key in &keys_to_remove {
            cache.remove(key);
        }

        if !keys_to_remove.is_empty() {
            debug!("Cleaned up {} expired cache entries", keys_to_remove.len());
        }
    }

    // Specialized methods for todos

    /// Cache an entity.
    pub async fn cache_entity(&self, entity_id: Uuid, entity: serde_json::Value) {
        let key = format!("entity:{}", entity_id);
        self.set(&key, entity, Some(Duration::from_secs(300))).await;
    }

    /// Get a cached entity.
    pub async fn get_cached_entity(&self, entity_id: Uuid) -> Option<serde_json::Value> {
        let key = format!("entity:{}", entity_id);
        self.get(&key).await
    }

    /// Cache a reminder recommendation.
    pub async fn cache_reminder_recommendation(&self, todo_id: Uuid, rec: serde_json::Value) {
        let key = format!("recommendation:{}", todo_id);
        self.set(&key, rec, Some(Duration::from_secs(600))).await;
    }

    /// Get a cached reminder recommendation.
    pub async fn get_cached_reminder_recommendation(
        &self,
        todo_id: Uuid,
    ) -> Option<serde_json::Value> {
        let key = format!("recommendation:{}", todo_id);
        self.get(&key).await
    }

    /// Cache service health.
    pub async fn cache_service_health(&self, service_name: &str, health: serde_json::Value) {
        let key = format!("health:{}", service_name);
        self.set(&key, health, Some(Duration::from_secs(30))).await;
    }

    /// Get cached service health.
    pub async fn get_cached_service_health(&self, service_name: &str) -> Option<serde_json::Value> {
        let key = format!("health:{}", service_name);
        self.get(&key).await
    }
}
