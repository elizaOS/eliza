# mypy: disable-error-code="call-arg,import-untyped,no-any-return,no-untyped-call"
# mypy: disable-error-code="untyped-decorator,var-annotated"
"""Reusable DiffEML image-demo components.

This module supports a small DiffEML logic-circuit classifier on image datasets.
It is intended for research demos, not as a claim of competitive image
performance.
The default mode executes depth-2 EML-threshold gate templates from
``core.diffeml`` and learns a DiffLogic-style selector at every circuit node.
The ``eml_threshold`` ablation compresses each node to one EML operation, one
learned threshold, and one learned direction. Evaluation reports both the
relaxed circuit and the hardened EML circuit.

For image-scale runs, ``threshold_pixels`` creates DiffLogic-style binary
threshold features and ``local_hierarchy`` wires EML gates as local tree
convolutions with progressively coarser spatial grids.
"""

from __future__ import annotations

import argparse
import pickle
import tarfile
import time
import urllib.request
import warnings
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, NamedTuple, cast

import jax
import jax.numpy as jnp
import jax.random as jr
import numpy as np
from jax import Array

from alberta_framework.core.diffeml import (
    EMLTemplateBank,
    build_eml_template_bank,
    eml_threshold_gate_library,
    evaluate_eml_template_bank,
)
from alberta_framework.core.diffeml_pruning import (
    CircuitCompactionResult,
    HardGateLayer,
    compact_hard_circuit,
)
from alberta_framework.core.diffeml_pruning import (
    HeadMode as PruningHeadMode,
)

CIFAR10_URL = "https://www.cs.toronto.edu/~kriz/cifar-10-python.tar.gz"
BOOLEAN_COUNT_HEAD_MODES = frozenset({"group_sum", "class_vote", "signed_class_vote"})
LEARNED_DISCRETE_HEAD_MODES = frozenset({"class_vote", "signed_class_vote"})
SELECTOR_GATE_MODES = frozenset({"eml_template", "truth_table"})


class CircuitWiring(NamedTuple):
    """Fixed source wiring for every DiffEML layer."""

    left: tuple[Array, ...]
    right: tuple[Array, ...]
    fixed_gate_indices: tuple[int | None, ...]
    fixed_gate_masks: tuple[int | None, ...]
    meta: dict[str, Any]


class FeatureLayout(NamedTuple):
    """Spatial coordinates for each binary input feature."""

    rows: np.ndarray
    cols: np.ndarray
    image_shape: tuple[int, int, int] | None


class CircuitParams(NamedTuple):
    """Trainable parameters for the image DiffEML classifier."""

    gate_logits: tuple[Array, ...] | None
    threshold_logits: tuple[Array, ...] | None
    direction_logits: tuple[Array, ...] | None
    head_w: Array
    head_b: Array


class AdamState(NamedTuple):
    """Minimal Adam optimizer state for a JAX PyTree."""

    m: CircuitParams
    v: CircuitParams
    step: Array


class MLPParams(NamedTuple):
    """Trainable parameters for the MLP baseline."""

    weights: tuple[Array, ...]
    biases: tuple[Array, ...]


class MLPAdamState(NamedTuple):
    """Adam optimizer state for the MLP baseline."""

    m: MLPParams
    v: MLPParams
    step: Array


@dataclass(frozen=True)
class DatasetSplit:
    """Prepared image dataset split."""

    x_train: np.ndarray
    y_train: np.ndarray
    x_test: np.ndarray
    y_test: np.ndarray
    meta: dict[str, Any]


@dataclass(frozen=True)
class DemoConfig:
    """Configuration for the DiffEML image demo."""

    datasets: tuple[str, ...]
    seed: int
    train_fraction: float
    max_train: int
    max_test: int
    feature_mode: str
    input_bits: int
    pixel_thresholds: int
    layers: int
    width: int
    wiring_mode: str
    local_patch_size: int
    tree_stage_depths: tuple[int, ...]
    epochs: int
    batch_size: int
    step_size: float
    initial_temperature: float
    min_temperature: float
    entropy_weight: float
    head_l2: float
    gate_init_scale: float
    head_init_scale: float
    max_grad_norm: float
    eml_template_depth: int
    eml_eps: float
    gate_mode: str
    eml_threshold_temperature: float
    threshold_init_scale: float
    direction_init_scale: float
    hard_loss_weight: float
    input_drop_rate: float
    feature_drop_rate: float
    residual_gate: str
    residual_gate_bias: float
    head_mode: str
    group_sum_tau: float
    readout_entropy_weight: float
    readout_balance_weight: float
    packed_eval: bool
    compare_mlp: bool
    mlp_hidden_sizes: tuple[int, ...]
    mlp_epochs: int
    mlp_step_size: float
    mlp_weight_decay: float
    mlp_max_grad_norm: float
    mlp_init_scale: float


def json_default(value: Any) -> Any:
    """Convert NumPy and path objects for JSON serialization."""
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        return float(value)
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, Path):
        return str(value)
    raise TypeError(f"cannot serialize {type(value)!r}")


def _subset(
    x: np.ndarray,
    y: np.ndarray,
    *,
    max_samples: int,
    seed: int,
) -> tuple[np.ndarray, np.ndarray]:
    """Return a deterministic class-mixed subset."""
    if max_samples <= 0 or x.shape[0] <= max_samples:
        return x, y
    rng = np.random.default_rng(seed)
    indices = rng.permutation(x.shape[0])[:max_samples]
    return x[indices], y[indices]


def _split_and_cap(
    x: np.ndarray,
    y: np.ndarray,
    *,
    seed: int,
    train_fraction: float,
    max_train: int,
    max_test: int,
    meta: dict[str, Any],
) -> DatasetSplit:
    try:
        from sklearn.model_selection import train_test_split
    except ImportError as exc:  # pragma: no cover - optional dependency guard
        msg = "scikit-learn is required for this image demo"
        raise RuntimeError(msg) from exc

    x_train, x_test, y_train, y_test = train_test_split(
        x,
        y,
        train_size=train_fraction,
        random_state=seed,
        stratify=y,
    )
    x_train, y_train = _subset(x_train, y_train, max_samples=max_train, seed=seed + 1)
    x_test, y_test = _subset(x_test, y_test, max_samples=max_test, seed=seed + 2)
    return DatasetSplit(
        x_train=np.asarray(x_train, dtype=np.float32),
        y_train=np.asarray(y_train, dtype=np.int32),
        x_test=np.asarray(x_test, dtype=np.float32),
        y_test=np.asarray(y_test, dtype=np.int32),
        meta={
            **meta,
            "train_examples": int(x_train.shape[0]),
            "test_examples": int(x_test.shape[0]),
            "num_features": int(x.shape[1]),
            "num_classes": int(np.max(y) + 1),
        },
    )


def load_digits_dataset(config: DemoConfig) -> DatasetSplit:
    """Load sklearn's bundled 8x8 handwritten digits."""
    try:
        from sklearn.datasets import load_digits
    except ImportError as exc:  # pragma: no cover - optional dependency guard
        msg = "scikit-learn is required for digits"
        raise RuntimeError(msg) from exc

    digits = load_digits()
    x = np.asarray(digits.data, dtype=np.float32) / 16.0
    y = np.asarray(digits.target, dtype=np.int32)
    return _split_and_cap(
        x,
        y,
        seed=config.seed,
        train_fraction=config.train_fraction,
        max_train=config.max_train,
        max_test=config.max_test,
        meta={
            "dataset": "sklearn.datasets.load_digits",
            "source": "local",
            "image_shape": (8, 8, 1),
            "flat_order": "hwc",
        },
    )


def load_mnist_dataset(config: DemoConfig, data_home: Path) -> DatasetSplit:
    """Load MNIST from OpenML through scikit-learn."""
    try:
        from sklearn.datasets import fetch_openml
    except ImportError as exc:  # pragma: no cover - optional dependency guard
        msg = "scikit-learn is required for OpenML MNIST"
        raise RuntimeError(msg) from exc

    mnist = fetch_openml(
        "mnist_784",
        version=1,
        data_home=data_home,
        as_frame=False,
        parser="auto",
    )
    x = np.asarray(mnist.data, dtype=np.float32) / 255.0
    y = np.asarray(mnist.target, dtype=np.int32)
    return _split_and_cap(
        x,
        y,
        seed=config.seed,
        train_fraction=config.train_fraction,
        max_train=config.max_train,
        max_test=config.max_test,
        meta={
            "dataset": "openml/mnist_784",
            "source": "openml",
            "image_shape": (28, 28, 1),
            "flat_order": "hwc",
        },
    )


def _download_cifar10(cache_dir: Path) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    archive = cache_dir / "cifar-10-python.tar.gz"
    if archive.exists():
        return archive
    urllib.request.urlretrieve(CIFAR10_URL, archive)  # noqa: S310 - canonical public data URL
    return archive


def _load_cifar_batch(tar: tarfile.TarFile, member_name: str) -> tuple[np.ndarray, np.ndarray]:
    member = tar.getmember(f"cifar-10-batches-py/{member_name}")
    file_obj = tar.extractfile(member)
    if file_obj is None:
        raise RuntimeError(f"could not read {member_name} from CIFAR archive")
    with file_obj:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            payload = pickle.load(file_obj, encoding="latin1")  # noqa: S301
    x = np.asarray(payload["data"], dtype=np.float32) / 255.0
    y = np.asarray(payload["labels"], dtype=np.int32)
    return x, y


def load_cifar10_dataset(config: DemoConfig, cache_dir: Path) -> DatasetSplit:
    """Load CIFAR-10 from the canonical Toronto archive."""
    archive = _download_cifar10(cache_dir)
    with tarfile.open(archive, "r:gz") as tar:
        train_batches = [_load_cifar_batch(tar, f"data_batch_{idx}") for idx in range(1, 6)]
        test_x, test_y = _load_cifar_batch(tar, "test_batch")
    x_train = np.concatenate([batch[0] for batch in train_batches], axis=0)
    y_train = np.concatenate([batch[1] for batch in train_batches], axis=0)
    x_train, y_train = _subset(
        x_train,
        y_train,
        max_samples=config.max_train,
        seed=config.seed + 1,
    )
    x_test, y_test = _subset(
        test_x,
        test_y,
        max_samples=config.max_test,
        seed=config.seed + 2,
    )
    return DatasetSplit(
        x_train=x_train,
        y_train=y_train,
        x_test=x_test,
        y_test=y_test,
        meta={
            "dataset": "cifar-10-python",
            "source": CIFAR10_URL,
            "image_shape": (32, 32, 3),
            "flat_order": "chw",
            "train_examples": int(x_train.shape[0]),
            "test_examples": int(x_test.shape[0]),
            "num_features": int(x_train.shape[1]),
            "num_classes": 10,
        },
    )


def load_dataset(name: str, config: DemoConfig, data_dir: Path) -> DatasetSplit:
    """Load one requested dataset."""
    if name == "digits":
        return load_digits_dataset(config)
    if name == "mnist":
        return load_mnist_dataset(config, data_dir / "openml")
    if name == "cifar":
        return load_cifar10_dataset(config, data_dir / "cifar10")
    raise ValueError(f"unknown dataset: {name}")


def binarize_features(
    split: DatasetSplit,
    *,
    config: DemoConfig,
) -> tuple[np.ndarray, np.ndarray, dict[str, Any], FeatureLayout]:
    """Return binary image features plus coordinates for local EML wiring."""
    rows, cols, image_shape = feature_coordinates(split.meta, split.x_train.shape[1])
    if config.feature_mode == "variance_pixels":
        variances = np.var(split.x_train, axis=0)
        n_bits = min(config.input_bits, split.x_train.shape[1])
        selected = np.argsort(variances)[-n_bits:]
        selected = np.sort(selected)
        thresholds = np.median(split.x_train[:, selected], axis=0)
        x_train = (split.x_train[:, selected] > thresholds).astype(np.float32)
        x_test = (split.x_test[:, selected] > thresholds).astype(np.float32)
        selected_rows = rows[selected]
        selected_cols = cols[selected]
        bit_meta = {
            "feature_mode": config.feature_mode,
            "selected_bits": int(n_bits),
            "threshold": "train_feature_median",
            "mean_train_density": float(np.mean(x_train)),
            "mean_test_density": float(np.mean(x_test)),
        }
    elif config.feature_mode in {"threshold_pixels", "detector_thresholds"}:
        if config.feature_mode == "detector_thresholds":
            feature_values, rows, cols, detector_meta = detector_feature_values(split)
            train_values, test_values = feature_values
        else:
            train_values, test_values = split.x_train, split.x_test
            detector_meta = {}
        thresholds = np.linspace(
            1.0 / (config.pixel_thresholds + 1),
            config.pixel_thresholds / (config.pixel_thresholds + 1),
            config.pixel_thresholds,
            dtype=np.float32,
        )
        expanded_train = (train_values[:, :, None] > thresholds[None, None, :]).astype(np.float32)
        expanded_test = (test_values[:, :, None] > thresholds[None, None, :]).astype(np.float32)
        flat_train = expanded_train.reshape(train_values.shape[0], -1)
        flat_test = expanded_test.reshape(test_values.shape[0], -1)
        expanded_rows = np.repeat(rows, config.pixel_thresholds)
        expanded_cols = np.repeat(cols, config.pixel_thresholds)
        variances = np.var(flat_train, axis=0)
        n_bits = min(config.input_bits, flat_train.shape[1])
        selected = np.argsort(variances)[-n_bits:]
        selected = np.sort(selected)
        x_train = flat_train[:, selected]
        x_test = flat_test[:, selected]
        selected_rows = expanded_rows[selected]
        selected_cols = expanded_cols[selected]
        bit_meta = {
            "feature_mode": config.feature_mode,
            "pixel_thresholds": config.pixel_thresholds,
            "threshold_values": thresholds.tolist(),
            **detector_meta,
            "expanded_bits": int(flat_train.shape[1]),
            "selected_bits": int(n_bits),
            "threshold": "fixed_uniform_pixel_thresholds",
            "mean_train_density": float(np.mean(x_train)),
            "mean_test_density": float(np.mean(x_test)),
        }
    else:
        raise ValueError(
            "feature_mode must be 'variance_pixels', 'threshold_pixels', or 'detector_thresholds'"
        )
    return (
        x_train,
        x_test,
        bit_meta,
        FeatureLayout(
            rows=np.asarray(selected_rows, dtype=np.int32),
            cols=np.asarray(selected_cols, dtype=np.int32),
            image_shape=image_shape,
        ),
    )


