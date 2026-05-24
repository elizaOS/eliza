"""Experience streams for continual learning."""

from alberta_framework.streams.base import ScanStream
from alberta_framework.streams.synthetic import (
    AbruptChangeState,
    AbruptChangeStream,
    AbruptChangeTarget,
    CyclicState,
    CyclicStream,
    CyclicTarget,
    DynamicScaleShiftState,
    DynamicScaleShiftStream,
    PeriodicChangeState,
    PeriodicChangeStream,
    PeriodicChangeTarget,
    RandomWalkState,
    RandomWalkStream,
    RandomWalkTarget,
    ScaleDriftState,
    ScaleDriftStream,
    ScaledStreamState,
    ScaledStreamWrapper,
    SuttonExperiment1State,
    SuttonExperiment1Stream,
    make_scale_range,
)

__all__ = [
    # Protocol
    "ScanStream",
    # Stream classes
    "AbruptChangeState",
    "AbruptChangeStream",
    "AbruptChangeTarget",
    "CyclicState",
    "CyclicStream",
    "CyclicTarget",
    "DynamicScaleShiftState",
    "DynamicScaleShiftStream",
    "PeriodicChangeState",
    "PeriodicChangeStream",
    "PeriodicChangeTarget",
    "RandomWalkState",
    "RandomWalkStream",
    "RandomWalkTarget",
    "ScaleDriftState",
    "ScaleDriftStream",
    "ScaledStreamState",
    "ScaledStreamWrapper",
    "SuttonExperiment1State",
    "SuttonExperiment1Stream",
    # Utilities
    "make_scale_range",
]

# Gymnasium streams are optional - only export if gymnasium is installed
try:
    from alberta_framework.streams.gymnasium import (
        GymnasiumStream,
        PredictionMode,
        TDStream,
        collect_trajectory,
        learn_from_trajectory,
        learn_from_trajectory_normalized,
        make_epsilon_greedy_policy,
        make_gymnasium_stream,
        make_random_policy,
    )

    __all__ += [
        "GymnasiumStream",
        "PredictionMode",
        "TDStream",
        "collect_trajectory",
        "learn_from_trajectory",
        "learn_from_trajectory_normalized",
        "make_epsilon_greedy_policy",
        "make_gymnasium_stream",
        "make_random_policy",
    ]
except ImportError:
    # gymnasium not installed
    pass
