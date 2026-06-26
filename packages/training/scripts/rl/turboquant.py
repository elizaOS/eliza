"""TurboQuant KV-cache."""

from __future__ import annotations

import math
from dataclasses import dataclass
from functools import cache
from typing import Any

import torch
from transformers.cache_utils import Cache, DynamicLayer


SQRT_PI_OVER_TWO = math.sqrt(math.pi / 2.0)
SUPPORTED_TURBOQUANT_BITS = {1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0}


@dataclass(frozen=True)
class TurboQuantSettings:
    key_bits: float = 3.5
    value_bits: float = 3.5
    residual_length: int = 128
    seed: int = 0

    def validate(self) -> None:
        _validate_turboquant_bits(self.key_bits, name="key_bits", minimum=2.0)
        _validate_turboquant_bits(self.value_bits, name="value_bits", minimum=1.0)
        if self.residual_length < 1:
            raise ValueError("TurboQuant residual_length must be at least 1.")


@dataclass
class TurboQuantMSEState:
    norms: torch.Tensor
    codes: torch.Tensor
    outlier_channels: torch.Tensor | None = None
    outlier_codes: torch.Tensor | None = None

    def repeat_batch(self, repeats: int) -> TurboQuantMSEState:
        return TurboQuantMSEState(
            norms=self.norms.repeat_interleave(repeats, dim=0),
            codes=self.codes.repeat_interleave(repeats, dim=0),
            outlier_channels=self.outlier_channels,
            outlier_codes=(
                self.outlier_codes.repeat_interleave(repeats, dim=0)
                if self.outlier_codes is not None
                else None
            ),
        )

    def select_batch(self, indices: torch.Tensor) -> TurboQuantMSEState:
        return TurboQuantMSEState(
            norms=self.norms.index_select(0, indices),
            codes=self.codes.index_select(0, indices),
            outlier_channels=self.outlier_channels,
            outlier_codes=(
                self.outlier_codes.index_select(0, indices)
                if self.outlier_codes is not None
                else None
            ),
        )

    def crop(self, max_length: int) -> TurboQuantMSEState:
        return TurboQuantMSEState(
            norms=self.norms[..., :max_length, :],
            codes=self.codes[..., :max_length, :],
            outlier_channels=self.outlier_channels,
            outlier_codes=(
                self.outlier_codes[..., :max_length, :] if self.outlier_codes is not None else None
            ),
        )

    def to(self, device: torch.device | str) -> TurboQuantMSEState:
        return TurboQuantMSEState(
            norms=self.norms.to(device),
            codes=self.codes.to(device),
            outlier_channels=(
                self.outlier_channels.to(device) if self.outlier_channels is not None else None
            ),
            outlier_codes=self.outlier_codes.to(device) if self.outlier_codes is not None else None,
        )


@dataclass
class TurboQuantTensorState:
    mse: TurboQuantMSEState
    qjl_signs: torch.Tensor | None = None
    qjl_norms: torch.Tensor | None = None

    def repeat_batch(self, repeats: int) -> TurboQuantTensorState:
        return TurboQuantTensorState(
            mse=self.mse.repeat_batch(repeats),
            qjl_signs=(
                self.qjl_signs.repeat_interleave(repeats, dim=0)
                if self.qjl_signs is not None
                else None
            ),
            qjl_norms=(
                self.qjl_norms.repeat_interleave(repeats, dim=0)
                if self.qjl_norms is not None
                else None
            ),
        )

    def select_batch(self, indices: torch.Tensor) -> TurboQuantTensorState:
        return TurboQuantTensorState(
            mse=self.mse.select_batch(indices),
            qjl_signs=(
                self.qjl_signs.index_select(0, indices) if self.qjl_signs is not None else None
            ),
            qjl_norms=(
                self.qjl_norms.index_select(0, indices) if self.qjl_norms is not None else None
            ),
        )

    def crop(self, max_length: int) -> TurboQuantTensorState:
        return TurboQuantTensorState(
            mse=self.mse.crop(max_length),
            qjl_signs=(self.qjl_signs[..., :max_length, :] if self.qjl_signs is not None else None),
            qjl_norms=(self.qjl_norms[..., :max_length, :] if self.qjl_norms is not None else None),
        )

    def to(self, device: torch.device | str) -> TurboQuantTensorState:
        return TurboQuantTensorState(
            mse=self.mse.to(device),
            qjl_signs=self.qjl_signs.to(device) if self.qjl_signs is not None else None,
            qjl_norms=self.qjl_norms.to(device) if self.qjl_norms is not None else None,
        )


