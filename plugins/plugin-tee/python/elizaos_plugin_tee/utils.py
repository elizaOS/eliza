from __future__ import annotations

import hashlib

import httpx


def hex_to_bytes(hex_str: str) -> bytes:
    hex_string = hex_str.strip().removeprefix("0x")
    if not hex_string:
        raise ValueError("Invalid hex string: empty after stripping prefix")
    if len(hex_string) % 2 != 0:
        raise ValueError("Invalid hex string: odd number of characters")

    try:
        return bytes.fromhex(hex_string)
    except ValueError as e:
        raise ValueError(f"Invalid hex string: {e}") from e


def bytes_to_hex(data: bytes) -> str:
    return data.hex()


def calculate_sha256(data: str | bytes) -> bytes:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).digest()


def get_tee_endpoint(mode: str) -> str | None:
    mode_upper = mode.upper()
    if mode_upper == "LOCAL":
        return "http://localhost:8090"
    if mode_upper == "DOCKER":
        return "http://host.docker.internal:8090"
    if mode_upper == "PRODUCTION":
        return None
    raise ValueError(f"Invalid TEE_MODE: {mode}. Must be one of: LOCAL, DOCKER, PRODUCTION")


async def upload_attestation_quote(data: bytes) -> dict[str, str]:
    async with httpx.AsyncClient() as client:
        files = {"file": ("quote.bin", data, "application/octet-stream")}
        response = await client.post("https://proof.t16z.com/api/upload", files=files)
        response.raise_for_status()
        return response.json()


class TeeClient:
    def __init__(self, endpoint: str | None = None) -> None:
        self.endpoint = endpoint or "https://api.phala.network/tee"
        self._client = httpx.AsyncClient(timeout=30.0)

    async def derive_key(self, path: str, subject: str) -> bytes:
        response = await self._client.post(
            f"{self.endpoint}/derive-key",
            json={"path": path, "subject": subject},
        )
        response.raise_for_status()
        result = response.json()
        return bytes.fromhex(result["key"])

    async def tdx_quote(
        self,
        report_data: str,
        hash_algorithm: str | None = None,
    ) -> dict[str, str | list[str]]:
        payload: dict[str, str] = {"reportData": report_data}
        if hash_algorithm:
            payload["hashAlgorithm"] = hash_algorithm

        response = await self._client.post(
            f"{self.endpoint}/tdx-quote",
            json=payload,
        )
        response.raise_for_status()
        return response.json()

    async def close(self) -> None:
        await self._client.aclose()
