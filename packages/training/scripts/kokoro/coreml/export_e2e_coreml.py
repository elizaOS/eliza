#!/usr/bin/env python3
"""Fused end-to-end Kokoro-82M -> CoreML exporter matching the elizaOS iOS
KokoroCoreMlModel contract.

Single .mlmodelc, inputs:
  input_ids      int32   [1, T]      (phoneme ids, padded; bos/eos included)
  attention_mask int32   [1, T]      (1 valid, 0 pad)
  ref_s          float32 [1, 256]    (voice style+baseline embedding)
  random_phases  float32 [1, 9]      (hn-NSF harmonic initial phases)
  speed          float32 [1]
outputs:
  audio                float32 [1, T*600 bucket]
  audio_length_samples float32 [1]
  pred_dur             int32   [1, T]

The graph fuses duration + in-graph fixed-bucket alignment + real F0/N
prosody + real AdaIN decoder + hn-NSF (injected phase) + CustomSTFT iSTFT.
"""
from __future__ import annotations
import argparse
import importlib.util
import os
from pathlib import Path
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

REF = Path(os.environ.get("KOKORO_COREML_REF", "/tmp/kokoro-coreml-work/ref"))
HEX = Path(os.environ.get("KOKORO_COREML_HEXGRAD", "/tmp/kokoro-coreml-work/hexgrad"))
SR = 24000
SAMPLES_PER_FRAME = 600  # measured: audio.numel() / pred_dur.sum()

def load_kokoro():
    spec = importlib.util.spec_from_file_location("k_eu", REF / "kokoro/_export_utils.py")
    eu = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(eu)
    return eu.load_kokoro_for_export(repo_root=str(REF), suffix="_e2e")

ISTFT, MODS, MDL = load_kokoro()
KModel = MDL.KModel
AdaLayerNorm = MODS.AdaLayerNorm
SineGen = ISTFT.SineGen
SourceModuleHnNSF = ISTFT.SourceModuleHnNSF

# ---- CoreML-friendly 1D linear resample (replaces F.interpolate(mode="linear")) ----
def _linear_resample(x: torch.Tensor, out_len: int) -> torch.Tensor:
    """Resize the LAST dim of `x` ([B, C, in_len]) to `out_len` with the exact
    semantics of `F.interpolate(..., mode="linear", align_corners=False)` — but
    using a static gather + linear blend instead of coremltools' `resize` op.

    coremltools lowers `F.interpolate(linear)` to a resize whose sampling-grid /
    boundary handling diverges from PyTorch (the root cause of the fused-Kokoro
    CoreML fidelity gap: stft-mag corr ~0.67, amplitude ~½). All shapes here are
    static in the traced graph, so the source indices `i0/i1` and blend weights
    `w0/w1` are compile-time constants and this lowers to gather+mul+add, which
    CoreML reproduces bit-for-bit. Verified float32-exact vs `F.interpolate`.
    """
    in_len = int(x.shape[-1])
    if in_len == out_len:
        return x
    # Indices + weights are pure functions of the (static) in/out lengths, so
    # compute them HOST-SIDE as numpy constants. Deriving them with traced torch
    # ops (arange/floor/clamp) makes coremltools type the gather indices as fp32
    # (gather rejects fp32). Baking them as constant int tensors avoids that.
    pos = (np.arange(out_len, dtype=np.float64) + 0.5) * (
        float(in_len) / float(out_len)
    ) - 0.5
    pos = np.clip(pos, 0.0, in_len - 1)
    i0 = np.floor(pos).astype(np.int64)
    i1 = np.minimum(i0 + 1, in_len - 1)
    w1 = (pos - i0).astype(np.float32)
    i0_t = torch.tensor(i0, dtype=torch.long)
    i1_t = torch.tensor(i1, dtype=torch.long)
    w1_t = torch.tensor(w1, dtype=torch.float32).view(1, 1, out_len)
    x0 = torch.index_select(x, -1, i0_t)
    x1 = torch.index_select(x, -1, i1_t)
    return x0 * (1.0 - w1_t) + x1 * w1_t