def detector_feature_values(
    split: DatasetSplit,
) -> tuple[tuple[np.ndarray, np.ndarray], np.ndarray, np.ndarray, dict[str, Any]]:
    """Return fixed low-level detector values for binary logic inputs."""
    train_images = images_from_flat(split.x_train, split.meta)
    test_images = images_from_flat(split.x_test, split.meta)
    if train_images is None or test_images is None:
        raise ValueError("detector_thresholds requires image_shape metadata")
    train_features = detector_maps(train_images)
    test_features = detector_maps(test_images)
    height, width, n_maps = train_features.shape[1:]
    rows = np.repeat(np.arange(height, dtype=np.int32), width * n_maps)
    cols = np.tile(np.repeat(np.arange(width, dtype=np.int32), n_maps), height)
    return (
        (
            train_features.reshape(train_features.shape[0], -1),
            test_features.reshape(test_features.shape[0], -1),
        ),
        rows,
        cols,
        {
            "detector_maps": int(n_maps),
            "detector_features": int(height * width * n_maps),
            "detectors": [
                "raw",
                "abs_dx",
                "abs_dy",
                "abs_laplace",
                "abs_color_difference",
            ],
        },
    )


def images_from_flat(x: np.ndarray, meta: dict[str, Any]) -> np.ndarray | None:
    """Convert flattened dataset rows to NHWC images."""
    image_shape = meta.get("image_shape")
    if image_shape is None:
        return None
    height, width, channels = (int(value) for value in image_shape)
    if height * width * channels != x.shape[1]:
        return None
    flat_order = str(meta.get("flat_order", "hwc"))
    if flat_order == "chw":
        return x.reshape(x.shape[0], channels, height, width).transpose(0, 2, 3, 1)
    return x.reshape(x.shape[0], height, width, channels)


def detector_maps(images: np.ndarray) -> np.ndarray:
    """Compute fixed raw, edge, contrast, and color-difference maps."""
    right = np.concatenate((images[:, :, 1:, :], images[:, :, -1:, :]), axis=2)
    down = np.concatenate((images[:, 1:, :, :], images[:, -1:, :, :]), axis=1)
    left = np.concatenate((images[:, :, :1, :], images[:, :, :-1, :]), axis=2)
    up = np.concatenate((images[:, :1, :, :], images[:, :-1, :, :]), axis=1)
    dx = np.abs(right - images)
    dy = np.abs(down - images)
    laplace = np.clip(np.abs(4.0 * images - left - right - up - down) / 4.0, 0.0, 1.0)
    maps = [images, dx, dy, laplace]
    if images.shape[-1] >= 3:
        color_maps = [
            np.abs(images[..., 0:1] - images[..., 1:2]),
            np.abs(images[..., 0:1] - images[..., 2:3]),
            np.abs(images[..., 1:2] - images[..., 2:3]),
        ]
        maps.extend(color_maps)
    return np.concatenate(maps, axis=-1).astype(np.float32)


def feature_coordinates(
    meta: dict[str, Any],
    n_features: int,
) -> tuple[np.ndarray, np.ndarray, tuple[int, int, int] | None]:
    """Return image-row and image-column coordinates for flat pixels."""
    image_shape = meta.get("image_shape")
    if image_shape is None:
        return np.arange(n_features, dtype=np.int32), np.zeros(n_features, dtype=np.int32), None
    height, width, channels = (int(value) for value in image_shape)
    if height * width * channels != n_features:
        return np.arange(n_features, dtype=np.int32), np.zeros(n_features, dtype=np.int32), None
    flat_order = str(meta.get("flat_order", "hwc"))
    rows: list[int] = []
    cols: list[int] = []
    if flat_order == "chw":
        for _channel in range(channels):
            for row in range(height):
                for col in range(width):
                    rows.append(row)
                    cols.append(col)
    else:
        for row in range(height):
            for col in range(width):
                for _channel in range(channels):
                    rows.append(row)
                    cols.append(col)
    return (
        np.asarray(rows, dtype=np.int32),
        np.asarray(cols, dtype=np.int32),
        (height, width, channels),
    )


def make_wiring(
    key: Array,
    *,
    input_dim: int,
    layers: int,
    width: int,
    mode: str,
    n_classes: int | None = None,
    feature_layout: FeatureLayout | None = None,
    local_patch_size: int = 3,
    tree_stage_depths: tuple[int, ...] = (2, 2, 2, 2),
    or_gate_index: int | None = None,
) -> CircuitWiring:
    """Create fixed source wiring for a DiffEML circuit."""
    if mode in {"local", "local_hierarchy", "local_tree_hierarchy"}:
        if feature_layout is None:
            raise ValueError("local wiring requires feature layout metadata")
        if mode == "local_tree_hierarchy":
            if or_gate_index is None:
                raise ValueError("local_tree_hierarchy requires an OR gate index")
            return make_local_tree_hierarchy_wiring(
                key,
                input_dim=input_dim,
                width=width,
                feature_layout=feature_layout,
                local_patch_size=local_patch_size,
                stage_depths=tree_stage_depths,
                or_gate_index=or_gate_index,
            )
        return make_local_wiring(
            key,
            input_dim=input_dim,
            layers=layers,
            width=width,
            mode=mode,
            feature_layout=feature_layout,
            local_patch_size=local_patch_size,
        )
    if mode not in {
        "random",
        "residual_random",
        "butterfly",
        "benes",
        "permuted_butterfly",
        "permuted_benes",
        "class_bank_random",
        "affine_expander",
        "butterfly_class_bank",
    }:
        raise ValueError(
            "mode must be 'random', 'residual_random', 'butterfly', 'benes', "
            "'permuted_butterfly', 'permuted_benes', 'local', 'local_hierarchy', "
            "'local_tree_hierarchy', 'class_bank_random', 'affine_expander', "
            "or 'butterfly_class_bank'"
        )
    if mode == "class_bank_random":
        if n_classes is None:
            raise ValueError("class_bank_random requires n_classes")
        return make_class_bank_random_wiring(
            key,
            input_dim=input_dim,
            layers=layers,
            width=width,
            n_classes=n_classes,
        )
    if mode == "affine_expander":
        return make_affine_expander_wiring(input_dim=input_dim, layers=layers, width=width)
    if mode == "butterfly_class_bank":
        if n_classes is None:
            raise ValueError("butterfly_class_bank requires n_classes")
        return make_butterfly_class_bank_wiring(
            input_dim=input_dim,
            layers=layers,
            width=width,
            n_classes=n_classes,
        )
    left: list[Array] = []
    right: list[Array] = []
    strides = butterfly_strides(width)
    is_benes = mode in {"benes", "permuted_benes"}
    if is_benes:
        schedule = (*strides, *tuple(reversed(strides[:-1])))
    else:
        schedule = strides
    wire_order = np.arange(width, dtype=np.int32)
    if mode.startswith("permuted_"):
        key, perm_key = jr.split(key)
        wire_order = np.asarray(jr.permutation(perm_key, width), dtype=np.int32)
    for layer_idx in range(layers):
        source_dim = input_dim + 1 + (width if layer_idx > 0 else 0)
        if mode == "random":
            key, left_key, right_key = jr.split(key, 3)
            left.append(jr.randint(left_key, (width,), minval=0, maxval=source_dim))
            right.append(jr.randint(right_key, (width,), minval=0, maxval=source_dim))
        elif mode == "residual_random":
            key, left_key, right_key = jr.split(key, 3)
            if layer_idx == 0:
                left.append(jr.randint(left_key, (width,), minval=0, maxval=input_dim + 1))
                right.append(jr.randint(right_key, (width,), minval=0, maxval=input_dim + 1))
            else:
                prev_start = input_dim + 1
                left.append(prev_start + jr.randint(left_key, (width,), minval=0, maxval=width))
                right.append(jr.randint(right_key, (width,), minval=0, maxval=input_dim + 1))
        elif layer_idx == 0:
            indices = np.arange(width, dtype=np.int32)
            partner = butterfly_partner_indices(width, schedule[layer_idx % len(schedule)])
            left.append(jnp.asarray(wire_order[indices] % input_dim, dtype=jnp.int32))
            right.append(jnp.asarray(wire_order[partner] % input_dim, dtype=jnp.int32))
        else:
            indices = np.arange(width, dtype=np.int32)
            prev_start = input_dim + 1
            partner = butterfly_partner_indices(width, schedule[layer_idx % len(schedule)])
            left.append(jnp.asarray(prev_start + wire_order[indices], dtype=jnp.int32))
            right.append(jnp.asarray(prev_start + wire_order[partner], dtype=jnp.int32))
    return CircuitWiring(
        left=tuple(left),
        right=tuple(right),
        fixed_gate_indices=(None,) * len(left),
        fixed_gate_masks=(None,) * len(left),
        meta={"mode": mode},
    )


def make_affine_expander_wiring(
    *,
    input_dim: int,
    layers: int,
    width: int,
) -> CircuitWiring:
    """Create deterministic degree-2 modular-affine sparse wiring."""
    if input_dim <= 0:
        raise ValueError("input_dim must be positive")
    if layers <= 0:
        raise ValueError("layers must be positive")
    if width <= 0:
        raise ValueError("width must be positive")
    descriptor_int_bytes = byte_count_for_value(max(input_dim, width))
    descriptor_bytes = 4 * descriptor_int_bytes
    left: list[Array] = []
    right: list[Array] = []
    descriptors: list[dict[str, int | str]] = []
    indices = np.arange(width, dtype=np.int32)
    for layer_idx in range(layers):
        modulus = input_dim if layer_idx == 0 else width
        left_multiplier = coprime_at_least(2 * layer_idx + 1, modulus)
        right_multiplier = coprime_at_least(2 * layer_idx + 3, modulus)
        left_offset = (layer_idx * 17 + 1) % modulus
        right_offset = (layer_idx * 31 + 7) % modulus
        layer_left = (left_multiplier * indices + left_offset) % modulus
        layer_right = (right_multiplier * indices + right_offset) % modulus
        if layer_idx > 0:
            prev_start = input_dim + 1
            layer_left = prev_start + layer_left
            layer_right = prev_start + layer_right
        left.append(jnp.asarray(layer_left, dtype=jnp.int32))
        right.append(jnp.asarray(layer_right, dtype=jnp.int32))
        descriptors.append(
            {
                "layer": layer_idx,
                "source": "input" if layer_idx == 0 else "previous_layer",
                "modulus": modulus,
                "left_multiplier": left_multiplier,
                "left_offset": left_offset,
                "right_multiplier": right_multiplier,
                "right_offset": right_offset,
                "wiring_storage_bytes": descriptor_bytes,
            }
        )
    return CircuitWiring(
        left=tuple(left),
        right=tuple(right),
        fixed_gate_indices=(None,) * len(left),
        fixed_gate_masks=(None,) * len(left),
        meta={
            "mode": "affine_expander",
            "deterministic_wiring": True,
            "wiring_storage_mode": "affine_mod_descriptor",
            "deployed_wiring_bytes": descriptor_bytes * layers,
            "layer_descriptors": descriptors,
        },
    )


def make_butterfly_class_bank_wiring(
    *,
    input_dim: int,
    layers: int,
    width: int,
    n_classes: int,
) -> CircuitWiring:
    """Create executable global butterfly mixers plus class-local banks."""
    if input_dim <= 0:
        raise ValueError("input_dim must be positive")
    if layers <= 0:
        raise ValueError("layers must be positive")
    if width <= 0:
        raise ValueError("width must be positive")
    if n_classes <= 0:
        raise ValueError("n_classes must be positive")
    mixer_layers = max(0, layers - 1)
    class_bank_layers = layers - mixer_layers
    strides = butterfly_strides(width)
    bank_width = int(np.ceil(width / n_classes))
    stride_bytes = byte_count_for_value(max(max(strides), bank_width))
    left: list[Array] = []
    right: list[Array] = []
    layer_kinds: list[str] = []
    descriptors: list[dict[str, int | bool | str]] = []
    indices = np.arange(width, dtype=np.int32)
    for layer_idx in range(layers):
        if layer_idx < mixer_layers:
            stride = strides[layer_idx % len(strides)]
            partner = butterfly_partner_indices(width, stride)
            kind = "butterfly_mixer"
            class_bank = False
        else:
            bank_idx = layer_idx - mixer_layers
            stride = bank_butterfly_stride(bank_width, bank_idx)
            partner = bank_butterfly_partner_indices(
                width,
                n_classes=n_classes,
                bank_width=bank_width,
                stride=stride,
            )
            kind = "class_bank_butterfly"
            class_bank = True
        if layer_idx == 0:
            layer_left = indices % input_dim
            layer_right = partner % input_dim
        else:
            prev_start = input_dim + 1
            layer_left = prev_start + indices
            layer_right = prev_start + partner
        left.append(jnp.asarray(layer_left, dtype=jnp.int32))
        right.append(jnp.asarray(layer_right, dtype=jnp.int32))
        layer_kinds.append(f"{kind}_{layer_idx}")
        descriptors.append(
            {
                "layer": layer_idx,
                "kind": kind,
                "stride": int(stride),
                "class_bank": class_bank,
                "bank_width": bank_width,
                "wiring_storage_bytes": stride_bytes,
            }
        )
    return CircuitWiring(
        left=tuple(left),
        right=tuple(right),
        fixed_gate_indices=(None,) * len(left),
        fixed_gate_masks=(None,) * len(left),
        meta={
            "mode": "butterfly_class_bank",
            "deterministic_wiring": True,
            "mixer_layers": mixer_layers,
            "class_bank_layers": class_bank_layers,
            "bank_width": bank_width,
            "layer_kinds": layer_kinds,
            "wiring_storage_mode": "implicit_butterfly_and_bank_strides",
            "deployed_wiring_bytes": stride_bytes * layers,
            "layer_descriptors": descriptors,
        },
    )


