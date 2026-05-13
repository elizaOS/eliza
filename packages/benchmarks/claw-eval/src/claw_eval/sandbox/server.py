"""Sandbox HTTP server — runs inside agent container.

Exposes file, shell, and browser operations over HTTP so that the host-side
dispatcher can drive the container without SSH or docker exec.
"""

from __future__ import annotations

import base64
import glob as _glob
import logging
import mimetypes
import subprocess
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel

logger = logging.getLogger("sandbox")

app = FastAPI(title="claw-eval sandbox")

WORKSPACE_ROOT = Path("/workspace")

# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class ExecRequest(BaseModel):
    command: str
    timeout_seconds: int = 30


class FileReadRequest(BaseModel):
    path: str = ""
    file_path: str | None = None
    offset: int | None = None
    limit: int | None = None
    pages: str | None = None  # PDF page range (e.g. "1-5", "3", "1,3,5")


class FileWriteRequest(BaseModel):
    path: str = ""
    file_path: str | None = None
    content: str


class FileWriteB64Request(BaseModel):
    path: str
    content_b64: str


class ScreenshotRequest(BaseModel):
    url: str
    wait_seconds: float = 2.0   # how long to observe the page
    frame_count: int = 4         # number of screenshots to capture
    viewport_width: int = 1080
    viewport_height: int = 720


class GlobRequest(BaseModel):
    pattern: str
    path: str | None = None
    max_files: int = 50


class ReadMediaRequest(BaseModel):
    path: str
    media_type: str = "auto"  # "auto"|"image"|"video"|"pdf"
    # Video options
    max_frames: int = 8
    fps: float = 1.0
    start_time: float = 0.0
    end_time: float | None = None
    screen_size: str | None = None  # e.g. "1280x720" resize output
    # PDF options
    pdf_pages: str = "all"  # "all", "1-3", "1,3,5"
    dpi: int = 100


class DownloadRequest(BaseModel):
    path: str
    max_bytes: int = 50_000_000  # 50MB cap


class EditRequest(BaseModel):
    path: str = ""
    file_path: str | None = None
    old_string: str
    new_string: str
    replace_all: bool = False


class GrepRequest(BaseModel):
    pattern: str
    path: str = "/workspace"
    glob: str | None = None
    output_mode: str = "files_with_matches"  # "content", "files_with_matches", "count"
    case_insensitive: bool = False
    context_lines: int | None = None
    after_context: int | None = None
    before_context: int | None = None
    head_limit: int | None = None
    multiline: bool = False


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.post("/exec")
def exec_command(req: ExecRequest):
    try:
        proc = subprocess.run(
            req.command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=req.timeout_seconds,
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
            "stderr": f"Timed out after {req.timeout_seconds}s",
        }


_TEXT_MIMES = {
    "application/json",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
    "application/javascript",
}
_TEXT_EXTENSIONS = {
    ".txt", ".md", ".csv", ".json", ".yaml", ".yml", ".xml",
    ".html", ".htm", ".js", ".ts", ".py", ".sh", ".bash",
    ".cfg", ".ini", ".toml", ".log", ".sql", ".r", ".rmd",
}

# Image/video extensions (used by /read to detect media files)
_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".tif", ".svg"}
_VIDEO_EXTS = {".mp4", ".avi", ".mov", ".mkv", ".webm", ".flv", ".wmv", ".m4v"}


