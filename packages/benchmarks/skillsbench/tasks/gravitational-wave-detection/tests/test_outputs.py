"""
Test suite for gravitational wave detection task.
Verifies that the agent's output matches expected format and results.
"""

from pathlib import Path
from typing import ClassVar

import pandas as pd
import pytest

# Path to agent output
OUTPUT_FILE = Path("/root/detection_results.csv")
EXPECTED_FILE = Path("/tests/expected_results.csv")


class TestGravitationalWaveDetection:
    """Test cases for gravitational wave detection output."""

    # Tolerances for matching expected results
    SNR_TOLERANCE = 0.25  # Allow small differences in SNR due to numerical precision
    TOTAL_MASS_TOLERANCE = 0.1  # Allow small differences in total mass due to numerical precision

    # Grid search parameters (from instruction)
    EXPECTED_APPROXIMANTS: ClassVar[set[str]] = {"SEOBNRv4_opt", "IMRPhenomD", "TaylorT4"}
    MASS_MIN = 10
    MASS_MAX = 40
    # Expected total combinations: 3 approximants x sum(1 to 31) = 3 x 496 = 1488
    # where sum(1 to 31) = 31x32/2 = 496 (mass combinations with m1 >= m2)
    EXPECTED_TOTAL_COMBINATIONS = 1488

    def test_output_file_exists(self):
        """Verify that the output file exists."""
        assert OUTPUT_FILE.exists(), f"Output file {OUTPUT_FILE} not found"

    def test_output_format(self, agent_output):
        """Verify the output CSV has correct columns."""
        required_columns = ["approximant", "snr", "total_mass"]
        assert all(col in agent_output.columns for col in required_columns), f"Missing required columns. Found: {list(agent_output.columns)}"

    def test_output_types(self, agent_output):
        """Verify column data types are correct."""
        assert pd.api.types.is_string_dtype(agent_output["approximant"]), "approximant must be string"
        assert pd.api.types.is_numeric_dtype(agent_output["snr"]), "snr must be numeric"
        assert pd.api.types.is_numeric_dtype(agent_output["total_mass"]), "total_mass must be numeric"

    def test_row_count(self, agent_output):
        """Verify output contains exactly one row per approximant (best result for each)."""
        # Must have exactly one row per approximant (all 3 approximants required)
        assert len(agent_output) == len(
            self.EXPECTED_APPROXIMANTS
        ), f"Output must contain exactly {len(self.EXPECTED_APPROXIMANTS)} rows (one per approximant), found {len(agent_output)}"

    def test_snr_range(self, agent_output):
        """Verify SNR is in reasonable range."""
        if len(agent_output) > 0 and agent_output["snr"].notna().any():
            snr = agent_output["snr"].dropna()
            assert (snr >= 0).all(), "SNR must be non-negative"

    def test_total_mass_values(self, agent_output):
        """Verify total mass values are reasonable."""
        if len(agent_output) > 0 and agent_output["total_mass"].notna().any():
            total_masses = agent_output["total_mass"].dropna()
            assert (total_masses > 0).all(), "total_mass must be positive"
            # Verify total mass is in reasonable range (for m1, m2 from 10-40, total mass should be 20-80)
            assert (total_masses >= 20).all(), "total_mass seems too small for the grid search range"
            assert (total_masses <= 80).all(), "total_mass seems too large for the grid search range"

    def test_all_approximants_tested(self, agent_output):
        """
        Verify that all required approximants were tested.

        The output must contain the best result for each of the three required approximants:
        SEOBNRv4_opt, IMRPhenomD, and TaylorT4.
        """
        if len(agent_output) == 0:
            pytest.fail("Agent output is empty - no approximants were tested")

        # Get unique approximants in output
        output_approximants = set(agent_output["approximant"].dropna().unique())

        # Verify all required approximants are present
        missing_approximants = self.EXPECTED_APPROXIMANTS - output_approximants
        assert (
            len(missing_approximants) == 0
        ), f"Missing required approximants: {missing_approximants}. Expected all of: {self.EXPECTED_APPROXIMANTS}"

        # Verify all approximants in output are valid
        invalid_approximants = output_approximants - self.EXPECTED_APPROXIMANTS
        assert (
            len(invalid_approximants) == 0
        ), f"Invalid approximants found: {invalid_approximants}. Expected one of: {self.EXPECTED_APPROXIMANTS}"

        # Verify no duplicate approximants (should have exactly one row per approximant)
        approximant_counts = agent_output["approximant"].value_counts()
        duplicates = approximant_counts[approximant_counts > 1]
        assert len(duplicates) == 0, f"Duplicate approximants found: {duplicates.to_dict()}. Should have exactly one row per approximant."

        # Verify we have exactly 3 rows (one for each approximant)
        assert len(agent_output) == len(
            self.EXPECTED_APPROXIMANTS
        ), f"Expected exactly {len(self.EXPECTED_APPROXIMANTS)} rows (one per approximant), got {len(agent_output)}"

    def test_result_satisfies_grid_search_constraints(self, agent_output):
        """
        Verify that all results satisfy the grid search constraints.

        The instruction requires testing all combinations of:
        - Approximants: "SEOBNRv4_opt", "IMRPhenomD"
        - Mass parameters: m1, m2 from 10 to 40 solar masses (integer steps), where m1 >= m2

        This test verifies each result came from the correct grid search space.
        Since we only output total_mass, we verify that approximant and SNR are valid.

        The instruction requires testing all combinations of:
        - Approximants: "SEOBNRv4_opt", "IMRPhenomD", "TaylorT4"
        - Mass parameters: m1, m2 from 10 to 40 solar masses (integer steps), where m1 >= m2
        """
        if len(agent_output) == 0:
            pytest.fail("Agent output is empty")

        # Verify constraints for each row
        for idx, agent_row in agent_output.iterrows():
            # Verify approximant is one of the required ones
            assert (
                agent_row["approximant"] in self.EXPECTED_APPROXIMANTS
            ), f"Row {idx}: Approximant '{agent_row['approximant']}' is not one of the required approximants: {self.EXPECTED_APPROXIMANTS}"

            # Verify SNR is reasonable
            snr = agent_row["snr"]
            assert pd.notna(snr), f"Row {idx}: SNR must not be null"
            assert snr > 0, f"Row {idx}: SNR must be positive, got {snr}"

            # Verify total_mass is reasonable
            total_mass = agent_row["total_mass"]
            assert pd.notna(total_mass), f"Row {idx}: total_mass must not be null"
            assert total_mass > 0, f"Row {idx}: total_mass must be positive, got {total_mass}"

    def test_matches_expected_result(self, agent_output, expected_result):
        """
        Test that the agent's results match the expected results within tolerance.

        For each approximant in the expected results, verify that the agent's result
        for that approximant matches within tolerance.
        """
        if len(agent_output) == 0:
            pytest.fail("Agent output is empty")

        # Create a lookup dictionary for agent results by approximant
        agent_results = {}
        for _, row in agent_output.iterrows():
            approx = row["approximant"]
            if pd.notna(approx):
                agent_results[approx] = row

        # Check each expected result
        missing_approximants = []
        mismatches = []

        for _, expected_row in expected_result.iterrows():
            expected_approx = expected_row["approximant"]

            if expected_approx not in agent_results:
                # All approximants are required - fail if any are missing
                missing_approximants.append(f"{expected_approx}: Missing from agent output")
                continue

            agent_row = agent_results[expected_approx]

            # Tolerance-based match on SNR and total_mass
            snr_diff = abs(agent_row["snr"] - expected_row["snr"])
            if snr_diff > self.SNR_TOLERANCE:
                mismatches.append(
                    f"{expected_approx}: SNR got {agent_row['snr']:.4f} expected {expected_row['snr']:.4f}, "
                    f"diff={snr_diff:.4f} > tolerance={self.SNR_TOLERANCE}"
                )
                continue

            total_mass_diff = abs(agent_row["total_mass"] - expected_row["total_mass"])
            if total_mass_diff > self.TOTAL_MASS_TOLERANCE:
                mismatches.append(
                    f"{expected_approx}: total_mass got {agent_row['total_mass']:.1f} expected {expected_row['total_mass']:.1f}, "
                    f"diff={total_mass_diff:.1f} > tolerance={self.TOTAL_MASS_TOLERANCE}"
                )
                continue

        # Report any missing approximants
        if missing_approximants:
            pytest.fail("Missing approximants:\n" + "\n".join(missing_approximants))

        # Report any mismatches
        if mismatches:
            pytest.fail("Result mismatches found:\n" + "\n".join(mismatches))

        # Verify all expected approximants were found
        if len(agent_results) != len(expected_result):
            pytest.fail(f"Expected {len(expected_result)} approximants, but only found {len(agent_results)}")

    @pytest.fixture
    def agent_output(self):
        """Load and return the agent's output."""
        if not OUTPUT_FILE.exists():
            pytest.skip(f"Output file {OUTPUT_FILE} does not exist")

        try:
            df = pd.read_csv(OUTPUT_FILE)
            return df
        except Exception as e:
            pytest.fail(f"Failed to read output file: {e}")

    @pytest.fixture
    def expected_result(self):
        """Load and return the expected result."""
        if not EXPECTED_FILE.exists():
            pytest.skip(f"Expected file {EXPECTED_FILE} does not exist")

        try:
            df = pd.read_csv(EXPECTED_FILE)
            return df
        except Exception as e:
            pytest.fail(f"Failed to read expected file: {e}")
