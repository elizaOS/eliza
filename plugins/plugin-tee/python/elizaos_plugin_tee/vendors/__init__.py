from elizaos_plugin_tee.vendors.phala import PhalaVendor
from elizaos_plugin_tee.vendors.types import TeeVendorInterface, TeeVendorNames

_vendors: dict[str, TeeVendorInterface] = {
    TeeVendorNames.PHALA: PhalaVendor(),
}


def get_vendor(vendor_type: str) -> TeeVendorInterface:
    vendor = _vendors.get(vendor_type)
    if not vendor:
        raise ValueError(f"Unsupported TEE vendor: {vendor_type}")
    return vendor


__all__ = [
    "TeeVendorNames",
    "TeeVendorInterface",
    "PhalaVendor",
    "get_vendor",
]
