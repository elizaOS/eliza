from __future__ import annotations

import builtins
import json
from pathlib import Path

import numpy as np

from eliza_robot.curriculum.loader import Curriculum, TaskSpec, TaskVerbs
from eliza_robot.rl.text_conditioned import encoder


def _curriculum() -> Curriculum:
    tasks = [
        TaskSpec(
            id="stand_up",
            tier=1,
            verbs=TaskVerbs(en=["stand up"]),
            description="Stand up.",
            reward={"target_height_m": 0.25},
            success={"no_fall": True},
        ),
        TaskSpec(
            id="walk_forward",
            tier=1,
            verbs=TaskVerbs(en=["walk forward"]),
            description="Walk forward.",
            reward={"target_velocity_x_m_s": 0.1},
            success={"no_fall": True},
        ),
    ]
    return Curriculum(version=991, tiers={}, tasks=tasks)


def test_corrupt_embedding_cache_falls_back_without_sentence_libs(
    monkeypatch, tmp_path: Path
) -> None:
    curriculum = _curriculum()
    model = "unit-test-model"
    pca_dim = 8
    key = encoder._hash_cache_key(model, pca_dim, curriculum.version)  # noqa: SLF001
    cache_path = tmp_path / f"{key}.npz"
    meta_path = tmp_path / f"{key}.json"

    cache_path.write_bytes(b"this is not a zip archive")
    meta_path.write_text(
        json.dumps(
            {
                "model": model,
                "pca_dim": pca_dim,
                "curriculum_version": curriculum.version,
                "curriculum_sha256": encoder.curriculum_content_sha256(curriculum),
                "task_ids": curriculum.all_ids(),
                "variants": curriculum.text_variant_inventory(),
            }
        )
    )

    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name in {"sentence_transformers", "sklearn"}:
            raise ImportError(name)
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)

    first = encoder.build_task_embeddings(
        curriculum=curriculum,
        model=model,
        pca_dim=pca_dim,
        cache_dir=tmp_path,
    )
    second = encoder.build_task_embeddings(
        curriculum=curriculum,
        model=model,
        pca_dim=pca_dim,
        cache_dir=tmp_path,
    )

    assert set(first) == {"stand_up", "walk_forward"}
    for task_id, task_embedding in first.items():
        assert task_embedding.mean_embed.shape == (encoder.DEFAULT_DIM,)
        assert task_embedding.reduced_embed.shape == (pca_dim,)
        assert task_embedding.mean_embed.dtype == np.float32
        assert task_embedding.reduced_embed.dtype == np.float32
        np.testing.assert_allclose(
            task_embedding.mean_embed,
            second[task_id].mean_embed,
        )
        np.testing.assert_allclose(
            task_embedding.reduced_embed,
            second[task_id].reduced_embed,
        )