@app.post("/read")
def read_file(req: FileReadRequest):
    raw_path = req.file_path or req.path
    if not raw_path:
        return {"error": "Missing path or file_path parameter."}
    p = Path(raw_path)
    if not p.exists():
        return {"error": f"File not found: {p}"}
    try:
        p.resolve().relative_to(WORKSPACE_ROOT)
    except ValueError:
        logger.warning("read outside workspace: %s", p)
    ext = p.suffix.lower()

    # Image files → return frames (triggers media injection in dispatcher)
    if ext in _IMAGE_EXTS:
        return _read_image(p, None)

    # PDF files → render as images
    if ext == ".pdf":
        return _read_pdf(p, req.pages or "all", 100)

    mime, _ = mimetypes.guess_type(str(p))
    # Known text mime OR known text extension → text; otherwise binary.
    # mime=None with unknown extension defaults to binary (safer).
    is_text = (
        mime in _TEXT_MIMES
        or (mime is not None and mime.startswith("text/"))
        or (mime is None and ext in _TEXT_EXTENSIONS)
    )
    if is_text:
        content = p.read_text(encoding="utf-8", errors="replace")
        # Apply offset/limit if provided
        if req.offset is not None or req.limit is not None:
            lines = content.splitlines(keepends=True)
            start = (req.offset - 1) if req.offset and req.offset >= 1 else 0
            end = (start + req.limit) if req.limit else len(lines)
            selected = lines[start:end]
            # Format with cat -n style line numbers
            numbered = []
            for i, line in enumerate(selected, start=start + 1):
                numbered.append(f"     {i}\t{line.rstrip()}")
            content = "\n".join(numbered)
        return {
            "content": content,
            "mime_type": mime or "text/plain",
            "encoding": "utf-8",
        }
    else:
        data = base64.b64encode(p.read_bytes()).decode("ascii")
        return {
            "content": data,
            "mime_type": mime or "application/octet-stream",
            "encoding": "base64",
            "size_bytes": p.stat().st_size,
        }


@app.post("/write")
def write_file(req: FileWriteRequest):
    raw_path = req.file_path or req.path
    if not raw_path:
        return {"error": "Missing path or file_path parameter."}
    p = Path(raw_path)
    try:
        p.resolve().relative_to(WORKSPACE_ROOT)
    except ValueError:
        logger.warning("write outside workspace: %s", p)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(req.content, encoding="utf-8")
    return {"written": str(p), "bytes": len(req.content)}


@app.post("/write_b64")
def write_file_b64(req: FileWriteB64Request):
    """Write a binary file from base64-encoded content."""
    p = Path(req.path)
    try:
        p.resolve().relative_to(WORKSPACE_ROOT)
    except ValueError:
        logger.warning("write_b64 outside workspace: %s", p)
    p.parent.mkdir(parents=True, exist_ok=True)
    raw = base64.b64decode(req.content_b64)
    p.write_bytes(raw)
    return {"written": str(p), "bytes": len(raw)}


@app.post("/glob")
def glob_files(req: GlobRequest):
    """List files matching a glob pattern (supports env snapshot collection)."""
    pattern = req.pattern
    if req.path:
        pattern = str(Path(req.path) / pattern)
    matches = sorted(_glob.glob(pattern, recursive=True))
    results = []
    for m in matches[: req.max_files]:
        p = Path(m)
        if p.is_file():
            mime, _ = mimetypes.guess_type(str(p))
            results.append({
                "path": str(p),
                "size_bytes": p.stat().st_size,
                "mime_type": mime or "unknown",
            })
    return {"files": results}


@app.post("/edit")
def edit_file(req: EditRequest):
    """Perform exact string replacement in a file."""
    raw_path = req.file_path or req.path
    if not raw_path:
        return {"error": "Missing path or file_path parameter."}
    p = Path(raw_path)
    if not p.exists():
        return {"error": f"File not found: {p}"}
    try:
        p.resolve().relative_to(WORKSPACE_ROOT)
    except ValueError:
        logger.warning("edit outside workspace: %s", p)
    content = p.read_text(encoding="utf-8", errors="replace")
    count = content.count(req.old_string)
    if count == 0:
        return {"error": f"old_string not found in {p}"}
    if count > 1 and not req.replace_all:
        return {"error": f"old_string found {count} times in {p}. Use replace_all=true to replace all."}
    if req.replace_all:
        new_content = content.replace(req.old_string, req.new_string)
    else:
        new_content = content.replace(req.old_string, req.new_string, 1)
    p.write_text(new_content, encoding="utf-8")
    return {"edited": str(p), "replacements": count if req.replace_all else 1}


