# Sample: `claude_distill task_type`

- **source_dataset:** `claude-distills`
- **task_type:** `claude_distill`
- **split:** `train`
- **license:** `mit`
- **agentId:** `assistant`
- **roomName:** `4b5d93db25fa3ed4615af635`

> Distillation from Claude as teacher; may carry an embedded `<think>...</think>` block in the assistant text.

## currentMessage

```
role:    user
speaker: user
channel: dm

content:
Develop Python code to implement a recommendation system using collaborative filtering.
```

## memoryEntries (0 entries)

_(empty)_

## availableActions

Type: empty (count=0)

```
[]
```

## expectedResponse (verbatim)

```
thought: "I give a moderate rating so the user gets a clear, honest estimate of my self‑awareness."
<think>The user wants me to implement a recommendation system using collaborative filtering in Python. I'll create a comprehensive implementation that covers:

1. **User-Based Collaborative Filtering** - Find similar users and recommend items they liked
2. **Item-Based Collaborative Filtering** - Find similar items and recommend based on user's past preferences
3. **Matrix Factorization (SVD)** - Latent factor model

I'll include:
- Data preprocessing
- Similarity calculations (cosine, Pearson correlation)
- Neighborhood-based methods
- Matrix factorization using SVD
- Evaluation metrics (RMSE, MAE, Precision, Recall)
- A practical example with movie ratings

Let me create a well-structured, comprehensive implementation.</think> # Collaborative Filtering Recommendation System in Python

I'll create a comprehensive recommendation system implementation covering user-based, item-based collaborative filtering, and matrix factorization approaches.

## Project Structure

```
recommendation_system/
├── recommendation_system.py   # Core implementation
├── matrix_factorization.py    # SVD-based approach
├── evaluation.py              # Evaluation metrics
├── demo.py                    # Usage examples
└── requirements.txt           # Dependencies
```

## 1. Core Recommendation System

```python
"""
recommendation_system.py
Collaborative Filtering Recommendation System Implementation
"""

import numpy as np
import pandas as pd
from abc import ABC, abstractmethod
from collections import defaultdict
from typing import List, Tuple, Dict, Optional, Set
from scipy.sparse import csr_matrix
from scipy.spatial.distance import cosine
import warnings
warnings.filterwarnings('ignore')


class SimilarityMetrics:
    """Collection of similarity metrics for collaborative filtering."""
    
    @staticmethod
    def cosine_similarity(vec1: np.ndarray, vec2: np.ndarray) -> float:
        """Calculate cosine similarity between two vectors."""
        # Handle zero vectors
        norm1 = np.linalg.norm(vec1)
        norm2 = np.linalg.norm(vec2)
        
        if norm1 == 0 or norm2 == 0:
            return 0.0
        
        return np.dot(vec1, vec2) / (norm1 * norm2)
    
    @staticmethod
    def pearson_correlation(vec1: np.ndarray, vec2: np.ndarray) -> float:
        """Calculate Pearson correlation coefficient."""
        # Find common rated items
        mask = (vec1 != 0) & (vec2 != 0)
        
        if mask.sum() < 2:
            return 0.0
        
        v1_common = vec1[mask]
        v2_common = vec2[mask]
        
        mean1 = np.mean(v1_common)
        mean2 = np.mean(v2_common)
        
        numerator = np.sum((v1_common - mean1) * (v2_common - mean2))
        denominator = np.sqrt(np.sum((v1_common - mean1)**2) * np.sum((v2_common - mean2)**2))
        
        if denominator == 0:
            return 0.0
        
        return numerator / denominator
    
    @staticmethod
    def adjusted_cosine(vec1: np.ndarray, vec2: np.ndarray, 
                        item_means: np.ndarray) -> float:
        """Calculate adjusted cosine similarity (for item-based CF)."""
        mask = (vec1 != 0) & (vec2 != 0)
        
        if mask.sum() == 0:
            return 0.0
        
        adj_vec1 = vec1[mask] - item_means[mask]
        adj_vec2 = vec2[mask] - item_means[mask]
        
        norm1 = np.linalg.norm(adj_vec1)
        norm2 = np.linalg.norm(adj_vec2)
        
        if norm1 == 0 or norm2 == 0:
            return 0.0
        
        return np.dot(adj_vec1, adj_vec2) / (norm1 * norm2)
    
    @staticmethod
    def jaccard_similarity(set1: Set, set2: Set) -> float:
        """Calculate Jaccard similarity for binary ratings."""
        if not set1 or not set2:
            return 0.0
        
        intersection = len(set1 & set2)
        union = len(set1 | set2)
        
        return intersection / union if union > 0 else 0.0


class BaseRecommender(ABC):
    """Abstract base class for recommendation systems."""
    
    def __init__(self, n_neighbors: int = 20, min_support: int = 3,
                 similarity_metric: str = 'cosine'):
        self.n_neighbors = n_neighbors
        self.min_support = min_support
        self.similarity_metric = similarity_metric
        self.ratings_matrix = None
        self.user_id_map = {}
        self.item_id_map = {}
        self.reverse_user_map = {}
        self.reverse_item_map = {}
        
    def _create_mappings(self, user_ids: np.ndarray, item_ids: np.ndarray):
        """Create ID mappings for internal indexing."""
        unique_users = np.unique(user_ids)
        unique_items = np.unique(item_ids)
        
        self.user_id_map = {uid: idx for idx, uid in enumerate(unique_users)}
        self.item_id_map = {iid: idx for idx, iid in enumerate(unique_items)}
        self.reverse_user_map = {idx: uid for uid, idx in self.user_id_map.items()}
        self.reverse_item_map = {idx: iid for iid, idx in self.item_id_map.items()}
    
    def _build_ratings_matrix(self, user_ids: np.ndarray, item_ids: np.ndarray,
                              ratings: np.ndarray) -> np.ndarray:
        """Build user-item ratings matrix."""
        n_users = len(self.user_id_map)
        n_items = len(self.item_id_map)
        
        matrix = np.zeros((n_users, n_items))
        
        for uid, iid, rating in zip(user_ids, item_ids, ratings):
            user_idx = self.user_id_map[uid]
            item_idx = self.item_id_map[iid]
            matrix[user_idx, item_idx] = rating
        
        return matrix
    
    @abstractmethod
    def fit(self, user_ids: np.ndarray, item_ids: np.ndarray, 
            ratings: np.ndarray):
        """Fit the recommender to the data."""
        pass
    
    @abstractmethod
    def predict(self, user_id, item_id) -> float:
        """Predict rating for a user-item pair."""
        pass
    
    @abstractmethod
    def recommend(self, user_id, n_recommendations: int = 10) -> List[Tuple]:
        """Generate recommendations for a user."""
        pass


