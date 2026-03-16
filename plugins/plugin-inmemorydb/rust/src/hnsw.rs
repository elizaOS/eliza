use async_trait::async_trait;
use parking_lot::RwLock;
use rand::Rng;
use std::collections::{HashMap, HashSet};

use crate::types::{IVectorStorage, StorageError, StorageResult, VectorSearchResult};

#[derive(Clone)]
struct HNSWNode {
    _id: String,
    vector: Vec<f32>,
    level: usize,
    neighbors: HashMap<usize, HashSet<String>>,
}

struct HNSWConfig {
    m: usize,
    ef_construction: usize,
    ef_search: usize,
    ml: f32,
}

impl Default for HNSWConfig {
    fn default() -> Self {
        let m = 16;
        Self {
            m,
            ef_construction: 200,
            ef_search: 50,
            ml: 1.0 / (m as f32).ln(),
        }
    }
}

fn cosine_distance(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 1.0;
    }

    let mut dot_product = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;

    for i in 0..a.len() {
        dot_product += a[i] * b[i];
        norm_a += a[i] * a[i];
        norm_b += b[i] * b[i];
    }

    let magnitude = norm_a.sqrt() * norm_b.sqrt();
    if magnitude == 0.0 {
        return 1.0;
    }

    1.0 - (dot_product / magnitude)
}

pub struct EphemeralHNSW {
    nodes: RwLock<HashMap<String, HNSWNode>>,
    entry_point: RwLock<Option<String>>,
    max_level: RwLock<usize>,
    dimension: RwLock<usize>,
    config: HNSWConfig,
}

impl EphemeralHNSW {
    pub fn new() -> Self {
        Self {
            nodes: RwLock::new(HashMap::new()),
            entry_point: RwLock::new(None),
            max_level: RwLock::new(0),
            dimension: RwLock::new(0),
            config: HNSWConfig::default(),
        }
    }

    fn get_random_level(&self) -> usize {
        let mut rng = rand::thread_rng();
        let mut level = 0usize;
        while rng.gen::<f32>() < (-(level as f32) * self.config.ml).exp() && level < 16 {
            level += 1;
        }
        level
    }

    fn search_layer(
        &self,
        nodes: &HashMap<String, HNSWNode>,
        query: &[f32],
        entry_id: &str,
        ef: usize,
        level: usize,
    ) -> Vec<(String, f32)> {
        let mut visited = HashSet::new();
        visited.insert(entry_id.to_string());

        let entry_node = match nodes.get(entry_id) {
            Some(n) => n,
            None => return vec![],
        };

        let entry_dist = cosine_distance(query, &entry_node.vector);
        let mut candidates = vec![(entry_id.to_string(), entry_dist)];
        let mut results = vec![(entry_id.to_string(), entry_dist)];

        while !candidates.is_empty() {
            candidates.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
            let current = candidates.remove(0);

            results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
            let furthest_result = results.first().map(|r| r.1).unwrap_or(f32::MAX);

            if current.1 > furthest_result {
                break;
            }

            let current_node = match nodes.get(&current.0) {
                Some(n) => n,
                None => continue,
            };

            let neighbors = match current_node.neighbors.get(&level) {
                Some(n) => n,
                None => continue,
            };

            for neighbor_id in neighbors {
                if visited.contains(neighbor_id) {
                    continue;
                }
                visited.insert(neighbor_id.clone());

                let neighbor_node = match nodes.get(neighbor_id) {
                    Some(n) => n,
                    None => continue,
                };

                let dist = cosine_distance(query, &neighbor_node.vector);

                if results.len() < ef || dist < furthest_result {
                    candidates.push((neighbor_id.clone(), dist));
                    results.push((neighbor_id.clone(), dist));

                    if results.len() > ef {
                        results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
                        results.pop();
                    }
                }
            }
        }

        results.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
        results
    }

    fn _select_best_neighbors(
        &self,
        nodes: &HashMap<String, HNSWNode>,
        node_vector: &[f32],
        neighbor_ids: &HashSet<String>,
        m: usize,
    ) -> Vec<(String, f32)> {
        let mut neighbors: Vec<_> = neighbor_ids
            .iter()
            .filter_map(|id| {
                nodes
                    .get(id)
                    .map(|n| (id.clone(), cosine_distance(node_vector, &n.vector)))
            })
            .collect();

        neighbors.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
        neighbors.truncate(m);
        neighbors
    }

    pub fn size(&self) -> usize {
        self.nodes.read().len()
    }
}

impl Default for EphemeralHNSW {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl IVectorStorage for EphemeralHNSW {
    async fn init(&self, dimension: usize) -> StorageResult<()> {
        *self.dimension.write() = dimension;
        Ok(())
    }