def _validate_turboquant_bits(bits: float, *, name: str, minimum: float) -> None:
    rounded = round(float(bits), 2)
    if rounded not in SUPPORTED_TURBOQUANT_BITS:
        raise ValueError(
            f"TurboQuant {name} must be one of "
            f"{', '.join(str(value) for value in sorted(SUPPORTED_TURBOQUANT_BITS))}; got {bits}."
        )
    if rounded < minimum:
        raise ValueError(f"TurboQuant {name} must be at least {minimum}; got {bits}.")


def _resolve_decoder_config(config: Any) -> Any:
    if hasattr(config, "get_text_config"):
        return config.get_text_config(decoder=True)
    return config


def _quantization_dtype(device: torch.device) -> torch.dtype:
    return torch.float16 if device.type == "cuda" else torch.float32


def _resolve_bit_plan(bits: float, dim: int) -> tuple[int, int, int]:
    lower_bits = math.floor(bits)
    upper_bits = math.ceil(bits)
    fractional = round(bits - lower_bits, 2)
    if fractional not in (0.0, 0.5):
        raise ValueError(f"TurboQuant only supports integer and half-bit allocations; got {bits}.")
    outlier_channels = round(dim * fractional)
    return lower_bits, upper_bits, outlier_channels


@cache
def _orthogonal_rotation(dim: int, seed: int) -> torch.Tensor:
    generator = torch.Generator(device="cpu")
    generator.manual_seed(seed + dim * 17)
    gaussian = torch.randn((dim, dim), generator=generator, dtype=torch.float64)
    q, r = torch.linalg.qr(gaussian)
    signs = torch.sign(torch.diag(r))
    signs[signs == 0] = 1
    return (q * signs).to(torch.float32).contiguous()


@cache
def _gaussian_projection(dim: int, seed: int) -> torch.Tensor:
    generator = torch.Generator(device="cpu")
    generator.manual_seed(seed + dim * 29)
    return torch.randn((dim, dim), generator=generator, dtype=torch.float32).contiguous()


@cache
def _sphere_codebook(dim: int, bits: int) -> tuple[torch.Tensor, torch.Tensor]:
    if bits < 1:
        raise ValueError(f"TurboQuant scalar codebooks require at least 1 bit; got {bits}.")

    levels = 1 << bits
    grid = torch.linspace(-1.0, 1.0, steps=8193, dtype=torch.float64)
    exponent = max((dim - 3) / 2.0, 0.0)
    normalization = math.exp(
        math.lgamma(dim / 2.0) - 0.5 * math.log(math.pi) - math.lgamma((dim - 1) / 2.0)
    )
    density = normalization * torch.clamp(1.0 - grid.square(), min=0.0).pow(exponent)
    step = float(grid[1] - grid[0])
    weights = density * step
    weighted_points = grid * weights
    cumulative_weights = torch.cumsum(weights, dim=0)
    cumulative_points = torch.cumsum(weighted_points, dim=0)
    cumulative_weights = cumulative_weights / cumulative_weights[-1]

    quantiles = torch.linspace(0.0, 1.0, steps=levels + 2, dtype=torch.float64)[1:-1]
    quantile_indices = torch.searchsorted(cumulative_weights, quantiles).clamp(max=grid.numel() - 1)
    centroids = grid[quantile_indices].clone()

    for _ in range(64):
        thresholds = torch.empty(levels + 1, dtype=torch.float64)
        thresholds[0] = -1.0
        thresholds[-1] = 1.0
        thresholds[1:-1] = (centroids[:-1] + centroids[1:]) / 2.0
        threshold_indices = torch.searchsorted(grid, thresholds).clamp(max=grid.numel() - 1)

        updated = centroids.clone()
        for index in range(levels):
            left = int(threshold_indices[index])
            right = int(threshold_indices[index + 1])
            if right <= left:
                continue
            mass = cumulative_weights[right - 1] - (
                cumulative_weights[left - 1] if left > 0 else 0.0
            )
            if float(mass) <= 1e-12:
                continue
            moment = cumulative_points[right - 1] - (
                cumulative_points[left - 1] if left > 0 else 0.0
            )
            updated[index] = moment / mass

        if torch.max(torch.abs(updated - centroids)) < 1e-8:
            centroids = updated
            break
        centroids = updated

    thresholds = ((centroids[:-1] + centroids[1:]) / 2.0).to(torch.float32).contiguous()
    return centroids.to(torch.float32).contiguous(), thresholds


