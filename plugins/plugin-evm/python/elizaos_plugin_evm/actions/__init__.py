"""
Actions for the EVM plugin.
"""

from elizaos_plugin_evm.actions.bridge import bridge_action, execute_bridge
from elizaos_plugin_evm.actions.swap import execute_swap, swap_action
from elizaos_plugin_evm.actions.transfer import execute_transfer, transfer_action

__all__ = [
    "execute_transfer",
    "transfer_action",
    "execute_swap",
    "swap_action",
    "execute_bridge",
    "bridge_action",
]
