"""
TEE Vendor types and interfaces.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    pass


class TeeVendorNames:
    """Supported TEE vendor names."""

    PHALA = "phala"
    """Phala Network."""


class TeeVendorInterface(ABC):
    """Interface for a TEE vendor implementation."""

    @property
    @abstractmethod
    def type(self) -> str:
        """Get the vendor type."""

    @abstractmethod
    def get_actions(self) -> list[dict[str, object]]:
        """Get actions provided by this vendor."""

    @abstractmethod
    def get_providers(self) -> list[object]:
        """Get providers provided by this vendor."""

    @abstractmethod
    def get_name(self) -> str:
        """Get the vendor name."""

    @abstractmethod
    def get_description(self) -> str:
        """Get the vendor description."""

