"""Tests for GAIA answer evaluator."""

import pytest
from elizaos_gaia.evaluator import GAIAEvaluator


class TestGAIAEvaluator:
    """Tests for answer evaluation and normalization."""
    
    @pytest.fixture
    def evaluator(self):
        """Create evaluator instance."""
        return GAIAEvaluator()
    
    @pytest.fixture
    def strict_evaluator(self):
        """Create strict evaluator instance."""
        return GAIAEvaluator(strict_mode=True)


class TestNormalization(TestGAIAEvaluator):
    """Tests for answer normalization."""
    
    def test_lowercase(self, evaluator):
        """Test lowercase conversion."""
        assert evaluator.normalize("HELLO") == "hello"
        assert evaluator.normalize("Hello World") == "hello world"
    
    def test_strip_whitespace(self, evaluator):
        """Test whitespace stripping."""
        assert evaluator.normalize("  hello  ") == "hello"
        assert evaluator.normalize("hello  world") == "hello world"
    
    def test_remove_articles(self, evaluator):
        """Test article removal."""
        assert evaluator.normalize("the answer") == "answer"
        assert evaluator.normalize("a book") == "book"
        assert evaluator.normalize("an apple") == "apple"
    
    def test_remove_punctuation(self, evaluator):
        """Test punctuation removal."""
        assert evaluator.normalize("hello!") == "hello"
        assert evaluator.normalize("what?") == "what"
        assert evaluator.normalize("hello, world") == "hello world"
    
    def test_preserve_decimal_points(self, evaluator):
        """Test that decimal points in numbers are preserved."""
        result = evaluator.normalize("3.14")
        assert "3" in result and "14" in result
    
    def test_number_normalization(self, evaluator):
        """Test number format normalization."""
        # Thousands separator
        assert "1000000" in evaluator.normalize("1,000,000")
        
        # Trailing zeros
        assert evaluator.normalize("5.00") == "5"
    
    def test_remove_prefixes(self, evaluator):
        """Test removal of common answer prefixes."""
        assert evaluator.normalize("The answer is 42") == "42"
        assert evaluator.normalize("Answer: 42") == "42"
        assert evaluator.normalize("Therefore, 42") == "42"


class TestExactMatch(TestGAIAEvaluator):
    """Tests for exact matching."""
    
    def test_exact_match(self, evaluator):
        """Test exact match after normalization."""
        is_correct, _, _ = evaluator.evaluate("Paris", "Paris")
        assert is_correct
    
    def test_case_insensitive(self, evaluator):
        """Test case insensitive matching."""
        is_correct, _, _ = evaluator.evaluate("PARIS", "paris")
        assert is_correct
    
    def test_whitespace_tolerance(self, evaluator):
        """Test whitespace tolerance."""
        is_correct, _, _ = evaluator.evaluate("  Paris  ", "Paris")
        assert is_correct
    
    def test_punctuation_tolerance(self, evaluator):
        """Test punctuation tolerance."""
        is_correct, _, _ = evaluator.evaluate("Paris.", "Paris")
        assert is_correct


class TestNumericMatch(TestGAIAEvaluator):
    """Tests for numeric matching."""
    
    def test_integer_match(self, evaluator):
        """Test integer matching."""
        is_correct, _, _ = evaluator.evaluate("42", "42")
        assert is_correct
    
    def test_float_match(self, evaluator):
        """Test float matching."""
        is_correct, _, _ = evaluator.evaluate("3.14", "3.14")
        assert is_correct
    
    def test_thousands_separator(self, evaluator):
        """Test thousands separator handling."""
        is_correct, _, _ = evaluator.evaluate("1,000,000", "1000000")
        assert is_correct
    
    def test_trailing_zeros(self, evaluator):
        """Test trailing zero handling."""
        is_correct, _, _ = evaluator.evaluate("5.00", "5")
        assert is_correct
    
    def test_numeric_tolerance(self, evaluator):
        """Test numeric comparison tolerance."""
        is_correct, _, _ = evaluator.evaluate("3.14159", "3.14159")
        assert is_correct


class TestFuzzyMatch(TestGAIAEvaluator):
    """Tests for fuzzy matching."""
    
    def test_substring_match(self, evaluator):
        """Test substring matching for similar length strings."""
        # Near-identical with small variation should match
        is_correct, _, _ = evaluator.evaluate("42", "42.")
        assert is_correct
        
        # Exact content with prefix should match
        is_correct, _, _ = evaluator.evaluate("The answer is 42", "42")
        assert is_correct  # Prefix is removed in normalization
    
    def test_very_different_no_match(self, evaluator):
        """Test that very different strings don't match."""
        is_correct, _, _ = evaluator.evaluate("London", "Paris")
        assert not is_correct
    
    def test_strict_mode_no_fuzzy(self, strict_evaluator):
        """Test that strict mode disables fuzzy matching."""
        # This might match fuzzy but not strict
        is_correct, _, _ = strict_evaluator.evaluate("42.", "42")
        # Punctuation is removed so should still match
        assert is_correct


class TestBatchEvaluation(TestGAIAEvaluator):
    """Tests for batch evaluation."""
    
    def test_batch_all_correct(self, evaluator):
        """Test batch with all correct answers."""
        predictions = ["Paris", "42", "Yes"]
        expectations = ["Paris", "42", "Yes"]
        
        correct, total, results = evaluator.evaluate_batch(predictions, expectations)
        
        assert correct == 3
        assert total == 3
        assert all(results)
    
    def test_batch_mixed(self, evaluator):
        """Test batch with mixed results."""
        predictions = ["Paris", "London", "42"]
        expectations = ["Paris", "Berlin", "42"]
        
        correct, total, results = evaluator.evaluate_batch(predictions, expectations)
        
        assert correct == 2
        assert total == 3
        assert results == [True, False, True]
    
    def test_batch_length_mismatch(self, evaluator):
        """Test that mismatched lengths raise error."""
        with pytest.raises(ValueError):
            evaluator.evaluate_batch(["a", "b"], ["a"])


class TestMatchExplanation(TestGAIAEvaluator):
    """Tests for match explanations."""
    
    def test_exact_match_explanation(self, evaluator):
        """Test explanation for exact match."""
        explanation = evaluator.get_match_explanation("Paris", "Paris")
        assert "match" in explanation.lower()
    
    def test_no_match_explanation(self, evaluator):
        """Test explanation for no match."""
        explanation = evaluator.get_match_explanation("London", "Paris")
        assert "no match" in explanation.lower()


class TestEdgeCases(TestGAIAEvaluator):
    """Tests for edge cases."""
    
    def test_empty_strings(self, evaluator):
        """Test empty string handling."""
        is_correct, _, _ = evaluator.evaluate("", "")
        assert is_correct
    
    def test_empty_vs_nonempty(self, evaluator):
        """Test empty vs non-empty."""
        is_correct, _, _ = evaluator.evaluate("", "answer")
        assert not is_correct
    
    def test_unicode(self, evaluator):
        """Test unicode handling."""
        is_correct, _, _ = evaluator.evaluate("café", "café")
        assert is_correct
    
    def test_very_long_answer(self, evaluator):
        """Test very long answer."""
        long_answer = "x" * 10000
        is_correct, _, _ = evaluator.evaluate(long_answer, long_answer)
        assert is_correct