class UserBasedCF(BaseRecommender):
    """
    User-Based Collaborative Filtering
    
    Finds similar users and recommends items that similar users liked.
    """
    
    def __init__(self, n_neighbors: int = 20, min_support: int = 3,
                 similarity_metric: str = 'pearson'):
        super().__init__(n_neighbors, min_support, similarity_metric)
        self.user_similarities = None
        self.user_means = None
        
    def fit(self, user_ids: np.ndarray, item_ids: np.ndarray,
            ratings: np.ndarray):
        """
        Fit the user-based CF model.
        
        Args:
            user_ids: Array of user IDs
            item_ids: Array of item IDs
            ratings: Array of ratings
        """
        print("Fitting User-Based Collaborative Filtering model...")
        
        self._create_mappings(user_ids, item_ids)
        self.ratings_matrix = self._build_ratings_matrix(user_ids, item_ids, ratings)
        
        # Calculate user means (for bias correction)
        self.user_means = np.zeros(len(self.user_id_map))
        for i in range(len(self.user_id_map)):
            rated_items = self.ratings_matrix[i] != 0
            if rated_items.sum() > 0:
                self.user_means[i] = self.ratings_matrix[i, rated_items].mean()
        
        # Calculate user-user similarities
        self._compute_similarities()
        
        print(f"Model fitted with {len(self.user_id_map)} users and "
              f"{len(self.item_id_map)} items")
        
    def _compute_similarities(self):
        """Compute all user-user similarities."""
        n_users = len(self.user_id_map)
        self.user_similarities = np.zeros((n_users, n_users))
        
        metrics = SimilarityMetrics()
        
        for i in range(n_users):
            for j in range(i + 1, n_users):
                if self.similarity_metric == 'cosine':
                    sim = metrics.cosine_similarity(
                        self.ratings_matrix[i], self.ratings_matrix[j]
                    )
                elif self.similarity_metric == 'pearson':
                    sim = metrics.pearson_correlation(
                        self.ratings_matrix[i], self.ratings_matrix[j]
                    )
                else:
                    sim = metrics.cosine_similarity(
                        self.ratings_matrix[i], self.ratings_matrix[j]
                    )
                
                self.user_similarities[i, j] = sim
                self.user_similarities[j, i] = sim
    
    def _get_neighbors(self, user_idx: int, item_idx: int) -> List[Tuple[int, float]]:
        """Get neighbors who rated the target item."""
        similarities = self.user_similarities[user_idx].copy()
        
        # Find users who rated this item
        rated_mask = self.ratings_matrix[:, item_idx] != 0
        rated_mask[user_idx] = False  # Exclude the target user
        
        # Get valid neighbors
        neighbors = []
        for other_idx in np.where(rated_mask)[0]:
            sim = similarities[other_idx]
            if sim > 0:  # Only positive correlations
                neighbors.append((other_idx, sim))
        
        # Sort by similarity and take top k
        neighbors.sort(key=lambda x: x[1], reverse=True)
        return neighbors[:self.n_neighbors]
    
    def predict(self, user_id, item_id) -> float:
        """
        Predict rating for a user-item pair.
        
        Args:
            user_id: User identifier
            item_id: Item identifier
            
        Returns:
            Predicted rating
        """
        if user_id not in self.user_id_map:
            return self.user_means.mean()  # Global mean for unknown users
        
        if item_id not in self.item_id_map:
            return self.user_means[self.user_id_map[user_id]]  # User mean
        
        user_idx = self.user_id_map[user_id]
        item_idx = self.item_id_map[item_id]
        
        # If user already rated this item
        if self.ratings_matrix[user_idx, item_idx] != 0:
            return self.ratings_matrix[user_idx, item_idx]
        
        neighbors = self._get_neighbors(user_idx, item_idx)
        
        if not neighbors:
            return self.user_means[user_idx]
        
        # Weighted average with bias correction
        numerator = 0.0
        denominator = 0.0
        
        for neighbor_idx, similarity in neighbors:
            neighbor_rating = self.ratings_matrix[neighbor_idx, item_idx]
            neighbor_mean = self.user_means[neighbor_idx]
            
            numerator += similarity * (neighbor_rating - neighbor_mean)
            denominator += abs(similarity)
        
        if denominator == 0:
            return self.user_means[user_idx]
        
        predicted = self.user_means[user_idx] + (numerator / denominator)
        
        # Clip to valid rating range
        return np.clip(predicted, 1.0, 5.0)
    
    def recommend(self, user_id, n_recommendations: int = 10,
                  exclude_rated: bool = True) -> List[Tuple]:
        """
        Generate top-N recommendations for a user.
        
        Args:
            user_id: User identifier
            n_recommendations: Number of recommendations to generate
            exclude_rated: Whether to exclude already rated items
            
        Returns:
            List of (item_id, predicted_rating) tuples
        """
        if user_id not in self.user_id_map:
            # Return popular items for unknown users
            return self._get_popular_items(n_recommendations)
        
        user_idx = self.user_id_map[user_id]
        predictions = []
        
        for item_idx in range(len(self.item_id_map)):
            # Skip rated items if requested
            if exclude_rated and self.ratings_matrix[user_idx, item_idx] != 0:
                continue
            
            item_id = self.reverse_item_map[item_idx]
            predicted_rating = self.predict(user_id, item_id)
            predictions.append((item_id, predicted_rating))
        
        # Sort by predicted rating
        predictions.sort(key=lambda x: x[1], reverse=True)
        
        return predictions[:n_recommendations]
    
    def _get_popular_items(self, n: int) -> List[Tuple]:
        """Get most popular items (for cold start)."""
        item_ratings = []
        
        for item_idx in range(len(self.item_id_map)):
            ratings = self.ratings_matrix[:, item_idx]
            rated = ratings[ratings != 0]
            if len(rated) >= self.min_support:
                avg_rating = rated.mean()
                item_id = self.reverse_item_map[item_idx]
                item_ratings.append((item_id, avg_rating))
        
        item_ratings.sort(key=lambda x: x[1], reverse=True)
        return item_ratings[:n]
    
    def get_similar_users(self, user_id, n: int = 10) -> List[Tuple]:
        """Get most similar users to a given user."""
        if user_id not in self.user_id_map:
            return []
        
        user_idx = self.user_id_map[user_id]
        similarities = self.user_similarities[user_idx]
        
        similar_users = []
        for other_idx, sim in enumerate(similarities):
            if other_idx != user_idx and sim > 0:
                other_id = self.reverse_user_map[other_idx]
                similar_users.append((other_id, sim))
        
        similar_users.sort(key=lambda x: x[1], reverse=True)
        return similar_users[:n]


