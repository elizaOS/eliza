"""Benchmark test suites."""

from .extract import ExtractSuite
from .rank import RankSuite
from .detect import DetectSuite
from .profit import ProfitSuite

ALL_SUITES = [ExtractSuite, RankSuite, DetectSuite, ProfitSuite]

__all__ = ["ExtractSuite", "RankSuite", "DetectSuite", "ProfitSuite", "ALL_SUITES"]
