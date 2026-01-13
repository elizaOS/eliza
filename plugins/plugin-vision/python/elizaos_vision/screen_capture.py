from __future__ import annotations

import asyncio
import logging
import math
import os
import platform
import random
import subprocess
import tempfile
import time
from io import BytesIO

from PIL import Image

from .types import ScreenCapture, ScreenTile, VisionConfig

logger = logging.getLogger(__name__)


class ScreenCaptureService:
    def __init__(self, config: VisionConfig):
        self._config = config
        self._active_tile_index = 0
        self._last_capture: ScreenCapture | None = None

    async def get_screen_info(self) -> dict[str, int] | None:
        system = platform.system()

        try:
            if system == "Darwin":
                result = await asyncio.create_subprocess_exec(
                    "system_profiler",
                    "SPDisplaysDataType",
                    "-json",
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                stdout, _ = await result.communicate()
                import json

                data = json.loads(stdout)
                if data.get("SPDisplaysDataType"):
                    display = data["SPDisplaysDataType"][0]
                    resolution = display.get("_items", [{}])[0].get("native_resolution", "")
                    if resolution:
                        import re

                        match = re.match(r"(\d+) x (\d+)", resolution)
                        if match:
                            return {
                                "width": int(match.group(1)),
                                "height": int(match.group(2)),
                            }

            elif system == "Linux":
                result = await asyncio.create_subprocess_shell(
                    'xrandr | grep " connected primary"',
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                stdout, _ = await result.communicate()
                import re

                match = re.search(r"(\d+)x(\d+)", stdout.decode())
                if match:
                    return {
                        "width": int(match.group(1)),
                        "height": int(match.group(2)),
                    }

            elif system == "Windows":
                result = await asyncio.create_subprocess_shell(
                    "wmic path Win32_VideoController get "
                    "CurrentHorizontalResolution,CurrentVerticalResolution /value",
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                stdout, _ = await result.communicate()
                output = stdout.decode()
                import re

                width_match = re.search(r"CurrentHorizontalResolution=(\d+)", output)
                height_match = re.search(r"CurrentVerticalResolution=(\d+)", output)
                if width_match and height_match:
                    return {
                        "width": int(width_match.group(1)),
                        "height": int(height_match.group(1)),
                    }

        except Exception as e:
            logger.error(f"[ScreenCapture] Failed to get screen info: {e}")

        return {"width": 1920, "height": 1080}

    async def capture_screen(self) -> ScreenCapture:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            temp_file = f.name

        try:
            await self._capture_screen_to_file(temp_file)

            with Image.open(temp_file) as img:
                width, height = img.size
                img_bytes = BytesIO()
                img.save(img_bytes, format="PNG")
                image_data = img_bytes.getvalue()

                # Create tiles
                tile_size = self._config.tile_size
                tiles: list[ScreenTile] = []

                for row in range(math.ceil(height / tile_size)):
                    for col in range(math.ceil(width / tile_size)):
                        x = col * tile_size
                        y = row * tile_size
                        tile_width = min(tile_size, width - x)
                        tile_height = min(tile_size, height - y)

                        tiles.append(
                            ScreenTile(
                                id=f"tile-{row}-{col}",
                                row=row,
                                col=col,
                                x=x,
                                y=y,
                                width=tile_width,
                                height=tile_height,
                            )
                        )

                if self._config.tile_processing_order == "priority":
                    col_count = math.ceil(width / tile_size)
                    center_row = len(tiles) // 2 // col_count
                    center_col = col_count // 2
                    self._active_tile_index = center_row * col_count + center_col
                elif self._config.tile_processing_order == "random":
                    self._active_tile_index = random.randint(0, len(tiles) - 1)
                else:
                    self._active_tile_index = (self._active_tile_index + 1) % len(tiles)

                # Extract active tile data
                if 0 <= self._active_tile_index < len(tiles):
                    active_tile = tiles[self._active_tile_index]
                    try:
                        tile_img = img.crop(
                            (
                                active_tile.x,
                                active_tile.y,
                                active_tile.x + active_tile.width,
                                active_tile.y + active_tile.height,
                            )
                        )
                        tile_bytes = BytesIO()
                        tile_img.save(tile_bytes, format="PNG")
                        active_tile.data = tile_bytes.getvalue()
                    except Exception as e:
                        logger.error(f"[ScreenCapture] Failed to extract tile: {e}")

            capture = ScreenCapture(
                timestamp=int(time.time() * 1000),
                width=width,
                height=height,
                data=image_data,
                tiles=tiles,
            )

            self._last_capture = capture
            return capture

        finally:
            try:
                os.unlink(temp_file)
            except Exception:
                pass

    async def _capture_screen_to_file(self, output_path: str) -> None:
        system = platform.system()

        try:
            if system == "Darwin":
                process = await asyncio.create_subprocess_exec(
                    "screencapture",
                    "-x",
                    output_path,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                await process.communicate()

            elif system == "Linux":
                try:
                    process = await asyncio.create_subprocess_exec(
                        "scrot",
                        output_path,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                    )
                    await process.communicate()
                except FileNotFoundError:
                    process = await asyncio.create_subprocess_exec(
                        "gnome-screenshot",
                        "-f",
                        output_path,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                    )
                    await process.communicate()

            elif system == "Windows":
                script = f"""
                Add-Type -AssemblyName System.Windows.Forms;
                Add-Type -AssemblyName System.Drawing;
                $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
                $bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height;
                $graphics = [System.Drawing.Graphics]::FromImage($bitmap);
                $graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size);
                $bitmap.Save('{output_path.replace(chr(92), chr(92) + chr(92))}');
                $graphics.Dispose();
                $bitmap.Dispose();
                """
                process = await asyncio.create_subprocess_shell(
                    f'powershell -Command "{script.replace(chr(10), " ")}"',
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                await process.communicate()

            else:
                raise RuntimeError(f"Unsupported platform: {system}")

        except Exception as e:
            logger.error(f"[ScreenCapture] Screen capture failed: {e}")
            if system == "Linux" and "command not found" in str(e):
                raise RuntimeError(
                    "Screen capture tool not found. Install with: sudo apt-get install scrot"
                ) from e
            raise

    def get_active_tile(self) -> ScreenTile | None:
        if not self._last_capture:
            return None
        if 0 <= self._active_tile_index < len(self._last_capture.tiles):
            return self._last_capture.tiles[self._active_tile_index]
        return None

    def get_all_tiles(self) -> list[ScreenTile]:
        return self._last_capture.tiles if self._last_capture else []

    def get_processed_tiles(self) -> list[ScreenTile]:
        if not self._last_capture:
            return []
        return [t for t in self._last_capture.tiles if t.analysis]