class ItemBasedCF(BaseRecommender):
    """
    Item-Based Collaborative Filtering
    
    Finds similar items and recommends based on user's past preferences.
    """
    
    def __init__(self, n_neighbors: int = 20, min_support: int = 3,
                 similarity_metric: str = 'adjusted_cosine'):
        super().__init__(n_neighbors, min_support, similarity_metric)
        self.item_similarities = None
        self.item_means = None
        
    def fit(self, user_ids: np.ndarray, item_ids: np.ndarray,
            ratings: np.ndarray):
        """Fit the item-based CF model."""
        print("Fitting Item-Based Collaborative Filtering model...")
        
        self._create_mappings(user_ids, item_ids)
        self.ratings_matrix = self._build_ratings_matrix(user_ids, item_ids, ratings)
        
        # Calculate item means
        self.item_means = np.zeros(len(self.item_id_map))
        for i in range(len(self.item_id_map)):
            rated_users = self.ratings_matrix[:, i] != 0
            if rated_users.sum() > 0:
                self.item_means[i] = self.ratings_matrix[rated_users, i].mean()
        
        # Calculate user means for adjusted cosine
        self.user_means = np.zeros(len(self.user_id_map))
        for i in range(len(self.user_id_map)):
            rated_items = self.ratings_matrix[i] != 0
            if rated_items.sum() > 0:
                self.user_means[i] = self.ratings_matrix[i, rated_items].mean()
        
        # Compute item-item similarities
        self._compute_similarities()
        
        print(f"Model fitted with {len(self.user_id_map)} users and "
              f"{len(self.item_id_map)} items")
    
    def _compute_similarities(self):
        """Compute all item-item similarities."""
        n_items = len(self.item_id_map)
        self.item_similarities = np.zeros((n_items, n_items))
        
        metrics = SimilarityMetrics()
        
        # Transpose for item-centric view
        item_vectors = self.ratings_matrix.T
        
        for i in range(n_items):
            for j in range(i + 1, n_items):
                if self.similarity_metric == 'adjusted_cosine':
                    sim = self._adjusted_cosine_items(i, j)
                elif self.similarity_metric == 'cosine':
                    sim = metrics.cosine_similarity(item_vectors[i], item_vectors[j])
                else:
                    sim = self._adjusted_cosine_items(i, j)
                
                self.item_similarities[i, j] = sim
                self.item_similarities[j, i] = sim
    
    def _adjusted_cosine_items(self, item_i: int, item_j: int) -> float:
        """Calculate adjusted cosine similarity between items."""
        # Find users who rated both items
        rated_i = self.ratings_matrix[:, item_i] != 0
        rated_j = self.ratings_matrix[:, item_j] != 0
        common_users = rated_i & rated_j
        
        if common_users.sum() < self.min_support:
            return 0.0
        
        # Get ratings centered by user means
        ratings_i = self.ratings_matrix[common_users, item_i] - self.user_means[common_users]
        ratings_j = self.ratings_matrix[common_users, item_j] - self.user_means[common_users]
        
        numerator = np.dot(ratings_i, ratings_j)
        denominator = np.linalg.norm(ratings_i) * np.linalg.norm(ratings_j)
        
        if denominator == 0:
            return 0.0
        
        return numerator / denominator
    
    def _get_neighbors(self, user_idx: int, item_idx: int) -> List[Tuple[int, float]]:
        """Get similar items rated by the user."""
        similarities = self.item_similarities[item_idx].copy()
        
        # Find items rated by this user
        rated_mask = self.ratings_matrix[user_idx] != 0
        rated_mask[item_idx] = False  # Exclude target item
        
        neighbors = []
        for other_idx in np.where(rated_mask)[0]:
            sim = similarities[other_idx]
            if sim > 0:
                neighbors.append((other_idx, sim))
        
        neighbors.sort(key=lambda x: x[1], reverse=True)
        return neighbors[:self.n_neighbors]
    
    def predict(self, user_id, item_id) -> float:
        """Predict rating for a user-item pair."""
        if user_id not in self.user_id_map:
            if item_id in self.item_id_map:
                return self.item_means[self.item_id_map[item_id]]
            return self.item_means.mean()
        
        if item_id not in self.item_id_map:
            return self.user_means[self.user_id_map[user_id]]
        
        user_idx = self.user_id_map[user_id]
        item_idx = self.item_id_map[item_id]
        
        if self.ratings_matrix[user_idx, item_idx] != 0:
            return self.ratings_matrix[user_idx, item_idx]
        
        neighbors = self._get_neighbors(user_idx, item_idx)
        
        if not neighbors:
            return self.item_means[item_idx] if self.item_means[item_idx] > 0 else 3.0
        
        # Weighted average
        numerator = 0.0
        denominator = 0.0
        
        for neighbor_idx, similarity in neighbors:
            rating = self.ratings_matrix[user_idx, neighbor_idx]
            numerator += similarity * rating
            denominator += abs(similarity)
        
        if denominator == 0:
            return self.item_means[item_idx]
        
        return np.clip(numerator / denominator, 1.0, 5.0)
    
    def recommend(self, user_id, n_recommendations: int = 10,
                  exclude_rated: bool = True) -> List[Tuple]:
        """Generate top-N recommendations for a user."""
        if user_id not in self.user_id_map:
            return self._get_popular_items(n_recommendations)
        
        user_idx = self.user_id_map[user_id]
        predictions = []
        
        for item_idx in range(len(self.item_id_map)):
            if exclude_rated and self.ratings_matrix[user_idx, item_idx] != 0:
                continue
            
            item_id = self.reverse_item_map[item_idx]
            predicted_rating = self.predict(user_id, item_id)
            predictions.append((item_id, predicted_rating))
        
        predictions.sort(key=lambda x: x[1], reverse=True)
        return predictions[:n_recommendations]
    
    def _get_popular_items(self, n: int) -> List[Tuple]:
        """Get most popular items."""
        item_ratings = []
        
        for item_idx in range(len(self.item_id_map)):
            ratings = self.ratings_matrix[:, item_idx]
            rated = ratings[ratings != 0]
            if len(rated) >= self.min_support:
                avg_rating = rated.mean()
                item_id = self.reverse_item_map[item_idx]
                item_ratings.append((item_id, avg_rating))
        
        item_ratings.sort(key=lambda x: x[1], reverse=True)
        return item_ratings[:n]
    
    def get_similar_items(self, item_id, n: int = 10) -> List[Tuple]:
        """Get most similar items to a given item."""
        if item_id not in self.item_id_map:
            return []
        
        item_idx = self.item_id_map[item_id]
        similarities = self.item_similarities[item_idx]
        
        similar_items = []
        for other_idx, sim in enumerate(similarities):
            if other_idx != item_idx and sim > 0:
                other_id = self.reverse_item_map[other_idx]
                similar_items.append((other_id, sim))
        
        similar_items.sort(key=lambda x: x[1], reverse=True)
        return similar_items[:n]


class HybridCF:
    """
    Hybrid Collaborative Filtering
    
    Combines user-based and item-based approaches.
    """
    
    def __init__(self, user_weight: float = 0.5, n_neighbors: int = 20):
        self.user_weight = user_weight
        self.item_weight = 1 - user_weight
        self.user_cf = UserBasedCF(n_neighbors=n_neighbors)
        self.item_cf = ItemBasedCF(n_neighbors=n_neighbors)
        self.is_fitted = False
        
    def fit(self, user_ids: np.ndarray, item_ids: np.ndarray,
            ratings: np.ndarray):
        """Fit both user and item-based models."""
        print("Fitting Hybrid Collaborative Filtering model...")
        self.user_cf.fit(user_ids, item_ids, ratings)
        self.item_cf.fit(user_ids, item_ids, ratings)
        self.is_fitted = True
        
    def predict(self, user_id, item_id) -> float:
        """Predict using weighted combination of both methods."""
        user_pred = self.user_cf.predict(user_id, item_id)
        item_pred = self.item_cf.predict(user_id, item_id)
        
        return self.user_weight * user_pred + self.item_weight * item_pred
    
    def recommend(self, user_id, n_recommendations: int = 10) -> List[Tuple]:
        """Generate recommendations using hybrid approach."""
        if user_id not in self.user_cf.user_id_map:
            return self.item_cf._get_popular_items(n_recommendations)
        
        user_idx = self.user_cf.user_id_map[user_id]
        predictions = []
        
        for item_idx in range(len(self.user_cf.item_id_map)):
            if self.user_cf.ratings_matrix[user_idx, item_idx] != 0:
                continue
            
            item_id = self.user_cf.reverse_item_map[item_idx]
            predicted_rating = self.predict(user_id, item_id)
            predictions.append((item_id, predicted_rating))
        
        predictions.sort(key=lambda x: x[1], reverse=True)
        return predictions[:n_recommendations]
