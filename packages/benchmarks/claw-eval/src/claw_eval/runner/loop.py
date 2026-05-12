"""Core agent execution loop: Think -> Act -> Observe -> Repeat."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import uuid4

if TYPE_CHECKING:
    from .user_agent import UserAgent

from ..config import MediaConfig, ModelConfig, PromptConfig
from ..models.content import ContentBlock, TextBlock, ToolResultBlock
from ..models.message import Message
from ..models.task import TaskDefinition
from ..models.trace import (
    AuditSnapshot,
    CompactEvent,
    DimensionScores,
    MediaLoad,
    TokenUsage,
    TraceEnd,
    TraceMessage,
    TraceStart,
)
from ..trace.writer import TraceWriter
from .agent_tools import build_agent_tools
from .compact import (
    _estimate_tokens,
    do_auto_compact,
    micro_compact,
    should_auto_compact,
)
from .dispatcher import ToolDispatcher
from .media_loader import collect_media_references, load_media_from_ref, model_supports_modality, to_content_block
from .providers.openai_compat import OpenAICompatProvider
from .system_prompt import build_system_prompt
from .todo import TodoManager


def _log(msg: str) -> None:
    """Print a log line and flush immediately (important for container logs)."""
    print(msg, flush=True)


def _brief(d: dict, max_len: int = 80) -> str:
    """Compact one-line summary of a dict for logging."""
    s = json.dumps(d, ensure_ascii=False)
    return s if len(s) <= max_len else s[:max_len] + "..."


def _make_local_tool_result(tool_use, text: str, is_error: bool = False) -> ToolResultBlock:
    """Create a ToolResultBlock for a locally dispatched agent tool."""
    return ToolResultBlock(
        tool_use_id=tool_use.id,
        content=[TextBlock(text=text)],
        is_error=is_error,
    )


def _cap_conversation_images(messages: list[Message], max_images: int) -> int:
    """Drop earliest image blocks in-place when total exceeds *max_images*.

    Protects messages[0] (system) and messages[1] (initial user prompt).
    Keeps the *last* max_images images; replaces earlier ones with text
    placeholders.  Returns the number of images dropped.
    """
    if max_images <= 0:
        return 0

    # Count ALL images (including protected prompt) to respect global budget
    total_images = sum(
        1 for msg in messages for b in msg.content if b.type == "image"
    )
    if total_images <= max_images:
        return 0

    # Protected images in messages[0:2] (system + initial prompt)
    protected = sum(
        1 for msg in messages[:2] for b in msg.content if b.type == "image"
    )
    # Non-protected budget: total budget minus the protected images
    allowed = max(0, max_images - protected)

    # Collect positions of droppable images (messages[2:])
    positions: list[tuple[int, int]] = []
    for mi in range(2, len(messages)):
        for bi, block in enumerate(messages[mi].content):
            if block.type == "image":
                positions.append((mi, bi))

    if len(positions) <= allowed:
        return 0

    # Drop earliest, keep the last `allowed`
    n_drop = len(positions) - allowed
    for mi, bi in positions[:n_drop]:
        messages[mi].content[bi] = TextBlock(
            text="[Image dropped: conversation image limit reached]"
        )
    return n_drop


def _strip_old_turn_images(messages: list[Message], keep_recent_turns: int = 3) -> int:
    """Strip ImageBlocks from messages older than *keep_recent_turns* turns.

    A turn is defined by an assistant message.  All images in messages before
    the *keep_recent_turns*-th most recent assistant message are removed
    in-place.  Text content (including media captions) is preserved.
    """
    if keep_recent_turns <= 0:
        return 0

    assistant_indices = [
        i for i, msg in enumerate(messages)
        if msg.role == "assistant"
    ]

    if len(assistant_indices) <= keep_recent_turns:
        return 0

    cutoff_idx = assistant_indices[-keep_recent_turns]

    n_stripped = 0
    for i in range(cutoff_idx):
        msg = messages[i]
        new_content = [b for b in msg.content if b.type != "image"]
        removed = len(msg.content) - len(new_content)
        if removed:
            msg.content = new_content
            n_stripped += removed

    return n_stripped


def _build_initial_user_content(
    task: TaskDefinition,
    *,
    trace_id: str,
    writer: TraceWriter,
    model_cfg: ModelConfig | None,
    media_cfg: MediaConfig | None,
) -> list[ContentBlock]:
    content: list[ContentBlock] = [TextBlock(text=task.prompt.text)]
    if media_cfg is not None and not media_cfg.enabled:
        return content

    cfg = media_cfg or MediaConfig()
    model = model_cfg or ModelConfig()
    refs = collect_media_references(task.prompt.text, task.prompt.attachments)
    if not refs:
        return content

    workspace_root = Path.cwd()
    task_dir = Path(task.task_file).parent if task.task_file else None
    for idx, ref in enumerate(refs):
        ref_modality = "image"
        if ref.mime_type:
            if ref.mime_type.startswith("audio/"):
                ref_modality = "audio"
            elif ref.mime_type.startswith("video/"):
                ref_modality = "video"
            elif ref.mime_type.startswith("text/") or ref.mime_type in {"application/json", "application/xml"}:
                ref_modality = "document"
        if idx >= cfg.max_files:
            writer.write_event(MediaLoad(
                trace_id=trace_id,
                modality=ref_modality,  # type: ignore[arg-type]
                source_path=ref.raw_path,
                mime_type=ref.mime_type or "",
                size_bytes=0,
                sha256="",
                status="skipped",
                note=f"exceeds max_files={cfg.max_files}",
            ))
            continue
        try:
            loaded = load_media_from_ref(
                ref,
                workspace_root=workspace_root,
                task_dir=task_dir,
                max_bytes=cfg.max_bytes_per_file,
                image_max_dimension=cfg.image_max_dimension,
            )
            if not model_supports_modality(model.input_modalities, loaded.modality):
                writer.write_event(MediaLoad(
                    trace_id=trace_id,
                    modality=loaded.modality,  # type: ignore[arg-type]
                    source_path=loaded.source_path,
                    mime_type=loaded.mime_type,
                    size_bytes=loaded.size_bytes,
                    sha256=loaded.sha256,
                    status="skipped",
                    note=f"model does not support modality: {loaded.modality}",
                ))
                if cfg.strict_mode:
                    raise ValueError(f"Model {model.model_id} does not support {loaded.modality} input")
                continue
            content.append(to_content_block(loaded))
            writer.write_event(MediaLoad(
                trace_id=trace_id,
                modality=loaded.modality,  # type: ignore[arg-type]
                source_path=loaded.source_path,
                mime_type=loaded.mime_type,
                size_bytes=loaded.size_bytes,
                sha256=loaded.sha256,
                status="loaded",
                note=ref.source,
            ))
        except Exception as exc:
            writer.write_event(MediaLoad(
                trace_id=trace_id,
                modality=ref_modality,  # type: ignore[arg-type]
                source_path=ref.raw_path,
                mime_type=ref.mime_type or "",
                size_bytes=0,
                sha256="",
                status="error",
                note=str(exc),
            ))
            if cfg.strict_mode:
                raise
    return content


def run_task(
    task: TaskDefinition,
    provider: OpenAICompatProvider,
    trace_dir: str | Path = "traces",
    *,
    sandbox_tools: bool = False,
    sandbox_url: str | None = None,
    prompt_cfg: PromptConfig | None = None,
    model_cfg: ModelConfig | None = None,
    media_cfg: MediaConfig | None = None,
    user_agent: "UserAgent | None" = None,
) -> Path:
    """Execute one trial of a task and write JSONL trace.

    Args:
        sandbox_tools: When True, sandbox tools (shell/file/browser) are
            appended to task tools and dispatched via
            :class:`SandboxToolDispatcher`.
        sandbox_url: When provided, sandbox tool calls are routed over
            HTTP to a container sandbox server at this URL (e.g.
            ``http://localhost:18080``).  When *None*, sandbox tools
            execute locally via subprocess (backward compatibility).

    Returns the path to the trace file.
    """
    trace_id = str(uuid4())
    trace_path = Path(trace_dir) / f"{task.task_id}_{trace_id[:8]}.jsonl"

    endpoint_map = task.get_endpoint_map()
    http_dispatcher = ToolDispatcher(endpoint_map)
    _mcfg = media_cfg or MediaConfig()

    sandbox_tool_list = None
    if sandbox_tools:
        from .sandbox_dispatcher import SandboxToolDispatcher
        from .sandbox_tools import SANDBOX_TOOLS

        # Deduplicate: skip sandbox tools already defined in task.yaml
        existing_names = {t.name for t in task.tools}
        sandbox_tool_list = [t for t in SANDBOX_TOOLS if t.name not in existing_names]
        task_tools = list(task.tools) + sandbox_tool_list
        dispatcher = SandboxToolDispatcher(
            http_dispatcher,
            sandbox_url=sandbox_url,
            max_images_per_turn=_mcfg.max_images_per_turn,
            tool_image_max_dimension=_mcfg.tool_image_max_dimension,
            tool_image_quality=_mcfg.tool_image_quality,
        )
    else:
        task_tools = task.tools
        dispatcher = http_dispatcher

    # Build agent-level tools (todo, compact)
    agent_tool_list = build_agent_tools(
        enable_todo=task.environment.enable_todo,
        enable_compact=task.environment.enable_compact,
    )
    task_tools = task_tools + agent_tool_list

    # Initialise TodoManager and compact state
    todo_mgr = TodoManager() if task.environment.enable_todo else None
    auto_compact_count = 0
    context_window = model_cfg.context_window if model_cfg else 200_000

    total_usage = TokenUsage()
    turn_count = 0
    wall_start = time.monotonic()
    model_time_s = 0.0
    tool_time_s = 0.0

    # User agent state
    user_agent_rounds = 0
    ua_done = False
    ua_cfg = task.user_agent
    ua_enabled = ua_cfg.enabled and user_agent is not None
    ua_max_rounds = ua_cfg.max_rounds if ua_enabled else 0

    _log(f"[start] task={task.task_id} model={provider.model_id} trace={trace_path.name}")
    _log(f"[config] max_turns={task.environment.max_turns} timeout={task.environment.timeout_seconds}s sandbox_tools={sandbox_tools}")
    if agent_tool_list:
        _log(f"[agent tools] {', '.join(t.name for t in agent_tool_list)}")

    with TraceWriter(trace_path) as writer:
        # Write trace start
        writer.write_event(TraceStart(
            trace_id=trace_id,
            task_id=task.task_id,
            model=provider.model_id,
        ))

        # Build initial messages
        system_prompt = build_system_prompt(task, prompt_cfg, extra_tools=sandbox_tool_list)
        if model_cfg and model_cfg.system_prompt_prefix:
            system_prompt = model_cfg.system_prompt_prefix + "\n\n" + system_prompt
        if ua_enabled and ua_cfg.system_prompt_suffix:
            system_prompt = system_prompt + "\n\n" + ua_cfg.system_prompt_suffix
        user_content = _build_initial_user_content(
            task,
            trace_id=trace_id,
            writer=writer,
            model_cfg=model_cfg,
            media_cfg=media_cfg,
        )
        messages: list[Message] = [
            Message(role="system", content=[TextBlock(text=system_prompt)]),
            Message(role="user", content=user_content),
        ]

        # Log user message
        writer.write_event(TraceMessage(
            trace_id=trace_id,
            message=messages[-1],
        ))

        # Agent loop — wrapped in try/finally so trace_end is always written,
        # even if the model API throws an unrecoverable error mid-run.
        loop_error: str | None = None
        loop_exc: Exception | None = None
        try:
            while turn_count < task.environment.max_turns:
                # Check timeout
                elapsed = time.monotonic() - wall_start
                if elapsed > task.environment.timeout_seconds:
                    _log(f"[timeout] {elapsed:.1f}s exceeded limit {task.environment.timeout_seconds}s")
                    break

                # --- Layer 1: Micro-compact (truncate old tool results & strip old images) ---
                if task.environment.enable_compact:
                    micro_compact(
                        messages,
                        keep_recent=task.environment.compact_keep_recent,
                        min_chars=task.environment.compact_min_chars,
                    )

                # --- Layer 2: Auto-compact (summarise when context is large) ---
                if (
                    task.environment.enable_compact
                    and auto_compact_count < task.environment.compact_max_auto_compacts
                    and should_auto_compact(messages, context_window, task.environment.compact_threshold_pct)
                ):
                    tokens_before = _estimate_tokens(messages)
                    msgs_before = len(messages)
                    _log(f"[auto-compact] triggering (est. {tokens_before} tokens, {msgs_before} msgs)")
                    messages = do_auto_compact(
                        messages,
                        provider,
                        keep_recent_on_summary=task.environment.compact_keep_recent_on_summary,
                        protect_tokens=task.environment.compact_protect_tokens,
                        todo_mgr=todo_mgr,
                    )
                    auto_compact_count += 1
                    tokens_after = _estimate_tokens(messages)
                    writer.write_event(CompactEvent(
                        trace_id=trace_id,
                        layer="auto",
                        estimated_tokens_before=tokens_before,
                        estimated_tokens_after=tokens_after,
                        messages_before=msgs_before,
                        messages_after=len(messages),
                    ))
                    _log(f"[auto-compact] done: {tokens_before} → {tokens_after} tokens, {msgs_before} → {len(messages)} msgs")

                # Strip images from turns older than keep_recent_turns
                n_old = _strip_old_turn_images(messages, _mcfg.image_keep_recent_turns)
                if n_old > 0:
                    _log(f"  [image-strip] stripped {n_old} image(s) from old turns, keeping last {_mcfg.image_keep_recent_turns} turns")

                # Cap total images in conversation before API call
                n_dropped = _cap_conversation_images(messages, _mcfg.max_conversation_images)
                if n_dropped > 0:
                    _log(f"  [image-cap] dropped {n_dropped} oldest image(s), keeping last {_mcfg.max_conversation_images}")

                # Call model
                _log(f"[turn {turn_count + 1}/{task.environment.max_turns}] calling model ...")
                model_t0 = time.monotonic()
                response, usage = provider.chat(messages, tools=task_tools)
                model_time_s += time.monotonic() - model_t0
                total_usage.input_tokens += usage.input_tokens
                total_usage.output_tokens += usage.output_tokens
                turn_count += 1

                # Log assistant message
                writer.write_event(TraceMessage(
                    trace_id=trace_id,
                    message=response,
                    usage=usage,
                ))

                messages.append(response)

                # Summarize what the model returned
                text_blocks = [b for b in response.content if b.type == "text"]
                tool_uses = [b for b in response.content if b.type == "tool_use"]
                text_preview = text_blocks[0].text[:120].replace("\n", " ") if text_blocks else ""
                _log(f"[turn {turn_count}] assistant: {len(text_blocks)} text, {len(tool_uses)} tool_use | tokens: +{usage.input_tokens}in +{usage.output_tokens}out")
                if text_preview:
                    _log(f"  text: {text_preview}{'...' if len(text_blocks[0].text) > 120 else ''}")

                if not tool_uses:
                    if ua_enabled and user_agent_rounds < ua_max_rounds:
                        ua_text = user_agent.generate_response(
                            persona=ua_cfg.persona,
                            conversation_messages=messages,
                        )
                        if ua_text is None:
                            ua_done = True
                            _log(f"[user-agent] user satisfied — ending at turn {turn_count}")
                            break
                        user_agent_rounds += 1
                        ua_msg = Message(role="user", content=[TextBlock(text=f"[user_agent]\n{ua_text}")])
                        messages.append(ua_msg)
                        writer.write_event(TraceMessage(trace_id=trace_id, message=ua_msg))
                        _log(f"[user-agent] round {user_agent_rounds}/{ua_max_rounds}: {ua_text[:100]}")
                        continue
                    _log(f"[done] no tool calls — agent finished at turn {turn_count}")
                    break

                # Dispatch each tool call
                result_blocks = []
                media_blocks: list[ContentBlock] = []
                has_non_agent_tool = False
                for tu in tool_uses:
                    _log(f"  -> tool: {tu.name}({_brief(tu.input)})")

                    # --- Local agent tool dispatch ---
                    if tu.name == "todo" and todo_mgr:
                        result_text = todo_mgr.update(tu.input.get("items", []))
                        result = _make_local_tool_result(tu, result_text)
                        result_blocks.append(result)
                        _log(f"  <- todo: OK (local)")
                        continue

                    if tu.name == "compact" and task.environment.enable_compact:
                        tokens_before = _estimate_tokens(messages)
                        msgs_before = len(messages)
                        messages = do_auto_compact(
                            messages,
                            provider,
                            keep_recent_on_summary=task.environment.compact_keep_recent_on_summary,
                            protect_tokens=task.environment.compact_protect_tokens,
                            todo_mgr=todo_mgr,
                            focus=tu.input.get("focus"),
                        )
                        auto_compact_count += 1
                        tokens_after = _estimate_tokens(messages)
                        writer.write_event(CompactEvent(
                            trace_id=trace_id,
                            layer="manual",
                            estimated_tokens_before=tokens_before,
                            estimated_tokens_after=tokens_after,
                            messages_before=msgs_before,
                            messages_after=len(messages),
                        ))
                        result = _make_local_tool_result(
                            tu, f"Context compacted. {tokens_before} → {tokens_after} est. tokens."
                        )
                        result_blocks.append(result)
                        _log(f"  <- compact: OK (local, {tokens_before} → {tokens_after} tokens)")
                        continue

                    # --- Standard dispatcher (sandbox / HTTP) ---
                    has_non_agent_tool = True
                    dispatch_result = dispatcher.dispatch(tu, trace_id)
                    # Support both 2-tuple (legacy) and 3-tuple (media-aware) dispatch
                    if len(dispatch_result) == 3:
                        result, dispatch_event, extra_media = dispatch_result
                    else:
                        result, dispatch_event = dispatch_result
                        extra_media = None
                    writer.write_event(dispatch_event)
                    result_blocks.append(result)
                    if extra_media:
                        media_blocks.extend(extra_media)
                    tool_time_s += dispatch_event.latency_ms / 1000.0
                    status_tag = "OK" if not result.is_error else "ERR"
                    _log(f"  <- {tu.name}: {status_tag} ({dispatch_event.latency_ms:.0f}ms)")

                # Message 1: tool results (becomes role:tool in OpenAI format)
                tool_msg = Message(role="user", content=result_blocks)
                messages.append(tool_msg)

                writer.write_event(TraceMessage(
                    trace_id=trace_id,
                    message=tool_msg,
                ))

                # Message 2: visual content (role:user with images, only if there are images)
                if media_blocks:
                    from ..models.content import ImageBlock as _IB
                    caption = TextBlock(text=f"[Visual content from tool results: {len(media_blocks)} image(s)]")
                    media_msg = Message(role="user", content=[caption] + media_blocks)
                    messages.append(media_msg)
                    writer.write_event(TraceMessage(
                        trace_id=trace_id,
                        message=media_msg,
                    ))
                    _log(f"  [media] injected {len(media_blocks)} image(s) into conversation")
        except Exception as exc:
            loop_error = f"{type(exc).__name__}: {exc}"
            loop_exc = exc  # preserve original exception for re-raise
            _log(f"[error] agent loop failed: {loop_error}")

        # Fetch audit snapshots from mock services (best-effort)
        import httpx as _httpx

        for svc in task.services:
            if svc.reset_endpoint:
                audit_url = svc.reset_endpoint.rsplit("/reset", 1)[0] + "/audit"
                try:
                    resp = _httpx.get(audit_url, timeout=5)
                    writer.write_event(AuditSnapshot(
                        trace_id=trace_id,
                        service_name=svc.name,
                        audit_url=audit_url,
                        audit_data=resp.json(),
                    ))
                except Exception:
                    pass  # audit fetch is best-effort

        # Write trace end (always, even on error)
        wall_time = time.monotonic() - wall_start
        input_tok = total_usage.input_tokens
        output_tok = total_usage.output_tokens
        total_tok = total_usage.input_tokens + total_usage.output_tokens
        other_time_s = max(0.0, wall_time - model_time_s - tool_time_s)
        failure_modes = [loop_error] if loop_error else []
        writer.write_event(TraceEnd(
            trace_id=trace_id,
            total_turns=turn_count,
            model_input_tokens=input_tok,
            model_output_tokens=output_tok,
            input_tokens=input_tok,
            output_tokens=output_tok,
            total_tokens=total_tok,
            model_time_s=round(model_time_s, 2),
            tool_time_s=round(tool_time_s, 2),
            other_time_s=round(other_time_s, 2),
            wall_time_s=round(wall_time, 2),
            failure_modes=failure_modes,
            user_agent_rounds=user_agent_rounds,
            user_agent_max_rounds=ua_max_rounds,
            user_agent_done=ua_done,
        ))

        # Re-raise original exception so the caller (_run_single_task) can
        # match on exception type (e.g. APIConnectionError) for retry logic.
        if loop_error:
            raise loop_exc

    _log(
        f"[end] turns={turn_count} tokens={total_tok} "
        f"({input_tok}in/{output_tok}out) "
        f"time=model {model_time_s:.1f}s tool {tool_time_s:.1f}s wall {wall_time:.1f}s"
    )

    dispatcher.close()
    return trace_path
