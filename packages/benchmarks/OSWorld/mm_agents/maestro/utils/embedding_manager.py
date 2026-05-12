import numpy as np
from ..utils.common_utils import (
    load_embeddings,
    save_embeddings,
)
import os

# List all embeddings' keys and their shapes
def list_embeddings(embeddings_path: str):
    if not os.path.exists(embeddings_path):
        print(f"[EmbeddingManager] File not found: {embeddings_path}")
        return {}
    embeddings = load_embeddings(embeddings_path)
    info = {}
    for k, v in embeddings.items():
        arr = np.array(v)
        info[k] = {'shape': arr.shape, 'preview': arr.flatten()[:5].tolist()}
    return info

# Delete a specific embedding by key
def delete_embedding(embeddings_path: str, key: str) -> bool:
    if not os.path.exists(embeddings_path):
        print(f"[EmbeddingManager] File not found: {embeddings_path}")
        return False
    embeddings = load_embeddings(embeddings_path)
    if key not in embeddings:
        print(f"[EmbeddingManager] Key not found: {key}")
        return False
    del embeddings[key]
    save_embeddings(embeddings_path, embeddings)
    print(f"[EmbeddingManager] Deleted embedding for key: {key}")
    return True

def delete_empty_shape_embeddings(embeddings_path: str) -> int:
    """Delete all embeddings whose value is empty (shape==0), shape==(), or content is error string, and return the number deleted."""
    if not os.path.exists(embeddings_path):
        print(f"[EmbeddingManager] File not found: {embeddings_path}")
        return 0
    embeddings = load_embeddings(embeddings_path)
    to_delete = []
    for k, v in embeddings.items():
        arr = np.array(v)
        # Delete shape==0 or shape==() or content is string/error information
        if arr.size == 0 or arr.shape == () or (
            isinstance(v, list) and v and isinstance(v[0], str) and v[0].startswith('Error:')
        ) or (isinstance(v, str) and v.startswith('Error:')):
            to_delete.append(k)
    for k in to_delete:
        del embeddings[k]
        print(f"[EmbeddingManager] Deleted empty or error embedding for key: {k}")
    if to_delete:
        save_embeddings(embeddings_path, embeddings)
    return len(to_delete) 