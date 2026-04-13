"""
Trajectory logging integration for the MINT benchmark.

This integrates with the elizaOS trajectory logger plugin:
`plugins/plugin-trajectory-logger/python/elizaos_plugin_trajectory_logger`.

Goal:
- Capture end-to-end ElizaOS flow (providers + model calls + tool execution) during benchmarks.
- Export trajectories in ART / GRPO-friendly formats for downstream training.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class TrajectoryLoggingConfig:
    dataset_name: str
    output_dir: Path


def instrument_runtime_for_trajectory_logging(runtime: object, logger_service: object) -> None:
    """
    Monkey-patch an AgentRuntime instance to emit provider + model call events into the
    trajectory logger service.

    The currently-active trajectory is read from `runtime.__mint_active_trajectory_id`.
    """
    # Avoid double-instrumentation
    if getattr(runtime, "__mint_trajectory_instrumented", False):
        return

    # Import plugin types lazily (only when installed / on sys.path).
    from elizaos_plugin_trajectory_logger.types import LLMCall, ProviderAccess

    # Wrap runtime.use_model
    if hasattr(runtime, "use_model"):
        original_use_model = getattr(runtime, "use_model")

        async def use_model_wrapped(model_type: object, params: dict[str, object] | None = None, **kwargs: object) -> object:  # type: ignore[no-redef]
            start_ms = int(time.time() * 1000)

            # Normalize params (mirror AgentRuntime.use_model behavior)
            effective_params: dict[str, object]
            if params is None:
                effective_params = dict(kwargs)
            elif kwargs:
                effective_params = {**params, **kwargs}
            else:
                effective_params = dict(params)

            system_prompt = str(effective_params.get("system") or effective_params.get("system_prompt") or "")
            user_prompt = str(effective_params.get("prompt") or "")
            temperature_val = effective_params.get("temperature")
            max_tokens_val = effective_params.get("maxTokens") or effective_params.get("max_tokens")

            response_obj = await original_use_model(model_type, params, **kwargs)  # type: ignore[misc]
            end_ms = int(time.time() * 1000)

            trajectory_id = getattr(runtime, "__mint_active_trajectory_id", None)
            if isinstance(trajectory_id, str) and trajectory_id:
                try:
                    model_name = str(model_type.value) if hasattr(model_type, "value") else str(model_type)
                    temperature = float(temperature_val) if isinstance(temperature_val, int | float) else 0.7
                    max_tokens = int(max_tokens_val) if isinstance(max_tokens_val, int) else 2048

                    logger_service.log_llm_call_by_trajectory_id(  # type: ignore[attr-defined]
                        trajectory_id,
                        LLMCall(
                            call_id=str(uuid.uuid4()),
                            timestamp=end_ms,
                            model=model_name,
                            system_prompt=system_prompt,
                            user_prompt=user_prompt[:8000],
                            response=str(response_obj)[:8000],
                            temperature=temperature,
                            max_tokens=max_tokens,
                            purpose="action",
                            latency_ms=max(0, end_ms - start_ms),
                        ),
                    )
                except Exception:
                    # Logging must never break benchmark execution.
                    pass

            return response_obj

        setattr(runtime, "__mint_original_use_model", original_use_model)
        setattr(runtime, "use_model", use_model_wrapped)

    # Wrap providers: runtime.providers is canonical public property.
    providers = getattr(runtime, "providers", None)
    if isinstance(providers, list):
        for provider in providers:
            get_fn = getattr(provider, "get", None)
            if get_fn is None or not callable(get_fn):
                continue

            async def get_wrapped(rt: object, message: object, state: object, __orig=get_fn, __provider=provider):  # type: ignore[no-redef]
                result = await __orig(rt, message, state)
                trajectory_id = getattr(rt, "__mint_active_trajectory_id", None)
                if isinstance(trajectory_id, str) and trajectory_id:
                    try:
                        logger_service.log_provider_access_by_trajectory_id(  # type: ignore[attr-defined]
                            trajectory_id,
                            ProviderAccess(
                                provider_id=str(uuid.uuid4()),
                                provider_name=str(getattr(__provider, "name", "UNKNOWN")),
                                timestamp=int(time.time() * 1000),
                                query={
                                    "message": str(getattr(getattr(message, "content", None), "text", "") or ""),
                                },
                                data={
                                    "text": str(getattr(result, "text", "") or "")[:1000],
                                    "valuesText": str(getattr(result, "values", "") or "")[:2000],
                                },
                                purpose="context",
                            ),
                        )
                    except Exception:
                        pass
                return result

            try:
                setattr(provider, "get", get_wrapped)
            except Exception:
                # Some Provider objects may be frozen; skip.
                continue

    setattr(runtime, "__mint_trajectory_instrumented", True)


def export_benchmark_trajectories(
    *,
    logger_service: object,
    trajectory_ids: list[str],
    config: TrajectoryLoggingConfig,
) -> None:
    """
    Export trajectories via the trajectory logger plugin utilities.
    """
    from elizaos_plugin_trajectory_logger.export import ExportOptions, export_for_openpipe_art, export_grouped_for_grpo

    trajectories: list[object] = []
    for tid in trajectory_ids:
        try:
            traj = logger_service.get_active_trajectory(tid)  # type: ignore[attr-defined]
        except Exception:
            traj = None
        if traj is not None:
            trajectories.append(traj)

    # Nothing to export
    if not trajectories:
        return

    config.output_dir.mkdir(parents=True, exist_ok=True)

    export_for_openpipe_art(
        ExportOptions(
            dataset_name=config.dataset_name,
            trajectories=trajectories,  # type: ignore[arg-type]
            output_dir=str(config.output_dir),
        )
    )
    export_grouped_for_grpo(
        ExportOptions(
            dataset_name=config.dataset_name,
            trajectories=trajectories,  # type: ignore[arg-type]
            output_dir=str(config.output_dir),
        )
    )