def make_local_wiring(
    key: Array,
    *,
    input_dim: int,
    layers: int,
    width: int,
    mode: str,
    feature_layout: FeatureLayout,
    local_patch_size: int,
) -> CircuitWiring:
    """Create image-local wiring for EML gate-tree convolution experiments."""
    if feature_layout.image_shape is None:
        raise ValueError("local wiring requires an image-shaped dataset")
    height, image_width, _channels = feature_layout.image_shape
    seed = int(
        np.asarray(
            jr.randint(
                key,
                (),
                minval=0,
                maxval=np.iinfo(np.int32).max,
                dtype=jnp.int32,
            )
        )
    )
    rng = np.random.default_rng(seed)
    left: list[Array] = []
    right: list[Array] = []
    layer_shapes: list[tuple[int, int]] = []
    previous_rows: np.ndarray | None = None
    previous_cols: np.ndarray | None = None
    radius = local_patch_size // 2

    for layer_idx in range(layers):
        grid_height, grid_width = local_layer_grid_shape(
            height,
            image_width,
            layer_idx=layer_idx,
            mode=mode,
        )
        layer_shapes.append((grid_height, grid_width))
        output_rows, output_cols = repeated_grid_coordinates(
            grid_height,
            grid_width,
            width,
            rng,
        )
        if layer_idx == 0:
            source_rows = feature_layout.rows
            source_cols = feature_layout.cols
            source_offset = 0
            source_height = height
            source_width = image_width
        else:
            if previous_rows is None or previous_cols is None:
                raise RuntimeError("previous local coordinates were not initialized")
            source_rows = previous_rows
            source_cols = previous_cols
            source_offset = input_dim + 1
            source_height, source_width = layer_shapes[layer_idx - 1]

        layer_left, layer_right = local_source_pairs(
            rng,
            output_rows=output_rows,
            output_cols=output_cols,
            output_grid=(grid_height, grid_width),
            source_rows=source_rows,
            source_cols=source_cols,
            source_grid=(source_height, source_width),
            source_offset=source_offset,
            radius=radius,
        )
        left.append(jnp.asarray(layer_left, dtype=jnp.int32))
        right.append(jnp.asarray(layer_right, dtype=jnp.int32))
        previous_rows = output_rows
        previous_cols = output_cols

    return CircuitWiring(
        left=tuple(left),
        right=tuple(right),
        fixed_gate_indices=(None,) * len(left),
        fixed_gate_masks=(None,) * len(left),
        meta={
            "mode": mode,
            "local_patch_size": local_patch_size,
            "layer_grid_shapes": [[int(h), int(w)] for h, w in layer_shapes],
        },
    )


