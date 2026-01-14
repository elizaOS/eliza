from __future__ import annotations


class TeeError(Exception):
    pass


class ConfigError(TeeError):
    def __init__(self, message: str) -> None:
        super().__init__(message)


class AttestationError(TeeError):
    def __init__(self, message: str) -> None:
        super().__init__(f"Failed to generate attestation: {message}")


class KeyDerivationError(TeeError):
    def __init__(self, message: str) -> None:
        super().__init__(f"Failed to derive key: {message}")


class NetworkError(TeeError):
    def __init__(self, message: str) -> None:
        super().__init__(f"Network error: {message}")


class InvalidModeError(ConfigError):
    def __init__(self, mode: str) -> None:
        super().__init__(f"Invalid TEE_MODE: {mode}. Must be one of: LOCAL, DOCKER, PRODUCTION")


class InvalidVendorError(ConfigError):
    def __init__(self, vendor: str) -> None:
        super().__init__(f"Invalid TEE_VENDOR: {vendor}. Must be one of: phala")