# ---- deterministic hn-NSF: injected phase + zero excitation noise ----
def _f02sine_injected(self, f0_values):
    rad_values = (f0_values / self.sampling_rate) % 1
    # injected phase [1,9]; fundamental (col 0) carries no phase noise
    phase = getattr(self, "_inj_phase")
    mask = torch.ones(1, phase.shape[1], dtype=phase.dtype, device=phase.device)
    mask = torch.cat([torch.zeros(1, 1, dtype=phase.dtype), mask[:, 1:]], dim=1)
    rand_ini = phase * mask
    rad_values = torch.cat(
        [rad_values[:, :1, :] + rand_ini.unsqueeze(1), rad_values[:, 1:, :]], dim=1
    )
    B, L, D = rad_values.shape
    down_len = max(1, int((L + self.upsample_scale - 1) // self.upsample_scale))
    rad_values_ds = _linear_resample(rad_values.transpose(1, 2), down_len).transpose(1, 2)
    phase_c = torch.cumsum(rad_values_ds, dim=1) * 2 * torch.pi
    up_len = down_len * self.upsample_scale
    phase_up = _linear_resample(phase_c.transpose(1, 2) * self.upsample_scale, up_len).transpose(1, 2)
    return torch.sin(phase_up)

def _sinegen_forward_nonoise(self, f0):
    harmonics = []
    for i in range(self.harmonic_num + 1):
        coef = torch.tensor(float(i + 1), dtype=f0.dtype, device=f0.device)
        harmonics.append(f0 * coef)
    fn = torch.cat(harmonics, dim=2)
    sine_waves = self._f02sine(fn) * self.sine_amp
    uv = self._f02uv(f0)
    sine_waves = sine_waves * uv  # noise dropped for determinism
    return sine_waves, uv, torch.zeros_like(uv)

def _srcmod_forward_nonoise(self, x):
    sine_wavs, uv, _ = self.l_sin_gen(x)
    sine_merge = self.l_tanh(self.l_linear(sine_wavs))
    # Stash the harmonic source for the diag exporter (localizes whether the
    # SineGen/source path is where CoreML diverges).
    self._last_har_source = sine_merge
    return sine_merge, torch.zeros_like(uv), uv

SineGen._f02sine = _f02sine_injected
SineGen.forward = _sinegen_forward_nonoise
SourceModuleHnNSF.forward = _srcmod_forward_nonoise

# ---- padding-invariant AdaIN: masked channel-wise stats over valid frames ----
AdaIN1d = ISTFT.AdaIN1d

def _adain_forward_masked(self, x, s):
    B, C, T = x.shape
    fm = getattr(AdaIN1d, "_frame_mask", None)
    if fm is None:
        mean = x.mean(dim=2, keepdim=True)
        var = x.var(dim=2, unbiased=False, keepdim=True)
    else:
        m = F.interpolate(fm, size=T, mode="nearest")  # [1,1,T] valid/pad split
        denom = m.sum(dim=2, keepdim=True).clamp(min=1.0)
        mean = (x * m).sum(dim=2, keepdim=True) / denom
        var = (((x - mean) ** 2) * m).sum(dim=2, keepdim=True) / denom
    x_norm = (x - mean) / torch.sqrt(var + self.eps)
    h = self.fc(s).view(B, 2 * self.num_features, 1)
    gamma, beta = torch.chunk(h, chunks=2, dim=1)
    return (1.0 + gamma.expand(B, C, T)) * x_norm + beta.expand(B, C, T)

AdaIN1d.forward = _adain_forward_masked

# ---- CoreML-friendly encoders (from export_duration.py, proven) ----
class MaskedBidirectionalLSTM(nn.Module):
    def __init__(self, lstm: nn.LSTM):
        super().__init__()
        assert lstm.num_layers == 1 and lstm.bidirectional and lstm.batch_first
        self.hidden_size = lstm.hidden_size
        for nm in ["weight_ih_l0","weight_hh_l0","bias_ih_l0","bias_hh_l0",
                   "weight_ih_l0_reverse","weight_hh_l0_reverse","bias_ih_l0_reverse","bias_hh_l0_reverse"]:
            self.register_buffer(nm, getattr(lstm, nm).detach().clone())
    def _cell(self, x_t, h, c, wih, whh, bih, bhh):
        g = F.linear(x_t, wih, bih) + F.linear(h, whh, bhh)
        i, f, gg, o = g.chunk(4, dim=1)
        i = torch.sigmoid(i)
        f = torch.sigmoid(f)
        gg = torch.tanh(gg)
        o = torch.sigmoid(o)
        c_new = f * c + i * gg
        return o * torch.tanh(c_new), c_new
    def forward(self, x, attention_mask):
        b, steps, _ = x.shape
        m = attention_mask.to(dtype=x.dtype)
        hf = x.new_zeros((b, self.hidden_size))
        cf = x.new_zeros((b, self.hidden_size))
        fout = []
        for t in range(steps):
            a = m[:, t].unsqueeze(1)
            h_new, c_new = self._cell(x[:, t, :], hf, cf, self.weight_ih_l0, self.weight_hh_l0, self.bias_ih_l0, self.bias_hh_l0)
            hf = h_new * a + hf * (1 - a)
            cf = c_new * a + cf * (1 - a)
            fout.append(hf * a)
        hb = x.new_zeros((b, self.hidden_size))
        cb = x.new_zeros((b, self.hidden_size))
        brev = []
        for t in range(steps - 1, -1, -1):
            a = m[:, t].unsqueeze(1)
            h_new, c_new = self._cell(x[:, t, :], hb, cb, self.weight_ih_l0_reverse, self.weight_hh_l0_reverse, self.bias_ih_l0_reverse, self.bias_hh_l0_reverse)
            hb = h_new * a + hb * (1 - a)
            cb = c_new * a + cb * (1 - a)
            brev.append(hb * a)
        return torch.cat([torch.stack(fout, 1), torch.stack(list(reversed(brev)), 1)], dim=2)

class CMLTextEncoder(nn.Module):
    def __init__(self, enc):
        super().__init__()
        self.embedding = enc.embedding
        self.cnn = enc.cnn
        self.lstm = MaskedBidirectionalLSTM(enc.lstm)
    def forward(self, x, input_lengths, m):
        valid = (~m).to(torch.long)
        x = self.embedding(x).transpose(1, 2)
        m1 = m.unsqueeze(1)
        x = x.masked_fill(m1, 0.0)
        for c in self.cnn:
            x = c(x)
            x = x.masked_fill(m1, 0.0)
        x = x.transpose(1, 2)
        x = self.lstm(x, valid)
        x = x.transpose(-1, -2)
        return x.masked_fill(m1, 0.0)

class CMLDurationEncoder(nn.Module):
    def __init__(self, enc):
        super().__init__()
        self.lstms = nn.ModuleList(
            MaskedBidirectionalLSTM(b) if isinstance(b, nn.LSTM) else b for b in enc.lstms)
        self.dropout = enc.dropout
    def forward(self, x, style, text_lengths, m):
        masks = m
        valid = (~masks).to(torch.long)
        x = x.permute(2, 0, 1)
        seq_len = x.shape[0]
        s = style.unsqueeze(0).repeat(seq_len, 1, 1)
        x = torch.cat([x, s], axis=-1)
        x = x.masked_fill(masks.unsqueeze(-1).transpose(0, 1), 0.0)
        x = x.transpose(0, 1).transpose(-1, -2)
        for block in self.lstms:
            if type(block).__name__ == "AdaLayerNorm":
                x = block(x.transpose(-1, -2), style).transpose(-1, -2)
                x = torch.cat([x, s.permute(1, 2, 0)], axis=1)
                x = x.masked_fill(masks.unsqueeze(-1).transpose(-1, -2), 0.0)
            else:
                x = x.transpose(-1, -2)
                x = block(x, valid)
                x = x.transpose(-1, -2)
        return x.transpose(-1, -2)

class KokoroE2E(nn.Module):
    def __init__(self, kmodel, bucket_frames: int):
        super().__init__()
        self.k = kmodel
        self.k.text_encoder = CMLTextEncoder(kmodel.text_encoder)
        self.k.predictor.text_encoder = CMLDurationEncoder(kmodel.predictor.text_encoder)
        self.duration_lstm = MaskedBidirectionalLSTM(kmodel.predictor.lstm)
        self.shared_masked = MaskedBidirectionalLSTM(kmodel.predictor.shared)
        if hasattr(self.k.bert.embeddings, "token_type_ids"):
            delattr(self.k.bert.embeddings, "token_type_ids")
        self.bucket_frames = bucket_frames
        self.lsin = self.k.decoder.generator.m_source.l_sin_gen
        self.msource = self.k.decoder.generator.m_source
        self._diag = False

    def _f0ntrain_masked(self, en, s, frame_valid_2d):
        pred = self.k.predictor
        xs = self.shared_masked(en.transpose(-1, -2), frame_valid_2d)  # [1,Fr,512]
        F0 = xs.transpose(-1, -2)
        for block in pred.F0:
            F0 = block(F0, s)
        F0 = pred.F0_proj(F0)
        N = xs.transpose(-1, -2)
        for block in pred.N:
            N = block(N, s)
        N = pred.N_proj(N)
        return F0.squeeze(1), N.squeeze(1)

    def forward(self, input_ids, attention_mask, ref_s, random_phases, speed):
        k = self.k
        input_lengths = attention_mask.sum(dim=-1).to(torch.long)
        text_mask = attention_mask == 0
        tti = torch.zeros_like(input_ids)
        bert_dur = k.bert(input_ids, attention_mask=attention_mask, token_type_ids=tti)
        d_en = k.bert_encoder(bert_dur).transpose(-1, -2)
        s = ref_s[:, 128:]
        d = k.predictor.text_encoder(d_en, s, input_lengths, text_mask)
        x = self.duration_lstm(d, attention_mask)
        duration = k.predictor.duration_proj(x)
        duration = torch.sigmoid(duration).sum(axis=-1) / speed  # [1,N]
        pred_dur = torch.round(duration).clamp(min=1)
        valid = attention_mask.to(pred_dur.dtype)
        pred_dur = pred_dur * valid  # pad tokens consume no frames
        Fr = self.bucket_frames
        cumend = torch.cumsum(pred_dur, dim=1)
        cumstart = cumend - pred_dur
        frames = torch.arange(Fr, dtype=pred_dur.dtype).view(1, 1, Fr)
        ge = (frames >= cumstart.unsqueeze(-1)).to(d.dtype)
        lt = (frames < cumend.unsqueeze(-1)).to(d.dtype)
        aln = ge * lt  # [1,N,Fr] one-hot frame->token, avoids bitwise_and
        frame_valid = (aln.sum(dim=1, keepdim=True) > 0).to(d.dtype)  # [1,1,Fr]
        frame_valid_2d = frame_valid.squeeze(1)  # [1,Fr]
        AdaIN1d._frame_mask = frame_valid  # padding-invariant AdaIN stats
        en = d.transpose(-1, -2).matmul(aln)  # [1,Hd,Fr]
        F0_pred, N_pred = self._f0ntrain_masked(en, s, frame_valid_2d)
        t_en = k.text_encoder(input_ids, input_lengths, text_mask)  # [1,Ht,N]
        asr = t_en.matmul(aln)  # [1,Ht,Fr]
        self.lsin._inj_phase = random_phases
        audio = k.decoder(asr, F0_pred, N_pred, ref_s[:, :128]).reshape(1, -1)
        # int32 length: float16 compute precision overflows past 65504, so any
        # utterance > ~1.8s (>109 frames) would yield inf in an fp16 scalar.
        pred_dur_i = pred_dur.to(torch.int32)
        total_frames = pred_dur_i.sum(dim=1)  # int32 [1]
        audio_length_samples = total_frames * SAMPLES_PER_FRAME  # int32, overflow-safe
        if self._diag:
            # Stage outputs for the divergence localizer (diag_stages.py): the
            # predicted F0 and the harmonic source captured during decode.
            har = getattr(self.msource, "_last_har_source", torch.zeros(1))
            return audio, audio_length_samples, pred_dur_i, F0_pred, har
        return audio, audio_length_samples, pred_dur_i


class KokoroE2ERefDynamic(nn.Module):
    """Reference: same math but dynamic alignment (no bucket) for parity check."""
    def __init__(self, e2e: KokoroE2E):
        super().__init__()
        self.k = e2e.k
        self.duration_lstm = e2e.duration_lstm
        self.lsin = e2e.lsin
    def forward(self, input_ids, attention_mask, ref_s, random_phases, speed):
        k = self.k
        input_lengths = attention_mask.sum(dim=-1).to(torch.long)
        text_mask = attention_mask == 0
        tti = torch.zeros_like(input_ids)
        bert_dur = k.bert(input_ids, attention_mask=attention_mask, token_type_ids=tti)
        d_en = k.bert_encoder(bert_dur).transpose(-1, -2)
        s = ref_s[:, 128:]
        d = k.predictor.text_encoder(d_en, s, input_lengths, text_mask)
        x = self.duration_lstm(d, attention_mask)
        duration = k.predictor.duration_proj(x)
        duration = torch.sigmoid(duration).sum(axis=-1) / speed
        pred_dur = torch.round(duration).clamp(min=1).long().squeeze()
        idx = torch.repeat_interleave(torch.arange(input_ids.shape[1]), pred_dur)
        aln = torch.zeros((input_ids.shape[1], idx.shape[0]))
        aln[idx, torch.arange(idx.shape[0])] = 1
        aln = aln.unsqueeze(0)
        en = d.transpose(-1, -2) @ aln
        F0_pred, N_pred = k.predictor.F0Ntrain(en, s)
        t_en = k.text_encoder(input_ids, input_lengths, text_mask)
        asr = t_en @ aln
        self.lsin._inj_phase = random_phases
        audio = k.decoder(asr, F0_pred, N_pred, ref_s[:, :128]).reshape(-1)
        return audio, pred_dur


def spectral_parity(a1, a2):
    """Phase-invariant parity: STFT magnitude correlation + log-mel L1."""
    import numpy as _np
    n = min(len(a1), len(a2))
    a1 = a1[:n].astype(_np.float64)
    a2 = a2[:n].astype(_np.float64)
    win = 1024
    hop = 256
    w = _np.hanning(win)
    def mag(a):
        frames = [a[i:i+win] * w for i in range(0, len(a) - win, hop)]
        if not frames:
            return _np.zeros((1, win // 2 + 1))
        return _np.abs(_np.fft.rfft(_np.stack(frames), axis=1))
    M1, M2 = mag(a1), mag(a2)
    k = min(len(M1), len(M2))
    M1, M2 = M1[:k].ravel(), M2[:k].ravel()
    sc = float(_np.corrcoef(M1, M2)[0, 1]) if k > 0 else 0.0
    l1 = float(_np.mean(_np.abs(_np.log1p(M1) - _np.log1p(M2))))
    return sc, l1

def load_model():
    return KModel(config=str(REF / "checkpoints/config.json"),
                  model=str(REF / "checkpoints/kokoro-v1_0.pth"),
                  disable_complex=True).eval()

def rep_voice_embedding(voice_pt: Path, n_avg=64) -> np.ndarray:
    vp = torch.load(voice_pt, map_location="cpu")  # [510,1,256]
    sl = vp[:n_avg].reshape(n_avg, -1).mean(0)
    return sl.float().numpy()

def make_inputs(T, n_tokens, ref_s_vec, seed=0):
    g = torch.Generator().manual_seed(seed)
    ids = torch.zeros(1, T, dtype=torch.int32)
    ids[0, 0] = 0
    ids[0, n_tokens-1] = 0
    ids[0, 1:n_tokens-1] = torch.randint(1, 170, (n_tokens-2,), generator=g, dtype=torch.int32)
    mask = torch.zeros(1, T, dtype=torch.int32)
    mask[0, :n_tokens] = 1
    ref_s = torch.tensor(ref_s_vec, dtype=torch.float32).view(1, 256)
    phases = torch.rand(1, 9, generator=g, dtype=torch.float32)
    speed = torch.tensor([1.0], dtype=torch.float32)
    return ids, mask, ref_s, phases, speed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", choices=["torch", "full"], default="torch")
    ap.add_argument("--seconds", type=int, default=5)
    ap.add_argument("--frames", type=int, default=0, help="override bucket frames (else seconds*40)")
    ap.add_argument("--tokens", type=int, default=128)
    ap.add_argument("--precision", choices=["fp16", "fp32"], default="fp32")
    ap.add_argument("--out", default=os.environ.get("KOKORO_COREML_OUT", "/tmp/kokoro-coreml-work/out"))
    args = ap.parse_args()
    bucket_frames = args.frames if args.frames > 0 else args.seconds * SR // SAMPLES_PER_FRAME
    print(f"[cfg] seconds={args.seconds} bucket_frames={bucket_frames} T={args.tokens}")

    import numpy as _np
    # pristine reference model for ground-truth forward_with_tokens (unpadded)
    m_ref = load_model()
    m = load_model()
    e2e = KokoroE2E(m, bucket_frames).eval()
    for mod in e2e.modules():
        mod.eval()

    ref_vec = rep_voice_embedding(HEX / "voices/af_heart.pt")
    n_tokens = 24
    ids, mask, ref_s, phases, speed = make_inputs(args.tokens, n_tokens, ref_vec, seed=3)
    ids_unpadded = ids[:, :n_tokens].long()

    with torch.no_grad():
        # ground truth first: exact-length data uses plain (unmasked) AdaIN stats
        AdaIN1d._frame_mask = None
        m_ref.decoder.generator.m_source.l_sin_gen._inj_phase = phases
        a_ref, pdur_ref = m_ref.forward_with_tokens(ids_unpadded, ref_s, 1.0)
        # fused bucket path (sets its own _frame_mask internally)
        a_e2e, alen, pdur = e2e(ids, mask, ref_s, phases, speed)
    valid = int(alen.item())
    print(f"[torch] e2e audio={tuple(a_e2e.shape)} valid_len={valid} pred_sum={int(pdur.sum())} "
          f"ref_len={a_ref.numel()} pdur_e2e={pdur[0,:n_tokens].tolist()} pdur_ref={pdur_ref.reshape(-1).tolist()}")
    n = min(valid, a_ref.numel())
    a1 = a_e2e[0, :n].numpy()
    a2 = a_ref.reshape(-1)[:n].numpy()
    mae = float(_np.mean(_np.abs(a1 - a2)))
    corr = float(_np.corrcoef(a1, a2)[0, 1]) if n > 1 else 0.0
    rms1 = float(_np.sqrt(_np.mean(a1**2)))
    rms2 = float(_np.sqrt(_np.mean(a2**2)))
    print(f"[parity torch fused-vs-truth] n={n} MAE={mae:.5f} wav_corr={corr:.5f} rms_fused={rms1:.4f} rms_ref={rms2:.4f}")
    sc, ld = spectral_parity(a1, a2)
    print(f"[spectral parity] stft_mag_corr={sc:.5f} logmel_L1={ld:.5f}")
    try:
        import soundfile as sf
        sf.write("/tmp/kokoro-coreml-work/out_fused.wav", a1, SR)
        sf.write("/tmp/kokoro-coreml-work/out_truth.wav", a2, SR)
        print("[wav] wrote out_fused.wav / out_truth.wav")
    except Exception as e:
        print("[wav] skipped:", e)

    if args.stage == "torch":
        print("[done] torch parity stage")
        return

    import coremltools as ct
    from coremltools.converters.mil.frontend.torch.ops import _get_inputs
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

    # Every `&` in this graph is a boolean-mask AND; coremltools sometimes types
    # one operand as float. Override to cast both operands to bool first.
    @register_torch_op(torch_alias=["and"], override=True)
    def bitwise_and(context, node):
        a, b = _get_inputs(context, node, expected=2)
        a = mb.cast(x=a, dtype="bool")
        b = mb.cast(x=b, dtype="bool")
        context.add(mb.logical_and(x=a, y=b, name=node.name))
    print("[convert] tracing...")
    with torch.no_grad():
        traced = torch.jit.trace(e2e, (ids, mask, ref_s, phases, speed), strict=False, check_trace=False)
    T = args.tokens
    print("[convert] ct.convert...")
    mlmodel = ct.convert(
        traced,
        inputs=[
            ct.TensorType(name="input_ids", shape=(1, T), dtype=np.int32),
            ct.TensorType(name="attention_mask", shape=(1, T), dtype=np.int32),
            ct.TensorType(name="ref_s", shape=(1, 256), dtype=np.float32),
            ct.TensorType(name="random_phases", shape=(1, 9), dtype=np.float32),
            ct.TensorType(name="speed", shape=(1,), dtype=np.float32),
        ],
        outputs=[
            ct.TensorType(name="audio"),
            ct.TensorType(name="audio_length_samples"),
            ct.TensorType(name="pred_dur"),
        ],
        convert_to="mlprogram",
        minimum_deployment_target=ct.target.iOS18,
        compute_precision=(ct.precision.FLOAT32 if args.precision == "fp32" else ct.precision.FLOAT16),
        compute_units=ct.ComputeUnit.ALL,
    )
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    pkg = out / f"kokoro_{args.seconds}s.mlpackage"
    mlmodel.save(str(pkg))
    print(f"[saved] {pkg}")

    print("[parity] coreml vs torch...")
    pred = mlmodel.predict({
        "input_ids": ids.numpy(), "attention_mask": mask.numpy(),
        "ref_s": ref_s.numpy(), "random_phases": phases.numpy(), "speed": speed.numpy(),
    })
    ca = pred["audio"].reshape(-1)[:valid]
    ta = a_e2e[0, :valid].numpy()
    n2 = min(len(ca), len(ta))
    cmae = float(_np.mean(_np.abs(ca[:n2] - ta[:n2])))
    ccorr = float(_np.corrcoef(ca[:n2], ta[:n2])[0, 1]) if n2 > 1 else 0.0
    print(f"[parity coreml-vs-torch] n={n2} MAE={cmae:.5f} corr={ccorr:.5f} cl_alen={float(pred['audio_length_samples'].reshape(-1)[0])}")
    print("[done] full stage")


if __name__ == "__main__":
    main()