@app.post("/grep")
def grep_files(req: GrepRequest):
    """Search for patterns in file contents using grep."""
    cmd = ["grep", "-rP"]
    if req.case_insensitive:
        cmd.append("-i")
    if req.output_mode == "files_with_matches":
        cmd.append("-l")
    elif req.output_mode == "count":
        cmd.append("-c")
    elif req.output_mode == "content":
        cmd.append("-n")
    if req.multiline:
        cmd.append("-z")
    if req.context_lines is not None:
        cmd.extend(["-C", str(req.context_lines)])
    if req.after_context is not None:
        cmd.extend(["-A", str(req.after_context)])
    if req.before_context is not None:
        cmd.extend(["-B", str(req.before_context)])
    if req.glob:
        cmd.extend(["--include", req.glob])
    cmd.extend([req.pattern, req.path])
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        output = proc.stdout
        if req.head_limit and req.head_limit > 0:
            lines = output.splitlines()[:req.head_limit]
            output = "\n".join(lines)
        return {"output": output, "exit_code": proc.returncode}
    except subprocess.TimeoutExpired:
        return {"error": "Grep timed out after 30s"}


@app.post("/screenshot")
def screenshot(req: ScreenshotRequest):
    try:
        from playwright.sync_api import sync_playwright  # type: ignore[import-untyped]
    except ImportError:
        return {
            "error": (
                "playwright is not installed. "
                "Install with: pip install playwright && playwright install chromium"
            ),
            "url": req.url,
        }

    import time as _time

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            page = browser.new_page(viewport={
                "width": req.viewport_width,
                "height": req.viewport_height,
            })
            page.goto(req.url, wait_until="networkidle", timeout=30_000)
            title = page.title()
            text = page.inner_text("body")[:2000]

            # Capture multiple frames over time to show animation state
            frames = []
            n = max(1, req.frame_count)
            interval = req.wait_seconds / n if n > 1 else 0
            for i in range(n):
                if i > 0:
                    _time.sleep(interval)
                png_bytes = page.screenshot(type="png")
                image_b64 = base64.b64encode(png_bytes).decode("ascii")
                frames.append({
                    "index": i,
                    "timestamp_s": round(i * interval, 2),
                    "image_b64": image_b64,
                    "mime_type": "image/png",
                })

            browser.close()
        return {
            "url": req.url,
            "title": title,
            "body_text": text,
            "frames": frames,
            "text_summary": f"Page: {title}. Captured {len(frames)} frame(s) over {req.wait_seconds}s.",
        }
    except Exception as exc:
        return {"error": str(exc), "url": req.url}


# ---------------------------------------------------------------------------
# Media endpoints
# ---------------------------------------------------------------------------

def _detect_media_type(path: Path, hint: str) -> str:
    """Detect media type from file extension or hint."""
    if hint != "auto":
        return hint
    ext = path.suffix.lower()
    if ext == ".pdf":
        return "pdf"
    if ext in _VIDEO_EXTS:
        return "video"
    if ext in _IMAGE_EXTS:
        return "image"
    return "image"  # default fallback


def _resize_image(img, max_dim: int | None):
    """Resize a PIL Image so its largest dimension <= max_dim."""
    if max_dim is None:
        return img
    w, h = img.size
    if max(w, h) <= max_dim:
        return img
    scale = max_dim / max(w, h)
    new_w, new_h = int(w * scale), int(h * scale)
    return img.resize((new_w, new_h), getattr(__import__("PIL.Image", fromlist=["Image"]), "LANCZOS", 1))


def _image_to_b64_png(img) -> str:
    """Convert PIL Image to base64-encoded PNG."""
    import io
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _parse_screen_size(s: str | None) -> int | None:
    """Parse '1280x720' -> max dimension (1280)."""
    if not s:
        return None
    parts = s.lower().split("x")
    if len(parts) == 2:
        try:
            return max(int(parts[0]), int(parts[1]))
        except ValueError:
            pass
    return None


