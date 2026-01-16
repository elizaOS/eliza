"""
Mind2Web Benchmark for ElizaOS

Web agent benchmark based on OSU-NLP-Group/Mind2Web dataset.
Evaluates agents on real-world web navigation and interaction tasks.
"""

from benchmarks.mind2web.types import (
    Mind2WebAction,
    Mind2WebConfig,
    Mind2WebOperation,
    Mind2WebResult,
    Mind2WebTask,
)

__all__ = [
    "Mind2WebAction",
    "Mind2WebConfig",
    "Mind2WebOperation",
    "Mind2WebResult",
    "Mind2WebTask",
]
