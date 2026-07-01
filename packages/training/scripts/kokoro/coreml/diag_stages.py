#!/usr/bin/env python3
"""Localize the CoreML Kokoro vocoder divergence by converting WITH intermediate
outputs (F0_pred, har_source) and comparing CoreML-vs-torch per stage.

- F0_pred matches, har_source diverges  -> SineGen F.interpolate(phase) is the culprit
- F0_pred diverges                       -> F0Ntrain (masked LSTM / AdaIN)
- both match, audio diverges             -> iSTFT / decoder convs
"""
import json
from pathlib import Path
import numpy as np
import torch
import export_e2e_coreml as E

ROOT = E.REF
OUT = Path("/tmp/kokoro-coreml-work/out")
BUCKET = 160

def reg_ops():
    from coremltools.converters.mil.frontend.torch.ops import _get_inputs, logical_and as _la  # noqa
    from coremltools.converters.mil.frontend.torch.torch_op_registry import register_torch_op, _TORCH_OPS_REGISTRY
    from coremltools.converters.mil import Builder as mb
    if "new_ones" not in _TORCH_OPS_REGISTRY.name_to_func_mapping:
        @register_torch_op
        def new_ones(context, node):
            inputs = _get_inputs(context, node)
            shape = inputs[1]
            if isinstance(shape, list):
                shape = mb.concat(values=shape, axis=0)
            shape = mb.cast(x=shape, dtype="int32")
            context.add(mb.fill(shape=shape, value=1.0, name=node.name))
    @register_torch_op(torch_alias=["and"], override=True)
    def bitwise_and(context, node):
        a, b = _get_inputs(context, node, expected=2)
        a = mb.cast(x=a, dtype="bool")
        b = mb.cast(x=b, dtype="bool")
        context.add(mb.logical_and(x=a, y=b, name=node.name))

def main():
    import coremltools as ct
    vocab = json.loads((OUT / "kokoro-coreml/vocab_index.json").read_text())["vocab"]
    voice = json.loads((OUT / "kokoro-coreml/voices/af_heart.json").read_text())["embedding"]
    ps = "həlˈoʊ, ðɪs ɪz ɪlˈaɪzə spˈiːkɪŋ ɑn dəvˈaɪs."
    ids = [0] + [vocab[c] for c in ps if c in vocab] + [0]
    n = len(ids)
    ids = ids + [0] * (128 - n)
    ids_t = torch.tensor([ids], dtype=torch.int32)
    mask = torch.zeros(1, 128, dtype=torch.int32)
    mask[0, :n] = 1
    ref_s = torch.tensor(voice, dtype=torch.float32).view(1, 256)
    phases = torch.rand(1, 9, generator=torch.Generator().manual_seed(7), dtype=torch.float32)
    speed = torch.tensor([1.0], dtype=torch.float32)

    m = E.load_model()
    e2e = E.KokoroE2E(m, BUCKET).eval()
    for mod in e2e.modules():
        mod.eval()
    e2e._diag = True
    with torch.no_grad():
        a_t, alen_t, pdur_t, f0_t, har_t = e2e(ids_t, mask, ref_s, phases, speed)
    print(f"[torch] audio={tuple(a_t.shape)} F0={tuple(f0_t.shape)} har={tuple(har_t.shape)}")

    reg_ops()
    with torch.no_grad():
        traced = torch.jit.trace(e2e, (ids_t, mask, ref_s, phases, speed), strict=False, check_trace=False)
    ml = ct.convert(
        traced,
        inputs=[
            ct.TensorType(name="input_ids", shape=(1, 128), dtype=np.int32),
            ct.TensorType(name="attention_mask", shape=(1, 128), dtype=np.int32),
            ct.TensorType(name="ref_s", shape=(1, 256), dtype=np.float32),
            ct.TensorType(name="random_phases", shape=(1, 9), dtype=np.float32),
            ct.TensorType(name="speed", shape=(1,), dtype=np.float32),
        ],
        outputs=[ct.TensorType(name=k) for k in ("audio", "audio_length_samples", "pred_dur", "F0_pred", "har_source")],
        convert_to="mlprogram", minimum_deployment_target=ct.target.iOS18,
        compute_precision=ct.precision.FLOAT32, compute_units=ct.ComputeUnit.ALL,
    )
    pred = ml.predict({"input_ids": ids_t.numpy(), "attention_mask": mask.numpy(),
                       "ref_s": ref_s.numpy(), "random_phases": phases.numpy(), "speed": speed.numpy()})
    def corr(a, b):
        a = np.asarray(a).reshape(-1).astype(np.float64)
        b = np.asarray(b).reshape(-1).astype(np.float64)
        k = min(len(a), len(b))
        a, b = a[:k], b[:k]
        return float(np.corrcoef(a, b)[0, 1]) if k > 1 else 0.0
    f0c = corr(pred["F0_pred"], f0_t.numpy())
    harc = corr(pred["har_source"], har_t.numpy())
    sc, _ = E.spectral_parity(pred["audio"].reshape(-1)[:int(alen_t.item())], a_t[0, :int(alen_t.item())].numpy())
    print(f"[DIAG coreml-vs-torch] F0_pred corr={f0c:.5f}  har_source corr={harc:.5f}  audio spectral={sc:.5f}")
    print("[verdict]",
          "F0Ntrain diverges" if f0c < 0.95 else
          ("SineGen interpolate (har) diverges" if harc < 0.95 else
           "F0+har match -> iSTFT/decoder convs diverge"))

if __name__ == "__main__":
    main()