def _read_image(p: Path, screen_size: str | None) -> dict:
    """Read an image file and return base64 PNG."""
    from PIL import Image
    img = Image.open(p)
    max_dim = _parse_screen_size(screen_size)
    img = _resize_image(img, max_dim)
    b64 = _image_to_b64_png(img)
    w, h = img.size
    return {
        "media_type": "image",
        "metadata": {"width": w, "height": h, "format": p.suffix.lower()},
        "frames": [{"index": 0, "timestamp_s": 0.0, "image_b64": b64, "mime_type": "image/png"}],
        "text_summary": f"Image: {w}x{h}, {p.suffix.lower()}",
    }


def _read_video(p: Path, req: ReadMediaRequest) -> dict:
    """Read a video file: probe metadata and extract frames via ffmpeg."""
    from PIL import Image
    import io
    import json as _json
    import tempfile

    # Probe metadata
    probe_cmd = [
        "ffprobe", "-v", "quiet", "-print_format", "json",
        "-show_format", "-show_streams", str(p),
    ]
    try:
        probe = subprocess.run(probe_cmd, capture_output=True, text=True, timeout=15)
        probe_data = _json.loads(probe.stdout) if probe.stdout else {}
    except Exception:
        probe_data = {}

    # Extract key metadata
    duration = None
    fps_val = None
    width = height = None
    codec = None
    for stream in probe_data.get("streams", []):
        if stream.get("codec_type") == "video":
            duration = float(stream.get("duration", 0)) or None
            codec = stream.get("codec_name")
            width = stream.get("width")
            height = stream.get("height")
            r_frame_rate = stream.get("r_frame_rate", "")
            if "/" in r_frame_rate:
                parts = r_frame_rate.split("/")
                try:
                    fps_val = float(parts[0]) / float(parts[1])
                except (ValueError, ZeroDivisionError):
                    pass
            break
    if duration is None:
        fmt_duration = probe_data.get("format", {}).get("duration")
        if fmt_duration:
            duration = float(fmt_duration)

    metadata = {
        "duration_s": duration,
        "fps": round(fps_val, 2) if fps_val else None,
        "width": width,
        "height": height,
        "codec": codec,
    }

    # Extract frames
    max_dim = _parse_screen_size(req.screen_size)
    start = req.start_time
    end = req.end_time if req.end_time is not None else duration

    # Build ffmpeg command for frame extraction
    with tempfile.TemporaryDirectory() as tmpdir:
        ffmpeg_cmd = ["ffmpeg", "-y"]
        if start > 0:
            ffmpeg_cmd += ["-ss", str(start)]
        ffmpeg_cmd += ["-i", str(p)]
        if end is not None:
            ffmpeg_cmd += ["-t", str(end - start)]
        ffmpeg_cmd += ["-vf", f"fps={req.fps}"]
        if max_dim:
            ffmpeg_cmd += ["-vf", f"fps={req.fps},scale='min({max_dim},iw)':min'({max_dim},ih)':force_original_aspect_ratio=decrease"]
        ffmpeg_cmd += ["-frames:v", str(req.max_frames)]
        ffmpeg_cmd += [f"{tmpdir}/frame_%04d.jpg"]

        try:
            subprocess.run(ffmpeg_cmd, capture_output=True, timeout=60)
        except Exception as exc:
            return {
                "media_type": "video",
                "metadata": metadata,
                "frames": [],
                "text_summary": f"Video: {duration}s. Frame extraction failed: {exc}",
            }

        # Read extracted frames
        frames = []
        frame_files = sorted(Path(tmpdir).glob("frame_*.jpg"))
        for idx, ff in enumerate(frame_files[:req.max_frames]):
            img = Image.open(ff)
            if max_dim:
                img = _resize_image(img, max_dim)
            b64 = _image_to_b64_png(img)
            # Calculate timestamp
            timestamp = start + idx / max(req.fps, 0.001)
            frames.append({
                "index": idx,
                "timestamp_s": round(timestamp, 2),
                "image_b64": b64,
                "mime_type": "image/png",
            })

    dur_str = f"{duration:.1f}s" if duration else "unknown"
    dim_str = f"{width}x{height}" if width and height else "unknown"
    fps_str = f"{fps_val:.0f}fps" if fps_val else "unknown"
    return {
        "media_type": "video",
        "metadata": metadata,
        "frames": frames,
        "text_summary": f"Video: {dur_str}, {dim_str}, {fps_str}. Extracted {len(frames)} frames.",
    }