class TurboQuantTensorQuantizer:
    def __init__(
        self,
        *,
        dim: int,
        bits: float,
        use_qjl: bool,
        seed: int,
        device: torch.device,
        output_dtype: torch.dtype,
    ) -> None:
        self.dim = dim
        self.bits = bits
        self.use_qjl = use_qjl
        self.seed = seed
        self.device = device
        self.output_dtype = output_dtype
        self.scale_dtype = _quantization_dtype(device)

        lower_bits, upper_bits, outlier_channels = _resolve_bit_plan(bits, dim)
        self.lower_bits = lower_bits
        self.upper_bits = upper_bits
        self.outlier_channels = outlier_channels
        self.lower_codebook, self.lower_thresholds = (
            tensor.to(device) for tensor in _sphere_codebook(dim, lower_bits)
        )
        if upper_bits != lower_bits:
            self.upper_codebook, self.upper_thresholds = (
                tensor.to(device) for tensor in _sphere_codebook(dim, upper_bits)
            )
        else:
            self.upper_codebook, self.upper_thresholds = self.lower_codebook, self.lower_thresholds
        self.rotation = _orthogonal_rotation(dim, seed).to(device)
        self.projection = _gaussian_projection(dim, seed + 1).to(device) if use_qjl else None

    def compress(self, tensor: torch.Tensor) -> TurboQuantTensorState:
        flat = tensor.to(torch.float32)
        norms = flat.norm(dim=-1, keepdim=True)
        safe_norms = torch.where(norms > 0, norms, torch.ones_like(norms))
        rotated = (flat / safe_norms) @ self.rotation
        rotated = rotated.clamp(-1.0, 1.0)

        lower_codes = self._quantize(rotated, self.lower_thresholds)
        mse_rotated = self.lower_codebook[lower_codes.long()]
        outlier_channels = None
        outlier_codes = None
        if self.outlier_channels > 0 and self.upper_bits > self.lower_bits:
            importance = rotated.abs().mean(dim=tuple(range(rotated.ndim - 1)))
            selected = torch.topk(importance, k=self.outlier_channels).indices.sort().values
            outlier_channels = selected.to(torch.int16)
            outlier_values = rotated.index_select(-1, selected)
            outlier_codes = self._quantize(outlier_values, self.upper_thresholds)
            mse_rotated[..., selected] = self.upper_codebook[outlier_codes.long()]

        mse_reconstruction = (mse_rotated @ self.rotation.transpose(0, 1)) * norms
        mse_state = TurboQuantMSEState(
            norms=norms.to(self.scale_dtype),
            codes=lower_codes.to(torch.uint8),
            outlier_channels=outlier_channels,
            outlier_codes=outlier_codes.to(torch.uint8) if outlier_codes is not None else None,
        )

        if not self.use_qjl:
            return TurboQuantTensorState(mse=mse_state)

        assert self.projection is not None
        residual = flat - mse_reconstruction
        residual_norms = residual.norm(dim=-1, keepdim=True)
        qjl_signs = (residual @ self.projection.transpose(0, 1)) >= 0
        return TurboQuantTensorState(
            mse=mse_state,
            qjl_signs=qjl_signs,
            qjl_norms=residual_norms.to(self.scale_dtype),
        )

    def decompress(self, state: TurboQuantTensorState) -> torch.Tensor:
        rotated = self.lower_codebook[state.mse.codes.long()]
        if state.mse.outlier_channels is not None and state.mse.outlier_codes is not None:
            outlier_indices = state.mse.outlier_channels.long()
            rotated[..., outlier_indices] = self.upper_codebook[state.mse.outlier_codes.long()]
        reconstructed = (rotated @ self.rotation.transpose(0, 1)) * state.mse.norms.to(
            torch.float32
        )
        if state.qjl_signs is not None and state.qjl_norms is not None:
            assert self.projection is not None
            qjl = state.qjl_signs.to(torch.float32).mul(2.0).sub(1.0)
            reconstructed = reconstructed + (
                (SQRT_PI_OVER_TWO / self.dim)
                * state.qjl_norms.to(torch.float32)
                * (qjl @ self.projection)
            )
        return reconstructed.to(self.output_dtype)

    @staticmethod
    def _quantize(values: torch.Tensor, thresholds: torch.Tensor) -> torch.Tensor:
        return torch.bucketize(values, thresholds)