```

## 2. Matrix Factorization (SVD)

```python
"""
matrix_factorization.py
Matrix Factorization approaches for recommendations
"""

import numpy as np
from typing import List, Tuple, Optional
from scipy.sparse import csr_matrix
from scipy.sparse.linalg import svds


class SVDRecommender:
    """
    Matrix Factorization using Singular Value Decomposition
    
    Decomposes the user-item matrix into latent factors.
    """
    
    def __init__(self, n_factors: int = 50, n_epochs: int = 100,
                 learning_rate: float = 0.005, regularization: float = 0.02):
        self.n_factors = n_factors
        self.n_epochs = n_epochs
        self.lr = learning_rate
        self.reg = regularization
        
        self.user_factors = None
        self.item_factors = None
        self.user_biases = None
        self.item_biases = None
        self.global_mean = None
        
        self.user_id_map = {}
        self.item_id_map = {}
        self.reverse_user_map = {}
        self.reverse_item_map = {}
        
    def fit(self, user_ids: np.ndarray, item_ids: np.ndarray,
            ratings: np.ndarray, verbose: bool = True):
        """
        Train the SVD model using stochastic gradient descent.
        
        Args:
            user_ids: Array of user IDs
            item_ids: Array of item IDs
            ratings: Array of ratings
            verbose: Print training progress
        """
        # Create mappings
        unique_users = np.unique(user_ids)
        unique_items = np.unique(item_ids)
        
        self.user_id_map = {uid: idx for idx, uid in enumerate(unique_users)}
        self.item_id_map = {iid: idx for idx, iid in enumerate(unique_items)}
        self.reverse_user_map = {idx: uid for uid, idx in self.user_id_map.items()}
        self.reverse_item_map = {idx: iid for iid, idx in self.item_id_map.items()}
        
        n_users = len(unique_users)
        n_items = len(unique_items)
        
        # Initialize factors randomly
        np.random.seed(42)
        self.user_factors = np.random.normal(0, 0.1, (n_users, self.n_factors))
        self.item_factors = np.random.normal(0, 0.1, (n_items, self.n_factors))
        self.user_biases = np.zeros(n_users)
        self.item_biases = np.zeros(n_items)
        self.global_mean = np.mean(ratings)
        
        # Convert IDs to indices
        user_indices = np.array([self.user_id_map[uid] for uid in user_ids])
        item_indices = np.array([self.item_id_map[iid] for iid in item_ids])
        
        if verbose:
            print(f"Training SVD model with {n_users} users, {n_items} items, "
                  f"{len(ratings)} ratings")
            print(f"Parameters: {self.n_factors} factors, {self.n_epochs} epochs")
        
        # SGD training
        for epoch in range(self.n_epochs):
            # Shuffle data
            indices = np.random.permutation(len(ratings))
            
            total_error = 0.0
            
            for idx in indices:
                u = user_indices[idx]
                i = item_indices[idx]
                r = ratings[idx]
                
                # Predict
                pred = self.global_mean + self.user_biases[u] + self.item_biases[i]
                pred += np.dot(self.user_factors[u], self.item_factors[i])
                
                # Error
                error = r - pred
                total_error += error ** 2
                
                # Update biases
                self.user_biases[u] += self.lr * (error - self.reg * self.user_biases[u])
                self.item_biases[i] += self.lr * (error - self.reg * self.item_biases[i])
                
                # Update factors
                user_factor = self.user_factors[u].copy()
                self.user_factors[u] += self.lr * (
                    error * self.item_factors[i] - self.reg * self.user_factors[u]
                )
                self.item_factors[i] += self.lr * (
                    error * user_factor - self.reg * self.item_factors[i]
                )
            
            rmse = np.sqrt(total_error / len(ratings))
            
            if verbose and (epoch + 1) % 10 == 0:
                print(f"  Epoch {epoch + 1}/{self.n_epochs} - RMSE: {rmse:.4f}")
        
        if verbose:
            print("Training completed!")
    
    def predict(self, user_id, item_id) -> float:
        """Predict rating for a user-item pair."""
        if user_id not in self.user_id_map:
            if item_id in self.item_id_map:
                item_idx = self.item_id_map[item_id]
                return self.global_mean + self.item_biases[item_idx]
            return self.global_mean
        
        if item_id not in self.item_id_map:
            user_idx = self.user_id_map[user_id]
            return self.global_mean + self.user_biases[user_idx]
        
        user_idx = self.user_id_map[user_id]
        item_idx = self.item_id_map[item_id]
        
        pred = self.global_mean
        pred += self.user_biases[user_idx]
        pred += self.item_biases[item_idx]
        pred += np.dot(self.user_factors[user_idx], self.item_factors[item_idx])
        
        return np.clip(pred, 1.0, 5.0)
    
    def recommend(self, user_id, n_recommendations: int = 10,
                  rated_items: Optional[set] = None) -> List[Tuple]:
        """Generate top-N recommendations for a user."""
        if user_id not in self.user_id_map:
            return self._get_popular_items(n_recommendations)
        
        user_idx = self.user_id_map[user_id]
        
        # Calculate scores for all items
        scores = (self.global_mean + 
                  self.user_biases[user_idx] + 
                  self.item_biases + 
                  np.dot(self.item_factors, self.user_factors[user_idx]))
        
        # Get top items
        predictions = []
        for item_idx in np.argsort(scores)[::-1]:
            item_id = self.reverse_item_map[item_idx]
            
            if rated_items and item_id in rated_items:
                continue
            
            predictions.append((item_id, float(np.clip(scores[item_idx], 1.0, 5.0))))
            
            if len(predictions) >= n_recommendations:
                break
        
        return predictions
    
    def _get_popular_items(self, n: int) -> List[Tuple]:
        """Get items with highest biases (popularity proxy)."""
        item_scores = self.global_mean + self.item_biases
        top_indices = np.argsort(item_scores)[::-1][:n]
        
        return [(self.reverse_item_map[idx], float(np.clip(item_scores[idx], 1.0, 5.0)))
                for idx in top_indices]
    
    def get_user_embedding(self, user_id) -> Optional[np.ndarray]:
        """Get latent factor representation for a user."""
        if user_id not in self.user_id_map:
            return None
        return self.user_factors[self.user_id_map[user_id]]
    
    def get_item_embedding(self, item_id) -> Optional[np.ndarray]:
        """Get latent factor representation for an item."""
        if item_id not in self.item_id_map:
            return None
        return self.item_factors[self.item_id_map[item_id]]


