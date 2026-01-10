"""
TEE Providers exports.
"""

from elizaos_plugin_tee.providers.base import DeriveKeyProvider, RemoteAttestationProvider
from elizaos_plugin_tee.providers.derive_key import (
    PhalaDeriveKeyProvider,
    get_derived_keys,
)
from elizaos_plugin_tee.providers.remote_attestation import (
    PhalaRemoteAttestationProvider,
    get_remote_attestation,
)

__all__ = [
    "DeriveKeyProvider",
    "RemoteAttestationProvider",
    "PhalaDeriveKeyProvider",
    "PhalaRemoteAttestationProvider",
    "get_derived_keys",
    "get_remote_attestation",
]

