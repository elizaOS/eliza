import unittest

from elizaos_voice_emotion.runner import (
    BenchOutput,
    BenchUnavailable,
    run_fidelity,
    run_intrinsic,
    run_text_intrinsic,
)


class RunnerSmokeTests(unittest.TestCase):
    def test_intrinsic_fixture_smoke_round_trips(self) -> None:
        out = run_intrinsic(suite="fixture", model="wav2small-msp-dim-int8")
        self.assertEqual(out.suite, "fixture")
        self.assertEqual(out.macro_f1, 1.0)
        # Fixture is symmetric — 2 samples per class, perfect prediction.
        self.assertEqual(out.n, 14)
        d = out.as_dict()
        self.assertEqual(d["schemaVersion"], 1)
        self.assertIn("perClassF1", d)
        self.assertIn("confusion", d)
        self.assertIn("meanLatencyMs", d)
        for label, f1 in d["perClassF1"].items():
            self.assertEqual(f1, 1.0, f"per-class F1 for {label} not 1.0")

    def test_text_intrinsic_fixture_smoke(self) -> None:
        out = run_text_intrinsic(suite="fixture", model="stage1-lm")
        self.assertEqual(out.suite, "fixture")
        self.assertEqual(out.macro_f1, 1.0)

    def test_real_suites_raise_bench_unavailable(self) -> None:
        for suite in ("iemocap", "meld", "msp_podcast"):
            with self.assertRaises(BenchUnavailable):
                run_intrinsic(suite=suite, model="wav2small-msp-dim-int8")

    def test_fidelity_raises_until_operator_runs_duet(self) -> None:
        with self.assertRaises(BenchUnavailable):
            run_fidelity(
                duet_host="http://localhost:31337",
                emotions=("happy", "sad"),
                rounds=1,
            )

    def test_text_intrinsic_goemotions_raises_until_corpus_staged(self) -> None:
        with self.assertRaises(BenchUnavailable):
            run_text_intrinsic(suite="goemotions", model="stage1-lm")


class BenchOutputDataclassTests(unittest.TestCase):
    def test_as_dict_default_notes_is_empty_list(self) -> None:
        out = BenchOutput(
            schema_version=1,
            suite="fixture",
            model="x",
            macro_f1=0.0,
            per_class_f1={},
            confusion=[],
            mean_latency_ms=0.0,
            n=0,
            run_started_at="2026-05-14T00:00:00Z",
        )
        self.assertEqual(out.as_dict()["notes"], [])


if __name__ == "__main__":
    unittest.main()
