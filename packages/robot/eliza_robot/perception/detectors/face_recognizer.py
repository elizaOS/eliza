"""Face recognition using ArcFace embeddings.

Maintains a gallery of known faces (512-d embeddings) and matches
new detections by cosine similarity. Supports persistence to disk.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from eliza_robot.perception.detectors.face_detector import FaceDetection
from eliza_robot.perception.detectors.utils import cosine_similarity


@dataclass
class FaceIdentity:
    """A recognized face identity."""
    identity_id: str
    name: str
    embedding: np.ndarray   # (512,) L2-normalized mean embedding
    num_samples: int = 1


class FaceRecognizer:
    """ArcFace gallery for face recognition.

    Matches face embeddings against a gallery of known identities
    using cosine similarity. Unknown faces are assigned new IDs.
    """

    MAX_GALLERY_SIZE = 200  # prevent unbounded growth

    def __init__(
        self,
        recognition_threshold: float = 0.4,
        gallery_dir: Path | None = None,
    ) -> None:
        self._threshold = recognition_threshold
        self._gallery: dict[str, FaceIdentity] = {}
        self._next_id = 0
        self._gallery_dir = gallery_dir
        if gallery_dir is not None:
            self._load_gallery(gallery_dir)

    def recognize(
        self, detection: FaceDetection, auto_enroll: bool = True,
    ) -> tuple[str, float]:
        """Match a face detection against the gallery.

        Returns (identity_id, similarity_score). If no match and
        auto_enroll is True, creates a new identity.
        """
        if detection.embedding is None:
            return "", 0.0

        best_id = ""
        best_sim = -1.0

        for identity in self._gallery.values():
            sim = cosine_similarity(detection.embedding, identity.embedding)
            if sim > best_sim:
                best_sim = sim
                best_id = identity.identity_id

        if best_sim >= self._threshold and best_id:
            # Update running mean embedding and re-normalize to unit length
            identity = self._gallery[best_id]
            n = identity.num_samples
            new_emb = (identity.embedding * n + detection.embedding) / (n + 1)
            norm = np.linalg.norm(new_emb)
            identity.embedding = new_emb / norm if norm > 1e-8 else new_emb
            identity.num_samples = n + 1
            return best_id, best_sim

        if auto_enroll and len(self._gallery) < self.MAX_GALLERY_SIZE:
            new_id = self._assign_new_id("person")
            emb = detection.embedding.copy()
            norm = np.linalg.norm(emb)
            self._gallery[new_id] = FaceIdentity(
                identity_id=new_id,
                name=f"Person {self._next_id - 1}",
                embedding=emb / norm if norm > 1e-8 else emb,
            )
            return new_id, 1.0

        return "", 0.0

    def enroll(
        self, name: str, embedding: np.ndarray, identity_id: str | None = None,
    ) -> str:
        """Manually enroll a face in the gallery."""
        if identity_id is None:
            identity_id = self._assign_new_id(name)
        self._gallery[identity_id] = FaceIdentity(
            identity_id=identity_id,
            name=name,
            embedding=embedding.copy(),
        )
        return identity_id

    def get_identity(self, identity_id: str) -> FaceIdentity | None:
        return self._gallery.get(identity_id)

    @property
    def gallery_size(self) -> int:
        return len(self._gallery)

    def save_gallery(self, path: Path | None = None) -> None:
        """Save gallery to disk as .npz files."""
        save_dir = path or self._gallery_dir
        if save_dir is None:
            raise ValueError("No gallery directory specified")
        save_dir.mkdir(parents=True, exist_ok=True)
        for identity in self._gallery.values():
            np.savez(
                save_dir / f"{identity.identity_id}.npz",
                embedding=identity.embedding,
                name=identity.name,
                num_samples=identity.num_samples,
            )

    def _load_gallery(self, path: Path) -> None:
        if not path.exists():
            return
        for npz_file in sorted(path.glob("*.npz")):
            data = np.load(npz_file, allow_pickle=True)
            identity_id = npz_file.stem
            self._gallery[identity_id] = FaceIdentity(
                identity_id=identity_id,
                name=str(data["name"]) if "name" in data else identity_id,
                embedding=data["embedding"],
                num_samples=int(data["num_samples"]) if "num_samples" in data else 1,
            )

    def _assign_new_id(self, prefix: str) -> str:
        identity_id = f"{prefix}_{self._next_id}"
        self._next_id += 1
        return identity_id
