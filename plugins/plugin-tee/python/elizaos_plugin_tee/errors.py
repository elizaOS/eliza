"""
Error types for the TEE plugin.
"""

from __future__ import annotations


class TeeError(Exception):
    """Base exception for all TEE-related errors."""


class ConfigError(TeeError):
    """Configuration error."""

    def __init__(self, message: str) -> None:
        """
        Initialize the config error.

        Args:
            message: The error message.
        """
        super().__init__(message)


class AttestationError(TeeError):
    """Remote attestation error."""

    def __init__(self, message: str) -> None:
        """
        Initialize the attestation error.

        Args:
            message: The error message.
        """
        super().__init__(f"Failed to generate attestation: {message}")


class KeyDerivationError(TeeError):
    """Key derivation error."""

    def __init__(self, message: str) -> None:
        """
        Initialize the key derivation error.

        Args:
            message: The error message.
        """
        super().__init__(f"Failed to derive key: {message}")


class NetworkError(TeeError):
    """Network communication error."""

    def __init__(self, message: str) -> None:
        """
        Initialize the network error.

        Args:
            message: The error message.
        """
        super().__init__(f"Network error: {message}")


class InvalidModeError(ConfigError):
    """Invalid TEE mode error."""

    def __init__(self, mode: str) -> None:
        """
        Initialize the invalid mode error.

        Args:
            mode: The invalid mode value.
        """
        super().__init__(f"Invalid TEE_MODE: {mode}. Must be one of: LOCAL, DOCKER, PRODUCTION")


class InvalidVendorError(ConfigError):
    """Invalid TEE vendor error."""

    def __init__(self, vendor: str) -> None:
        """
        Initialize the invalid vendor error.

        Args:
            vendor: The invalid vendor value.
        """
        super().__init__(f"Invalid TEE_VENDOR: {vendor}. Must be one of: phala")





