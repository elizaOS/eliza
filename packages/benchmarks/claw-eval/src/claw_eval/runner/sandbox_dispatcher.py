"""Sandbox-aware tool dispatcher.

Routes sandbox tool calls either:
  - Over HTTP to a remote sandbox container (when *sandbox_url* is provided), OR
  - Locally via subprocess/filesystem (fallback for backward compatibility).

All other tool calls are delegated to the standard HTTP ToolDispatcher.
"""

from __future__ import annotations

import base64
import io
import json
import subprocess
import time
from pathlib import Path

from ..models.content import ImageBlock, TextBlock, ToolResultBlock, ToolUseBlock
from ..models.trace import ToolDispatch
from .dispatcher import ToolDispatcher
from .sandbox_tools import SANDBOX_TOOL_NAMES

# Tools whose responses always contain extractable image frames
_ALWAYS_MEDIA_TOOLS = frozenset({"ReadMedia", "BrowserScreenshot"})
# Tools that conditionally return frames (e.g. Read with image/PDF)
_CONDITIONAL_MEDIA_TOOLS = frozenset({"Read"})


def _compress_image_b64(
    data_b64: str, max_dimension: int, quality: int = 60
) -> str:
    """Resize + JPEG-compress a base64-encoded image.

    - Resizes so the longest edge <= *max_dimension* (if needed).
    - Converts to JPEG at the given *quality* (0–100).
    - Handles RGBA / palette images by compositing onto white background.

    Returns the original data unchanged when Pillow is unavailable or
    any decoding/encoding error occurs.
    """
    try:
        from PIL import Image as _PILImage

        raw = base64.b64decode(data_b64)
        img = _PILImage.open(io.BytesIO(raw))
        w, h = img.size

        # Resize if needed
        needs_resize = max_dimension > 0 and max(w, h) > max_dimension
        if needs_resize:
            scale = max_dimension / max(w, h)
            new_w = max(1, int(w * scale))
            new_h = max(1, int(h * scale))
            img = img.resize((new_w, new_h), _PILImage.LANCZOS)

        # Convert to RGB for JPEG (handle RGBA, palette, LA, etc.)
        if img.mode not in ("RGB", "L"):
            background = _PILImage.new("RGB", img.size, (255, 255, 255))
            if img.mode in ("RGBA", "LA") or (
                img.mode == "P" and "transparency" in img.info
            ):
                background.paste(img, mask=img.split()[-1])
            else:
                background.paste(img)
            img = background

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality)
        return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:
        return data_b64


