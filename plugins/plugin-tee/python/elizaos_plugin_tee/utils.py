"""
Utility functions for the TEE plugin.
"""

from __future__ import annotations

import hashlib
from typing import TYPE_CHECKING

import httpx

if TYPE_CHECKING:
    pass


def hex_to_bytes(hex_str: str) -> bytes:
    """
    Convert a hexadecimal string to bytes.

    Args:
        hex_str: The hexadecimal string to convert.

    Returns:
        The resulting bytes.

    Raises:
        ValueError: If the input hex string is invalid.
    """
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
    """
    Convert bytes to a hexadecimal string (without 0x prefix).

    Args:
        data: The bytes to convert.

    Returns:
        The hex string (without 0x prefix).
    """
    return data.hex()


def calculate_sha256(data: str | bytes) -> bytes:
    """
    Calculate the SHA256 hash of the input.

    Args:
        data: The input string or bytes to hash.

    Returns:
        The calculated SHA256 hash as bytes.
    """
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).digest()


def get_tee_endpoint(mode: str) -> str | None:
    """
    Get TEE endpoint URL based on mode.

    Args:
        mode: The TEE mode (LOCAL, DOCKER, PRODUCTION).

    Returns:
        The endpoint URL or None for production.

    Raises:
        ValueError: If the mode is invalid.
    """
    mode_upper = mode.upper()
    if mode_upper == "LOCAL":
        return "http://localhost:8090"
    if mode_upper == "DOCKER":
        return "http://host.docker.internal:8090"
    if mode_upper == "PRODUCTION":
        return None
    raise ValueError(f"Invalid TEE_MODE: {mode}. Must be one of: LOCAL, DOCKER, PRODUCTION")


async def upload_attestation_quote(data: bytes) -> dict[str, str]:
    """
    Upload attestation quote to proof service.

    Args:
        data: The attestation quote data.

    Returns:
        The response from the upload service with checksum.

    Raises:
        httpx.HTTPError: If the upload fails.
    """
    async with httpx.AsyncClient() as client:
        files = {"file": ("quote.bin", data, "application/octet-stream")}
        response = await client.post("https://proof.t16z.com/api/upload", files=files)
        response.raise_for_status()
        return response.json()


class TeeClient:
    """
    HTTP client for communicating with TEE services.

    This client simulates the TappdClient from the DStack SDK for Python.
    """

    def __init__(self, endpoint: str | None = None) -> None:
        """
        Initialize the TEE client.

        Args:
            endpoint: The TEE service endpoint URL. None for production.
        """
        self.endpoint = endpoint or "https://api.phala.network/tee"
        self._client = httpx.AsyncClient(timeout=30.0)

    async def derive_key(self, path: str, subject: str) -> bytes:
        """
        Derive a key from the TEE.

        Args:
            path: The derivation path.
            subject: The subject for the certificate chain.

        Returns:
            The derived key bytes.
        """
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
        """
        Generate a TDX attestation quote.

        Args:
            report_data: The data to include in the attestation report.
            hash_algorithm: Optional hash algorithm for the quote.

        Returns:
            The TDX quote response with quote and rtmrs.
        """
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
        """Close the HTTP client."""
        await self._client.aclose()