def _read_pdf(p: Path, pages: str, dpi: int, max_dimension: int | None = None) -> dict:
    """Read a PDF file and render pages as images."""
    from pdf2image import convert_from_path

    kwargs = {"dpi": dpi}
    if pages != "all":
        # Parse page ranges like "1-3" or "1,3,5"
        if "-" in pages:
            parts = pages.split("-")
            kwargs["first_page"] = int(parts[0])
            kwargs["last_page"] = int(parts[1])
        elif "," in pages:
            # pdf2image doesn't support arbitrary page lists natively,
            # so convert all and filter
            pass
        else:
            kwargs["first_page"] = int(pages)
            kwargs["last_page"] = int(pages)

    try:
        images = convert_from_path(str(p), **kwargs)
    except Exception as exc:
        return {
            "media_type": "pdf",
            "metadata": {"error": str(exc)},
            "frames": [],
            "text_summary": f"PDF render failed: {exc}",
        }

    # Filter pages if comma-separated
    if pages != "all" and "," in pages:
        try:
            page_nums = [int(x) - 1 for x in pages.split(",")]
            images = [images[i] for i in page_nums if 0 <= i < len(images)]
        except (ValueError, IndexError):
            pass

    frames = []
    for idx, img in enumerate(images):
        if max_dimension:
            img = _resize_image(img, max_dimension)
        b64 = _image_to_b64_png(img)
        frames.append({
            "index": idx,
            "timestamp_s": 0.0,
            "image_b64": b64,
            "mime_type": "image/png",
        })

    return {
        "media_type": "pdf",
        "metadata": {"page_count": len(images), "dpi": dpi},
        "frames": frames,
        "text_summary": f"PDF: {len(images)} page(s) at {dpi} DPI.",
    }


@app.post("/read_media")
def read_media(req: ReadMediaRequest):
    p = Path(req.path)
    if not p.exists():
        return {"error": f"File not found: {p}"}
    media_type = _detect_media_type(p, req.media_type)
    try:
        if media_type == "image":
            return _read_image(p, req.screen_size)
        elif media_type == "video":
            return _read_video(p, req)
        elif media_type == "pdf":
            return _read_pdf(p, req.pdf_pages, req.dpi)
        else:
            return {"error": f"Unsupported media type: {media_type}"}
    except Exception as exc:
        return {"error": str(exc)}



@app.post("/download")
def download_file(req: DownloadRequest):
    p = Path(req.path)
    if not p.exists():
        return {"error": f"File not found: {p}"}
    size = p.stat().st_size
    if size > req.max_bytes:
        return {"error": f"File too large: {size} bytes (max {req.max_bytes})"}
    mime, _ = mimetypes.guess_type(str(p))
    data = base64.b64encode(p.read_bytes()).decode("ascii")
    return {
        "path": str(p),
        "content_b64": data,
        "mime_type": mime or "application/octet-stream",
        "size_bytes": size,
    }


@app.get("/health")
def health():
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Standalone entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Sandbox HTTP server")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--host", default="0.0.0.0")
    cli_args = parser.parse_args()
    uvicorn.run(app, host=cli_args.host, port=cli_args.port)