    async fn add(&self, id: &str, vector: &[f32]) -> StorageResult<()> {
        let dimension = *self.dimension.read();
        if vector.len() != dimension {
            return Err(StorageError::DimensionMismatch {
                expected: dimension,
                actual: vector.len(),
            });
        }

        let mut nodes = self.nodes.write();

        if let Some(node) = nodes.get_mut(id) {
            node.vector = vector.to_vec();
            return Ok(());
        }

        let level = self.get_random_level();
        let mut new_node = HNSWNode {
            _id: id.to_string(),
            vector: vector.to_vec(),
            level,
            neighbors: HashMap::new(),
        };

        for l in 0..=level {
            new_node.neighbors.insert(l, HashSet::new());
        }

        let entry_point = self.entry_point.read().clone();

        if entry_point.is_none() {
            *self.entry_point.write() = Some(id.to_string());
            *self.max_level.write() = level;
            nodes.insert(id.to_string(), new_node);
            return Ok(());
        }

        let mut current_node = entry_point.clone().unwrap();
        let max_level = *self.max_level.read();

        for l in (level + 1..=max_level).rev() {
            let results = self.search_layer(&nodes, vector, &current_node, 1, l);
            if !results.is_empty() {
                current_node = results[0].0.clone();
            }
        }

        for l in (0..=std::cmp::min(level, max_level)).rev() {
            let neighbors = self.search_layer(
                &nodes,
                vector,
                &current_node,
                self.config.ef_construction,
                l,
            );
            let m = self.config.m;
            let selected: Vec<_> = neighbors.iter().take(m).cloned().collect();

            for (neighbor_id, _) in &selected {
                new_node
                    .neighbors
                    .get_mut(&l)
                    .unwrap()
                    .insert(neighbor_id.clone());

                if let Some(neighbor_node) = nodes.get_mut(neighbor_id) {
                    let neighbor_set = neighbor_node
                        .neighbors
                        .entry(l)
                        .or_insert_with(HashSet::new);
                    neighbor_set.insert(id.to_string());

                    if neighbor_set.len() > m {
                        let neighbor_vector = neighbor_node.vector.clone();
                        let neighbor_ids = neighbor_set.clone();

                        let mut neighbors_with_dist: Vec<_> = neighbor_ids
                            .iter()
                            .filter_map(|nid| {
                                nodes.get(nid).map(|n| {
                                    (nid.clone(), cosine_distance(&neighbor_vector, &n.vector))
                                })
                            })
                            .collect();
                        neighbors_with_dist.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
                        neighbors_with_dist.truncate(m);

                        if let Some(neighbor_node) = nodes.get_mut(neighbor_id) {
                            if let Some(ns) = neighbor_node.neighbors.get_mut(&l) {
                                *ns = neighbors_with_dist.into_iter().map(|(id, _)| id).collect();
                            }
                        }
                    }
                }
            }

            if !neighbors.is_empty() {
                current_node = neighbors[0].0.clone();
            }
        }

        nodes.insert(id.to_string(), new_node);

        if level > max_level {
            *self.max_level.write() = level;
            *self.entry_point.write() = Some(id.to_string());
        }

        Ok(())
    }

    async fn remove(&self, id: &str) -> StorageResult<()> {
        let mut nodes = self.nodes.write();

        let node = match nodes.get(id) {
            Some(n) => n.clone(),
            None => return Ok(()),
        };

        for (level, neighbors) in &node.neighbors {
            for neighbor_id in neighbors {
                if let Some(neighbor_node) = nodes.get_mut(neighbor_id) {
                    if let Some(neighbor_set) = neighbor_node.neighbors.get_mut(level) {
                        neighbor_set.remove(id);
                    }
                }
            }
        }

        nodes.remove(id);

        let entry_point = self.entry_point.read().clone();
        if entry_point.as_deref() == Some(id) {
            if nodes.is_empty() {
                *self.entry_point.write() = None;
                *self.max_level.write() = 0;
            } else {
                let mut max_level = 0;
                let mut new_entry = None;
                for (node_id, n) in nodes.iter() {
                    if n.level >= max_level {
                        max_level = n.level;
                        new_entry = Some(node_id.clone());
                    }
                }
                *self.entry_point.write() = new_entry;
                *self.max_level.write() = max_level;
            }
        }

        Ok(())
    }

    async fn search(
        &self,
        query: &[f32],
        k: usize,
        threshold: f32,
    ) -> StorageResult<Vec<VectorSearchResult>> {
        let nodes = self.nodes.read();
        let entry_point = self.entry_point.read().clone();

        if entry_point.is_none() || nodes.is_empty() {
            return Ok(vec![]);
        }

        let dimension = *self.dimension.read();
        if query.len() != dimension {
            return Err(StorageError::DimensionMismatch {
                expected: dimension,
                actual: query.len(),
            });
        }

        let mut current_node = entry_point.unwrap();
        let max_level = *self.max_level.read();

        for l in (1..=max_level).rev() {
            let closest = self.search_layer(&nodes, query, &current_node, 1, l);
            if !closest.is_empty() {
                current_node = closest[0].0.clone();
            }
        }

        let results = self.search_layer(
            &nodes,
            query,
            &current_node,
            std::cmp::max(k, self.config.ef_search),
            0,
        );

        Ok(results
            .into_iter()
            .take(k)
            .filter(|(_, dist)| (1.0 - dist) >= threshold)
            .map(|(id, dist)| VectorSearchResult {
                id,
                distance: dist,
                similarity: 1.0 - dist,
            })
            .collect())
    }

    async fn clear(&self) -> StorageResult<()> {
        self.nodes.write().clear();
        *self.entry_point.write() = None;
        *self.max_level.write() = 0;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_add_and_search() {
        let hnsw = EphemeralHNSW::new();
        hnsw.init(3).await.unwrap();

        hnsw.add("1", &[1.0, 0.0, 0.0]).await.unwrap();
        hnsw.add("2", &[0.0, 1.0, 0.0]).await.unwrap();
        hnsw.add("3", &[0.9, 0.1, 0.0]).await.unwrap();

        let results = hnsw.search(&[1.0, 0.0, 0.0], 2, 0.0).await.unwrap();
        assert!(!results.is_empty());
        assert_eq!(results[0].id, "1");
    }

    #[tokio::test]
    async fn test_remove() {
        let hnsw = EphemeralHNSW::new();
        hnsw.init(3).await.unwrap();

        hnsw.add("1", &[1.0, 0.0, 0.0]).await.unwrap();
        hnsw.add("2", &[0.0, 1.0, 0.0]).await.unwrap();

        assert_eq!(hnsw.size(), 2);
        hnsw.remove("1").await.unwrap();
        assert_eq!(hnsw.size(), 1);
    }
}
