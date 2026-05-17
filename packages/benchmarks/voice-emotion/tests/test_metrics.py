import unittest

from elizaos_voice_emotion.metrics import (
    EXPRESSIVE_EMOTION_TAGS,
    confusion_matrix,
    macro_f1,
    per_class_f1,
)


class MetricsTests(unittest.TestCase):
    def test_tag_tuple_matches_runtime_adapter(self) -> None:
        # If you change the tag list, also update both the TS adapter
        # (`expressive-tags.ts`) AND `distill_wav2small.py`.
        self.assertEqual(
            EXPRESSIVE_EMOTION_TAGS,
            (
                "happy",
                "sad",
                "angry",
                "nervous",
                "calm",
                "excited",
                "whisper",
            ),
        )

    def test_confusion_matrix_perfect_prediction(self) -> None:
        y_true = list(EXPRESSIVE_EMOTION_TAGS)
        y_pred = list(EXPRESSIVE_EMOTION_TAGS)
        matrix = confusion_matrix(y_true, y_pred)
        n = len(EXPRESSIVE_EMOTION_TAGS)
        for i in range(n):
            for j in range(n):
                self.assertEqual(matrix[i][j], 1 if i == j else 0)

    def test_confusion_matrix_diff_lengths_raises(self) -> None:
        with self.assertRaises(ValueError):
            confusion_matrix(["happy"], ["happy", "sad"])

    def test_per_class_and_macro_f1_perfect(self) -> None:
        y_true = list(EXPRESSIVE_EMOTION_TAGS)
        y_pred = list(EXPRESSIVE_EMOTION_TAGS)
        f1s = per_class_f1(y_true, y_pred)
        for label in EXPRESSIVE_EMOTION_TAGS:
            self.assertEqual(f1s[label], 1.0)
        self.assertEqual(macro_f1(y_true, y_pred), 1.0)

    def test_per_class_f1_handles_zero_predictions(self) -> None:
        y_true = ["happy", "happy", "sad", "sad"]
        y_pred = ["happy", "happy", "happy", "happy"]
        # happy: P=0.5 R=1 F1=0.6666
        # sad:   P=0 R=0 F1=0
        f1s = per_class_f1(y_true, y_pred)
        self.assertAlmostEqual(f1s["happy"], 2 / 3, places=4)
        self.assertEqual(f1s["sad"], 0.0)

    def test_unknown_pred_label_treated_as_abstention(self) -> None:
        # An adapter that returns a label outside the target set is skipped
        # by the confusion matrix (abstention rate is tracked separately).
        matrix = confusion_matrix(
            ["happy", "sad"],
            ["happy", "neutral"],
        )
        # 'neutral' is not in EXPRESSIVE_EMOTION_TAGS; only the first row
        # lands. happy/happy → matrix[0][0] = 1; sad/neutral → skipped.
        n = len(EXPRESSIVE_EMOTION_TAGS)
        self.assertEqual(matrix[0][0], 1)
        for i in range(n):
            for j in range(n):
                if (i, j) == (0, 0):
                    continue
                self.assertEqual(matrix[i][j], 0)


if __name__ == "__main__":
    unittest.main()
