from __future__ import annotations

from elizaos_plugin_tee.actions.remote_attestation import REMOTE_ATTESTATION_ACTION
from elizaos_plugin_tee.providers import (
    get_derived_keys,
    get_remote_attestation,
)
from elizaos_plugin_tee.vendors.types import TeeVendorInterface, TeeVendorNames


class PhalaVendor(TeeVendorInterface):
    @property
    def type(self) -> str:
        return TeeVendorNames.PHALA

    def get_actions(self) -> list[dict[str, object]]:
        return [REMOTE_ATTESTATION_ACTION]

    def get_providers(self) -> list[object]:
        return [get_derived_keys, get_remote_attestation]

    def get_name(self) -> str:
        return "phala-tee-plugin"

    def get_description(self) -> str:
        return "Phala Network TEE for secure agent execution"