class ALSRecommender:
    """
    Alternating Least Squares Matrix Factorization
    
    Efficient for implicit feedback or large datasets.
    """
    
    def __init__(self, n_factors: int = 50, n_iterations: int = 20,
                 regularization: float = 0.1):
        self.n_factors = n_factors
        self.n_iterations = n_iterations
        self.reg = regularization
        
        self.user_factors = None
        self.item_factors = None
        self.ratings_matrix = None
        
        self.user_id_map = {}
        self.item_id_map = {}
        self.reverse_user_map = {}
        self.reverse_item_map = {}
    
    def fit(self, user_ids: np.ndarray, item_ids: np.ndarray,
            ratings: np.ndarray, verbose: bool = True):
        """
        Train using Alternating Least Squares.
        """
        # Create mappings
        unique_users = np.unique(user_ids)
        unique_items = np.unique(item_ids)
        
        self.user_id_map = {uid: idx for idx, uid in enumerate(unique_users)}
        self.item_id_map = {iid: idx for idx, iid in enumerate(unique_items)}
        self.reverse_user_map = {idx: uid for uid, idx in self.user_id_map.items()}
        self.reverse_item_map = {idx: iid for iid, idx in self.item_id_map.items()}
        
        n_users = len(unique_users)
        n_items = len(unique_items)
        
        # Build ratings matrix
        self.ratings_matrix = np.zeros((n_users, n_items))
        for uid, iid, r in zip(user_ids, item_ids, ratings):
            self.ratings_matrix[self.user_id_map[uid], self.item_id_map[iid]] = r
        
        # Initialize factors
        np.random.seed(42)
        self.user_factors = np.random.rand(n_users, self.n_factors)
        self.item_factors = np.random.rand(n_items, self.n_factors)
        
        if verbose:
            print(f"Training ALS model with {n_users} users, {n_items} items")
        
        # Alternating optimization
        for iteration in range(self.n_iterations):
            # Fix item factors, update user factors
            self._update_user_factors()
            
            # Fix user factors, update item factors
            self._update_item_factors()
            
            if verbose and (iteration + 1) % 5 == 0:
                rmse = self._calculate_rmse()
                print(f"  Iteration {iteration + 1}/{self.n_iterations} - RMSE: {rmse:.4f}")
        
        if verbose:
            print("Training completed!")
    
    def _update_user_factors(self):
        """Update user factors while holding item factors fixed."""
        item_gram = self.item_factors.T @ self.item_factors
        reg_matrix = self.reg * np.eye(self.n_factors)
        
        for user_idx in range(len(self.user_factors)):
            rated_mask = self.ratings_matrix[user_idx] != 0
            if not rated_mask.any():
                continue
            
            item_factors_rated = self.item_factors[rated_mask]
            ratings_user = self.ratings_matrix[user_idx, rated_mask]
            
            A = item_factors_rated.T @ item_factors_rated + reg_matrix
            b = item_factors_rated.T @ ratings_user
            
            self.user_factors[user_idx] = np.linalg.solve(A, b)
    
    def _update_item_factors(self):
        """Update item factors while holding user factors fixed."""
        user_gram = self.user_factors.T @ self.user_factors
        reg_matrix = self.reg * np.eye(self.n_factors)
        
        for item_idx in range(len(self.item_factors)):
            rated_mask = self.ratings_matrix[:, item_idx] != 0
            if not rated_mask.any():
                continue
            
            user_factors_rated = self.user_factors[rated_mask]
            ratings_item = self.ratings_matrix[rated_mask, item_idx]
            
            A = user_factors_rated.T @ user_factors_rated + reg_matrix
            b = user_factors_rated.T @ ratings_item
            
            self.item_factors[item_idx] = np.linalg.solve(A, b)
    
    def _calculate_rmse(self) -> float:
        """Calculate RMSE on observed ratings."""
        predictions = self.user_factors @ self.item_factors.T
        mask = self.ratings_matrix != 0
        
        errors = (self.ratings_matrix[mask] - predictions[mask]) ** 2
        return np.sqrt(np.mean(errors))
    
    def predict(self, user_id, item_id) -> float:
        """Predict rating for a user-item pair."""
        if user_id not in self.user_id_map or item_id not in self.item_id_map:
            return 3.0  # Default rating
        
        user_idx = self.user_id_map[user_id]
        item_idx = self.item_id_map[item_id]
        
        pred = np.dot(self.user_factors[user_idx], self.item_factors[item_idx])
        return np.clip(pred, 1.0, 5.0)
    
    def recommend(self, user_id, n_recommendations: int = 10) -> List[Tuple]:
        """Generate top-N recommendations."""
        if user_id not in self.user_id_map:
            return []
        
        user_idx = self.user_id_map[user_id]
        scores = self.user_factors[user_idx] @ self.item_factors.T
        
        # Get unrated items
        rated_mask = self.ratings_matrix[user_idx] != 0
        scores[rated_mask] = -np.inf
        
        top_indices = np.argsort(scores)[::-1][:n_recommendations]
        
        return [(self.reverse_item_map[idx], float(np.clip(scores[idx], 1.0, 5.0)))
                for idx in top_indices]
```

## 3. Evaluation Metrics

```python
"""
evaluation.py
Evaluation metrics for recommendation systems
"""

import numpy as np
from typing import List, Dict, Tuple, Set
from collections import defaultdict
import matplotlib.pyplot as plt
from sklearn.model_selection import train_test_split


