"""Retrieval Evaluator for Context Benchmark.

Evaluates information retrieval accuracy using exact match,
semantic similarity, and fuzzy matching methods.
"""

import difflib
import re
from collections.abc import Callable


class RetrievalEvaluator:
    """Evaluate information retrieval from context."""

    def __init__(
        self,
        embedding_fn: Callable[[str], list[float]] | None = None,
        semantic_threshold: float = 0.8,
    ):
        """Initialize the retrieval evaluator.

        Args:
            embedding_fn: Optional function to generate embeddings for semantic comparison.
            semantic_threshold: Threshold for semantic similarity match (0-1).

        """
        self.embedding_fn = embedding_fn
        self.semantic_threshold = semantic_threshold
        self._embedding_cache: dict[str, list[float]] = {}

    @staticmethod
    def normalize_text(text: str) -> str:
        """Normalize text for comparison."""
        # Convert to lowercase
        text = text.lower()
        # Remove extra whitespace
        text = " ".join(text.split())
        # Remove common punctuation that doesn't affect meaning
        text = re.sub(r"[.,;:!?\"'()\[\]{}]", "", text)
        # Remove common prefixes like "the answer is", "it is", etc.
        prefixes_to_remove = [
            r"^the answer is\s*",
            r"^it is\s*",
            r"^the\s+",
            r"^a\s+",
            r"^an\s+",
        ]
        for prefix in prefixes_to_remove:
            text = re.sub(prefix, "", text, flags=re.IGNORECASE)
        return text.strip()

    def evaluate_exact_match(self, predicted: str, expected: str) -> bool:
        """Check for exact match after normalization.

        Args:
            predicted: The predicted/generated answer.
            expected: The expected/ground truth answer.

        Returns:
            True if texts match after normalization.

        """
        norm_predicted = self.normalize_text(predicted)
        norm_expected = self.normalize_text(expected)
        return norm_predicted == norm_expected

    def evaluate_contains(self, predicted: str, expected: str) -> bool:
        """Check if predicted contains the expected answer.

        Args:
            predicted: The predicted/generated answer.
            expected: The expected/ground truth answer.

        Returns:
            True if normalized expected is contained in normalized predicted.

        """
        norm_predicted = self.normalize_text(predicted)
        norm_expected = self.normalize_text(expected)
        return norm_expected in norm_predicted

    def evaluate_fuzzy_match(
        self,
        predicted: str,
        expected: str,
        threshold: float = 0.85,
    ) -> tuple[bool, float]:
        """Evaluate using fuzzy string matching.

        Args:
            predicted: The predicted/generated answer.
            expected: The expected/ground truth answer.
            threshold: Similarity threshold for match (0-1).

        Returns:
            Tuple of (is_match, similarity_score).

        """
        norm_predicted = self.normalize_text(predicted)
        norm_expected = self.normalize_text(expected)

        # Use SequenceMatcher for fuzzy matching
        similarity = difflib.SequenceMatcher(
            None, norm_predicted, norm_expected
        ).ratio()

        return similarity >= threshold, similarity

    def _get_embedding(self, text: str) -> list[float]:
        """Get embedding for text, using cache if available."""
        if text in self._embedding_cache:
            return self._embedding_cache[text]

        if self.embedding_fn is None:
            raise ValueError("No embedding function provided")

        embedding = self.embedding_fn(text)
        self._embedding_cache[text] = embedding
        return embedding

    @staticmethod
    def _cosine_similarity(vec1: list[float], vec2: list[float]) -> float:
        """Calculate cosine similarity between two vectors."""
        if len(vec1) != len(vec2):
            raise ValueError("Vectors must have same dimension")

        dot_product: float = sum(a * b for a, b in zip(vec1, vec2, strict=True))
        norm1: float = sum(a * a for a in vec1) ** 0.5
        norm2: float = sum(b * b for b in vec2) ** 0.5

        if norm1 == 0 or norm2 == 0:
            return 0.0

        # Cosine similarity is mathematically in [-1, 1]. For benchmark reporting we
        # clamp to [0, 1] so "semantic_similarity" remains a well-behaved score.
        sim = float(dot_product / (norm1 * norm2))
        return max(0.0, min(1.0, sim))

    def evaluate_semantic_similarity(
        self,
        predicted: str,
        expected: str,
    ) -> float:
        """Calculate semantic similarity using embeddings.

        Args:
            predicted: The predicted/generated answer.
            expected: The expected/ground truth answer.

        Returns:
            Semantic similarity score (0-1).

        """
        if self.embedding_fn is None:
            # Fall back to fuzzy matching if no embedding function
            _, similarity = self.evaluate_fuzzy_match(predicted, expected, threshold=0)
            return similarity

        try:
            pred_embedding = self._get_embedding(predicted)
            exp_embedding = self._get_embedding(expected)
            return self._cosine_similarity(pred_embedding, exp_embedding)
        except Exception:
            # Fall back to fuzzy matching on error
            _, similarity = self.evaluate_fuzzy_match(predicted, expected, threshold=0)
            return similarity

    def evaluate_contains_needle(self, response: str, needle: str) -> bool:
        """Check if response contains the needle information.

        This is a more lenient check that looks for key information
        from the needle appearing in the response.

        Args:
            response: The model's response.
            needle: The needle text that was embedded.

        Returns:
            True if the response contains key needle information.

        """
        norm_response = self.normalize_text(response)

        # Extract key content from needle (numbers, names, codes, etc.)
        # Look for patterns that are likely the "answer" portion
        date_words_pattern = (
            r"(?:January|February|March|April|May|June|July|August|"
            r"September|October|November|December)\s+\d{1,2},?\s+\d{4}"
        )
        patterns = [
            r"\$[\d,]+(?:\.\d+)?",  # Money amounts
            r"\d+(?:,\d{3})*(?:\.\d+)?(?:\s*%)?",  # Numbers/percentages
            r"[A-Z][a-z]+\s+[A-Z][a-z]+",  # Names (First Last)
            r"[A-Z]{2,}[\dA-Z]*",  # Codes/IDs
            r"\d{1,2}/\d{1,2}/\d{2,4}",  # Dates (MM/DD/YYYY)
            date_words_pattern,  # Date words
        ]

        for pattern in patterns:
            matches = re.findall(pattern, needle, re.IGNORECASE)
            for match in matches:
                norm_match = self.normalize_text(match)
                if norm_match and norm_match in norm_response:
                    return True

        # Also check if significant words from needle appear
        needle_words = set(self.normalize_text(needle).split())
        response_words = set(norm_response.split())

        # Remove common words
        common_words = {
            "the",
            "a",
            "an",
            "is",
            "are",
            "was",
            "were",
            "be",
            "been",
            "being",
            "have",
            "has",
            "had",
            "do",
            "does",
            "did",
            "will",
            "would",
            "could",
            "should",
            "may",
            "might",
            "must",
            "shall",
            "can",
            "need",
            "dare",
            "ought",
            "used",
            "to",
            "of",
            "in",
            "for",
            "on",
            "with",
            "at",
            "by",
            "from",
            "as",
            "into",
            "through",
            "during",
            "before",
            "after",
            "above",
            "below",
            "between",
            "under",
            "again",
            "further",
            "then",
            "once",
            "and",
            "but",
            "or",
            "nor",
            "so",
            "yet",
            "both",
            "either",
            "neither",
            "not",
            "only",
            "own",
            "same",
            "than",
            "too",
            "very",
            "just",
        }

        significant_needle_words = needle_words - common_words
        significant_overlap = significant_needle_words & response_words

        # If more than 50% of significant words match, consider it a match
        if significant_needle_words:
            overlap_ratio = len(significant_overlap) / len(significant_needle_words)
            return overlap_ratio > 0.5

        return False

    def evaluate(
        self,
        predicted: str,
        expected: str,
        needle: str | None = None,
    ) -> dict[str, bool | float]:
        """Comprehensive evaluation of retrieval.

        Args:
            predicted: The predicted/generated answer.
            expected: The expected/ground truth answer.
            needle: Optional needle text for additional checks.

        Returns:
            Dictionary with evaluation results.

        """
        exact_match = self.evaluate_exact_match(predicted, expected)
        contains = self.evaluate_contains(predicted, expected)
        fuzzy_match, fuzzy_score = self.evaluate_fuzzy_match(predicted, expected)
        semantic_similarity = self.evaluate_semantic_similarity(predicted, expected)

        result: dict[str, bool | float] = {
            "exact_match": exact_match,
            "contains_answer": contains,
            "fuzzy_match": fuzzy_match,
            "fuzzy_score": fuzzy_score,
            "semantic_similarity": semantic_similarity,
            "retrieval_success": exact_match or contains or fuzzy_match,
        }

        if needle:
            result["contains_needle_info"] = self.evaluate_contains_needle(
                predicted, needle
            )

        return result
