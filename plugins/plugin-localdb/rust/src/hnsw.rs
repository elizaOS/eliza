#![allow(missing_docs)]

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, HashSet};

#[derive(Debug, Clone)]
pub struct VectorSearchResult {
    pub id: String,
    pub distance: f32,
    pub similarity: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HNSWConfig {
    pub m: usize,
    pub ef_construction: usize,
    pub ef_search: usize,
    pub ml: f32,
}

impl Default for HNSWConfig {
    fn default() -> Self {
        Self {
            m: 16,
            ef_construction: 200,
            ef_search: 50,
            ml: 1.0 / 16.0_f32.ln(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HNSWNode {
    id: String,
    vector: Vec<f32>,
    level: usize,
    neighbors: HashMap<usize, HashSet<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HNSWIndex {
    pub dimension: usize,
    config: HNSWConfig,
    nodes: HashMap<String, HNSWNode>,
    entry_point: Option<String>,
    max_level: usize,
}

#[derive(Debug, Clone)]
struct Candidate {
    id: String,
    distance: f32,
}

impl PartialEq for Candidate {
    fn eq(&self, other: &Self) -> bool {
        self.distance == other.distance
    }
}

impl Eq for Candidate {}

impl PartialOrd for Candidate {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Candidate {
    fn cmp(&self, other: &Self) -> Ordering {
        // Reverse ordering for min-heap behavior
        other
            .distance
            .partial_cmp(&self.distance)
            .unwrap_or(Ordering::Equal)
    }
}

fn cosine_distance(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 1.0;
    }

    let mut dot_product = 0.0;
    let mut norm_a = 0.0;
    let mut norm_b = 0.0;

    for (ai, bi) in a.iter().zip(b.iter()) {
        dot_product += ai * bi;
        norm_a += ai * ai;
        norm_b += bi * bi;
    }

    let magnitude = norm_a.sqrt() * norm_b.sqrt();
    if magnitude == 0.0 {
        return 1.0;
    }

    1.0 - (dot_product / magnitude)
}

pub struct SimpleHNSW {
    nodes: HashMap<String, HNSWNode>,
    entry_point: Option<String>,
    max_level: usize,
    dimension: usize,
    config: HNSWConfig,
}

impl SimpleHNSW {
    pub fn new() -> Self {
        Self {
            nodes: HashMap::new(),
            entry_point: None,
            max_level: 0,
            dimension: 0,
            config: HNSWConfig::default(),
        }
    }

    pub fn init(&mut self, dimension: usize) {
        self.dimension = dimension;
    }

    pub fn load_from_index(&mut self, index: HNSWIndex) {
        self.dimension = index.dimension;
        self.config = index.config;
        self.nodes = index.nodes;
        self.entry_point = index.entry_point;
        self.max_level = index.max_level;
    }

    fn get_random_level(&self) -> usize {
        let mut level: i32 = 0;
        while rand::random::<f32>() < (-(level as f32) * self.config.ml).exp() && level < 16 {
            level += 1;
        }
        level as usize
    }

    pub fn add(&mut self, id: String, vector: Vec<f32>) -> Result<()> {
        if vector.len() != self.dimension {
            anyhow::bail!(
                "Vector dimension mismatch: expected {}, got {}",
                self.dimension,
                vector.len()
            );
        }

        if let Some(existing) = self.nodes.get_mut(&id) {
            existing.vector = vector;
            return Ok(());
        }

        let level = self.get_random_level();
        let mut new_node = HNSWNode {
            id: id.clone(),
            vector: vector.clone(),
            level,
            neighbors: HashMap::new(),
        };

        for l in 0..=level {
            new_node.neighbors.insert(l, HashSet::new());
        }

        if self.entry_point.is_none() {
            self.entry_point = Some(id.clone());
            self.max_level = level;
            self.nodes.insert(id, new_node);
            return Ok(());
        }

        let mut current = self.entry_point.clone().unwrap();

        for l in (level + 1..=self.max_level).rev() {
            if let Some(closest) = self.search_layer(&vector, &current, 1, l).first() {
                current = closest.id.clone();
            }
        }

        for l in (0..=level.min(self.max_level)).rev() {
            let neighbors = self.search_layer(&vector, &current, self.config.ef_construction, l);
            let selected: Vec<_> = neighbors.into_iter().take(self.config.m).collect();

            for neighbor in &selected {
                new_node
                    .neighbors
                    .get_mut(&l)
                    .unwrap()
                    .insert(neighbor.id.clone());

                if let Some(neighbor_node) = self.nodes.get_mut(&neighbor.id) {
                    neighbor_node
                        .neighbors
                        .entry(l)
                        .or_default()
                        .insert(id.clone());
                }
            }

            for neighbor in &selected {
                let should_prune = if let Some(neighbor_node) = self.nodes.get(&neighbor.id) {
                    neighbor_node
                        .neighbors
                        .get(&l)
                        .is_some_and(|n| n.len() > self.config.m)
                } else {
                    false
                };

                if should_prune {
                    let (neighbor_vector, current_neighbors) = {
                        let neighbor_node = self.nodes.get(&neighbor.id).unwrap();
                        (
                            neighbor_node.vector.clone(),
                            neighbor_node.neighbors.get(&l).unwrap().clone(),
                        )
                    };

                    let to_keep: HashSet<_> = self
                        .select_best_neighbors(&neighbor_vector, &current_neighbors, self.config.m)
                        .into_iter()
                        .map(|c| c.id)
                        .collect();

                    if let Some(neighbor_node) = self.nodes.get_mut(&neighbor.id) {
                        if let Some(neighbors) = neighbor_node.neighbors.get_mut(&l) {
                            *neighbors = to_keep;
                        }
                    }
                }
            }

            if let Some(first) = selected.first() {
                current = first.id.clone();
            }
        }

        self.nodes.insert(id.clone(), new_node);

        if level > self.max_level {
            self.max_level = level;
            self.entry_point = Some(id);
        }

        Ok(())
    }

    fn search_layer(&self, query: &[f32], entry: &str, ef: usize, level: usize) -> Vec<Candidate> {
        let entry_node = match self.nodes.get(entry) {
            Some(n) => n,
            None => return Vec::new(),
        };

        let entry_dist = cosine_distance(query, &entry_node.vector);
        let mut visited = HashSet::new();
        visited.insert(entry.to_string());

        let mut candidates = BinaryHeap::new();
        candidates.push(Candidate {
            id: entry.to_string(),
            distance: entry_dist,
        });

        let mut results = vec![Candidate {
            id: entry.to_string(),
            distance: entry_dist,
        }];

        while let Some(current) = candidates.pop() {
            if let Some(furthest) = results.iter().max_by(|a, b| {
                a.distance
                    .partial_cmp(&b.distance)
                    .unwrap_or(Ordering::Equal)
            }) {
                if current.distance > furthest.distance {
                    break;
                }
            }

            let current_node = match self.nodes.get(&current.id) {
                Some(n) => n,
                None => continue,
            };

            if let Some(neighbors) = current_node.neighbors.get(&level) {
                for neighbor_id in neighbors {
                    if visited.contains(neighbor_id) {
                        continue;
                    }
                    visited.insert(neighbor_id.clone());

                    let neighbor_node = match self.nodes.get(neighbor_id) {
                        Some(n) => n,
                        None => continue,
                    };

                    let dist = cosine_distance(query, &neighbor_node.vector);

                    let should_add = results.len() < ef
                        || results
                            .iter()
                            .max_by(|a, b| {
                                a.distance
                                    .partial_cmp(&b.distance)
                                    .unwrap_or(Ordering::Equal)
                            })
                            .is_none_or(|f| dist < f.distance);

                    if should_add {
                        candidates.push(Candidate {
                            id: neighbor_id.clone(),
                            distance: dist,
                        });
                        results.push(Candidate {
                            id: neighbor_id.clone(),
                            distance: dist,
                        });

                        if results.len() > ef {
                            results.sort_by(|a, b| {
                                a.distance
                                    .partial_cmp(&b.distance)
                                    .unwrap_or(Ordering::Equal)
                            });
                            results.pop();
                        }
                    }
                }
            }
        }

        results.sort_by(|a, b| {
            a.distance
                .partial_cmp(&b.distance)
                .unwrap_or(Ordering::Equal)
        });
        results
    }

    fn select_best_neighbors(
        &self,
        node_vector: &[f32],
        neighbor_ids: &HashSet<String>,
        m: usize,
    ) -> Vec<Candidate> {
        let mut candidates: Vec<_> = neighbor_ids
            .iter()
            .filter_map(|id| {
                self.nodes.get(id).map(|n| Candidate {
                    id: id.clone(),
                    distance: cosine_distance(node_vector, &n.vector),
                })
            })
            .collect();

        candidates.sort_by(|a, b| {
            a.distance
                .partial_cmp(&b.distance)
                .unwrap_or(Ordering::Equal)
        });
        candidates.truncate(m);
        candidates
    }

    pub fn remove(&mut self, id: &str) {
        let node = match self.nodes.remove(id) {
            Some(n) => n,
            None => return,
        };

        for (level, neighbors) in &node.neighbors {
            for neighbor_id in neighbors {
                if let Some(neighbor_node) = self.nodes.get_mut(neighbor_id) {
                    if let Some(n) = neighbor_node.neighbors.get_mut(level) {
                        n.remove(id);
                    }
                }
            }
        }

        if self.entry_point.as_deref() == Some(id) {
            if self.nodes.is_empty() {
                self.entry_point = None;
                self.max_level = 0;
            } else {
                let (new_entry, new_level) = self
                    .nodes
                    .iter()
                    .max_by_key(|(_, n)| n.level)
                    .map(|(id, n)| (id.clone(), n.level))
                    .unwrap_or_default();
                self.entry_point = Some(new_entry);
                self.max_level = new_level;
            }
        }
    }

    pub fn search(&self, query: &[f32], k: usize, threshold: f32) -> Vec<VectorSearchResult> {
        if self.entry_point.is_none() || self.nodes.is_empty() {
            return Vec::new();
        }

        if query.len() != self.dimension {
            return Vec::new();
        }

        let mut current = self.entry_point.clone().unwrap();

        for l in (1..=self.max_level).rev() {
            if let Some(closest) = self.search_layer(query, &current, 1, l).first() {
                current = closest.id.clone();
            }
        }

        let results = self.search_layer(query, &current, k.max(self.config.ef_search), 0);

        results
            .into_iter()
            .take(k)
            .filter(|c| (1.0 - c.distance) >= threshold)
            .map(|c| VectorSearchResult {
                id: c.id,
                distance: c.distance,
                similarity: 1.0 - c.distance,
            })
            .collect()
    }

    pub fn serialize(&self) -> HNSWIndex {
        HNSWIndex {
            dimension: self.dimension,
            config: self.config.clone(),
            nodes: self.nodes.clone(),
            entry_point: self.entry_point.clone(),
            max_level: self.max_level,
        }
    }

    pub fn size(&self) -> usize {
        self.nodes.len()
    }
}

impl Default for SimpleHNSW {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_add_and_search() {
        let mut hnsw = SimpleHNSW::new();
        hnsw.init(3);

        hnsw.add("v1".to_string(), vec![1.0, 0.0, 0.0]).unwrap();
        hnsw.add("v2".to_string(), vec![0.0, 1.0, 0.0]).unwrap();
        hnsw.add("v3".to_string(), vec![0.9, 0.1, 0.0]).unwrap();

        assert_eq!(hnsw.size(), 3);

        let results = hnsw.search(&[1.0, 0.0, 0.0], 2, 0.5);
        assert!(!results.is_empty());
        assert_eq!(results[0].id, "v1");
    }

    #[test]
    fn test_remove() {
        let mut hnsw = SimpleHNSW::new();
        hnsw.init(3);

        hnsw.add("v1".to_string(), vec![1.0, 0.0, 0.0]).unwrap();
        hnsw.add("v2".to_string(), vec![0.0, 1.0, 0.0]).unwrap();

        hnsw.remove("v1");

        assert_eq!(hnsw.size(), 1);
    }

    #[test]
    fn test_serialization() {
        let mut hnsw = SimpleHNSW::new();
        hnsw.init(3);
        hnsw.add("v1".to_string(), vec![1.0, 0.0, 0.0]).unwrap();

        let index = hnsw.serialize();

        let mut hnsw2 = SimpleHNSW::new();
        hnsw2.load_from_index(index);

        assert_eq!(hnsw2.size(), 1);
    }
}