class RecommenderEvaluator:
    """Evaluation metrics for recommendation systems."""
    
    @staticmethod
    def rmse(predictions: List[float], actuals: List[float]) -> float:
        """Root Mean Square Error."""
        predictions = np.array(predictions)
        actuals = np.array(actuals)
        return np.sqrt(np.mean((predictions - actuals) ** 2))
    
    @staticmethod
    def mae(predictions: List[float], actuals: List[float]) -> float:
        """Mean Absolute Error."""
        predictions = np.array(predictions)
        actuals = np.array(actuals)
        return np.mean(np.abs(predictions - actuals))
    
    @staticmethod
    def precision_at_k(recommended: List, relevant: Set, k: int) -> float:
        """
        Precision@k - Fraction of recommended items that are relevant.
        
        Args:
            recommended: List of recommended items (ordered)
            relevant: Set of relevant items
            k: Number of top recommendations to consider
        """
        if k == 0:
            return 0.0
        
        recommended_at_k = set(recommended[:k])
        relevant_and_recommended = len(recommended_at_k & relevant)
        
        return relevant_and_recommended / k
    
    @staticmethod
    def recall_at_k(recommended: List, relevant: Set, k: int) -> float:
        """
        Recall@k - Fraction of relevant items that are recommended.
        """
        if len(relevant) == 0:
            return 0.0
        
        recommended_at_k = set(recommended[:k])
        relevant_and_recommended = len(recommended_at_k & relevant)
        
        return relevant_and_recommended / len(relevant)
    
    @staticmethod
    def f1_at_k(recommended: List, relevant: Set, k: int) -> float:
        """F1 Score at k."""
        precision = RecommenderEvaluator.precision_at_k(recommended, relevant, k)
        recall = RecommenderEvaluator.recall_at_k(recommended, relevant, k)
        
        if precision + recall == 0:
            return 0.0
        
        return 2 * precision * recall / (precision + recall)
    
    @staticmethod
    def ndcg_at_k(recommended: List, relevant: Set, k: int,
                  relevance_scores: Dict = None) -> float:
        """
        Normalized Discounted Cumulative Gain at k.
        
        Args:
            recommended: List of recommended items
            relevant: Set of relevant items
            k: Number of recommendations
            relevance_scores: Optional dict of item -> relevance score
        """
        if len(relevant) == 0:
            return 0.0
        
        # Calculate DCG
        dcg = 0.0
        for i, item in enumerate(recommended[:k]):
            if item in relevant:
                rel = relevance_scores.get(item, 1.0) if relevance_scores else 1.0
                dcg += rel / np.log2(i + 2)  # i+2 because i starts at 0
        
        # Calculate ideal DCG
        ideal_relevances = []
        for item in relevant:
            rel = relevance_scores.get(item, 1.0) if relevance_scores else 1.0
            ideal_relevances.append(rel)
        
        ideal_relevances.sort(reverse=True)
        
        idcg = 0.0
        for i, rel in enumerate(ideal_relevances[:k]):
            idcg += rel / np.log2(i + 2)
        
        if idcg == 0:
            return 0.0
        
        return dcg / idcg
    
    @staticmethod
    def mean_average_precision(recommendations: Dict[int, List],
                               relevants: Dict[int, Set]) -> float:
        """
        Mean Average Precision across all users.
        
        Args:
            recommendations: Dict of user_id -> recommended items list
            relevants: Dict of user_id -> relevant items set
        """
        average_precisions = []
        
        for user_id in recommendations:
            if user_id not in relevants or len(relevants[user_id]) == 0:
                continue
            
            recommended = recommendations[user_id]
            relevant = relevants[user_id]
            
            hits = 0
            sum_precisions = 0.0
            
            for i, item in enumerate(recommended):
                if item in relevant:
                    hits += 1
                    sum_precisions += hits / (i + 1)
            
            if hits > 0:
                average_precisions.append(sum_precisions / len(relevant))
        
        return np.mean(average_precisions) if average_precisions else 0.0
    
    @staticmethod
    def hit_rate(recommended: List, relevant: Set) -> float:
        """Whether at least one relevant item is recommended."""
        return 1.0 if set(recommended) & relevant else 0.0
    
    @staticmethod
    def coverage(all_recommendations: List[List], n_items: int) -> float:
        """Fraction of items that were recommended to at least one user."""
        recommended_items = set()
        for recs in all_recommendations:
            recommended_items.update(recs)
        
        return len(recommended_items) / n_items if n_items > 0 else 0.0
    
    @staticmethod
    def diversity(recommended: List, item_similarities: np.ndarray,
                  item_id_map: Dict) -> float:
        """
        Intra-list diversity - average dissimilarity between recommended items.
        """
        if len(recommended) < 2:
            return 0.0
        
        total_dissimilarity = 0.0
        n_pairs = 0
        
        for i in range(len(recommended)):
            for j in range(i + 1, len(recommended)):
                item_i = recommended[i]
                item_j = recommended[j]
                
                if item_i in item_id_map and item_j in item_id_map:
                    idx_i = item_id_map[item_i]
                    idx_j = item_id_map[item_j]
                    similarity = item_similarities[idx_i, idx_j]
                    total_dissimilarity += (1 - similarity)
                    n_pairs += 1
        
        return total_dissimilarity / n_pairs if n_pairs > 0 else 0.0


class CrossValidator:
    """Cross-validation for recommender systems."""
    
    def __init__(self, n_folds: int = 5):
        self.n_folds = n_folds
    
    def split_data(self, user_ids: np.ndarray, item_ids: np.ndarray,
                   ratings: np.ndarray, test_size: float = 0.2):
        """Split data into train and test sets."""
        indices = np.arange(len(ratings))
        train_idx, test_idx = train_test_split(
            indices, test_size=test_size, random_state=42
        )
        
        return (
            user_ids[train_idx], item_ids[train_idx], ratings[train_idx],
            user_ids[test_idx], item_ids[test_idx], ratings[test_idx]
        )
    
    def evaluate_recommender(self, recommender, train_data: Tuple,
                            test_data: Tuple, k_values: List[int] = [5, 10, 20]):
        """
        Comprehensive evaluation of a recommender system.
        """
        train_users, train_items, train_ratings = train_data
        test_users, test_items, test_ratings = test_data
        
        # Fit the model
        recommender.fit(train_users, train_items, train_ratings)
        
        results = {
            'rating_prediction': {},
            'ranking_metrics': defaultdict(list)
        }
        
        # Rating prediction metrics
        predictions = []
        actuals = []
        
        for user_id, item_id, rating in zip(test_users, test_items, test_ratings):
            pred = recommender.predict(user_id, item_id)
            predictions.append(pred)
            actuals.append(rating)
        
        evaluator = RecommenderEvaluator()
        results['rating_prediction']['RMSE'] = evaluator.rmse(predictions, actuals)
        results['rating_prediction']['MAE'] = evaluator.mae(predictions, actuals)
        
        # Build test set per user
        user_test_items = defaultdict(set)
        for user_id, item_id, rating in zip(test_users, test_items, test_ratings):
            if rating >= 4.0:  # Consider high ratings as relevant
                user_test_items[user_id].add(item_id)
        
        # Ranking metrics
        for k in k_values:
            precisions = []
            recalls = []
            ndcgs = []
            
            for user_id in set(test_users):
                if user_id not in user_test_items:
                    continue
                
                relevant = user_test_items[user_id]
                recommendations = recommender.recommend(user_id, n_recommendations=k)
                recommended = [r[0] for r in recommendations]
                
                precisions.append(evaluator.precision_at_k(recommended, relevant, k))
                recalls.append(evaluator.recall_at_k(recommended, relevant, k))
                ndcgs.append(evaluator.ndcg_at_k(recommended, relevant, k))
            
            results['ranking_metrics'][f'Precision@{k}'] = np.mean(precisions)
            results['ranking_metrics'][f'Recall@{k}'] = np.mean(recalls)
            results['ranking_metrics'][f'NDCG@{k}'] = np.mean(ndcgs)
        
        return results


