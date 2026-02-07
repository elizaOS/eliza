"""
Media utilities for Eliza.

Provides MIME type detection, media parsing, format utilities, and hybrid search.
"""

from .mime import (
    MediaKind,
    detect_mime,
    extension_for_mime,
    get_file_extension,
    image_mime_from_format,
    is_audio_filename,
    is_gif_media,
    is_voice_compatible_audio,
    media_kind_from_mime,
)
from .search import (
    HybridKeywordResult,
    HybridMergedResult,
    HybridVectorResult,
    bm25_rank_to_score,
    build_fts_query,
    merge_hybrid_results,
)

__all__ = [
    # MIME utilities
    "MediaKind",
    "detect_mime",
    "extension_for_mime",
    "get_file_extension",
    "image_mime_from_format",
    "is_audio_filename",
    "is_gif_media",
    "is_voice_compatible_audio",
    "media_kind_from_mime",
    # Hybrid search utilities
    "HybridKeywordResult",
    "HybridMergedResult",
    "HybridVectorResult",
    "bm25_rank_to_score",
    "build_fts_query",
    "merge_hybrid_results",
]
