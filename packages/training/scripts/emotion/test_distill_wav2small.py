"""Unit-tests for `distill_wav2small.py`.

These tests run on the CI box without the audeering teacher or any GPU. They
cover the pure-Python contract:

  - provenance dataclass round-trips through JSON,
  - `stage_audio` enumerates `*.wav` from a temp dir and rejects an empty dir,
  - `assert_student_param_budget` allows the in-budget student and refuses an
    out-of-budget one,
  - the CLI arg parser produces stable defaults the operator scripts rely on,
  - the expressive-emotion tag tuple matches the runtime adapter byte-for-byte
    (so the seven-class projection table stays aligned across TS + Python).

The heavy phases (`teacher_pseudo_labels`, `train_student`, `export_student_onnx`)
are explicit `NotImplementedError` until the operator runs the full pipeline
with the corpora staged; that contract is asserted here so a future drift
fails loudly.
"""

from __future__ import annotations

import json
import pathlib
import tempfile
import unittest

from packages.training.scripts.emotion import distill_wav2small as dw


class StageAudioTests(unittest.TestCase):
    def test_rejects_missing_dir(self) -> None:
        with self.assertRaises(FileNotFoundError):
            dw.stage_audio(pathlib.Path("/nonexistent/dir-for-test"))

    def test_rejects_empty_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(RuntimeError):
                dw.stage_audio(pathlib.Path(tmp))

    def test_enumerates_wav_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / "a.wav").touch()
            (root / "b.WAV").touch()  # case
            (root / "c.txt").touch()  # not wav
            sub = root / "sub"
            sub.mkdir()
            (sub / "d.wav").touch()
            clips = dw.stage_audio(root)
            # case-sensitive *.wav matches what soundfile expects later
            self.assertEqual(
                sorted(p.name for p in clips),
                ["a.wav", "d.wav"],
            )


class ProvenanceTests(unittest.TestCase):
    def test_roundtrip(self) -> None:
        prov = dw.StudentProvenance(
            teacher_repo=dw.DEFAULT_TEACHER,
            teacher_revision="abc123",
            teacher_license="CC-BY-NC-SA-4.0",
            student_version="0.1.0",
            corpora=("MSP-Podcast",),
            corpus_sizes={"clips": 100},
            train_val_test_split={"train": 80, "val": 10, "test": 10},
            eval_mse_vad=0.012,
            eval_macro_f1_meld=0.38,
            eval_macro_f1_iemocap=0.62,
            param_count=72_256,
            onnx_sha256="deadbeef",
            onnx_size_bytes=120_000,
            opset=17,
            quantization="int8-dynamic",
            runtime_compatible_versions=("onnxruntime-node@>=1.20",),
            commit="cafe1234",
        )
        parsed = json.loads(prov.to_json())
        self.assertEqual(parsed["teacher_repo"], dw.DEFAULT_TEACHER)
        self.assertEqual(parsed["param_count"], 72_256)
        self.assertEqual(parsed["corpora"], ["MSP-Podcast"])

    def test_write_provenance_creates_parents(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / "nested" / "deeper" / "p.json"
            prov = dw.StudentProvenance(
                teacher_repo=dw.DEFAULT_TEACHER,
                teacher_revision="x",
                teacher_license="CC-BY-NC-SA-4.0",
                student_version="0.0.0",
                corpora=(),
                corpus_sizes={},
                train_val_test_split={},
                eval_mse_vad=0.0,
                eval_macro_f1_meld=0.0,
                eval_macro_f1_iemocap=0.0,
                param_count=0,
                onnx_sha256="",
                onnx_size_bytes=0,
                opset=17,
                quantization="int8-dynamic",
                runtime_compatible_versions=(),
                commit="",
            )
            dw.write_provenance(target, prov)
            self.assertTrue(target.is_file())
            text = target.read_text(encoding="utf-8")
            self.assertIn(dw.DEFAULT_TEACHER, text)


class BudgetTests(unittest.TestCase):
    def test_in_budget_passes(self) -> None:
        class Fake:
            def parameters(self):  # noqa: D401 — match torch.nn.Module API
                # Fake tensors with `.numel()` and `.requires_grad`.
                class T:
                    requires_grad = True

                    def numel(self) -> int:
                        return dw.TARGET_PARAM_COUNT // 2

                return [T(), T()]

        # Two tensors of half-target each → exactly target. Within tolerance.
        dw.assert_student_param_budget(Fake())

    def test_out_of_budget_fails(self) -> None:
        class Fake:
            def parameters(self):
                class T:
                    requires_grad = True

                    def numel(self) -> int:
                        return dw.TARGET_PARAM_COUNT * 4

                return [T()]

        with self.assertRaisesRegex(RuntimeError, "outside target"):
            dw.assert_student_param_budget(Fake())


class HeavyPhasesTests(unittest.TestCase):
    """The heavy phases must raise `NotImplementedError` until the operator
    runs the full pipeline — that's the contract that keeps CI honest.
    """

    def test_teacher_pseudo_labels_real_path_raises(self) -> None:
        with self.assertRaises(NotImplementedError):
            dw.teacher_pseudo_labels(teacher=None, clips=[pathlib.Path("x.wav")])

    def test_teacher_pseudo_labels_empty_clips_returns_empty(self) -> None:
        # No-op when staging incomplete — operator gets a friendly path through.
        self.assertEqual(dw.teacher_pseudo_labels(teacher=None, clips=[]), [])

    def test_train_student_raises(self) -> None:
        with self.assertRaises(NotImplementedError):
            dw.train_student(
                student=None,
                teacher_labels=[],
                epochs=1,
                batch_size=1,
                device="cpu",
            )

    def test_export_onnx_raises(self) -> None:
        with self.assertRaises(NotImplementedError):
            dw.export_student_onnx(
                student=None,
                out_path=pathlib.Path("/tmp/wav2small.onnx"),
            )


class TagSyncTests(unittest.TestCase):
    """The 7-class tuple here must stay byte-equal with the TS adapter's
    `EXPRESSIVE_EMOTION_TAGS`. If you change one, change the other.
    """

    def test_tag_order_locked(self) -> None:
        self.assertEqual(
            dw.EXPRESSIVE_EMOTION_TAGS,
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


class CliTests(unittest.TestCase):
    def test_argparser_defaults_stable(self) -> None:
        parser = dw._build_arg_parser()
        args = parser.parse_args(["--audio-dir", "/tmp/x", "--out", "/tmp/y"])
        self.assertEqual(args.teacher, dw.DEFAULT_TEACHER)
        self.assertEqual(args.epochs, 40)
        self.assertEqual(args.batch_size, 32)
        self.assertEqual(args.export_onnx, "wav2small-msp-dim-int8.onnx")
        self.assertEqual(args.provenance, "wav2small-msp-dim-int8.json")
        self.assertEqual(args.opset, dw.DEFAULT_OPSET)


if __name__ == "__main__":
    unittest.main()