def plot_evaluation_results(results: Dict, title: str = "Evaluation Results"):
    """Visualize evaluation results."""
    fig, axes = plt.subplots(1, 2, figsize=(14, 5))
    
    # Rating prediction metrics
    rating_metrics = results['rating_prediction']
    ax1 = axes[0]
    bars = ax1.bar(rating_metrics.keys(), rating_metrics.values(), color=['#3498db', '#e74c3c'])
    ax1.set_ylabel('Error')
    ax1.set_title('Rating Prediction Metrics')
    for bar, val in zip(bars, rating_metrics.values()):
        ax1.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.01,
                f'{val:.3f}', ha='center', va='bottom')
    
    # Ranking metrics
    ranking_metrics = dict(results['ranking_metrics'])
    ax2 = axes[1]
    x = np.arange(len(ranking_metrics))
    bars = ax2.bar(x, ranking_metrics.values(), color='#2ecc71')
    ax2.set_xticks(x)
    ax2.set_xticklabels(ranking_metrics.keys(), rotation=45, ha='right')
    ax2.set_ylabel('Score')
    ax2.set_title('Ranking Metrics')
    for bar, val in zip(bars, ranking_metrics.values()):
        ax2.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.01,
                f'{val:.3f}', ha='center', va='bottom', fontsize=8)
    
    plt.suptitle(title)
    plt.tight_layout()
    plt.savefig('evaluation_results.png', dpi=150, bbox_inches='tight')
    plt.show()
```

## 4. Demo and Usage Examples

```python
"""
demo.py
Demonstration of the recommendation system
"""

import numpy as np
import pandas as pd
from recommendation_system import UserBasedCF, ItemBasedCF, HybridCF
from matrix_factorization import SVDRecommender, ALSRecommender
from evaluation import CrossValidator, RecommenderEvaluator, plot_evaluation_results


def generate_sample_data(n_users: int = 500, n_items: int = 200,
                         n_ratings: int = 10000, seed: int = 42):
    """Generate sample rating data for demonstration."""
    np.random.seed(seed)
    
    # Generate user preferences (latent factors)
    n_genres = 5
    user_preferences = np.random.rand(n_users, n_genres)
    item_genres = np.random.rand(n_items, n_genres)
    
    # Generate ratings based on preferences
    user_ids = []
    item_ids = []
    ratings = []
    
    user_item_pairs = set()
    
    while len(ratings) < n_ratings:
        user = np.random.randint(0, n_users)
        item = np.random.randint(0, n_items)
        
        if (user, item) in user_item_pairs:
            continue
        
        user_item_pairs.add((user, item))
        
        # Base rating from preference matching
        base_rating = np.dot(user_preferences[user], item_genres[item])
        # Normalize to 1-5 scale with some noise
        rating = 1 + 4 * base_rating / n_genres + np.random.normal(0, 0.5)
        rating = np.clip(round(rating * 2) / 2, 1.0, 5.0)  # Round to 0.5
        
        user_ids.append(f"user_{user}")
        item_ids.append(f"item_{item}")
        ratings.append(rating)
    
    return np.array(user_ids), np.array(item_ids), np.array(ratings)


def demo_user_based_cf():
    """Demonstrate User-Based Collaborative Filtering."""
    print("\n" + "="*60)
    print("USER-BASED COLLABORATIVE FILTERING DEMO")
    print("="*60)
    
    # Generate data
    user_ids, item_ids, ratings = generate_sample_data(
        n_users=200, n_items=100, n_ratings=5000
    )
    
    # Create and fit model
    user_cf = UserBasedCF(n_neighbors=30, similarity_metric='pearson')
    user_cf.fit(user_ids, item_ids, ratings)
    
    # Get recommendations for a user
    test_user = "user_0"
    recommendations = user_cf.recommend(test_user, n_recommendations=10)
    
    print(f"\nTop 10 recommendations for {test_user}:")
    print("-" * 40)
    for rank, (item_id, pred_rating) in enumerate(recommendations, 1):
        print(f"  {rank}. {item_id}: {pred_rating:.2f}")
    
    # Show similar users
    similar_users = user_cf.get_similar_users(test_user, n=5)
    print(f"\nMost similar users to {test_user}:")
    for user_id, similarity in similar_users:
        print(f"  {user_id}: similarity = {similarity:.3f}")
    
    # Predict specific rating
    test_item = "item_50"
    pred = user_cf.predict(test_user, test_item)
    print(f"\nPredicted rating for {test_user} on {test_item}: {pred:.2f}")
    
    return user_cf


def demo_item_based_cf():
    """Demonstrate Item-Based Collaborative Filtering."""
    print("\n" + "="*60)
    print("ITEM-BASED COLLABORATIVE FILTERING DEMO")
    print("="*60)
    
    # Generate data
    user_ids, item_ids, ratings = generate_sample_data(
        n_users=200, n_items=100, n_ratings=5000
    )
    
    # Create and fit model
    item_cf = ItemBasedCF(n_neighbors=30, similarity_metric='adjusted_cosine')
    item_cf.fit(user_ids, item_ids, ratings)
    
    # Get recommendations
    test_user = "user_5"
    recommendations = item_cf.recommend(test_user, n_recommendations=10)
    
    print(f"\nTop 10 recommendations for {test_user}:")
    print("-" * 40)
    for rank, (item_id, pred_rating) in enumerate(recommendations, 1):
        print(f"  {rank}. {item_id}: {pred_rating:.2f}")
    
    # Show similar items
    test_item = "item_10"
    similar_items = item_cf.get_similar_items(test_item, n=5)
    print(f"\nMost similar items to {test_item}:")
    for item_id, similarity in similar_items:
        print(f"  {item_id}: similarity = {similarity:.3f}")
    
    return item_cf


def demo_svd():
    """Demonstrate SVD-based Matrix Factorization."""
    print("\n" + "="*60)
    print("SVD MATRIX FACTORIZATION DEMO")
    print("="*60)
    
    # Generate data
    user_ids, item_ids, ratings = generate_sample_data(
        n_users=300, n_items=150, n_ratings=8000
    )
    
    # Create and fit model
    svd = SVDRecommender(n_factors=30, n_epochs=50, 
                         learning_rate=0.01, regularization=0.02)
    svd.fit(user_ids, item_ids, ratings, verbose=True)
    
    # Get recommendations
    test_user = "user_10"
    
    # Get user's rated items to exclude
    rated_items = set()
    for uid, iid in zip(user_ids, item_ids):
        if uid == test_user:
            rated_items.add(iid)
    
    recommendations = svd.recommend(test_user, n_recommendations=10,
                                    rated_items=rated_items)
    
    print(f"\nTop 10 recommendations for {test_user}:")
    print("-" * 40)
    for rank, (item_id, pred_rating) in enumerate(recommendations, 1):
        print(f"  {rank}. {item_id}: {pred_rating:.2f}")
    
    # Show user embedding
    embedding = svd.get_user_embedding(test_user)
    print(f"\nUser embedding (first 5 dimensions): {embedding[:5].round(3)}")
    
    return svd


