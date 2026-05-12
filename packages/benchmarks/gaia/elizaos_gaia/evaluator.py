"""
GAIA Answer Evaluator

Evaluates predicted answers against expected answers using GAIA's
normalization and matching rules.
"""

import logging
import re

logger = logging.getLogger(__name__)


class GAIAEvaluator:
    """
    Evaluator for GAIA benchmark answers.

    GAIA uses exact match after normalization. The normalization process:
    1. Lowercase
    2. Remove punctuation (except in numbers)
    3. Normalize numbers (1000 vs 1,000)
    4. Remove articles (a, an, the)
    5. Normalize whitespace
    """

    def __init__(
        self,
        strict_mode: bool = False,
        fuzzy_threshold: float = 0.9,
    ):
        """
        Initialize evaluator.

        Args:
            strict_mode: If True, only exact matches count as correct
            fuzzy_threshold: Similarity threshold for fuzzy matching (0-1)
        """
        self.strict_mode = strict_mode
        self.fuzzy_threshold = fuzzy_threshold

    def evaluate(
        self,
        predicted: str,
        expected: str,
        question_type: str = "factual",
    ) -> tuple[bool, str, str]:
        """
        Evaluate if predicted answer matches expected answer.

        Args:
            predicted: The predicted answer
            expected: The expected (ground truth) answer
            question_type: Type of question (factual, numeric, etc.)

        Returns:
            Tuple of (is_correct, normalized_predicted, normalized_expected)
        """
        # Normalize both answers
        norm_predicted = self.normalize(predicted)
        norm_expected = self.normalize(expected)

        # Exact match after normalization
        if norm_predicted == norm_expected:
            return True, norm_predicted, norm_expected

        # Try numeric comparison if both look like numbers
        numeric_match = self._compare_numeric(norm_predicted, norm_expected)
        if numeric_match:
            return True, norm_predicted, norm_expected

        # Try fuzzy matching if not in strict mode
        if not self.strict_mode:
            # Check if one contains the other
            if norm_expected in norm_predicted or norm_predicted in norm_expected:
                # Only match if the contained string is significant
                shorter = min(len(norm_predicted), len(norm_expected))
                longer = max(len(norm_predicted), len(norm_expected))
                if shorter > 0 and shorter / longer > 0.8:
                    return True, norm_predicted, norm_expected

            # Try Levenshtein distance for very similar answers
            similarity = self._calculate_similarity(norm_predicted, norm_expected)
            if similarity >= self.fuzzy_threshold:
                logger.debug(
                    f"Fuzzy match: '{norm_predicted}' ~ '{norm_expected}' "
                    f"(similarity: {similarity:.2f})"
                )
                return True, norm_predicted, norm_expected

        return False, norm_predicted, norm_expected

    def normalize(self, answer: str) -> str:
        """
        Normalize an answer string.

        Following GAIA normalization rules:
        1. Strip and lowercase
        2. Remove punctuation (preserving in numbers)
        3. Normalize numbers
        4. Remove articles
        5. Normalize whitespace
        """
        if not answer:
            return ""

        text = answer.strip().lower()

        # Remove common prefixes that models add
        prefixes_to_remove = [
            "the answer is",
            "answer:",
            "final answer:",
            "the final answer is",
            "therefore,",
            "thus,",
            "so,",
            "hence,",
        ]
        for prefix in prefixes_to_remove:
            if text.startswith(prefix):
                text = text[len(prefix):].strip()

        # Normalize numbers
        text = self._normalize_numbers(text)

        # Remove articles
        text = re.sub(r"\b(a|an|the)\b", "", text)

        # Remove punctuation except in numbers (keep decimal points, negative signs)
        text = re.sub(r"(?<![0-9])[.,!?;:'\"-](?![0-9])", " ", text)

        # Remove extra punctuation
        text = re.sub(r"[\[\](){}<>]", "", text)

        # Normalize whitespace
        text = " ".join(text.split())

        # Remove trailing punctuation
        text = text.strip(".,;:!?'\"-")

        return text.strip()

    def _normalize_numbers(self, text: str) -> str:
        """Normalize number formats."""
        # Remove currency symbols before numbers
        text = re.sub(r"[$€£¥]\s*(?=\d)", "", text)
        text = re.sub(r"(?<=\d)\s*[$€£¥]", "", text)  # Handle suffix currencies

        # Remove thousands separators: 1,000,000 -> 1000000
        text = re.sub(r"(\d),(\d{3})", r"\1\2", text)
        text = re.sub(r"(\d),(\d{3})", r"\1\2", text)  # Run twice for millions

        # Normalize scientific notation
        def sci_to_float(match):
            try:
                val = float(match.group(0))
                if val.is_integer():
                    return str(int(val))
                return f"{val:.10g}"
            except ValueError:
                return match.group(0)

        text = re.sub(r"\d+\.?\d*[eE][+-]?\d+", sci_to_float, text)

        # Normalize decimal places (trim trailing zeros)
        def normalize_decimal(match):
            val = match.group(0)
            try:
                num = float(val)
                if num.is_integer():
                    return str(int(num))
                # Remove trailing zeros
                return f"{num:.10g}"
            except ValueError:
                return val

        text = re.sub(r"-?\d+\.\d+", normalize_decimal, text)

        # Convert word numbers to digits
        word_to_num = {
            "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4",
            "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
            "ten": "10", "eleven": "11", "twelve": "12", "thirteen": "13",
            "fourteen": "14", "fifteen": "15", "sixteen": "16", "seventeen": "17",
            "eighteen": "18", "nineteen": "19", "twenty": "20",
            "thirty": "30", "forty": "40", "fifty": "50", "sixty": "60",
            "seventy": "70", "eighty": "80", "ninety": "90",
            "hundred": "100", "thousand": "1000", "million": "1000000",
            "billion": "1000000000",
        }

        for word, num in word_to_num.items():
            text = re.sub(rf"\b{word}\b", num, text)

        return text

    def _compare_numeric(
        self,
        predicted: str,
        expected: str,
        tolerance: float = 0.001,
    ) -> bool:
        """Compare two strings as numbers if possible."""
        try:
            # Extract numbers from strings
            pred_nums = re.findall(r"-?\d+\.?\d*", predicted)
            exp_nums = re.findall(r"-?\d+\.?\d*", expected)

            if not pred_nums or not exp_nums:
                return False

            # Compare first number found
            pred_num = float(pred_nums[0])
            exp_num = float(exp_nums[0])

            # Check if they're equal within tolerance
            if exp_num == 0:
                return abs(pred_num) < tolerance

            relative_diff = abs(pred_num - exp_num) / abs(exp_num)
            return relative_diff < tolerance

        except (ValueError, IndexError):
            return False

    def _calculate_similarity(self, s1: str, s2: str) -> float:
        """Calculate Levenshtein similarity ratio."""
        if not s1 or not s2:
            return 0.0 if s1 != s2 else 1.0

        if s1 == s2:
            return 1.0

        # Use Levenshtein distance
        len1, len2 = len(s1), len(s2)

        # Quick check for very different lengths
        if abs(len1 - len2) / max(len1, len2) > (1 - self.fuzzy_threshold):
            return 0.0

        # Calculate Levenshtein distance
        if len1 < len2:
            s1, s2 = s2, s1
            len1, len2 = len2, len1

        if len2 == 0:
            return 0.0

        prev_row = list(range(len2 + 1))

        for i, c1 in enumerate(s1):
            curr_row = [i + 1]
            for j, c2 in enumerate(s2):
                insertions = prev_row[j + 1] + 1
                deletions = curr_row[j] + 1
                substitutions = prev_row[j] + (c1 != c2)
                curr_row.append(min(insertions, deletions, substitutions))
            prev_row = curr_row

        distance = prev_row[len2]
        max_len = max(len1, len2)

        return 1.0 - (distance / max_len)

    def evaluate_batch(
        self,
        predictions: list[str],
        expectations: list[str],
    ) -> tuple[int, int, list[bool]]:
        """
        Evaluate a batch of predictions.

        Args:
            predictions: List of predicted answers
            expectations: List of expected answers

        Returns:
            Tuple of (correct_count, total_count, list of individual results)
        """
        if len(predictions) != len(expectations):
            raise ValueError("Predictions and expectations must have same length")

        results: list[bool] = []
        correct = 0

        for pred, exp in zip(predictions, expectations, strict=False):
            is_correct, _, _ = self.evaluate(pred, exp)
            results.append(is_correct)
            if is_correct:
                correct += 1

        return correct, len(predictions), results

    def get_match_explanation(
        self,
        predicted: str,
        expected: str,
    ) -> str:
        """Get a human-readable explanation of the match result."""
        is_correct, norm_pred, norm_exp = self.evaluate(predicted, expected)

        if is_correct:
            if norm_pred == norm_exp:
                return "Exact match after normalization"

            if self._compare_numeric(norm_pred, norm_exp):
                return "Numeric match"

            similarity = self._calculate_similarity(norm_pred, norm_exp)
            if similarity >= self.fuzzy_threshold:
                return f"Fuzzy match (similarity: {similarity:.2f})"

            if norm_exp in norm_pred or norm_pred in norm_exp:
                return "Substring match"

            return "Match (unknown reason)"
        else:
            return (
                f"No match:\n"
                f"  Predicted (normalized): '{norm_pred}'\n"
                f"  Expected (normalized): '{norm_exp}'"
            )
