"""Tests for hybrid search utilities."""

from elizaos.media.search import (
    HybridKeywordResult,
    HybridVectorResult,
    bm25_rank_to_score,
    build_fts_query,
    merge_hybrid_results,
)


class TestBuildFtsQuery:
    def test_simple_query(self):
        result = build_fts_query("hello world")
        assert result == '"hello" AND "world"'

    def test_single_token(self):
        result = build_fts_query("test_function")
        assert result == '"test_function"'

    def test_empty_string(self):
        assert build_fts_query("") is None

    def test_whitespace_only(self):
        assert build_fts_query("   ") is None

    def test_special_characters(self):
        result = build_fts_query("hello! world?")
        assert result == '"hello" AND "world"'


class TestBm25RankToScore:
    def test_zero_rank(self):
        score = bm25_rank_to_score(0.0)
        assert abs(score - 1.0) < 0.001

    def test_one_rank(self):
        score = bm25_rank_to_score(1.0)
        assert abs(score - 0.5) < 0.001

    def test_infinite_rank(self):
        score = bm25_rank_to_score(float("inf"))
        assert score < 0.01

    def test_negative_rank(self):
        # Negative ranks should be clamped to 0
        score = bm25_rank_to_score(-5.0)
        assert abs(score - 1.0) < 0.001


class TestMergeHybridResults:
    def test_merge_single_result(self):
        vector = [
            HybridVectorResult(
                id="a",
                path="file.py",
                start_line=1,
                end_line=10,
                source="test",
                snippet="hello",
                vector_score=0.8,
            )
        ]

        keyword = [
            HybridKeywordResult(
                id="a",
                path="file.py",
                start_line=1,
                end_line=10,
                source="test",
                snippet="hello world",
                text_score=0.6,
            )
        ]

        merged = merge_hybrid_results(vector, keyword, 0.7, 0.3)

        assert len(merged) == 1
        expected_score = 0.7 * 0.8 + 0.3 * 0.6
        assert abs(merged[0].score - expected_score) < 0.001
        # Keyword snippet should be preferred
        assert merged[0].snippet == "hello world"

    def test_merge_disjoint_results(self):
        vector = [
            HybridVectorResult(
                id="a",
                path="file1.py",
                start_line=1,
                end_line=10,
                source="test",
                snippet="first",
                vector_score=0.9,
            )
        ]

        keyword = [
            HybridKeywordResult(
                id="b",
                path="file2.py",
                start_line=20,
                end_line=30,
                source="test",
                snippet="second",
                text_score=0.7,
            )
        ]

        merged = merge_hybrid_results(vector, keyword, 0.7, 0.3)

        assert len(merged) == 2
        # Results should be sorted by score descending
        assert merged[0].score >= merged[1].score

    def test_empty_inputs(self):
        merged = merge_hybrid_results([], [], 0.7, 0.3)
        assert len(merged) == 0

    def test_vector_only(self):
        vector = [
            HybridVectorResult(
                id="a",
                path="file.py",
                start_line=1,
                end_line=10,
                source="test",
                snippet="hello",
                vector_score=0.8,
            )
        ]

        merged = merge_hybrid_results(vector, [], 0.7, 0.3)

        assert len(merged) == 1
        expected_score = 0.7 * 0.8
        assert abs(merged[0].score - expected_score) < 0.001

    def test_keyword_only(self):
        keyword = [
            HybridKeywordResult(
                id="a",
                path="file.py",
                start_line=1,
                end_line=10,
                source="test",
                snippet="hello",
                text_score=0.6,
            )
        ]

        merged = merge_hybrid_results([], keyword, 0.7, 0.3)

        assert len(merged) == 1
        expected_score = 0.3 * 0.6
        assert abs(merged[0].score - expected_score) < 0.001
