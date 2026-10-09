"""Transcript selection must honor the same privacy rules as other training data."""
from eliza_training.voice.eot.prep_eot_corpus import _PrivacyFilter


def test_eot_rejects_transcripts_requiring_redaction():
    allowed = _PrivacyFilter()
    assert allowed("Please explain how to train the model.")
    assert not allowed("My email is person@example.com.")
    assert not allowed("The key is sk-ant-" + "a" * 64)