class SandboxToolDispatcher:
    """Routes sandbox tools to container HTTP or local fallback; others via HTTP."""

    def __init__(
        self,
        http_dispatcher: ToolDispatcher,
        *,
        sandbox_url: str | None = None,
        max_images_per_turn: int = 64,
        tool_image_max_dimension: int = 1280,
        tool_image_quality: int = 60,
    ) -> None:
        self._http = http_dispatcher
        self._sandbox_url = sandbox_url
        self._client = None  # lazy-init httpx client for remote mode
        self._max_per_turn = max_images_per_turn
        self._max_dimension = tool_image_max_dimension
        self._image_quality = tool_image_quality

    # ---- public interface (same signature as ToolDispatcher) ---------------

    def dispatch(
        self, tool_use: ToolUseBlock, trace_id: str
    ) -> tuple[ToolResultBlock, ToolDispatch, list[ImageBlock] | None]:
        if tool_use.name in SANDBOX_TOOL_NAMES:
            return self._dispatch_sandbox(tool_use, trace_id)
        result, event = self._http.dispatch(tool_use, trace_id)
        return result, event, None

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
        self._http.close()

    # ---- sandbox routing -------------------------------------------------

    def _dispatch_sandbox(
        self, tool_use: ToolUseBlock, trace_id: str
    ) -> tuple[ToolResultBlock, ToolDispatch, list[ImageBlock] | None]:
        if self._sandbox_url:
            return self._dispatch_remote(tool_use, trace_id)
        return self._dispatch_local(tool_use, trace_id)

    # ---- remote mode: HTTP to container ----------------------------------

    _PATH_MAP = {
        "Bash": "/exec",
        "Read": "/read",
        "Write": "/write",
        "Edit": "/edit",
        "Glob": "/glob",
        "Grep": "/grep",
        "BrowserScreenshot": "/screenshot",
        "ReadMedia": "/read_media",
        "Download": "/download",
    }

    def _get_client(self):
        if self._client is None:
            import httpx
            self._client = httpx.Client(timeout=120.0)
        return self._client

    @staticmethod
    def _translate_payload(tool_use: ToolUseBlock) -> dict:
        """Translate client-facing param names to server-side param names."""
        payload = dict(tool_use.input)
        if tool_use.name == "Bash":
            if "timeout" in payload:
                payload["timeout_seconds"] = max(1, payload.pop("timeout") // 1000)
            payload.pop("description", None)
            payload.pop("run_in_background", None)
        elif tool_use.name in ("Read", "Write", "Edit"):
            if "file_path" in payload:
                payload["path"] = payload.pop("file_path")
        elif tool_use.name == "Grep":
            # Translate Claude Code param names to server grep params
            if "case_insensitive" in payload:
                payload["case_insensitive"] = payload.pop("case_insensitive")
            if "context_lines" in payload:
                payload["context_lines"] = payload.pop("context_lines")
            if "after_context" in payload:
                payload["after_context"] = payload.pop("after_context")
            if "before_context" in payload:
                payload["before_context"] = payload.pop("before_context")
        return payload

    def _dispatch_remote(
        self, tool_use: ToolUseBlock, trace_id: str
    ) -> tuple[ToolResultBlock, ToolDispatch, list[ImageBlock] | None]:
        path = self._PATH_MAP.get(tool_use.name)
        if not path:
            return self._error_result(
                tool_use, trace_id,
                f"Unknown sandbox tool: {tool_use.name}",
                status=404,
            )

        endpoint_url = f"{self._sandbox_url}{path}"
        payload = self._translate_payload(tool_use)
        t0 = time.monotonic()
        try:
            client = self._get_client()
            resp = client.post(endpoint_url, json=payload)
            latency_ms = (time.monotonic() - t0) * 1000
            body = resp.json()
            is_error = resp.status_code >= 400
        except Exception as exc:
            latency_ms = (time.monotonic() - t0) * 1000
            return self._error_result(
                tool_use, trace_id, str(exc),
                status=500, latency_ms=latency_ms,
                endpoint_url=endpoint_url,
            )

        # Extract images from media tool responses
        extra_images: list[ImageBlock] | None = None
        is_media_response = (
            tool_use.name in _ALWAYS_MEDIA_TOOLS
            or (tool_use.name in _CONDITIONAL_MEDIA_TOOLS and "frames" in body)
        )
        if is_media_response and not is_error:
            extra_images = []
            frames = body.get("frames", [])
            valid_frames = [f for f in frames if "image_b64" in f]
            total_available = len(valid_frames)
            budget = self._max_per_turn

            # Uniform sampling when more frames than budget
            if total_available <= budget:
                selected = valid_frames
            else:
                indices = [int(i * total_available / budget) for i in range(budget)]
                selected = [valid_frames[idx] for idx in indices]

            for frame in selected:
                compressed = _compress_image_b64(
                    frame["image_b64"], self._max_dimension, self._image_quality,
                )
                extra_images.append(ImageBlock(
                    data=compressed,
                    mime_type="image/jpeg",
                ))

            # Strip base64 data from text summary to save tokens
            summary_body = {k: v for k, v in body.items() if k != "frames"}
            summary_body["frame_count"] = total_available
            summary_body["frames_shown"] = len(selected)
            if total_available > len(selected):
                summary_body["sampling"] = f"uniform ({len(selected)} of {total_available})"
            text_content = json.dumps(summary_body, ensure_ascii=False)
            if not extra_images:
                extra_images = None
        else:
            text_content = json.dumps(body, ensure_ascii=False)

        result = ToolResultBlock(
            tool_use_id=tool_use.id,
            content=[TextBlock(text=text_content)],
            is_error=is_error,
        )
        dispatch_event = ToolDispatch(
            trace_id=trace_id,
            tool_use_id=tool_use.id,
            tool_name=tool_use.name,
            endpoint_url=endpoint_url,
            request_body=tool_use.input,
            response_status=resp.status_code,
            response_body=body,
            latency_ms=latency_ms,
        )
        return result, dispatch_event, extra_images

    # ---- local mode: subprocess/filesystem (backward compat) -------------

    _LOCAL_HANDLERS: dict[str, str] = {
        "Bash": "_handle_shell_exec",
        "Read": "_handle_file_read",
        "Write": "_handle_file_write",
        "Edit": "_handle_edit",
        "Glob": "_handle_glob",
        "Grep": "_handle_grep",
        "BrowserScreenshot": "_handle_browser_screenshot",
        "ReadMedia": "_handle_not_available",
        "Download": "_handle_not_available",
    }

    def _dispatch_local(
        self, tool_use: ToolUseBlock, trace_id: str
    ) -> tuple[ToolResultBlock, ToolDispatch, list[ImageBlock] | None]:
        handler_name = self._LOCAL_HANDLERS.get(tool_use.name)
        if handler_name is None:
            return self._error_result(
                tool_use, trace_id,
                f"Unknown sandbox tool: {tool_use.name}",
                status=404,
            )

        handler = getattr(self, handler_name)
        t0 = time.monotonic()
        try:
            body = handler(tool_use.input)
            latency_ms = (time.monotonic() - t0) * 1000
            content_text = json.dumps(body, ensure_ascii=False) if isinstance(body, dict) else str(body)
            result = ToolResultBlock(
                tool_use_id=tool_use.id,
                content=[TextBlock(text=content_text)],
                is_error=False,
            )
            dispatch_event = ToolDispatch(
                trace_id=trace_id,
                tool_use_id=tool_use.id,
                tool_name=tool_use.name,
                endpoint_url=f"local://sandbox/{tool_use.name}",
                request_body=tool_use.input,
                response_status=200,
                response_body=body,
                latency_ms=latency_ms,
            )
        except Exception as exc:
            latency_ms = (time.monotonic() - t0) * 1000
            return self._error_result(
                tool_use, trace_id, str(exc),
                status=500, latency_ms=latency_ms,
            )

        return result, dispatch_event, None

    # ---- local handlers --------------------------------------------------

    @staticmethod
    def _handle_shell_exec(inp: dict) -> dict:
        command = inp["command"]
        # Accept timeout in ms (Claude Code style) or seconds (legacy)
        timeout_ms = inp.get("timeout")
        if timeout_ms is not None:
            timeout = max(1, timeout_ms // 1000)
        else:
            timeout = inp.get("timeout_seconds", 30)
        try:
            proc = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            return {
                "exit_code": proc.returncode,
                "stdout": proc.stdout,
                "stderr": proc.stderr,
            }
        except subprocess.TimeoutExpired:
            return {
                "exit_code": -1,
                "stdout": "",
                "stderr": f"Command timed out after {timeout}s",
            }

    @staticmethod
    def _handle_file_read(inp: dict) -> dict:
        raw_path = inp.get("file_path") or inp.get("path")
        if not raw_path:
            return {"error": "Missing file_path or path parameter."}
        path = Path(raw_path)
        if not path.exists():
            return {"error": f"File not found: {path}"}
        content = path.read_text(encoding="utf-8", errors="replace")
        offset = inp.get("offset")
        limit = inp.get("limit")
        if offset is not None or limit is not None:
            lines = content.splitlines(keepends=True)
            start = (offset - 1) if offset and offset >= 1 else 0
            end = (start + limit) if limit else len(lines)
            selected = lines[start:end]
            # Format with cat -n style line numbers
            numbered = []
            for i, line in enumerate(selected, start=start + 1):
                numbered.append(f"     {i}\t{line.rstrip()}")
            return {"content": "\n".join(numbered)}
        return {"content": content}

    @staticmethod
    def _handle_file_write(inp: dict) -> dict:
        raw_path = inp.get("file_path") or inp.get("path")
        if not raw_path:
            return {"error": "Missing file_path or path parameter."}
        path = Path(raw_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(inp["content"], encoding="utf-8")
        return {"written": str(path), "bytes": len(inp["content"])}

    @staticmethod
    def _handle_edit(inp: dict) -> dict:
        raw_path = inp.get("file_path") or inp.get("path")
        if not raw_path:
            return {"error": "Missing file_path or path parameter."}
        path = Path(raw_path)
        if not path.exists():
            return {"error": f"File not found: {path}"}
        content = path.read_text(encoding="utf-8", errors="replace")
        old_string = inp["old_string"]
        new_string = inp["new_string"]
        replace_all = inp.get("replace_all", False)
        count = content.count(old_string)
        if count == 0:
            return {"error": f"old_string not found in {path}"}
        if count > 1 and not replace_all:
            return {"error": f"old_string found {count} times in {path}. Use replace_all=true to replace all."}
        if replace_all:
            new_content = content.replace(old_string, new_string)
        else:
            new_content = content.replace(old_string, new_string, 1)
        path.write_text(new_content, encoding="utf-8")
        return {"edited": str(path), "replacements": count if replace_all else 1}

    @staticmethod
    def _handle_glob(inp: dict) -> dict:
        import glob as _glob
        pattern = inp["pattern"]
        base_path = inp.get("path")
        if base_path:
            full_pattern = str(Path(base_path) / pattern)
        else:
            full_pattern = pattern
        matches = sorted(_glob.glob(full_pattern, recursive=True))
        files = [m for m in matches[:50] if Path(m).is_file()]
        return {"files": files}

    @staticmethod
    def _handle_grep(inp: dict) -> dict:
        pattern = inp["pattern"]
        path = inp.get("path", ".")
        cmd = ["grep", "-rP"]
        if inp.get("case_insensitive"):
            cmd.append("-i")
        output_mode = inp.get("output_mode", "files_with_matches")
        if output_mode == "files_with_matches":
            cmd.append("-l")
        elif output_mode == "count":
            cmd.append("-c")
        context = inp.get("context_lines")
        if context:
            cmd.extend(["-C", str(context)])
        after = inp.get("after_context")
        if after:
            cmd.extend(["-A", str(after)])
        before = inp.get("before_context")
        if before:
            cmd.extend(["-B", str(before)])
        glob_filter = inp.get("glob")
        if glob_filter:
            cmd.extend(["--include", glob_filter])
        head_limit = inp.get("head_limit")
        cmd.extend([pattern, path])
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=30,
            )
            output = proc.stdout
            if head_limit and head_limit > 0:
                lines = output.splitlines()[:head_limit]
                output = "\n".join(lines)
            return {"output": output, "exit_code": proc.returncode}
        except subprocess.TimeoutExpired:
            return {"error": "Grep timed out after 30s"}

    @staticmethod
    def _handle_browser_screenshot(inp: dict) -> dict:
        url = inp["url"]
        try:
            from playwright.sync_api import sync_playwright  # type: ignore[import-untyped]
        except ImportError:
            return {
                "error": "playwright is not installed. "
                "Install with: pip install playwright && playwright install chromium",
                "url": url,
            }

        try:
            with sync_playwright() as pw:
                browser = pw.chromium.launch(headless=True)
                page = browser.new_page(viewport={"width": 1280, "height": 720})
                page.goto(url, wait_until="networkidle", timeout=30_000)
                title = page.title()
                text = page.inner_text("body")[:2000]
                browser.close()
            return {"url": url, "title": title, "body_text": text}
        except Exception as exc:
            return {"error": str(exc), "url": url}

    # ---- local-only fallback for media tools ----------------------------

    @staticmethod
    def _handle_not_available(inp: dict) -> dict:
        return {
            "error": "This tool requires a remote sandbox container (--sandbox mode).",
        }

    # ---- helpers ---------------------------------------------------------

    @staticmethod
    def _error_result(
        tool_use: ToolUseBlock,
        trace_id: str,
        error_msg: str,
        *,
        status: int = 500,
        latency_ms: float = 0.0,
        endpoint_url: str | None = None,
    ) -> tuple[ToolResultBlock, ToolDispatch, list[ImageBlock] | None]:
        result = ToolResultBlock(
            tool_use_id=tool_use.id,
            content=[TextBlock(text=f"Error: {error_msg}")],
            is_error=True,
        )
        dispatch_event = ToolDispatch(
            trace_id=trace_id,
            tool_use_id=tool_use.id,
            tool_name=tool_use.name,
            endpoint_url=endpoint_url or f"local://sandbox/{tool_use.name}",
            request_body=tool_use.input,
            response_status=status,
            response_body={"error": error_msg},
            latency_ms=latency_ms,
        )
        return result, dispatch_event, None
