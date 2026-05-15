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
    """The heavy phases are now implemented. They still require torch +
    onnxruntime + a teacher checkpoint for the full run, but the contracts
    below are enforced in pure Python: empty inputs no-op, missing teachers
    fail loudly with the license-checked path, and the export rejects bad
    output paths before touching ONNX.
    """

    def test_teacher_pseudo_labels_empty_clips_returns_empty(self) -> None:
        # No-op when staging incomplete — operator gets a friendly path through.
        self.assertEqual(dw.teacher_pseudo_labels(teacher=None, clips=[]), [])

    def test_teacher_pseudo_labels_rejects_unlicensed_teacher(self) -> None:
        """Passing a non-dict teacher (i.e. bypassing the license-checked
        loader) must fail loudly — the audeering license guard runs inside
        `load_teacher`, and `teacher_pseudo_labels` re-checks the shape so
        operators can't sneak past the guard.
        """
        with self.assertRaisesRegex(RuntimeError, "load_teacher"):
            dw.teacher_pseudo_labels(
                teacher=None, clips=[pathlib.Path("/tmp/missing.wav")],
            )
        with self.assertRaisesRegex(RuntimeError, "license check"):
            dw.teacher_pseudo_labels(
                teacher={"foo": "bar"},  # missing model/processor
                clips=[pathlib.Path("/tmp/missing.wav")],
            )

    def test_train_student_rejects_empty_labels(self) -> None:
        """No labels means no-op — operator should be told loudly to
        run `teacher_pseudo_labels` first."""
        with self.assertRaisesRegex(RuntimeError, "empty teacher_labels"):
            dw.train_student(
                student=None,
                teacher_labels=[],
                epochs=1,
                batch_size=1,
                device="cpu",
            )

    def test_export_onnx_rejects_non_onnx_suffix(self) -> None:
        """Suffix is part of the contract — the operator publish script
        expects `<run-dir>/wav2small-int8.onnx`."""
        with self.assertRaisesRegex(ValueError, "must end in"):
            dw.export_student_onnx(
                student=None,
                out_path=pathlib.Path("/tmp/wav2small.pt"),
            )

    def test_macro_f1_empty_returns_zero(self) -> None:
        """Helper: macro F1 of empty predictions is 0.0, not NaN."""
        self.assertEqual(dw._macro_f1([], [], num_classes=7), 0.0)

    def test_macro_f1_perfect(self) -> None:
        self.assertAlmostEqual(
            dw._macro_f1([0, 1, 2], [0, 1, 2], num_classes=7),
            3 / 7,  # 3 perfect classes out of 7 averaged
        )

    def test_slice_windows_pads_short_clip(self) -> None:
        """A clip shorter than one window is zero-padded to exactly one
        window — never dropped. Operators training on short MELD clips
        need every clip to produce ≥1 row."""
        import numpy as np

        short_pcm = np.zeros(int(2.0 * dw.WAV2SMALL_SAMPLE_RATE), dtype="float32")
        windows = dw._slice_windows(
            short_pcm, dw.TEACHER_WINDOW_SECONDS, dw.TEACHER_HOP_SECONDS,
        )
        self.assertEqual(len(windows), 1)
        self.assertEqual(
            windows[0].shape[0],
            int(dw.TEACHER_WINDOW_SECONDS * dw.WAV2SMALL_SAMPLE_RATE),
        )

    def test_slice_windows_strides_long_clip(self) -> None:
        """A clip ≫ window emits multiple striped windows."""
        import numpy as np

        long_pcm = np.zeros(int(20.0 * dw.WAV2SMALL_SAMPLE_RATE), dtype="float32")
        windows = dw._slice_windows(long_pcm, 8.0, 4.0)
        # 20-second clip with 8s window / 4s hop → starts at 0,4,8,12 then
        # a tail-padded window at 16. = 5 windows.
        self.assertEqual(len(windows), 5)

    def test_provenance_extracts_corpus_split(self) -> None:
        prov = dw._provenance_from_clip(
            pathlib.Path("/data/MSP-Podcast/train/clip-001.wav"),
        )
        self.assertEqual(prov["corpus"], "MSP-Podcast")
        self.assertEqual(prov["split"], "train")
        self.assertEqual(prov["clip_id"], "clip-001")

    def test_provenance_truly_bare_is_unknown(self) -> None:
        # A bare filename (no parents) has both corpus and split set to
        # "unknown" so the run is still well-formed.
        prov = dw._provenance_from_clip(pathlib.Path("clip.wav"))
        self.assertEqual(prov["corpus"], "unknown")
        self.assertEqual(prov["split"], "unknown")
        self.assertEqual(prov["clip_id"], "clip")


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
