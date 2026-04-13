"""Tests for corpus integrity and structure."""

from elizaos_trust_bench.corpus import TEST_CORPUS, get_corpus, TrustTestCase
from elizaos_trust_bench.types import Difficulty, ThreatCategory


class TestCorpusIntegrity:
    """Validate the test corpus has correct structure and no issues."""

    def test_corpus_not_empty(self) -> None:
        """Corpus should have test cases."""
        assert len(TEST_CORPUS) > 0

    def test_corpus_has_at_least_150_cases(self) -> None:
        """We target ~200 cases; enforce at least 150."""
        assert len(TEST_CORPUS) >= 150, (
            f"Corpus should have >= 150 cases, got {len(TEST_CORPUS)}"
        )

    def test_unique_ids(self) -> None:
        """All test case IDs should be unique."""
        ids = [tc.id for tc in TEST_CORPUS]
        assert len(ids) == len(set(ids)), (
            f"Duplicate IDs found: {[x for x in ids if ids.count(x) > 1]}"
        )

    def test_unique_inputs(self) -> None:
        """All inputs should be unique (no duplicate test cases)."""
        inputs = [tc.input for tc in TEST_CORPUS]
        assert len(inputs) == len(set(inputs)), "Duplicate inputs found"

    def test_all_categories_represented(self) -> None:
        """Every ThreatCategory should have at least one test case."""
        categories_present = {tc.category for tc in TEST_CORPUS}
        for cat in ThreatCategory:
            assert cat in categories_present, f"Missing category: {cat.value}"

    def test_all_difficulties_represented(self) -> None:
        """Every difficulty level should have at least one test case."""
        difficulties_present = {tc.difficulty for tc in TEST_CORPUS}
        for diff in Difficulty:
            assert diff in difficulties_present, f"Missing difficulty: {diff.value}"

    def test_malicious_cases_have_expected_type(self) -> None:
        """All malicious test cases should specify an expected_type."""
        for tc in TEST_CORPUS:
            if tc.expected_malicious:
                assert tc.expected_type is not None, (
                    f"Malicious case {tc.id} missing expected_type"
                )

    def test_benign_cases_not_malicious(self) -> None:
        """All benign cases should be expected_malicious=False."""
        benign_cases = [tc for tc in TEST_CORPUS if tc.category == ThreatCategory.BENIGN]
        for tc in benign_cases:
            assert not tc.expected_malicious, (
                f"Benign case {tc.id} should not be expected_malicious"
            )

    def test_impersonation_cases_have_existing_users(self) -> None:
        """Impersonation cases should have existing_users list."""
        imp_cases = [
            tc for tc in TEST_CORPUS
            if tc.category == ThreatCategory.IMPERSONATION
        ]
        for tc in imp_cases:
            assert tc.existing_users is not None and len(tc.existing_users) > 0, (
                f"Impersonation case {tc.id} missing existing_users"
            )

    def test_descriptions_non_empty(self) -> None:
        """All test cases should have a description."""
        for tc in TEST_CORPUS:
            assert tc.description, f"Case {tc.id} has empty description"

    def test_inputs_non_empty(self) -> None:
        """All test cases should have non-empty input."""
        for tc in TEST_CORPUS:
            assert tc.input, f"Case {tc.id} has empty input"


class TestCorpusCategoryDistribution:
    """Verify category distribution is balanced and sufficient."""

    def test_prompt_injection_count(self) -> None:
        cases = [tc for tc in TEST_CORPUS if tc.category == ThreatCategory.PROMPT_INJECTION]
        assert len(cases) >= 20, f"Expected >= 20 injection cases, got {len(cases)}"

    def test_social_engineering_count(self) -> None:
        cases = [tc for tc in TEST_CORPUS if tc.category == ThreatCategory.SOCIAL_ENGINEERING]
        assert len(cases) >= 15, f"Expected >= 15 SE cases, got {len(cases)}"

    def test_impersonation_count(self) -> None:
        cases = [tc for tc in TEST_CORPUS if tc.category == ThreatCategory.IMPERSONATION]
        assert len(cases) >= 10, f"Expected >= 10 impersonation cases, got {len(cases)}"

    def test_credential_theft_count(self) -> None:
        cases = [tc for tc in TEST_CORPUS if tc.category == ThreatCategory.CREDENTIAL_THEFT]
        assert len(cases) >= 10, f"Expected >= 10 cred theft cases, got {len(cases)}"

    def test_privilege_escalation_count(self) -> None:
        cases = [tc for tc in TEST_CORPUS if tc.category == ThreatCategory.PRIVILEGE_ESCALATION]
        assert len(cases) >= 10, f"Expected >= 10 priv esc cases, got {len(cases)}"

    def test_data_exfiltration_count(self) -> None:
        cases = [tc for tc in TEST_CORPUS if tc.category == ThreatCategory.DATA_EXFILTRATION]
        assert len(cases) >= 10, f"Expected >= 10 exfil cases, got {len(cases)}"

    def test_resource_abuse_count(self) -> None:
        cases = [tc for tc in TEST_CORPUS if tc.category == ThreatCategory.RESOURCE_ABUSE]
        assert len(cases) >= 8, f"Expected >= 8 abuse cases, got {len(cases)}"

    def test_content_policy_count(self) -> None:
        cases = [tc for tc in TEST_CORPUS if tc.category == ThreatCategory.CONTENT_POLICY]
        assert len(cases) >= 8, f"Expected >= 8 content policy cases, got {len(cases)}"

    def test_benign_count(self) -> None:
        cases = [tc for tc in TEST_CORPUS if tc.category == ThreatCategory.BENIGN]
        assert len(cases) >= 25, f"Expected >= 25 benign cases, got {len(cases)}"


class TestCorpusFiltering:
    """Test the get_corpus filtering function."""

    def test_filter_by_category(self) -> None:
        injection_only = get_corpus(categories=[ThreatCategory.PROMPT_INJECTION])
        assert all(tc.category == ThreatCategory.PROMPT_INJECTION for tc in injection_only)
        assert len(injection_only) > 0

    def test_filter_by_difficulty(self) -> None:
        easy_only = get_corpus(difficulties=[Difficulty.EASY])
        assert all(tc.difficulty == Difficulty.EASY for tc in easy_only)
        assert len(easy_only) > 0

    def test_filter_by_tags(self) -> None:
        encoding_cases = get_corpus(tags=["encoding"])
        assert len(encoding_cases) > 0
        for tc in encoding_cases:
            assert "encoding" in tc.tags

    def test_combined_filter(self) -> None:
        filtered = get_corpus(
            categories=[ThreatCategory.PROMPT_INJECTION],
            difficulties=[Difficulty.HARD],
        )
        for tc in filtered:
            assert tc.category == ThreatCategory.PROMPT_INJECTION
            assert tc.difficulty == Difficulty.HARD

    def test_no_filter_returns_all(self) -> None:
        all_cases = get_corpus()
        assert len(all_cases) == len(TEST_CORPUS)
