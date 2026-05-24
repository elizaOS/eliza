"""Text-conditioning embedding cache for curriculum tasks.

Strategy (matches the unanimous research-agent recommendation):

  1. For each curriculum task, gather every text variant across every
     language from `tasks.yaml`.
  2. Encode each variant with a small sentence-transformer (default
     "all-MiniLM-L6-v2", 384-D, 22 MB) — cheap, CPU-friendly.
  3. Take the mean across variants → one 384-D embedding per task.
  4. Optionally PCA-down to `n_components` (default 32) so the policy's
     observation stays small.
  5. Cache the result on disk so training and inference are deterministic
     and start-up is instant.

At inference, free-form text from the agent is encoded the same way and
matched (by cosine similarity) against the cached task embeddings; the
nearest task's embedding is passed to the policy. The bridge's
`CommandParser` already handles this nearest-match logic — we just give
it the embeddings.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from eliza_robot.curriculum.loader import Curriculum, load_curriculum

DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
DEFAULT_CACHE_DIR = Path.home() / ".cache" / "eliza_robot" / "text_embeddings"
DEFAULT_DIM = 384
DEFAULT_PCA_DIM = 32


@dataclass
class TaskEmbedding:
    task_id: str
    mean_embed: np.ndarray          # (DEFAULT_DIM,) before reduction
    reduced_embed: np.ndarray       # (n_components,) after reduction
    variants: list[str]


def _hash_cache_key(model: str, pca_dim: int, curriculum_version: int) -> str:
    return f"{model.replace('/', '__')}__pca{pca_dim}__v{curriculum_version}"


def curriculum_content_sha256(curriculum: Curriculum) -> str:
    """Stable content hash used to reject stale text-embedding caches.

    `tasks.yaml` historically only keyed caches by `version`. That allows a
    stale cache whenever task text changes without a version bump, which is
    exactly the kind of silent conditioning/data mismatch that is painful to
    debug after a training run.
    """

    payload = curriculum.model_dump(mode="json")
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )
    return hashlib.sha256(encoded).hexdigest()


def _synthetic_task_embeddings(
    curriculum: Curriculum, *, pca_dim: int
) -> dict[str, TaskEmbedding]:
    """Hash-seeded deterministic embeddings used when sentence_transformers
    and sklearn are unavailable. NOT a semantic encoder — task ids that
    sound similar get unrelated vectors. Adequate for shape-compatibility
    tests, contract checks, and zero-policy mp4 rendering where the
    embedding is fed as obs but the policy doesn't depend on its content.
    """
    import hashlib

    out: dict[str, TaskEmbedding] = {}
    for task in curriculum.tasks:
        digest = hashlib.sha256(task.id.encode("utf-8")).digest()
        seed = int.from_bytes(digest[:8], "little", signed=False)
        rng = np.random.default_rng(seed)
        mean = rng.standard_normal(DEFAULT_DIM).astype(np.float32)
        mean = mean / (np.linalg.norm(mean) + 1e-9)
        reduced = rng.standard_normal(pca_dim).astype(np.float32)
        reduced = reduced / (np.linalg.norm(reduced) + 1e-9)
        out[task.id] = TaskEmbedding(
            task_id=task.id,
            mean_embed=mean,
            reduced_embed=reduced,
            variants=task.verbs.all_variants(),
        )
    return out


def build_task_embeddings(
    curriculum: Curriculum | None = None,
    *,
    model: str = DEFAULT_MODEL,
    pca_dim: int = DEFAULT_PCA_DIM,
    cache_dir: Path | None = None,
    force_rebuild: bool = False,
) -> dict[str, TaskEmbedding]:
    """Build (or load) the per-task text embedding cache.

    On a fresh machine this downloads the sentence-transformer (~22 MB).
    """
    curriculum = curriculum or load_curriculum()
    cache_dir = cache_dir or DEFAULT_CACHE_DIR
    cache_dir.mkdir(parents=True, exist_ok=True)
    key = _hash_cache_key(model, pca_dim, curriculum.version)
    cache_path = cache_dir / f"{key}.npz"
    meta_path = cache_dir / f"{key}.json"
    curriculum_sha256 = curriculum_content_sha256(curriculum)

    # Inference-time fallback: when the cache is missing AND
    # sentence_transformers / sklearn aren't installed, synthesize a
    # deterministic per-task embedding so policies can still be loaded
    # and exercised end-to-end (zero-policy mp4 rendering, contract tests,
    # CI smokes on the bridge). The embedding is a hash-seeded normalized
    # vector per task — has no semantic transfer power, but matches the
    # training cache's shape/dtype exactly so downstream code is happy.
    try:
        import sentence_transformers  # noqa: F401
        import sklearn  # noqa: F401

        sentence_libs_available = True
    except ImportError:
        sentence_libs_available = False

    if not sentence_libs_available and not cache_path.exists() and not force_rebuild:
        return _synthetic_task_embeddings(curriculum, pca_dim=pca_dim)

    if not force_rebuild and cache_path.exists() and meta_path.exists():
        meta = json.loads(meta_path.read_text())
        cache_sha256 = meta.get("curriculum_sha256")
        cache_is_current = cache_sha256 == curriculum_sha256
        if cache_is_current or (cache_sha256 is None and not sentence_libs_available):
            npz = np.load(cache_path)
            out: dict[str, TaskEmbedding] = {}
            for task_id in meta["task_ids"]:
                out[task_id] = TaskEmbedding(
                    task_id=task_id,
                    mean_embed=npz[f"{task_id}_mean"],
                    reduced_embed=npz[f"{task_id}_reduced"],
                    variants=meta["variants"][task_id],
                )
            return out
        if not sentence_libs_available:
            return _synthetic_task_embeddings(curriculum, pca_dim=pca_dim)

    # Lazy-import sentence_transformers + sklearn so the dependency only
    # matters when we actually rebuild the cache.
    from sentence_transformers import SentenceTransformer
    from sklearn.decomposition import PCA

    encoder = SentenceTransformer(model)
    raw: dict[str, np.ndarray] = {}
    variants_by_task: dict[str, list[str]] = {}
    all_means: list[np.ndarray] = []
    for task in curriculum.tasks:
        variants = task.verbs.all_variants()
        variants_by_task[task.id] = variants
        emb = encoder.encode(variants, normalize_embeddings=True)
        mean = emb.mean(axis=0)
        # re-normalize after averaging
        mean = mean / (np.linalg.norm(mean) + 1e-9)
        raw[task.id] = mean.astype(np.float32)
        all_means.append(mean)

    stacked = np.stack(all_means, axis=0)
    # Force PCA whenever it makes the obs strictly smaller. When
    # n_tasks < pca_dim, fall back to n_components = n_tasks (sklearn
    # caps it anyway), so we still strictly shrink the obs vs the raw
    # 384-D sentence-transformer output. The previous behavior — return
    # raw 384-D when n_tasks < pca_dim — was silently dropping PCA and
    # lying about it in the manifest (R-8 in the SOTA audit).
    if pca_dim < stacked.shape[1]:
        effective_n = min(pca_dim, stacked.shape[0])
        pca = PCA(n_components=effective_n, whiten=False)
        reduced = pca.fit_transform(stacked).astype(np.float32)
        pca_components = pca.components_.astype(np.float32)
        pca_mean = pca.mean_.astype(np.float32)
    else:
        reduced = stacked.astype(np.float32)
        pca_components = np.eye(stacked.shape[1], dtype=np.float32)
        pca_mean = np.zeros(stacked.shape[1], dtype=np.float32)

    task_ids = list(raw.keys())
    out: dict[str, TaskEmbedding] = {}
    save_dict: dict[str, np.ndarray] = {}
    for i, tid in enumerate(task_ids):
        out[tid] = TaskEmbedding(
            task_id=tid,
            mean_embed=raw[tid],
            reduced_embed=reduced[i],
            variants=variants_by_task[tid],
        )
        save_dict[f"{tid}_mean"] = raw[tid]
        save_dict[f"{tid}_reduced"] = reduced[i]

    save_dict["__pca_components"] = pca_components
    save_dict["__pca_mean"] = pca_mean
    np.savez(cache_path, **save_dict)
    meta_path.write_text(json.dumps({
        "model": model,
        "pca_dim": pca_dim,
        "curriculum_version": curriculum.version,
        "curriculum_sha256": curriculum_sha256,
        "task_ids": task_ids,
        "variants": variants_by_task,
    }, indent=2))
    return out


def project_text(
    text: str,
    embeddings: dict[str, TaskEmbedding] | None = None,
    *,
    model: str = DEFAULT_MODEL,
    cache_dir: Path | None = None,
    pca_dim: int = DEFAULT_PCA_DIM,
) -> tuple[str, np.ndarray, float]:
    """Encode free-form `text` and return (best_task_id, reduced_embed, similarity).

    Used at inference time: agent emits "shuffle to the right" → returns
    (sidestep_right, [pca-32 embedding], 0.92).
    """
    embeddings = embeddings or build_task_embeddings(
        model=model, pca_dim=pca_dim, cache_dir=cache_dir
    )
    from sentence_transformers import SentenceTransformer

    encoder = SentenceTransformer(model)
    query = encoder.encode([text], normalize_embeddings=True)[0]
    best_id, best_sim = "", -1.0
    for tid, te in embeddings.items():
        sim = float(np.dot(query, te.mean_embed))
        if sim > best_sim:
            best_id = tid
            best_sim = sim
    return best_id, embeddings[best_id].reduced_embed.copy(), best_sim


def text_conditioned_obs_dim(pca_dim: int = DEFAULT_PCA_DIM) -> int:
    """Helper for env factories: how many extra obs dims for the text channel."""
    return pca_dim
