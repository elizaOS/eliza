"""
Phala Network TEE Vendor implementation.
"""

from __future__ import annotations

from elizaos_plugin_tee.actions.remote_attestation import REMOTE_ATTESTATION_ACTION
from elizaos_plugin_tee.providers import (
    get_derived_keys,
    get_remote_attestation,
)
from elizaos_plugin_tee.vendors.types import TeeVendorInterface, TeeVendorNames


class PhalaVendor(TeeVendorInterface):
    """
    Phala Network TEE Vendor.

    Provides TEE capabilities using Phala Network's DStack SDK.
    """

    @property
    def type(self) -> str:
        """Get the vendor type."""
        return TeeVendorNames.PHALA

    def get_actions(self) -> list[dict[str, object]]:
        """Get actions provided by Phala vendor."""
        return [REMOTE_ATTESTATION_ACTION]

    def get_providers(self) -> list[object]:
        """Get providers provided by Phala vendor."""
        return [get_derived_keys, get_remote_attestation]

    def get_name(self) -> str:
        """Get the vendor name."""
        return "phala-tee-plugin"

    def get_description(self) -> str:
        """Get the vendor description."""
        return "Phala Network TEE for secure agent execution"