def class_bank_ids(width: int, n_classes: int) -> np.ndarray:
    """Return the group-sum class bank id for each final feature column."""
    if width <= 0:
        raise ValueError("width must be positive")
    if n_classes <= 0:
        raise ValueError("n_classes must be positive")
    bank_width = max(1, width // n_classes)
    usable_width = bank_width * n_classes
    ids = np.arange(width, dtype=np.int32) // bank_width
    ids = np.minimum(ids, n_classes - 1)
    if usable_width < width:
        ids[usable_width:] = n_classes - 1
    return ids.astype(np.int32)


def make_class_bank_random_wiring(
    key: Array,
    *,
    input_dim: int,
    layers: int,
    width: int,
    n_classes: int,
) -> CircuitWiring:
    """Create random/global mixers followed by class-specific Boolean banks.

    The final one or two layers are grouped into the same contiguous class
    banks consumed by ``group_sum``. This keeps deployment as popcount readout
    while giving training deeper class-specific feature construction.
    """
    if layers <= 0:
        raise ValueError("layers must be positive")
    if n_classes <= 0:
        raise ValueError("n_classes must be positive")
    key, seed_key = jr.split(key)
    seed = int(
        np.asarray(
            jr.randint(
                seed_key,
                (),
                minval=0,
                maxval=np.iinfo(np.int32).max,
                dtype=jnp.int32,
            )
        )
    )
    rng = np.random.default_rng(seed)
    left: list[Array] = []
    right: list[Array] = []
    generic_layers = max(0, layers - 2)
    bank_ids = class_bank_ids(width, n_classes)
    class_indices = [
        np.flatnonzero(bank_ids == class_idx).astype(np.int32) for class_idx in range(n_classes)
    ]
    for layer_idx in range(layers):
        source_dim = input_dim + 1 + (width if layer_idx > 0 else 0)
        if layer_idx < generic_layers:
            left_indices = rng.integers(0, source_dim, size=width, dtype=np.int32)
            right_indices = rng.integers(0, source_dim, size=width, dtype=np.int32)
        elif layer_idx == 0:
            left_indices = rng.integers(0, input_dim + 1, size=width, dtype=np.int32)
            right_indices = rng.integers(0, input_dim + 1, size=width, dtype=np.int32)
        elif layer_idx == generic_layers:
            prev_start = input_dim + 1
            left_indices = prev_start + rng.integers(0, width, size=width, dtype=np.int32)
            right_indices = rng.integers(0, input_dim + 1, size=width, dtype=np.int32)
        else:
            prev_start = input_dim + 1
            left_indices = np.full((width,), -1, dtype=np.int32)
            right_indices = rng.integers(0, input_dim + 1, size=width, dtype=np.int32)
            for _class_idx, indices in enumerate(class_indices):
                if indices.shape[0] == 0:
                    continue
                sampled = rng.choice(indices, size=indices.shape[0], replace=True)
                left_indices[indices] = prev_start + sampled.astype(np.int32)
            if np.any(left_indices < 0):
                fallback = rng.integers(0, width, size=width, dtype=np.int32)
                left_indices = np.where(left_indices < 0, prev_start + fallback, left_indices)
        left.append(jnp.asarray(left_indices, dtype=jnp.int32))
        right.append(jnp.asarray(right_indices, dtype=jnp.int32))
    return CircuitWiring(
        left=tuple(left),
        right=tuple(right),
        fixed_gate_indices=(None,) * len(left),
        fixed_gate_masks=(None,) * len(left),
        meta={
            "mode": "class_bank_random",
            "generic_layers": generic_layers,
            "class_bank_layers": layers - generic_layers,
            "n_classes": n_classes,
            "bank_width": int(max(1, width // n_classes)),
        },
    )


def make_local_tree_hierarchy_wiring(
    key: Array,
    *,
    input_dim: int,
    width: int,
    feature_layout: FeatureLayout,
    local_patch_size: int,
    stage_depths: tuple[int, ...],
    or_gate_index: int,
) -> CircuitWiring:
    """Create C-DLGN-style local EML tree convolutions with fixed OR pooling."""
    if feature_layout.image_shape is None:
        raise ValueError("local tree wiring requires an image-shaped dataset")
    height, image_width, _channels = feature_layout.image_shape
    seed = int(
        np.asarray(
            jr.randint(
                key,
                (),
                minval=0,
                maxval=np.iinfo(np.int32).max,
                dtype=jnp.int32,
            )
        )
    )
    rng = np.random.default_rng(seed)
    left: list[Array] = []
    right: list[Array] = []
    fixed_gate_indices: list[int | None] = []
    fixed_gate_masks: list[int | None] = []
    layer_kinds: list[str] = []
    layer_shapes: list[tuple[int, int]] = []
    radius = local_patch_size // 2
    source_rows = feature_layout.rows
    source_cols = feature_layout.cols
    source_grid = (height, image_width)
    source_offset = 0

    for stage_idx, stage_depth in enumerate(stage_depths):
        grid = local_layer_grid_shape(
            height,
            image_width,
            layer_idx=stage_idx,
            mode="local_hierarchy",
        )
        previous_rows: np.ndarray | None = None
        previous_cols: np.ndarray | None = None
        for tree_idx in range(stage_depth):
            output_rows, output_cols = repeated_grid_coordinates(grid[0], grid[1], width, rng)
            if tree_idx == 0:
                candidate_rows = source_rows
                candidate_cols = source_cols
                candidate_grid = source_grid
                candidate_offset = source_offset
                candidate_radius = radius
            else:
                if previous_rows is None or previous_cols is None:
                    raise RuntimeError("previous tree coordinates were not initialized")
                candidate_rows = previous_rows
                candidate_cols = previous_cols
                candidate_grid = grid
                candidate_offset = input_dim + 1
                candidate_radius = 0
            layer_left, layer_right = local_source_pairs(
                rng,
                output_rows=output_rows,
                output_cols=output_cols,
                output_grid=grid,
                source_rows=candidate_rows,
                source_cols=candidate_cols,
                source_grid=candidate_grid,
                source_offset=candidate_offset,
                radius=candidate_radius,
            )
            left.append(jnp.asarray(layer_left, dtype=jnp.int32))
            right.append(jnp.asarray(layer_right, dtype=jnp.int32))
            fixed_gate_indices.append(None)
            fixed_gate_masks.append(None)
            layer_kinds.append(f"stage{stage_idx}_tree{tree_idx}")
            layer_shapes.append(grid)
            previous_rows = output_rows
            previous_cols = output_cols

        if previous_rows is None or previous_cols is None:
            raise RuntimeError("tree stage produced no coordinates")
        source_rows = previous_rows
        source_cols = previous_cols
        source_grid = grid
        source_offset = input_dim + 1
        if stage_idx < len(stage_depths) - 1:
            pooled_grid = local_layer_grid_shape(
                height,
                image_width,
                layer_idx=stage_idx + 1,
                mode="local_hierarchy",
            )
            output_rows, output_cols = repeated_grid_coordinates(
                pooled_grid[0],
                pooled_grid[1],
                width,
                rng,
            )
            layer_left, layer_right = local_source_pairs(
                rng,
                output_rows=output_rows,
                output_cols=output_cols,
                output_grid=pooled_grid,
                source_rows=source_rows,
                source_cols=source_cols,
                source_grid=source_grid,
                source_offset=source_offset,
                radius=0,
            )
            left.append(jnp.asarray(layer_left, dtype=jnp.int32))
            right.append(jnp.asarray(layer_right, dtype=jnp.int32))
            fixed_gate_indices.append(or_gate_index)
            fixed_gate_masks.append(14)
            layer_kinds.append(f"stage{stage_idx}_or_pool")
            layer_shapes.append(pooled_grid)
            source_rows = output_rows
            source_cols = output_cols
            source_grid = pooled_grid

    return CircuitWiring(
        left=tuple(left),
        right=tuple(right),
        fixed_gate_indices=tuple(fixed_gate_indices),
        fixed_gate_masks=tuple(fixed_gate_masks),
        meta={
            "mode": "local_tree_hierarchy",
            "local_patch_size": local_patch_size,
            "tree_stage_depths": list(stage_depths),
            "or_pool_layers": int(max(0, len(stage_depths) - 1)),
            "layer_kinds": layer_kinds,
            "layer_grid_shapes": [[int(h), int(w)] for h, w in layer_shapes],
        },
    )


def local_layer_grid_shape(
    height: int,
    width: int,
    *,
    layer_idx: int,
    mode: str,
) -> tuple[int, int]:
    """Return the spatial grid used by one local EML layer."""
    if mode == "local":
        stage = 0
    else:
        stage = layer_idx
    stride = 2**stage
    return max(1, int(np.ceil(height / stride))), max(1, int(np.ceil(width / stride)))


def repeated_grid_coordinates(
    height: int,
    width: int,
    n_nodes: int,
    rng: np.random.Generator,
) -> tuple[np.ndarray, np.ndarray]:
    """Assign fixed-width layer nodes to spatial grid cells."""
    n_cells = height * width
    cells = np.arange(n_nodes, dtype=np.int32) % n_cells
    cells = rng.permutation(cells)
    return (cells // width).astype(np.int32), (cells % width).astype(np.int32)


def local_source_pairs(
    rng: np.random.Generator,
    *,
    output_rows: np.ndarray,
    output_cols: np.ndarray,
    output_grid: tuple[int, int],
    source_rows: np.ndarray,
    source_cols: np.ndarray,
    source_grid: tuple[int, int],
    source_offset: int,
    radius: int,
) -> tuple[np.ndarray, np.ndarray]:
    """Sample two source indices from each node's local receptive field."""
    left = np.empty(output_rows.shape[0], dtype=np.int32)
    right = np.empty(output_rows.shape[0], dtype=np.int32)
    fallback = np.arange(source_rows.shape[0], dtype=np.int32)
    for idx, (row, col) in enumerate(zip(output_rows, output_cols)):
        candidates = local_candidates(
            int(row),
            int(col),
            output_grid=output_grid,
            source_rows=source_rows,
            source_cols=source_cols,
            source_grid=source_grid,
            radius=radius,
        )
        if candidates.shape[0] == 0:
            candidates = fallback
        picks = rng.choice(candidates, size=2, replace=True)
        left[idx] = source_offset + int(picks[0])
        right[idx] = source_offset + int(picks[1])
    return left, right


def local_candidates(
    row: int,
    col: int,
    *,
    output_grid: tuple[int, int],
    source_rows: np.ndarray,
    source_cols: np.ndarray,
    source_grid: tuple[int, int],
    radius: int,
) -> np.ndarray:
    """Return source nodes that fall in a mapped local spatial window."""
    output_height, output_width = output_grid
    source_height, source_width = source_grid
    row_low = int(np.floor(row * source_height / output_height)) - radius
    row_high = int(np.ceil((row + 1) * source_height / output_height)) + radius
    col_low = int(np.floor(col * source_width / output_width)) - radius
    col_high = int(np.ceil((col + 1) * source_width / output_width)) + radius
    mask = (
        (source_rows >= max(0, row_low))
        & (source_rows < min(source_height, row_high))
        & (source_cols >= max(0, col_low))
        & (source_cols < min(source_width, col_high))
    )
    return np.flatnonzero(mask).astype(np.int32)


def butterfly_strides(width: int) -> tuple[int, ...]:
    """Return power-of-two butterfly strides below ``width``."""
    if width < 2:
        return (1,)
    return tuple(2**idx for idx in range(int(np.ceil(np.log2(width)))))


def butterfly_partner_indices(width: int, stride: int) -> np.ndarray:
    """Pair indices inside stride-sized butterfly blocks.

    For power-of-two widths this is the usual butterfly pairing. For a final
    partial block, dangling indices pair with themselves rather than wrapping
    across the truncated block.
    """
    indices = np.arange(width, dtype=np.int32)
    block = 2 * stride
    offsets = indices % block
    partners = indices - offsets + ((offsets + stride) % block)
    return np.where(partners < width, partners, indices).astype(np.int32)


def bank_butterfly_stride(bank_width: int, layer_idx: int) -> int:
    """Return a power-of-two class-bank butterfly stride."""
    if bank_width <= 1:
        return 1
    depth = int(np.ceil(np.log2(bank_width)))
    return 2 ** (layer_idx % max(1, depth))


def bank_butterfly_partner_indices(
    width: int,
    *,
    n_classes: int,
    bank_width: int,
    stride: int,
) -> np.ndarray:
    """Return butterfly partners constrained within each class bank."""
    partners = np.empty((width,), dtype=np.int32)
    block = 2 * stride
    for idx in range(width):
        bank_idx = min(n_classes - 1, idx // bank_width)
        bank_start = bank_idx * bank_width
        bank_end = min(width, bank_start + bank_width)
        offset = idx - bank_start
        partner = bank_start + offset - (offset % block) + ((offset + stride) % block)
        partners[idx] = partner if partner < bank_end else idx
    return partners


def byte_count_for_value(value: int) -> int:
    """Return the minimum whole bytes needed to store nonnegative ``value``."""
    if value < 0:
        raise ValueError("value must be nonnegative")
    return max(1, (int(value).bit_length() + 7) // 8)


def coprime_at_least(start: int, modulus: int) -> int:
    """Return the first integer at least ``start`` and coprime to ``modulus``."""
    if modulus <= 0:
        raise ValueError("modulus must be positive")
    candidate = max(1, start)
    while int(np.gcd(candidate, modulus)) != 1:
        candidate += 1
    return candidate


def residual_gate_index(name: str, masks: tuple[int, ...]) -> int | None:
    """Return the selector index for a residual-friendly Boolean gate."""
    if name == "none":
        return None
    mask_by_name = {
        "right": 10,
        "left": 12,
        "or": 14,
    }
    if name not in mask_by_name:
        raise ValueError("residual_gate must be 'none', 'left', 'right', or 'or'")
    return masks.index(mask_by_name[name])


def init_params(
    key: Array,
    *,
    layers: int,
    width: int,
    n_gates: int,
    n_classes: int,
    gate_mode: str,
    gate_init_scale: float,
    threshold_init_scale: float,
    direction_init_scale: float,
    head_init_scale: float,
    residual_gate_index: int | None,
    residual_gate_bias: float,
    head_mode: str = "linear",
) -> CircuitParams:
    """Initialize DiffEML gate selectors and classifier head."""
    gate_logits: list[Array] | None = None
    threshold_logits: list[Array] | None = None
    direction_logits: list[Array] | None = None
    if gate_mode == "eml_threshold":
        threshold_logits = []
        direction_logits = []
        for _ in range(layers):
            key, threshold_key, direction_key = jr.split(key, 3)
            threshold_logits.append(
                threshold_init_scale * jr.normal(threshold_key, (width,), dtype=jnp.float32)
            )
            direction_logits.append(
                direction_init_scale * jr.normal(direction_key, (width,), dtype=jnp.float32)
            )
    else:
        gate_logits = []
        for _ in range(layers):
            key, gate_key = jr.split(key)
            logits = gate_init_scale * jr.normal(gate_key, (width, n_gates), dtype=jnp.float32)
            if residual_gate_index is not None and residual_gate_bias > 0.0:
                logits = logits.at[:, residual_gate_index].add(residual_gate_bias)
            gate_logits.append(logits)
    key, head_key = jr.split(key)
    head_columns = 2 * n_classes if head_mode == "signed_class_vote" else n_classes
    head_w = (
        head_init_scale
        * jr.normal(head_key, (width, head_columns), dtype=jnp.float32)
        / jnp.sqrt(jnp.array(width, dtype=jnp.float32))
    )
    head_b = jnp.zeros((n_classes,), dtype=jnp.float32)
    return CircuitParams(
        gate_logits=None if gate_logits is None else tuple(gate_logits),
        threshold_logits=None if threshold_logits is None else tuple(threshold_logits),
        direction_logits=None if direction_logits is None else tuple(direction_logits),
        head_w=head_w,
        head_b=head_b,
    )


def _adam_zeros(params: CircuitParams) -> CircuitParams:
    return jax.tree_util.tree_map(jnp.zeros_like, params)


def init_adam(params: CircuitParams) -> AdamState:
    """Initialize Adam state."""
    return AdamState(
        m=_adam_zeros(params),
        v=_adam_zeros(params),
        step=jnp.array(0, dtype=jnp.int32),
    )


def gate_multilinear(truth_tables: Array, left: Array, right: Array) -> Array:
    """Evaluate two-input truth tables on soft or hard inputs."""
    t00 = truth_tables[..., 0]
    t01 = truth_tables[..., 1]
    t10 = truth_tables[..., 2]
    t11 = truth_tables[..., 3]
    return (
        t00 * (1.0 - left) * (1.0 - right)
        + t01 * (1.0 - left) * right
        + t10 * left * (1.0 - right)
        + t11 * left * right
    )


def eml_boolean_threshold_range(eps: float) -> tuple[float, float]:
    """Return the useful EML threshold range for Boolean-like inputs."""
    low = float(np.exp(0.0) - np.log(eps + 1.0))
    high = float(np.exp(1.0) - np.log(eps))
    return low, high


def eml_threshold_node(
    left: Array,
    right: Array,
    threshold_logits: Array,
    direction_logits: Array,
    *,
    eps: float,
    threshold_temperature: Array,
    hard: bool,
) -> Array:
    """Evaluate a compressed raw EML-threshold node.

    This mode has one executable EML operation, one learned threshold, and one
    learned direction per circuit node. It is less expressive per node than the
    depth-2 template bank, but it is the most direct EML-circuit relaxation.
    """
    threshold_low, threshold_high = eml_boolean_threshold_range(eps)
    threshold = threshold_low + (threshold_high - threshold_low) * jax.nn.sigmoid(threshold_logits)
    eml_value = jnp.exp(jnp.clip(left, -8.0, 8.0)) - jnp.log(eps + jnp.clip(right, 0.0, 1.0))
    margin = (eml_value - threshold[None, :]) / threshold_temperature
    if hard:
        ge = (margin >= 0.0).astype(jnp.float32)
        le = (margin <= 0.0).astype(jnp.float32)
        use_ge = direction_logits >= 0.0
        return jnp.where(use_ge[None, :], ge, le)
    direction_prob = jax.nn.sigmoid(direction_logits)[None, :]
    ge_soft = jax.nn.sigmoid(margin)
    le_soft = jax.nn.sigmoid(-margin)
    return direction_prob * ge_soft + (1.0 - direction_prob) * le_soft


def circuit_features(
    params: CircuitParams,
    x_bits: Array,
    wiring: CircuitWiring,
    library_outputs: Array,
    template_bank: EMLTemplateBank,
    temperature: Array,
    config: DemoConfig,
    *,
    hard: bool,
) -> Array:
    """Return relaxed or hardened DiffEML circuit features."""
    previous: Array | None = None
    for layer_idx in range(len(wiring.left)):
        one = jnp.ones((x_bits.shape[0], 1), dtype=x_bits.dtype)
        sources = (
            jnp.concatenate((x_bits, one), axis=1)
            if previous is None
            else jnp.concatenate((x_bits, one, previous), axis=1)
        )
        left = sources[:, wiring.left[layer_idx]]
        right = sources[:, wiring.right[layer_idx]]
        fixed_gate_mask = wiring.fixed_gate_masks[layer_idx]
        if fixed_gate_mask == 14:
            previous = jnp.maximum(left, right)
        elif config.gate_mode == "eml_threshold":
            if params.threshold_logits is None or params.direction_logits is None:
                raise ValueError("eml_threshold mode requires threshold and direction logits")
            previous = eml_threshold_node(
                left,
                right,
                params.threshold_logits[layer_idx],
                params.direction_logits[layer_idx],
                eps=config.eml_eps,
                threshold_temperature=jnp.array(
                    config.eml_threshold_temperature,
                    dtype=jnp.float32,
                ),
                hard=hard,
            )
        elif config.gate_mode == "truth_table":
            fixed_gate_index = wiring.fixed_gate_indices[layer_idx]
            if params.gate_logits is None:
                raise ValueError("truth_table mode requires gate logits")
            gate_logits = params.gate_logits[layer_idx]
            if fixed_gate_index is not None:
                truth_tables = jnp.broadcast_to(
                    library_outputs[fixed_gate_index],
                    (left.shape[1], library_outputs.shape[1]),
                )
            elif hard:
                selected = jnp.argmax(gate_logits, axis=-1)
                truth_tables = library_outputs[selected]
            else:
                probs = jax.nn.softmax(gate_logits / temperature, axis=-1)
                truth_tables = jnp.einsum("wg,gk->wk", probs, library_outputs)
            previous = gate_multilinear(truth_tables[None, :, :], left, right)
        else:
            fixed_gate_index = wiring.fixed_gate_indices[layer_idx]
            if params.gate_logits is None:
                raise ValueError("eml_template mode requires gate logits")
            gate_logits = params.gate_logits[layer_idx]
            template_values = evaluate_eml_template_bank(
                template_bank,
                left,
                right,
                eps=config.eml_eps,
                threshold_temperature=jnp.array(
                    config.eml_threshold_temperature,
                    dtype=jnp.float32,
                ),
                hard=hard,
            )
            if fixed_gate_index is not None:
                previous = template_values[..., fixed_gate_index]
            elif hard:
                selected = jnp.argmax(gate_logits, axis=-1)
                previous = jnp.squeeze(
                    jnp.take_along_axis(
                        template_values,
                        selected[None, :, None],
                        axis=-1,
                    ),
                    axis=-1,
                )
            else:
                probs = jax.nn.softmax(gate_logits / temperature, axis=-1)
                previous = jnp.einsum("bwg,wg->bw", template_values, probs)
        if hard:
            previous = (previous >= 0.5).astype(jnp.float32)
    if previous is None:
        raise RuntimeError("at least one layer is required")
    return previous


def forward(
    params: CircuitParams,
    x_bits: Array,
    wiring: CircuitWiring,
    library_outputs: Array,
    template_bank: EMLTemplateBank,
    temperature: Array,
    config: DemoConfig,
    *,
    hard: bool,
) -> Array:
    """Forward pass through the relaxed or hardened DiffEML circuit."""
    features = circuit_features(
        params,
        x_bits,
        wiring,
        library_outputs,
        template_bank,
        temperature,
        config,
        hard=hard,
    )
    return classifier_logits(params, features, config, hard=hard)


def classifier_logits(
    params: CircuitParams,
    features: Array,
    config: DemoConfig,
    *,
    hard: bool = False,
) -> Array:
    """Map final EML features to class logits."""
    if config.head_mode == "group_sum":
        n_classes = params.head_b.shape[0]
        usable_width = (features.shape[1] // n_classes) * n_classes
        grouped = jnp.reshape(features[:, :usable_width], (features.shape[0], n_classes, -1))
        return jnp.sum(grouped, axis=-1) / config.group_sum_tau
    if config.head_mode == "class_vote":
        n_classes = params.head_b.shape[0]
        soft_votes = jax.nn.softmax(params.head_w, axis=-1)
        if hard:
            class_ids = jnp.argmax(params.head_w, axis=-1)
            hard_votes = jax.nn.one_hot(class_ids, n_classes, dtype=features.dtype)
            votes = jax.lax.stop_gradient(hard_votes - soft_votes) + soft_votes
        else:
            votes = soft_votes
        return features @ votes / config.group_sum_tau
    if config.head_mode == "signed_class_vote":
        n_classes = params.head_b.shape[0]
        vote_logits = jnp.reshape(params.head_w, (params.head_w.shape[0], n_classes, 2))
        flat_probs = jax.nn.softmax(jnp.reshape(vote_logits, (params.head_w.shape[0], -1)), axis=-1)
        soft_pair_probs = jnp.reshape(flat_probs, (params.head_w.shape[0], n_classes, 2))
        soft_votes = soft_pair_probs[:, :, 0] - soft_pair_probs[:, :, 1]
        if hard:
            flat_vote_logits = jnp.reshape(vote_logits, (params.head_w.shape[0], -1))
            flat_selected = jnp.argmax(flat_vote_logits, axis=-1)
            hard_pairs = jax.nn.one_hot(
                flat_selected,
                n_classes * 2,
                dtype=features.dtype,
            )
            hard_pair_probs = jnp.reshape(hard_pairs, (params.head_w.shape[0], n_classes, 2))
            hard_votes = hard_pair_probs[:, :, 0] - hard_pair_probs[:, :, 1]
            votes = jax.lax.stop_gradient(hard_votes - soft_votes) + soft_votes
        else:
            votes = soft_votes
        return features @ votes / config.group_sum_tau
    return features @ params.head_w + params.head_b


def cross_entropy(logits: Array, labels: Array) -> Array:
    """Mean multiclass cross entropy."""
    log_probs = jax.nn.log_softmax(logits, axis=-1)
    return -jnp.mean(log_probs[jnp.arange(labels.shape[0]), labels])


def gate_entropy(
    params: CircuitParams,
    temperature: Array,
    gate_mode: str,
    fixed_gate_indices: tuple[int | None, ...],
) -> Array:
    """Mean gate-selector entropy across all circuit nodes."""
    entropies = []
    if gate_mode == "eml_threshold":
        if params.direction_logits is None:
            raise ValueError("eml_threshold mode requires direction logits")
        for direction_logits in params.direction_logits:
            probs = jax.nn.sigmoid(direction_logits)
            entropies.append(
                -(probs * jnp.log(probs + 1e-8) + (1.0 - probs) * jnp.log(1.0 - probs + 1e-8))
            )
        return jnp.mean(jnp.concatenate(entropies))
    if params.gate_logits is None:
        raise ValueError("selector modes require gate logits")
    for layer_idx, gate_logits in enumerate(params.gate_logits):
        if fixed_gate_indices[layer_idx] is not None:
            continue
        probs = jax.nn.softmax(gate_logits / temperature, axis=-1)
        entropies.append(-jnp.sum(probs * jnp.log(probs + 1e-8), axis=-1))
    if not entropies:
        return jnp.array(0.0, dtype=jnp.float32)
    return jnp.mean(jnp.concatenate(entropies))


def class_vote_readout_regularization(params: CircuitParams, config: DemoConfig) -> Array:
    """Return train-time hardening and balance penalties for class-vote metadata."""
    if config.head_mode not in {"class_vote", "signed_class_vote"}:
        return jnp.array(0.0, dtype=jnp.float32)
    if config.head_mode == "signed_class_vote":
        probs = jax.nn.softmax(params.head_w, axis=-1)
        probs = jnp.reshape(probs, (params.head_w.shape[0], -1))
    else:
        probs = jax.nn.softmax(params.head_w, axis=-1)
    penalty = jnp.array(0.0, dtype=jnp.float32)
    if config.readout_entropy_weight > 0.0:
        entropy = -jnp.sum(probs * jnp.log(jnp.clip(probs, 1e-8, 1.0)), axis=-1)
        penalty = penalty + config.readout_entropy_weight * jnp.mean(entropy)
    if config.readout_balance_weight > 0.0:
        mean_probs = jnp.mean(probs, axis=0)
        target = jnp.full_like(mean_probs, 1.0 / mean_probs.shape[0])
        penalty = penalty + config.readout_balance_weight * jnp.mean((mean_probs - target) ** 2)
    return penalty


def temperature_at(step: Array, total_steps: int, initial: float, minimum: float) -> Array:
    """Exponential temperature annealing schedule."""
    fraction = jnp.minimum(1.0, step.astype(jnp.float32) / jnp.array(total_steps, jnp.float32))
    return jnp.maximum(minimum, initial * (minimum / initial) ** fraction)


def accuracy(logits: Array, labels: Array) -> Array:
    """Classification accuracy."""
    return jnp.mean(jnp.argmax(logits, axis=-1) == labels)


def prediction_disagreement(left_logits: Array, right_logits: Array) -> Array:
    """Return the fraction of examples whose predicted classes differ."""
    return jnp.mean(jnp.argmax(left_logits, axis=-1) != jnp.argmax(right_logits, axis=-1))


def deployment_purity_summary(config: DemoConfig) -> dict[str, bool | str]:
    """Describe what is soft only during training versus present after hardening.

    The point of this summary is auditability: a DiffEML result should make it
    obvious whether the reported deployment path is a Boolean circuit with a
    count readout, or whether a continuous head/threshold still participates.
    """
    deploy_readout = {
        "group_sum": "fixed_class_bank_popcount",
        "class_vote": "learned_class_id_popcount",
        "signed_class_vote": "learned_class_id_and_polarity_popcount",
    }.get(config.head_mode, "continuous_linear_head")
    if config.gate_mode == "eml_template":
        deploy_gate_family = "selected_fixed_eml_templates"
    elif config.gate_mode == "truth_table":
        deploy_gate_family = "selected_eml_derived_truth_tables"
    elif config.gate_mode == "eml_threshold":
        deploy_gate_family = "learned_raw_eml_thresholds"
    else:
        deploy_gate_family = "unknown"

    packed_boolean_gates = config.gate_mode in SELECTOR_GATE_MODES
    boolean_count_readout = config.head_mode in BOOLEAN_COUNT_HEAD_MODES
    hard_deploy_is_pure_boolean = packed_boolean_gates and boolean_count_readout
    return {
        "train_uses_soft_gate_mixture": config.gate_mode in SELECTOR_GATE_MODES,
        "train_uses_soft_threshold_relaxation": config.gate_mode == "eml_threshold",
        "train_uses_soft_readout_mixture": config.head_mode in LEARNED_DISCRETE_HEAD_MODES,
        "train_uses_continuous_head": config.head_mode == "linear",
        "deploy_gate_family": deploy_gate_family,
        "deploy_readout": deploy_readout,
        "deploy_uses_continuous_head": config.head_mode == "linear",
        "deploy_uses_learned_real_thresholds": config.gate_mode == "eml_threshold",
        "hard_readout_is_boolean_count": boolean_count_readout,
        "packed_boolean_eval_available": packed_boolean_gates,
        "hard_deploy_contains_train_time_mixture": False,
        "hard_deploy_is_pure_boolean": hard_deploy_is_pure_boolean,
        "primary_no_larp_metric": (
            "packed_hard_test_accuracy"
            if hard_deploy_is_pure_boolean and config.packed_eval
            else "test_hard_accuracy"
        ),
    }


def selected_gate_mask_arrays(
    params: CircuitParams,
    wiring: CircuitWiring,
    library_masks: tuple[int, ...],
    width: int,
) -> tuple[np.ndarray, ...]:
    """Return hardened Boolean gate masks for each circuit layer."""
    if params.gate_logits is None:
        raise ValueError("packed selector evaluation requires gate logits")
    selected_layers = []
    for layer_idx, gate_logits in enumerate(params.gate_logits):
        fixed_mask = wiring.fixed_gate_masks[layer_idx]
        if fixed_mask is not None:
            selected_layers.append(np.full((width,), fixed_mask, dtype=np.uint8))
        else:
            selected = np.asarray(jnp.argmax(gate_logits, axis=-1))
            selected_layers.append(
                np.asarray([library_masks[int(idx)] for idx in selected.tolist()], dtype=np.uint8)
            )
    return tuple(selected_layers)


def pack_gate_masks_4bit(selected_masks: tuple[np.ndarray, ...]) -> np.ndarray:
    """Pack selected 16-way Boolean gate masks into two masks per byte."""
    if not selected_masks:
        return np.zeros((0,), dtype=np.uint8)
    flat = np.concatenate(
        [np.asarray(layer, dtype=np.uint8).reshape(-1) for layer in selected_masks]
    )
    if np.any(flat > 15):
        raise ValueError("gate masks must fit in 4 bits")
    packed = np.zeros(((flat.size + 1) // 2,), dtype=np.uint8)
    packed[: flat[0::2].size] = flat[0::2] & np.uint8(0x0F)
    packed[: flat[1::2].size] |= (flat[1::2] & np.uint8(0x0F)) << np.uint8(4)
    return packed


def unpack_gate_masks_4bit(packed: np.ndarray, *, n_masks: int) -> np.ndarray:
    """Unpack a flat 4-bit gate-mask byte array."""
    packed_arr = np.asarray(packed, dtype=np.uint8).reshape(-1)
    if n_masks < 0:
        raise ValueError("n_masks must be non-negative")
    if packed_arr.size < (n_masks + 1) // 2:
        raise ValueError("packed array is too short for n_masks")
    masks = np.empty((n_masks,), dtype=np.uint8)
    masks[0::2] = packed_arr[: masks[0::2].size] & np.uint8(0x0F)
    masks[1::2] = (packed_arr[: masks[1::2].size] >> np.uint8(4)) & np.uint8(0x0F)
    return masks


def hard_gate_layers_from_wiring(
    wiring: CircuitWiring,
    selected_masks: tuple[np.ndarray, ...],
) -> tuple[HardGateLayer, ...]:
    """Return pruning-compatible hard gate layers for selected masks."""
    if len(wiring.left) != len(selected_masks):
        raise ValueError("selected_masks must contain one mask array per wiring layer")
    layer_names = wiring.meta.get("layer_kinds", [])
    layers = []
    for layer_idx, (left, right, masks) in enumerate(
        zip(wiring.left, wiring.right, selected_masks, strict=True)
    ):
        name = (
            str(layer_names[layer_idx])
            if isinstance(layer_names, list) and layer_idx < len(layer_names)
            else f"layer{layer_idx}"
        )
        layers.append(
            HardGateLayer.from_iterables(
                np.asarray(left).tolist(),
                np.asarray(right).tolist(),
                np.asarray(masks).tolist(),
                name=name,
            )
        )
    return tuple(layers)


def compact_selected_hard_circuit(
    params: CircuitParams,
    wiring: CircuitWiring,
    selected_masks: tuple[np.ndarray, ...],
    config: DemoConfig,
    *,
    input_dim: int,
) -> CircuitCompactionResult:
    """Compact a hardened selector circuit using deploy-time readout metadata."""
    n_classes = int(np.asarray(params.head_b).shape[0])
    hard_layers = hard_gate_layers_from_wiring(wiring, selected_masks)
    head_weights = None
    class_ids = None
    if config.head_mode == "linear":
        head_weights = np.asarray(params.head_w, dtype=np.float32).tolist()
    elif config.head_mode == "class_vote":
        class_ids = np.asarray(jnp.argmax(params.head_w, axis=-1), dtype=np.int32).tolist()
    elif config.head_mode == "signed_class_vote":
        flat_selected = np.asarray(jnp.argmax(params.head_w, axis=-1), dtype=np.int32)
        class_ids = (flat_selected // 2).tolist()
    return compact_hard_circuit(
        hard_layers,
        input_dim=input_dim,
        head_mode=cast(PruningHeadMode, config.head_mode),
        n_classes=n_classes,
        head_weights=head_weights,
        class_ids=class_ids,
        tolerance=1e-7,
    )


def compaction_summary(result: CircuitCompactionResult) -> dict[str, Any]:
    """Return compact hard-DAG metadata without serializing every gate edge."""
    return {
        "source_index_model": "global_dag",
        "input_dim": result.input_dim,
        "original_layer_widths": list(result.original_layer_widths),
        "compacted_layer_widths": [layer.width for layer in result.compacted_layers],
        "readout_used_features": len(result.readout_used_features),
        "readout_used_sources": len(result.readout_used_sources),
        "stats": result.stats.to_config(),
    }


def packed_hard_logits(
    params: CircuitParams,
    x_bits: np.ndarray,
    wiring: CircuitWiring,
    selected_masks: tuple[np.ndarray, ...],
    config: DemoConfig,
) -> np.ndarray:
    """Evaluate the hard EML selector as a bit-packed Boolean circuit."""
    if config.head_mode == "group_sum":
        n_classes = int(np.asarray(params.head_b).shape[0])
        return packed_group_sum_logits(
            x_bits,
            wiring,
            selected_masks,
            config.width,
            n_classes=n_classes,
            tau=config.group_sum_tau,
        )
    if config.head_mode == "class_vote":
        n_classes = int(np.asarray(params.head_b).shape[0])
        class_ids = np.asarray(jnp.argmax(params.head_w, axis=-1), dtype=np.int32)
        return packed_class_vote_logits(
            x_bits,
            wiring,
            selected_masks,
            config.width,
            class_ids=class_ids,
            n_classes=n_classes,
            tau=config.group_sum_tau,
        )
    if config.head_mode == "signed_class_vote":
        n_classes = int(np.asarray(params.head_b).shape[0])
        flat_selected = np.asarray(jnp.argmax(params.head_w, axis=-1), dtype=np.int32)
        class_ids = flat_selected // 2
        signs = np.where((flat_selected % 2) == 0, 1, -1).astype(np.int8)
        return packed_signed_class_vote_logits(
            x_bits,
            wiring,
            selected_masks,
            config.width,
            class_ids=class_ids,
            signs=signs,
            n_classes=n_classes,
            tau=config.group_sum_tau,
        )
    features = packed_hard_features(x_bits, wiring, selected_masks, config.width)
    return features @ np.asarray(params.head_w) + np.asarray(params.head_b)


def quantize_linear_head_int8(params: CircuitParams) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return per-class symmetric int8 weights plus scales and fp32 bias."""
    weights = np.asarray(params.head_w, dtype=np.float32)
    bias = np.asarray(params.head_b, dtype=np.float32)
    max_abs = np.max(np.abs(weights), axis=0)
    scales = np.maximum(max_abs / 127.0, 1e-8).astype(np.float32)
    quantized = np.clip(np.round(weights / scales[None, :]), -127, 127).astype(np.int8)
    return quantized, scales, bias


def int8_head_logits(features: np.ndarray, params: CircuitParams) -> np.ndarray:
    """Evaluate a packed feature matrix with a dequantized int8 linear head."""
    quantized, scales, bias = quantize_linear_head_int8(params)
    weights = quantized.astype(np.float32) * scales[None, :]
    return features @ weights + bias


def packed_hard_logits_int8_head(
    params: CircuitParams,
    x_bits: np.ndarray,
    wiring: CircuitWiring,
    selected_masks: tuple[np.ndarray, ...],
    config: DemoConfig,
) -> np.ndarray:
    """Evaluate a packed hard circuit with an int8-quantized linear head."""
    if config.head_mode != "linear":
        raise ValueError("int8 head evaluation only supports head_mode='linear'")
    features = packed_hard_features(x_bits, wiring, selected_masks, config.width)
    return int8_head_logits(features, params)


def compiled_circuit_storage_summary(
    params: CircuitParams,
    wiring: CircuitWiring,
    selected_masks: tuple[np.ndarray, ...],
    config: DemoConfig,
) -> dict[str, int | float | str]:
    """Estimate deployable hard-circuit storage for fp32 and int8 heads."""
    nodes = int(sum(layer.shape[0] for layer in selected_masks))
    max_source = 0
    for left, right in zip(wiring.left, wiring.right):
        max_source = max(max_source, int(jnp.max(left)), int(jnp.max(right)))
    if max_source < 2**8:
        index_bytes = 1
    elif max_source < 2**16:
        index_bytes = 2
    else:
        index_bytes = 4
    explicit_wiring_bytes = nodes * 2 * index_bytes
    deployed_wiring_bytes = wiring.meta.get("deployed_wiring_bytes")
    wiring_bytes = (
        int(deployed_wiring_bytes)
        if deployed_wiring_bytes is not None
        else explicit_wiring_bytes
    )
    gate_mask_bytes = nodes
    gate_mask_packed4_bytes = (nodes + 1) // 2
    n_classes = int(np.asarray(params.head_b).shape[0])
    if config.head_mode == "group_sum":
        head_train_bytes = 0
        head_fp32_bytes = 0
        head_int8_bytes = 0
        head_vote_index_bytes = 0
        head_signed_vote_index_bytes = 0
    elif config.head_mode == "class_vote":
        head_weight_count = int(np.asarray(params.head_w).size)
        class_index_bits = max(1, int(np.ceil(np.log2(max(n_classes, 2)))))
        head_train_bytes = 4 * head_weight_count
        head_fp32_bytes = 0
        head_int8_bytes = 0
        head_vote_index_bytes = (config.width * class_index_bits + 7) // 8
        head_signed_vote_index_bytes = 0
    elif config.head_mode == "signed_class_vote":
        head_weight_count = int(np.asarray(params.head_w).size)
        class_index_bits = max(1, int(np.ceil(np.log2(max(n_classes, 2)))))
        head_train_bytes = 4 * head_weight_count
        head_fp32_bytes = 0
        head_int8_bytes = 0
        head_vote_index_bytes = 0
        head_signed_vote_index_bytes = (config.width * (class_index_bits + 1) + 7) // 8
    else:
        head_weight_count = int(np.asarray(params.head_w).size)
        head_bias_count = int(np.asarray(params.head_b).size)
        head_train_bytes = 4 * (head_weight_count + head_bias_count)
        head_fp32_bytes = 4 * (head_weight_count + head_bias_count)
        head_int8_bytes = head_weight_count + 4 * n_classes + 4 * head_bias_count
        head_vote_index_bytes = 0
        head_signed_vote_index_bytes = 0
    selector_train_parameters = 0
    if params.gate_logits is not None:
        selector_train_parameters = int(
            sum(np.asarray(logits).size for logits in params.gate_logits)
        )
    elif params.threshold_logits is not None and params.direction_logits is not None:
        selector_train_parameters = int(
            sum(np.asarray(logits).size for logits in params.threshold_logits)
            + sum(np.asarray(logits).size for logits in params.direction_logits)
        )
    soft_train_bytes = 4 * selector_train_parameters + head_train_bytes
    deployed_readout_bytes = (
        head_vote_index_bytes
        if config.head_mode == "class_vote"
        else head_signed_vote_index_bytes
        if config.head_mode == "signed_class_vote"
        else head_int8_bytes
    )
    compiled_fp32_bytes = (
        wiring_bytes
        + gate_mask_bytes
        + head_fp32_bytes
        + head_vote_index_bytes
        + head_signed_vote_index_bytes
    )
    compiled_int8_bytes = (
        wiring_bytes
        + gate_mask_bytes
        + head_int8_bytes
        + head_vote_index_bytes
        + head_signed_vote_index_bytes
    )
    compiled_packed_bytes = wiring_bytes + gate_mask_bytes + deployed_readout_bytes
    compiled_bitpacked_bytes = (
        wiring_bytes + gate_mask_packed4_bytes + deployed_readout_bytes
    )
    int8_compression = (
        float(soft_train_bytes / compiled_int8_bytes)
        if compiled_int8_bytes > 0
        else 0.0
    )
    packed_compression = (
        float(soft_train_bytes / compiled_packed_bytes)
        if compiled_packed_bytes > 0
        else 0.0
    )
    bitpacked_compression = (
        float(soft_train_bytes / compiled_bitpacked_bytes)
        if compiled_bitpacked_bytes > 0
        else 0.0
    )
    return {
        "nodes": nodes,
        "max_source_index": max_source,
        "source_index_bytes": index_bytes,
        "wiring_bytes": wiring_bytes,
        "explicit_wiring_bytes": explicit_wiring_bytes,
        "wiring_storage_mode": str(wiring.meta.get("wiring_storage_mode", "explicit_indices")),
        "gate_mask_bytes": gate_mask_bytes,
        "gate_mask_packed4_bytes": gate_mask_packed4_bytes,
        "head_fp32_bytes": head_fp32_bytes,
        "head_int8_bytes": head_int8_bytes,
        "head_vote_index_bytes": head_vote_index_bytes,
        "head_signed_vote_index_bytes": head_signed_vote_index_bytes,
        "deployed_readout_bytes": deployed_readout_bytes,
        "compiled_fp32_bytes": compiled_fp32_bytes,
        "compiled_int8_bytes": compiled_int8_bytes,
        "compiled_packed_bytes": compiled_packed_bytes,
        "compiled_bitpacked_bytes": compiled_bitpacked_bytes,
        "soft_train_bytes": soft_train_bytes,
        "soft_to_compiled_int8_compression": int8_compression,
        "soft_to_compiled_packed_compression": packed_compression,
        "soft_to_compiled_bitpacked_compression": bitpacked_compression,
    }


def packed_hard_features(
    x_bits: np.ndarray,
    wiring: CircuitWiring,
    selected_masks: tuple[np.ndarray, ...],
    width: int,
) -> np.ndarray:
    """Return final hard circuit features using uint64-packed examples."""
    outputs = np.empty((x_bits.shape[0], width), dtype=np.float32)
    for start in range(0, x_bits.shape[0], 64):
        stop = min(start + 64, x_bits.shape[0])
        chunk = x_bits[start:stop]
        previous, _, n_bits = eval_packed_circuit_chunk(chunk, wiring, selected_masks)
        outputs[start:stop] = unpack_feature_columns(previous, n_bits)
    return outputs


def packed_group_sum_logits(
    x_bits: np.ndarray,
    wiring: CircuitWiring,
    selected_masks: tuple[np.ndarray, ...],
    width: int,
    *,
    n_classes: int,
    tau: float,
) -> np.ndarray:
    """Return grouped class counts directly from packed hard circuit bits."""
    logits = np.empty((x_bits.shape[0], n_classes), dtype=np.float32)
    usable_width = (width // n_classes) * n_classes
    for start in range(0, x_bits.shape[0], 64):
        stop = min(start + 64, x_bits.shape[0])
        chunk = x_bits[start:stop]
        previous, _, n_bits = eval_packed_circuit_chunk(chunk, wiring, selected_masks)
        grouped = previous[:usable_width].reshape(n_classes, -1)
        for row_idx in range(n_bits):
            bit = np.uint64(row_idx)
            counts = np.sum((grouped >> bit) & np.uint64(1), axis=1, dtype=np.uint32)
            logits[start + row_idx] = counts.astype(np.float32) / tau
    return logits


def packed_class_vote_logits(
    x_bits: np.ndarray,
    wiring: CircuitWiring,
    selected_masks: tuple[np.ndarray, ...],
    width: int,
    *,
    class_ids: np.ndarray,
    n_classes: int,
    tau: float,
) -> np.ndarray:
    """Return packed class-vote counts for a learned discrete readout."""
    logits = np.empty((x_bits.shape[0], n_classes), dtype=np.float32)
    class_ids = np.asarray(class_ids[:width], dtype=np.int32)
    class_groups = [
        np.flatnonzero(class_ids == class_idx).astype(np.int32) for class_idx in range(n_classes)
    ]
    for start in range(0, x_bits.shape[0], 64):
        stop = min(start + 64, x_bits.shape[0])
        chunk = x_bits[start:stop]
        previous, _, n_bits = eval_packed_circuit_chunk(chunk, wiring, selected_masks)
        previous = previous[:width]
        for row_idx in range(n_bits):
            bit = np.uint64(row_idx)
            counts = np.array(
                [
                    np.sum((previous[group] >> bit) & np.uint64(1), dtype=np.uint32)
                    if group.shape[0] > 0
                    else np.uint32(0)
                    for group in class_groups
                ],
                dtype=np.float32,
            )
            logits[start + row_idx] = counts / tau
    return logits


def packed_signed_class_vote_logits(
    x_bits: np.ndarray,
    wiring: CircuitWiring,
    selected_masks: tuple[np.ndarray, ...],
    width: int,
    *,
    class_ids: np.ndarray,
    signs: np.ndarray,
    n_classes: int,
    tau: float,
) -> np.ndarray:
    """Return packed signed class-vote counts for discrete readout metadata."""
    logits = np.empty((x_bits.shape[0], n_classes), dtype=np.float32)
    class_ids = np.asarray(class_ids[:width], dtype=np.int32)
    signs = np.asarray(signs[:width], dtype=np.int8)
    signed_groups = [
        np.flatnonzero((class_ids == class_idx) & (signs == sign)).astype(np.int32)
        for class_idx in range(n_classes)
        for sign in (1, -1)
    ]
    for start in range(0, x_bits.shape[0], 64):
        stop = min(start + 64, x_bits.shape[0])
        chunk = x_bits[start:stop]
        previous, _, n_bits = eval_packed_circuit_chunk(chunk, wiring, selected_masks)
        previous = previous[:width]
        for row_idx in range(n_bits):
            bit = np.uint64(row_idx)
            counts = []
            for class_idx in range(n_classes):
                pos_group = signed_groups[2 * class_idx]
                neg_group = signed_groups[2 * class_idx + 1]
                pos = (
                    np.sum((previous[pos_group] >> bit) & np.uint64(1), dtype=np.int32)
                    if pos_group.shape[0] > 0
                    else np.int32(0)
                )
                neg = (
                    np.sum((previous[neg_group] >> bit) & np.uint64(1), dtype=np.int32)
                    if neg_group.shape[0] > 0
                    else np.int32(0)
                )
                counts.append(pos - neg)
            logits[start + row_idx] = np.asarray(counts, dtype=np.float32) / tau
    return logits


def eval_packed_circuit_chunk(
    chunk: np.ndarray,
    wiring: CircuitWiring,
    selected_masks: tuple[np.ndarray, ...],
) -> tuple[np.ndarray, np.uint64, int]:
    """Evaluate one up-to-64-example chunk and keep features bit-packed."""
    n_bits = chunk.shape[0]
    full_mask = (
        np.uint64(np.iinfo(np.uint64).max) if n_bits == 64 else np.uint64((1 << n_bits) - 1)
    )
    previous: np.ndarray | None = None
    input_packed = pack_feature_columns(chunk, full_mask)
    for layer_idx, layer_masks in enumerate(selected_masks):
        sources = (
            np.concatenate((input_packed, np.asarray([full_mask], dtype=np.uint64)))
            if previous is None
            else np.concatenate((input_packed, np.asarray([full_mask], dtype=np.uint64), previous))
        )
        left = sources[np.asarray(wiring.left[layer_idx])]
        right = sources[np.asarray(wiring.right[layer_idx])]
        previous = eval_packed_binary_gates(left, right, layer_masks, full_mask)
    if previous is None:
        raise RuntimeError("packed circuit requires at least one layer")
    return previous, full_mask, n_bits


def pack_feature_columns(chunk: np.ndarray, full_mask: np.uint64) -> np.ndarray:
    """Pack each feature column across up to 64 examples."""
    packed = np.zeros((chunk.shape[1],), dtype=np.uint64)
    bits = chunk >= 0.5
    for row_idx in range(chunk.shape[0]):
        packed |= bits[row_idx].astype(np.uint64) << np.uint64(row_idx)
    return packed & full_mask


def unpack_feature_columns(packed: np.ndarray, n_bits: int) -> np.ndarray:
    """Unpack uint64 feature columns into a dense example-major matrix."""
    out = np.empty((n_bits, packed.shape[0]), dtype=np.float32)
    for row_idx in range(n_bits):
        out[row_idx] = ((packed >> np.uint64(row_idx)) & np.uint64(1)).astype(np.float32)
    return out


def eval_packed_binary_gates(
    left: np.ndarray,
    right: np.ndarray,
    masks: np.ndarray,
    full_mask: np.uint64,
) -> np.ndarray:
    """Evaluate hardened two-input Boolean gates on packed bit columns."""
    not_left = (~left) & full_mask
    not_right = (~right) & full_mask
    out = np.zeros(left.shape, dtype=np.uint64)
    out |= np.where((masks & 1) != 0, not_left & not_right, np.uint64(0))
    out |= np.where((masks & 2) != 0, not_left & right, np.uint64(0))
    out |= np.where((masks & 4) != 0, left & not_right, np.uint64(0))
    out |= np.where((masks & 8) != 0, left & right, np.uint64(0))
    return out & full_mask


def init_mlp_params(
    key: Array,
    *,
    input_dim: int,
    n_classes: int,
    hidden_sizes: tuple[int, ...],
    init_scale: float,
) -> MLPParams:
    """Initialize a ReLU MLP classifier baseline."""
    sizes = (input_dim, *hidden_sizes, n_classes)
    weights = []
    biases = []
    for in_dim, out_dim in zip(sizes[:-1], sizes[1:]):
        key, layer_key = jr.split(key)
        weights.append(
            init_scale
            * jr.normal(layer_key, (in_dim, out_dim), dtype=jnp.float32)
            / jnp.sqrt(jnp.array(in_dim, dtype=jnp.float32))
        )
        biases.append(jnp.zeros((out_dim,), dtype=jnp.float32))
    return MLPParams(weights=tuple(weights), biases=tuple(biases))


def init_mlp_adam(params: MLPParams) -> MLPAdamState:
    """Initialize MLP Adam state."""
    zeros = jax.tree_util.tree_map(jnp.zeros_like, params)
    return MLPAdamState(m=zeros, v=zeros, step=jnp.array(0, dtype=jnp.int32))


def mlp_forward(params: MLPParams, x: Array) -> Array:
    """Forward pass for the baseline MLP."""
    activations = x
    for weight, bias in zip(params.weights[:-1], params.biases[:-1]):
        activations = jax.nn.relu(activations @ weight + bias)
    return activations @ params.weights[-1] + params.biases[-1]


def mlp_param_count(params: MLPParams) -> int:
    """Return number of scalar MLP parameters."""
    return int(sum(np.prod(np.asarray(leaf).shape) for leaf in jax.tree_util.tree_leaves(params)))


def make_mlp_update_step(config: DemoConfig) -> Any:
    """Build a jitted MLP update step."""

    @jax.jit
    def update_step(
        params: MLPParams,
        opt_state: MLPAdamState,
        x_batch: Array,
        y_batch: Array,
    ) -> tuple[MLPParams, MLPAdamState, Array]:
        def loss_fn(local_params: MLPParams) -> Array:
            logits = mlp_forward(local_params, x_batch)
            weight_penalty = sum(jnp.mean(weight**2) for weight in local_params.weights)
            return cross_entropy(logits, y_batch) + config.mlp_weight_decay * weight_penalty

        loss, grads = jax.value_and_grad(loss_fn)(params)
        grad_sq_sum = sum(jnp.sum(leaf**2) for leaf in jax.tree_util.tree_leaves(grads))
        grad_norm = jnp.sqrt(grad_sq_sum + 1e-12)
        grad_scale = jnp.minimum(1.0, config.mlp_max_grad_norm / (grad_norm + 1e-8))
        grads = jax.tree_util.tree_map(lambda grad: grad * grad_scale, grads)
        new_step = opt_state.step + 1
        beta1 = 0.9
        beta2 = 0.999
        new_m = jax.tree_util.tree_map(
            lambda m, grad: beta1 * m + (1.0 - beta1) * grad,
            opt_state.m,
            grads,
        )
        new_v = jax.tree_util.tree_map(
            lambda v, grad: beta2 * v + (1.0 - beta2) * grad**2,
            opt_state.v,
            grads,
        )
        step_float = new_step.astype(jnp.float32)
        new_params = jax.tree_util.tree_map(
            lambda param, m, v: (
                param
                - config.mlp_step_size
                * (m / (1.0 - beta1**step_float))
                / (jnp.sqrt(v / (1.0 - beta2**step_float)) + 1e-8)
            ),
            params,
            new_m,
            new_v,
        )
        return (
            new_params,
            MLPAdamState(m=new_m, v=new_v, step=new_step),
            jnp.array(
                [loss, grad_norm],
                dtype=jnp.float32,
            ),
        )

    return update_step


def run_mlp_baseline(
    x_train_np: np.ndarray,
    y_train_np: np.ndarray,
    x_test_np: np.ndarray,
    y_test_np: np.ndarray,
    *,
    n_classes: int,
    config: DemoConfig,
) -> dict[str, Any]:
    """Train a same-feature MLP baseline for comparison."""
    key = jr.key(config.seed + 10_000)
    params = init_mlp_params(
        key,
        input_dim=x_train_np.shape[1],
        n_classes=n_classes,
        hidden_sizes=config.mlp_hidden_sizes,
        init_scale=config.mlp_init_scale,
    )
    opt_state = init_mlp_adam(params)
    update_step = make_mlp_update_step(config)
    x_train = jnp.asarray(x_train_np)
    y_train = jnp.asarray(y_train_np)
    x_test = jnp.asarray(x_test_np)
    y_test = jnp.asarray(y_test_np)
    rng = np.random.default_rng(config.seed + 10_000)
    epochs = config.mlp_epochs if config.mlp_epochs > 0 else config.epochs
    t0 = time.time()
    last_metrics = np.zeros((2,), dtype=np.float32)
    for _ in range(epochs):
        order = rng.permutation(x_train_np.shape[0])
        for start in range(0, order.shape[0], config.batch_size):
            batch_idx = order[start : start + config.batch_size]
            params, opt_state, metrics = update_step(
                params,
                opt_state,
                x_train[batch_idx],
                y_train[batch_idx],
            )
            last_metrics = np.asarray(metrics)

    train_logits = mlp_forward(params, x_train)
    test_logits = mlp_forward(params, x_test)
    return {
        "hidden_sizes": list(config.mlp_hidden_sizes),
        "parameters": mlp_param_count(params),
        "epochs": epochs,
        "updates": int(opt_state.step),
        "elapsed_s": time.time() - t0,
        "last_loss": float(last_metrics[0]),
        "last_grad_norm": float(last_metrics[1]),
        "train_accuracy": float(accuracy(train_logits, y_train)),
        "test_accuracy": float(accuracy(test_logits, y_test)),
    }


def make_update_step(
    wiring: CircuitWiring,
    library_outputs: Array,
    template_bank: EMLTemplateBank,
    *,
    total_steps: int,
    config: DemoConfig,
) -> Any:
    """Build a jitted update step for one fixed circuit."""

    @jax.jit
    def update_step(
        params: CircuitParams,
        opt_state: AdamState,
        x_batch: Array,
        y_batch: Array,
    ) -> tuple[CircuitParams, AdamState, Array]:
        temperature = temperature_at(
            opt_state.step,
            total_steps,
            config.initial_temperature,
            config.min_temperature,
        )
        drop_key = jr.fold_in(jr.key(config.seed + 20_000), opt_state.step)
        input_drop_key, feature_drop_key = jr.split(drop_key)

        def maybe_drop_inputs(values: Array) -> Array:
            if config.input_drop_rate <= 0.0:
                return values
            keep_prob = 1.0 - config.input_drop_rate
            mask = jr.bernoulli(input_drop_key, keep_prob, values.shape)
            return values * mask.astype(values.dtype)

        def maybe_drop_features(values: Array) -> Array:
            if config.feature_drop_rate <= 0.0:
                return values
            keep_prob = 1.0 - config.feature_drop_rate
            mask = jr.bernoulli(feature_drop_key, keep_prob, values.shape)
            return values * mask.astype(values.dtype)

        def loss_fn(local_params: CircuitParams) -> Array:
            regularized_x = maybe_drop_inputs(x_batch)
            soft_features = circuit_features(
                local_params,
                regularized_x,
                wiring,
                library_outputs,
                template_bank,
                temperature,
                config,
                hard=False,
            )
            dropped_soft_features = maybe_drop_features(soft_features)
            logits = classifier_logits(local_params, dropped_soft_features, config, hard=False)
            loss = cross_entropy(logits, y_batch)
            if config.hard_loss_weight > 0.0:
                hard_features = circuit_features(
                    local_params,
                    regularized_x,
                    wiring,
                    library_outputs,
                    template_bank,
                    temperature,
                    config,
                    hard=True,
                )
                ste_features = jax.lax.stop_gradient(hard_features - soft_features) + soft_features
                dropped_ste_features = maybe_drop_features(ste_features)
                hard_logits = classifier_logits(
                    local_params,
                    dropped_ste_features,
                    config,
                    hard=True,
                )
                loss = loss + config.hard_loss_weight * cross_entropy(hard_logits, y_batch)
            regularization = (
                0.0
                if config.head_mode in BOOLEAN_COUNT_HEAD_MODES
                else config.head_l2 * jnp.mean(local_params.head_w**2)
            )
            return (
                loss
                + config.entropy_weight
                * gate_entropy(
                    local_params,
                    temperature,
                    config.gate_mode,
                    wiring.fixed_gate_indices,
                )
                + regularization
                + class_vote_readout_regularization(local_params, config)
            )

        loss, grads = jax.value_and_grad(loss_fn)(params)
        grad_sq_sum = sum(jnp.sum(leaf**2) for leaf in jax.tree_util.tree_leaves(grads))
        grad_norm = jnp.sqrt(grad_sq_sum + 1e-12)
        grad_scale = jnp.minimum(1.0, config.max_grad_norm / (grad_norm + 1e-8))
        grads = jax.tree_util.tree_map(lambda grad: grad * grad_scale, grads)

        new_step = opt_state.step + 1
        beta1 = 0.9
        beta2 = 0.999
        new_m = jax.tree_util.tree_map(
            lambda m, grad: beta1 * m + (1.0 - beta1) * grad,
            opt_state.m,
            grads,
        )
        new_v = jax.tree_util.tree_map(
            lambda v, grad: beta2 * v + (1.0 - beta2) * grad**2,
            opt_state.v,
            grads,
        )
        step_float = new_step.astype(jnp.float32)
        new_params = jax.tree_util.tree_map(
            lambda param, m, v: (
                param
                - config.step_size
                * (m / (1.0 - beta1**step_float))
                / (jnp.sqrt(v / (1.0 - beta2**step_float)) + 1e-8)
            ),
            params,
            new_m,
            new_v,
        )
        metrics = jnp.array([loss, grad_norm, temperature], dtype=jnp.float32)
        return new_params, AdamState(m=new_m, v=new_v, step=new_step), metrics

    return update_step


def eval_logits(
    params: CircuitParams,
    x_bits: Array,
    wiring: CircuitWiring,
    library_outputs: Array,
    template_bank: EMLTemplateBank,
    temperature: Array,
    config: DemoConfig,
) -> tuple[Array, Array]:
    """Return soft and hardened logits for evaluation."""
    soft_logits = forward(
        params,
        x_bits,
        wiring,
        library_outputs,
        template_bank,
        temperature,
        config,
        hard=False,
    )
    hard_logits = forward(
        params,
        x_bits,
        wiring,
        library_outputs,
        template_bank,
        temperature,
        config,
        hard=True,
    )
    return soft_logits, hard_logits


def run_one_dataset(name: str, split: DatasetSplit, config: DemoConfig) -> dict[str, Any]:
    """Train and evaluate DiffEML on one prepared dataset."""
    x_train_np, x_test_np, bit_meta, feature_layout = binarize_features(split, config=config)
    y_train_np = split.y_train
    y_test_np = split.y_test
    n_classes = int(max(np.max(y_train_np), np.max(y_test_np)) + 1)
    library = eml_threshold_gate_library(depth=config.eml_template_depth, eps=config.eml_eps)
    template_bank = build_eml_template_bank(depth=config.eml_template_depth, eps=config.eml_eps)
    total_steps = config.epochs * max(1, int(np.ceil(x_train_np.shape[0] / config.batch_size)))

    key = jr.key(config.seed)
    key, wiring_key, init_key = jr.split(key, 3)
    or_gate_index = residual_gate_index("or", library.masks)
    wiring = make_wiring(
        wiring_key,
        input_dim=x_train_np.shape[1],
        layers=config.layers,
        width=config.width,
        mode=config.wiring_mode,
        n_classes=n_classes,
        feature_layout=feature_layout,
        local_patch_size=config.local_patch_size,
        tree_stage_depths=config.tree_stage_depths,
        or_gate_index=or_gate_index,
    )
    n_layers = len(wiring.left)
    residual_index = residual_gate_index(config.residual_gate, library.masks)
    params = init_params(
        init_key,
        layers=n_layers,
        width=config.width,
        n_gates=library.size,
        n_classes=n_classes,
        gate_mode=config.gate_mode,
        head_mode=config.head_mode,
        gate_init_scale=config.gate_init_scale,
        threshold_init_scale=config.threshold_init_scale,
        direction_init_scale=config.direction_init_scale,
        head_init_scale=config.head_init_scale,
        residual_gate_index=residual_index,
        residual_gate_bias=config.residual_gate_bias,
    )
    opt_state = init_adam(params)
    update_step = make_update_step(
        wiring,
        library.outputs,
        template_bank,
        total_steps=total_steps,
        config=config,
    )

    x_train = jnp.asarray(x_train_np)
    y_train = jnp.asarray(y_train_np)
    x_test = jnp.asarray(x_test_np)
    y_test = jnp.asarray(y_test_np)
    rng = np.random.default_rng(config.seed)
    t0 = time.time()
    last_metrics = np.zeros((3,), dtype=np.float32)
    for _ in range(config.epochs):
        order = rng.permutation(x_train_np.shape[0])
        for start in range(0, order.shape[0], config.batch_size):
            batch_idx = order[start : start + config.batch_size]
            params, opt_state, metrics = update_step(
                params,
                opt_state,
                x_train[batch_idx],
                y_train[batch_idx],
            )
            last_metrics = np.asarray(metrics)

    final_temperature = temperature_at(
        opt_state.step,
        total_steps,
        config.initial_temperature,
        config.min_temperature,
    )
    train_soft_logits, train_hard_logits = eval_logits(
        params,
        x_train,
        wiring,
        library.outputs,
        template_bank,
        final_temperature,
        config,
    )
    test_soft_logits, test_hard_logits = eval_logits(
        params,
        x_test,
        wiring,
        library.outputs,
        template_bank,
        final_temperature,
        config,
    )
    packed_test_accuracy: float | None = None
    packed_int8_test_accuracy: float | None = None
    packed_logits: np.ndarray | None = None
    selected_mask_layers: tuple[np.ndarray, ...] | None = None
    if params.gate_logits is not None:
        selected_mask_layers = selected_gate_mask_arrays(
            params,
            wiring,
            library.masks,
            config.width,
        )
    if config.packed_eval:
        if selected_mask_layers is None:
            raise ValueError("packed eval requires selector-based gate logits")
        packed_logits = packed_hard_logits(
            params,
            x_test_np,
            wiring,
            selected_mask_layers,
            config,
        )
        packed_test_accuracy = float(np.mean(np.argmax(packed_logits, axis=-1) == y_test_np))
        if config.head_mode == "linear":
            packed_int8_logits = packed_hard_logits_int8_head(
                params,
                x_test_np,
                wiring,
                selected_mask_layers,
                config,
            )
            packed_int8_test_accuracy = float(
                np.mean(np.argmax(packed_int8_logits, axis=-1) == y_test_np)
            )
    elapsed = time.time() - t0
    model_meta: dict[str, Any] = {
        "gate_mode": config.gate_mode,
        "library_size": library.size,
        "library_masks": list(library.masks),
        "configured_layers": config.layers,
        "layers": n_layers,
        "width": config.width,
        "wiring_mode": config.wiring_mode,
        "wiring": wiring.meta,
        "residual_gate": config.residual_gate,
        "residual_gate_bias": config.residual_gate_bias,
        "head_mode": config.head_mode,
        "group_sum_tau": config.group_sum_tau,
        "readout_entropy_weight": config.readout_entropy_weight,
        "readout_balance_weight": config.readout_balance_weight,
        "purity": deployment_purity_summary(config),
        "nodes": n_layers * config.width,
        "fixed_gate_layers": sum(index is not None for index in wiring.fixed_gate_indices),
        "active_node_parameters": sum(index is None for index in wiring.fixed_gate_indices)
        * config.width
        * (2 if config.gate_mode == "eml_threshold" else library.size),
        "head_parameters": 0
        if config.head_mode == "group_sum"
        else 2 * config.width * n_classes
        if config.head_mode == "signed_class_vote"
        else config.width * n_classes
        if config.head_mode == "class_vote"
        else config.width * n_classes + n_classes,
    }
    if config.wiring_mode in {"butterfly", "benes", "permuted_butterfly", "permuted_benes"}:
        strides = butterfly_strides(config.width)
        if config.wiring_mode in {"benes", "permuted_benes"}:
            schedule = (*strides, *tuple(reversed(strides[:-1])))
        else:
            schedule = strides
        model_meta["wiring_schedule"] = [
            int(schedule[layer_idx % len(schedule)]) for layer_idx in range(n_layers)
        ]
    if config.gate_mode == "eml_threshold":
        if params.threshold_logits is None or params.direction_logits is None:
            raise ValueError("eml_threshold mode requires threshold and direction logits")
        threshold_low, threshold_high = eml_boolean_threshold_range(config.eml_eps)
        direction_counts: Counter[str] = Counter()
        thresholds = []
        for threshold_logits, direction_logits in zip(
            params.threshold_logits,
            params.direction_logits,
        ):
            threshold_values = threshold_low + (threshold_high - threshold_low) * np.asarray(
                jax.nn.sigmoid(threshold_logits)
            )
            thresholds.extend(threshold_values.tolist())
            direction_counts.update(
                "ge" if value >= 0.0 else "le" for value in np.asarray(direction_logits).tolist()
            )
        model_meta["threshold_range"] = [threshold_low, threshold_high]
        model_meta["selected_direction_counts"] = dict(sorted(direction_counts.items()))
        model_meta["mean_threshold"] = float(np.mean(thresholds))
    else:
        if params.gate_logits is None:
            raise ValueError("selector modes require gate logits")
        if selected_mask_layers is None:
            selected_mask_layers = selected_gate_mask_arrays(
                params,
                wiring,
                library.masks,
                config.width,
            )
        selected_masks: list[int] = []
        for layer_masks in selected_mask_layers:
            selected_masks.extend(int(mask) for mask in layer_masks.tolist())
        model_meta["selected_gate_mask_counts"] = {
            str(mask): count for mask, count in sorted(Counter(selected_masks).items())
        }
        model_meta["compiled_storage"] = compiled_circuit_storage_summary(
            params,
            wiring,
            selected_mask_layers,
            config,
        )
        model_meta["compaction"] = compaction_summary(
            compact_selected_hard_circuit(
                params,
                wiring,
                selected_mask_layers,
                config,
                input_dim=x_train_np.shape[1],
            )
        )
    metrics = {
        "train_soft_accuracy": float(accuracy(train_soft_logits, y_train)),
        "train_hard_accuracy": float(accuracy(train_hard_logits, y_train)),
        "train_soft_hard_accuracy_gap": float(
            jnp.abs(accuracy(train_soft_logits, y_train) - accuracy(train_hard_logits, y_train))
        ),
        "train_soft_hard_prediction_disagreement": float(
            prediction_disagreement(train_soft_logits, train_hard_logits)
        ),
        "test_soft_accuracy": float(accuracy(test_soft_logits, y_test)),
        "test_hard_accuracy": float(accuracy(test_hard_logits, y_test)),
        "test_soft_hard_accuracy_gap": float(
            jnp.abs(accuracy(test_soft_logits, y_test) - accuracy(test_hard_logits, y_test))
        ),
        "test_soft_hard_prediction_disagreement": float(
            prediction_disagreement(test_soft_logits, test_hard_logits)
        ),
    }
    if packed_test_accuracy is not None:
        if packed_logits is None:
            raise RuntimeError("packed logits should be available when packed accuracy is set")
        metrics["packed_hard_test_accuracy"] = packed_test_accuracy
        metrics["test_hard_packed_prediction_disagreement"] = float(
            np.mean(
                np.argmax(np.asarray(test_hard_logits), axis=-1)
                != np.argmax(packed_logits, axis=-1)
            )
        )
    if packed_int8_test_accuracy is not None:
        metrics["packed_int8_head_test_accuracy"] = packed_int8_test_accuracy
    baselines: dict[str, Any] = {}
    if config.compare_mlp:
        baselines["mlp_same_features"] = run_mlp_baseline(
            x_train_np,
            y_train_np,
            x_test_np,
            y_test_np,
            n_classes=n_classes,
            config=config,
        )
    return {
        "dataset": name,
        "data": {**split.meta, **bit_meta},
        "model": model_meta,
        "training": {
            "epochs": config.epochs,
            "batch_size": config.batch_size,
            "updates": int(opt_state.step),
            "elapsed_s": elapsed,
            "last_loss": float(last_metrics[0]),
            "last_grad_norm": float(last_metrics[1]),
            "final_temperature": float(final_temperature),
        },
        "metrics": metrics,
        "baselines": baselines,
    }


def parse_stage_depths(text: str | tuple[int, ...]) -> tuple[int, ...]:
    """Parse comma-separated local tree stage depths."""
    if isinstance(text, tuple):
        return text
    try:
        depths = tuple(int(part) for part in text.split(",") if part)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("--tree-stage-depths must contain integers") from exc
    if not depths or any(depth <= 0 for depth in depths):
        raise argparse.ArgumentTypeError("--tree-stage-depths must be positive")
    return depths


def parse_hidden_sizes(text: str | tuple[int, ...]) -> tuple[int, ...]:
    """Parse comma-separated hidden sizes for the MLP baseline."""
    if isinstance(text, tuple):
        return text
    if text == "":
        return ()
    try:
        sizes = tuple(int(part) for part in text.split(",") if part)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("--mlp-hidden-sizes must contain integers") from exc
    if any(size <= 0 for size in sizes):
        raise argparse.ArgumentTypeError("--mlp-hidden-sizes must be positive")
    return sizes


def validate_args(args: argparse.Namespace) -> None:
    """Validate CLI arguments."""
    if not 0.0 < args.train_fraction < 1.0:
        raise ValueError("--train-fraction must be in (0, 1)")
    for name in (
        "max_train",
        "max_test",
        "input_bits",
        "pixel_thresholds",
        "layers",
        "width",
        "local_patch_size",
        "epochs",
        "batch_size",
    ):
        if getattr(args, name) <= 0:
            raise ValueError(f"--{name.replace('_', '-')} must be positive")
    if args.mlp_epochs < 0:
        raise ValueError("--mlp-epochs must be nonnegative")
    for name in (
        "step_size",
        "initial_temperature",
        "min_temperature",
        "gate_init_scale",
        "threshold_init_scale",
        "direction_init_scale",
        "head_init_scale",
        "max_grad_norm",
        "eml_eps",
        "eml_threshold_temperature",
        "group_sum_tau",
        "mlp_step_size",
        "mlp_max_grad_norm",
        "mlp_init_scale",
    ):
        if getattr(args, name) <= 0.0:
            raise ValueError(f"--{name.replace('_', '-')} must be positive")
    if args.mlp_weight_decay < 0.0:
        raise ValueError("--mlp-weight-decay must be nonnegative")
    if args.min_temperature > args.initial_temperature:
        raise ValueError("--min-temperature must be <= --initial-temperature")
    if (
        args.entropy_weight < 0.0
        or args.head_l2 < 0.0
        or args.readout_entropy_weight < 0.0
        or args.readout_balance_weight < 0.0
    ):
        raise ValueError("regularization weights must be nonnegative")
    if args.hard_loss_weight < 0.0:
        raise ValueError("--hard-loss-weight must be nonnegative")
    if not 0.0 <= args.input_drop_rate < 1.0:
        raise ValueError("--input-drop-rate must be in [0, 1)")
    if not 0.0 <= args.feature_drop_rate < 1.0:
        raise ValueError("--feature-drop-rate must be in [0, 1)")
    if args.residual_gate_bias < 0.0:
        raise ValueError("--residual-gate-bias must be nonnegative")
    if args.local_patch_size % 2 == 0:
        raise ValueError("--local-patch-size must be odd")
    if args.wiring_mode == "local_tree_hierarchy" and args.gate_mode == "eml_threshold":
        raise ValueError("local_tree_hierarchy OR pooling requires selector-based EML templates")
    if args.packed_eval and args.gate_mode == "eml_threshold":
        raise ValueError("--packed-eval currently requires selector-based EML templates")


def build_config(args: argparse.Namespace) -> DemoConfig:
    """Build an immutable config from CLI arguments."""
    return DemoConfig(
        datasets=tuple(args.datasets),
        seed=args.seed,
        train_fraction=args.train_fraction,
        max_train=args.max_train,
        max_test=args.max_test,
        feature_mode=args.feature_mode,
        input_bits=args.input_bits,
        pixel_thresholds=args.pixel_thresholds,
        layers=args.layers,
        width=args.width,
        wiring_mode=args.wiring_mode,
        local_patch_size=args.local_patch_size,
        tree_stage_depths=args.tree_stage_depths,
        epochs=args.epochs,
        batch_size=args.batch_size,
        step_size=args.step_size,
        initial_temperature=args.initial_temperature,
        min_temperature=args.min_temperature,
        entropy_weight=args.entropy_weight,
        head_l2=args.head_l2,
        gate_init_scale=args.gate_init_scale,
        head_init_scale=args.head_init_scale,
        max_grad_norm=args.max_grad_norm,
        eml_template_depth=args.eml_template_depth,
        eml_eps=args.eml_eps,
        gate_mode=args.gate_mode,
        eml_threshold_temperature=args.eml_threshold_temperature,
        threshold_init_scale=args.threshold_init_scale,
        direction_init_scale=args.direction_init_scale,
        hard_loss_weight=args.hard_loss_weight,
        input_drop_rate=args.input_drop_rate,
        feature_drop_rate=args.feature_drop_rate,
        residual_gate=args.residual_gate,
        residual_gate_bias=args.residual_gate_bias,
        head_mode=args.head_mode,
        group_sum_tau=args.group_sum_tau,
        readout_entropy_weight=args.readout_entropy_weight,
        readout_balance_weight=args.readout_balance_weight,
        packed_eval=args.packed_eval,
        compare_mlp=args.compare_mlp,
        mlp_hidden_sizes=args.mlp_hidden_sizes,
        mlp_epochs=args.mlp_epochs,
        mlp_step_size=args.mlp_step_size,
        mlp_weight_decay=args.mlp_weight_decay,
        mlp_max_grad_norm=args.mlp_max_grad_norm,
        mlp_init_scale=args.mlp_init_scale,
    )


def run_demo(config: DemoConfig, data_dir: Path) -> dict[str, Any]:
    """Run all requested datasets, preserving errors as result records."""
    results = []
    for dataset_name in config.datasets:
        print(f"running DiffEML image demo on {dataset_name}", flush=True)
        try:
            split = load_dataset(dataset_name, config, data_dir)
            results.append(run_one_dataset(dataset_name, split, config))
        except Exception as exc:  # pragma: no cover - exercised by unavailable external data
            results.append(
                {
                    "dataset": dataset_name,
                    "error": f"{type(exc).__name__}: {exc}",
                }
            )
    return {
        "config": asdict(config),
        "results": results,
    }
