from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List


def load_embedding_cache(path: Path) -> Dict[str, List[float]]:
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        return {}
    out: Dict[str, List[float]] = {}
    for key, val in raw.items():
        if isinstance(key, str) and isinstance(val, list) and all(isinstance(x, (int, float)) for x in val):
            out[key] = [float(x) for x in val]
    return out


def save_embedding_cache(path: Path, embeddings: Dict[str, List[float]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(embeddings, indent=2) + "\n", encoding="utf-8")


def get_embedding(text: str, model: str) -> List[float]:
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise ImportError("openai package not installed. Run: pip install openai") from exc
    client = OpenAI()
    resp = client.embeddings.create(model=model, input=text)
    data = resp.data
    if not data:
        raise ValueError("Empty embedding response")
    vec = data[0].embedding
    return [float(x) for x in vec]