class TurboQuantLayer(DynamicLayer):
    def __init__(self, settings: TurboQuantSettings, layer_idx: int):
        super().__init__()
        self.settings = settings
        self.layer_idx = layer_idx
        self.cumulative_length = 0
        self._compressed_keys: TurboQuantTensorState | None = None
        self._compressed_values: TurboQuantTensorState | None = None
        self._key_quantizer: TurboQuantTensorQuantizer | None = None
        self._value_quantizer: TurboQuantTensorQuantizer | None = None

    def lazy_initialization(self, key_states: torch.Tensor, value_states: torch.Tensor) -> None:
        super().lazy_initialization(key_states, value_states)
        head_dim = int(key_states.shape[-1])
        base_seed = self.settings.seed + (self.layer_idx * 101)
        self._key_quantizer = TurboQuantTensorQuantizer(
            dim=head_dim,
            bits=self.settings.key_bits,
            use_qjl=True,
            seed=base_seed,
            device=key_states.device,
            output_dtype=key_states.dtype,
        )
        self._value_quantizer = TurboQuantTensorQuantizer(
            dim=head_dim,
            bits=self.settings.value_bits,
            use_qjl=False,
            seed=base_seed + 17,
            device=value_states.device,
            output_dtype=value_states.dtype,
        )

    def _dequantized_prefix(self) -> tuple[torch.Tensor | None, torch.Tensor | None]:
        key_prefix = (
            self._key_quantizer.decompress(self._compressed_keys)
            if self._compressed_keys is not None and self._key_quantizer is not None
            else None
        )
        value_prefix = (
            self._value_quantizer.decompress(self._compressed_values)
            if self._compressed_values is not None and self._value_quantizer is not None
            else None
        )
        return key_prefix, value_prefix

    def _set_from_full_states(self, full_keys: torch.Tensor, full_values: torch.Tensor) -> None:
        total_length = int(full_keys.shape[-2])
        tail_length = min(max(self.settings.residual_length - 1, 0), total_length)
        prefix_length = total_length - tail_length
        if prefix_length > 0:
            assert self._key_quantizer is not None
            assert self._value_quantizer is not None
            self._compressed_keys = self._key_quantizer.compress(
                full_keys[..., :prefix_length, :].contiguous()
            )
            self._compressed_values = self._value_quantizer.compress(
                full_values[..., :prefix_length, :].contiguous()
            )
        else:
            self._compressed_keys = None
            self._compressed_values = None

        if tail_length > 0:
            self.keys = full_keys[..., prefix_length:, :].contiguous()
            self.values = full_values[..., prefix_length:, :].contiguous()
        else:
            self.keys = torch.tensor([], dtype=self.dtype, device=self.device)
            self.values = torch.tensor([], dtype=self.dtype, device=self.device)
        self.cumulative_length = total_length

    def update(
        self,
        key_states: torch.Tensor,
        value_states: torch.Tensor,
        cache_kwargs: dict[str, Any] | None = None,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        if not self.is_initialized:
            self.lazy_initialization(key_states, value_states)

        self.cumulative_length += key_states.shape[-2]

        prefix_keys, prefix_values = self._dequantized_prefix()
        segments = [
            segment
            for segment in [prefix_keys, self.keys, key_states]
            if segment is not None and segment.numel() > 0
        ]
        value_segments = [
            segment
            for segment in [prefix_values, self.values, value_states]
            if segment is not None and segment.numel() > 0
        ]
        full_keys = torch.cat(segments, dim=-2) if len(segments) > 1 else segments[0]
        full_values = (
            torch.cat(value_segments, dim=-2) if len(value_segments) > 1 else value_segments[0]
        )

        tail_length = self.keys.shape[-2] if self.keys.dim() == 4 else 0
        if tail_length + key_states.shape[-2] >= self.settings.residual_length:
            self._set_from_full_states(full_keys, full_values)
        else:
            self.keys = torch.cat([self.keys, key_states], dim=-2)
            self.values = torch.cat([self.values, value_states], dim=-2)

        return full_keys, full_values

    def get_seq_length(self) -> int:
        return self.cumulative_length

    def reset(self) -> None:
        super().reset()
        self._compressed_keys = None
        self._compressed_values = None
        self.cumulative_length = 0

    def crop(self, max_length: int) -> None:
        if max_length < 0:
            max_length = self.get_seq_length() - abs(max_length)
        if self.get_seq_length() <= max_length:
            return
        prefix_keys, prefix_values = self._dequantized_prefix()
        segments = [
            segment
            for segment in [prefix_keys, self.keys]
            if segment is not None and segment.numel() > 0
        ]
        value_segments = [
            segment
            for segment in [prefix_values, self.values]
            if segment is not None and segment.numel() > 0
        ]
        if not segments or not value_segments:
            return
        full_keys = torch.cat(segments, dim=-2) if len(segments) > 1 else segments[0]
        full_values = (
            torch.cat(value_segments, dim=-2) if len(value_segments) > 1 else value_segments[0]
        )
        self._set_from_full_states(full_keys[..., :max_length, :], full_values[..., :max_length, :])

    def batch_repeat_interleave(self, repeats: int) -> None:
        if self._compressed_keys is not None:
            self._compressed_keys = self._compressed_keys.repeat_batch(repeats)
        if self._compressed_values is not None:
            self._compressed_values = self._compressed_values.repeat_batch(repeats)
        if self.get_seq_length() > 0 and self.keys.numel() > 0:
            self.keys = self.keys.repeat_interleave(repeats, dim=0)
            self.values = self.values.repeat_interleave(repeats, dim=0)

    def batch_select_indices(self, indices: torch.Tensor) -> None:
        if self._compressed_keys is not None:
            self._compressed_keys = self._compressed_keys.select_batch(indices)
        if self._compressed_values is not None:
            self._compressed_values = self._compressed_values.select_batch(indices)
        if self.get_seq_length() > 0 and self.keys.numel() > 0:
            self.keys = self.keys.index_select(0, indices)
            self.values = self.values.index_select(0, indices)

    def reorder_cache(self, beam_idx: torch.LongTensor) -> None:
        self.batch_select_indices(beam_idx)

    def offload(self):
        if self._compressed_keys is not None:
            self._compressed_keys = self._compressed_keys.to("cpu")
        if self._compressed_values is not None:
            self._compressed_values = self._compressed_values.to("cpu")
        super().offload()

    def prefetch(self):
        if self._compressed_keys is not None:
            self._compressed_keys = self._compressed_keys.to(self.device)
        if self._compressed_values is not None:
            self._compressed_values = self._compressed_values.to(self.device)
        super().prefetch()


class TurboQuantCache(Cache):
    def __init__(self, config: Any, settings: TurboQuantSettings):
        settings.validate()
        decoder_config = _resolve_decoder_config(config)
        sliding_window = getattr(decoder_config, "sliding_window", None) or getattr(
            decoder_config, "attention_chunk_size", None
        )
        if sliding_window is not None:
            raise ValueError(
                "TurboQuantCache does not yet support sliding-window attention caches."
            )
        layers = [
            TurboQuantLayer(settings=settings, layer_idx=layer_idx)
            for layer_idx in range(int(decoder_config.num_hidden_layers))
        ]
        super().__init__(layers=layers)

    @property
    def has_previous_state(self) -> bool:
        return self.get_seq_length() > 0


def build_generation_cache(
    model_config: Any,
    *,
    cache_implementation: str = "dynamic",
    turboquant_settings: TurboQuantSettings | None = None,
) -> Any | None:
    if cache_implementation == "dynamic":
        return None
    if cache_implementation != "turboquant":
        raise ValueError(f"Unsupported cache implementation: {cache_implementation}")
    decoder_config = _resolve_decoder_config(model_config)
    settings = turboquant_settings or TurboQuantSettings()
    return TurboQuantCache(
        config=decoder_config,
        settings=settings,
    )
