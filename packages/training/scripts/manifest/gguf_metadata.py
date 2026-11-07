"""Optional GGUF lineage metadata used during local bundle staging."""

from pathlib import Path


def read_drafter_target_checkpoint_sha256(drafter_path: Path) -> str | None:
    """Read the target text-checkpoint sha256 the drafter was distilled
    against, recorded as a GGUF metadata string by the drafter producer.

    Returns ``None`` for local stand-in drafters (source-converted GGUFs
    have no such key). The publish path treats a missing key as a hard
    error; this staging helper only records what it finds.
    """
    try:
        from gguf import GGUFReader
    except ImportError:
        return None
    try:
        reader = GGUFReader(str(drafter_path), "r")
    except Exception:
        return None
    field = reader.fields.get("mtp-draft.target_checkpoint_sha256")
    if field is None:
        return None
    try:
        return str(field.parts[field.data[0]].tobytes().decode("utf-8"))
    except Exception:
        return None
