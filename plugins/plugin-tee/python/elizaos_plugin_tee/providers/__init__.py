from elizaos_plugin_tee.providers.base import DeriveKeyProvider, RemoteAttestationProvider
from elizaos_plugin_tee.providers.derive_key import (
    PhalaDeriveKeyProvider,
    get_derived_keys,
)
from elizaos_plugin_tee.providers.remote_attestation import (
    PhalaRemoteAttestationProvider,
    get_remote_attestation,
)

PHALA_DERIVE_KEY_PROVIDER_NAME = "phala-derive-key"
PHALA_REMOTE_ATTESTATION_PROVIDER_NAME = "phala-remote-attestation"

__all__ = [
    "DeriveKeyProvider",
    "RemoteAttestationProvider",
    "PhalaDeriveKeyProvider",
    "PhalaRemoteAttestationProvider",
    "get_derived_keys",
    "get_remote_attestation",
    "PHALA_DERIVE_KEY_PROVIDER_NAME",
    "PHALA_REMOTE_ATTESTATION_PROVIDER_NAME",
]
