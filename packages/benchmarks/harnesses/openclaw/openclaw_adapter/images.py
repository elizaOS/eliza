"""Complete visual benchmark input for the native OpenClaw image loader."""
import base64
import binascii
import hashlib
from pathlib import Path
from typing import Mapping

def extract_benchmark_images(context: Mapping[str, object]) -> tuple[dict[str, object], list[dict[str, object]]]:
    """Move visual benchmark bytes into native image parts without text encoding."""
    ctx = dict(context)
    if str(ctx.get("benchmark", "")).lower() not in {"osworld", "os-world", "visualwebbench", "visual-web-bench"}:
        return ctx, []
    raw_images = []
    screenshot = ctx.pop("screenshot_base64", None)
    if screenshot is not None:
        raw_images.append({"media_type": "image/png", "data_base64": screenshot})
    attachments = ctx.pop("attachments", [])
    if not isinstance(attachments, list):
        raise ValueError("Visual benchmark attachments must be a list")
    raw_images.extend(attachments)
    parts = []
    references = []
    for image in raw_images:
        if not isinstance(image, Mapping):
            raise ValueError("Visual benchmark image must be an object")
        encoded, mime = image.get("data_base64"), image.get("media_type")
        if not isinstance(encoded, str) or not encoded:
            raise ValueError("Visual benchmark requires actual image bytes, not a path")
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValueError("Invalid benchmark image base64") from exc
        actual_mime = (
            "image/png" if data.startswith(b"\x89PNG\r\n\x1a\n") else
            "image/jpeg" if data.startswith(b"\xff\xd8\xff") else
            "image/webp" if data[:4] == b"RIFF" and data[8:12] == b"WEBP" else None
        )
        if actual_mime is None or mime != actual_mime:
            raise ValueError("Benchmark image MIME does not match PNG/JPEG/WebP bytes")
        parts.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{encoded}"}})
        references.append({"sha256": hashlib.sha256(data).hexdigest(), "media_type": mime, "size": len(data)})
    if parts:
        ctx["image_references"] = references
    return ctx, parts




def native_image_argv(binary: Path, node: str, state_dir: Path, argv: list[str], images: list[dict[str, object]]) -> list[str]:
    """Use the public native agent API; CLI path loading optimizes screenshots."""
    import json
    package_json = None
    for parent in binary.expanduser().resolve().parents:
        candidate = parent / "package.json"
        if candidate.is_file() and json.loads(candidate.read_text()).get("name") == "openclaw":
            package_json = candidate
            break
    if package_json is None:
        raise ValueError("Cannot resolve installed OpenClaw package for native image input")
    def option(name: str):
        return argv[argv.index(name) + 1] if name in argv else None
    options = {"message": option("--message"), "model": option("--model"), "thinking": option("--thinking"), "timeout": option("--timeout"), "agentId": option("--agent")}
    if option("--session-id"):
        options["sessionId"] = option("--session-id")
    options["images"] = []
    for image in images:
        prefix, encoded = image["image_url"]["url"].split(",", 1)
        options["images"].append({"type": "image", "data": encoded, "mimeType": prefix.removeprefix("data:").removesuffix(";base64")})
    payload_path = state_dir / "native-image-turn.json"
    payload_path.write_text(json.dumps(options))
    return [node, str(Path(__file__).with_name("native_images.mjs")), str(package_json), str(payload_path)]