def demo_evaluation():
    """Demonstrate evaluation of different recommenders."""
    print("\n" + "="*60)
    print("EVALUATION COMPARISON DEMO")
    print("="*60)
    
    # Generate data
    user_ids, item_ids, ratings = generate_sample_data(
        n_users=300, n_items=150, n_ratings=8000
    )
    
    # Split data
    cv = CrossValidator()
    train_data = (user_ids, item_ids, ratings)
    
    train_users, train_items, train_ratings, \
    test_users, test_items, test_ratings = cv.split_data(
        user_ids, item_ids, ratings, test_size=0.2
    )
    
    train_data = (train_users, train_items, train_ratings)
    test_data = (test_users, test_items, test_ratings)
    
    # Evaluate different models
    models = {
        'User-Based CF': UserBasedCF(n_neighbors=20),
        'Item-Based CF': ItemBasedCF(n_neighbors=20),
        'SVD': SVDRecommender(n_factors=30, n_epochs=30),
        'ALS': ALSRecommender(n_factors=30, n_iterations=15)
    }
    
    all_results = {}
    
    for name, model in models.items():
        print(f"\nEvaluating {name}...")
        results = cv.evaluate_recommender(model, train_data, test_data)
        all_results[name] = results
        
        print(f"\n{name} Results:")
        print(f"  RMSE: {results['rating_prediction']['RMSE']:.4f}")
        print(f"  MAE: {results['rating_prediction']['MAE']:.4f}")
        for metric, value in results['ranking_metrics'].items():
            print(f"  {metric}: {value:.4f}")
    
    # Compare results
    print("\n" + "="*60)
    print("COMPARISON SUMMARY")
    print("="*60)
    
    comparison_df = pd.DataFrame({
        name: {
            'RMSE': res['rating_prediction']['RMSE'],
            'MAE': res['rating_prediction']['MAE'],
            **dict(res['ranking_metrics'])
        }
        for name, res in all_results.items()
    }).T
    
    print("\n", comparison_df.round(4).to_string())
    
    # Plot results for best model
    best_model = min(all_results.items(), 
                     key=lambda x: x[1]['rating_prediction']['RMSE'])
    plot_evaluation_results(best_model[1], f"Best Model: {best_model[0]}")
    
    return all_results


def demo_hybrid():
    """Demonstrate Hybrid Collaborative Filtering."""
    print("\n" + "="*60)
    print("HYBRID COLLABORATIVE FILTERING DEMO")
    print("="*60)
    
    # Generate data
    user_ids, item_ids, ratings = generate_sample_data(
        n_users=200, n_items=100, n_ratings=5000
    )
    
    # Create hybrid model
    hybrid = HybridCF(user_weight=0.6, n_neighbors=25)
    hybrid.fit(user_ids, item_ids, ratings)
    
    # Get recommendations
    test_user = "user_15"
    recommendations = hybrid.recommend(test_user, n_recommendations=10)
    
    print(f"\nTop 10 hybrid recommendations for {test_user}:")
    print("-" * 40)
    for rank, (item_id, pred_rating) in enumerate(recommendations, 1):
        print(f"  {rank}. {item_id}: {pred_rating:.2f}")
    
    # Compare with individual models
    print("\nComparing prediction methods for specific items:")
    test_items = ["item_20", "item_40", "item_60"]
    
    for item in test_items:
        user_pred = hybrid.user_cf.predict(test_user, item)
        item_pred = hybrid.item_cf.predict(test_user, item)
        hybrid_pred = hybrid.predict(test_user, item)
        
        print(f"\n  {item}:")
        print(f"    User-Based:  {user_pred:.2f}")
        print(f"    Item-Based:  {item_pred:.2f}")
        print(f"    Hybrid:      {hybrid_pred:.2f}")
    
    return hybrid


def main():
    """Run all demonstrations."""
    print("\n" + "="*60)
    print("COLLABORATIVE FILTERING RECOMMENDATION SYSTEM")
    print("Complete Demonstration")
    print("="*60)
    
    # Run demos
    demo_user_based_cf()
    demo_item_based_cf()
    demo_svd()
    demo_hybrid()
    demo_evaluation()
    
    print("\n" + "="*60)
    print("All demonstrations completed successfully!")
    print("="*60)


if __name__ == "__main__":
    main()
```

## 5. Requirements

```text
# requirements.txt
numpy>=1.21.0
pandas>=1.3.0
scipy>=1.7.0
scikit-learn>=0.24.0
matplotlib>=3.4.0
```

## Visualization of the Recommendation Process

```
┌─────────────────────────────────────────────────────────────────────┐
│                COLLABORATIVE FILTERING APPROACHES                    │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                     USER-BASED CF                                    │
│                                                                      │
│   User-Item Matrix          Similar Users       Recommendations      │
│   ┌───────────────┐        ┌─────────────┐     ┌──────────────┐     │
│   │ I1 I2 I3 I4   │        │  User A     │     │ Recommend    │     │
│   │U1 5  3  -  4  │  ───►  │  similarity │ ──► │ items that   │     │
│   │U2 4  -  2  5  │        │  with U1    │     │ similar      │     │
│   │U3 -  4  4  -  │        │  = 0.89     │     │ users liked  │     │
│   │...            │        └─────────────┘     └──────────────┘     │
│   └───────────────┘                                                  │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                     ITEM-BASED CF                                    │
│                                                                      │
│   User-Item Matrix          Similar Items      Recommendations      │
│   ┌───────────────┐        ┌─────────────┐     ┌──────────────┐     │
│   │ I1 I2 I3 I4   │        │  Item A     │     │ Recommend    │     │
│   │U1 5  3  -  4  │  ───►  │  similar to │ ──► │ items        │     │
│   │U2 4  -  2  5  │        │  user's     │     │ similar to   │     │
│   │U3 -  4  4  -  │        │  rated items│     │ past likes   │     │
│   │...            │        └─────────────┘     └──────────────┘     │
│   └───────────────┘                                                  │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                  MATRIX FACTORIZATION (SVD)                          │
│                                                                      │
│   User-Item Matrix     =   User Factors  ×  Item Factors             │
│   ┌───────────────┐       ┌─────────┐      ┌─────────────┐          │
│   │ R(n×m)        │   =   │ U(n×k)  │  ×   │ V(k×m)      │          │
│   │               │       │         │      │             │          │
│   │ Rating Matrix │       │ Latent  │      │ Latent      │          │
│   │               │       │ User    │      │ Item        │          │
│   │               │       │ Features│      │ Features    │          │
│   └───────────────┘       └─────────┘      └─────────────┘          │
│                                                                      │
│   Prediction: r̂(u,i) = μ + bᵤ + bᵢ + uᵀ × vᵢ                       │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    EVALUATION METRICS                                │
├─────────────────┬───────────────────────────────────────────────────┤
│ RMSE            │ √(Σ(actual - predicted)² / n) - Rating accuracy   │
│ MAE             │ Σ|actual - predicted| / n - Absolute error        │
│ Precision@k     │ Relevant∩Recommended / k - Recommendation quality │
│ Recall@k        │ Relevant∩Recommended / |Relevant| - Coverage      │
│ NDCG@k          │ DCG/IDCG - Ranking quality with position weights  │
└─────────────────┴───────────────────────────────────────────────────┘
```

## Key Features

| Feature | Description |
|---------|-------------|
| **User-Based CF** | Find similar users, recommend their liked items |
| **Item-Based CF** | Find similar items to user's preferences |
| **SVD** | Matrix factorization with gradient descent |
| **ALS** | Alternating Least Squares optimization |
| **Hybrid** | Combines user and item-based approaches |
| **Evaluation** | RMSE, MAE, Precision, Recall, NDCG |

This implementation provides a complete collaborative filtering system suitable for building production-ready recommendation engines!
```