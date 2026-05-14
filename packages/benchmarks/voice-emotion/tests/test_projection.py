import unittest

from elizaos_voice_emotion.projection import (
    project_28_to_7,
    project_iemocap_to_7,
    project_meld_to_7,
)


class ProjectionTests(unittest.TestCase):
    def test_iemocap_basic_mappings(self) -> None:
        self.assertEqual(project_iemocap_to_7("ang"), "angry")
        self.assertEqual(project_iemocap_to_7("hap"), "happy")
        self.assertEqual(project_iemocap_to_7("sad"), "sad")
        self.assertEqual(project_iemocap_to_7("neu"), "calm")
        # Unknown label → abstain.
        self.assertIsNone(project_iemocap_to_7("xyz"))

    def test_iemocap_handles_long_form_labels(self) -> None:
        self.assertEqual(project_iemocap_to_7("anger"), "angry")
        self.assertEqual(project_iemocap_to_7("sadness"), "sad")
        self.assertEqual(project_iemocap_to_7("happy"), "happy")
        self.assertEqual(project_iemocap_to_7("Excited"), "excited")  # case
        self.assertEqual(project_iemocap_to_7("frustration"), "angry")

    def test_meld_basic_mappings(self) -> None:
        self.assertEqual(project_meld_to_7("anger"), "angry")
        self.assertEqual(project_meld_to_7("disgust"), "angry")
        self.assertEqual(project_meld_to_7("fear"), "nervous")
        self.assertEqual(project_meld_to_7("joy"), "happy")
        self.assertEqual(project_meld_to_7("neutral"), "calm")
        self.assertEqual(project_meld_to_7("sadness"), "sad")
        self.assertEqual(project_meld_to_7("surprise"), "excited")

    def test_goemotions_canonical_mappings(self) -> None:
        # Canonical Demszky et al. Ekman mappings.
        self.assertEqual(project_28_to_7("admiration"), "happy")
        self.assertEqual(project_28_to_7("anger"), "angry")
        self.assertEqual(project_28_to_7("annoyance"), "angry")
        self.assertEqual(project_28_to_7("disappointment"), "sad")
        self.assertEqual(project_28_to_7("fear"), "nervous")
        self.assertEqual(project_28_to_7("joy"), "happy")
        self.assertEqual(project_28_to_7("surprise"), "excited")
        # Calm-leaning labels.
        self.assertEqual(project_28_to_7("approval"), "calm")
        self.assertEqual(project_28_to_7("relief"), "calm")
        self.assertEqual(project_28_to_7("neutral"), "calm")

    def test_goemotions_unknown_label_abstains(self) -> None:
        self.assertIsNone(project_28_to_7("notARealLabel"))


if __name__ == "__main__":
    unittest.main()
