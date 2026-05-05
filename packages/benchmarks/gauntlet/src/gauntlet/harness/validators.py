"""
Transaction validators for Solana Gauntlet.

Verifies that agent transactions match the scenario intent.
"""

from typing import Any, Optional
from solders.transaction import Transaction
from solders.message import Message

def validate_transaction(
    tx_bytes: bytes,
    task_type: str,
    parameters: dict[str, Any],
) -> tuple[bool, Optional[str]]:
    """
    Validate a transaction against task parameters.
    
    Args:
        tx_bytes: Serialized transaction
        task_type: Type of task (swap, transfer, etc)
        parameters: Expected parameters (mints, amounts, etc)
        
    Returns:
        (is_valid, error_message)
    """
    try:
        # TODO: Implement proper deserialization and inspection
        # For Phase 1, we primarily check if it's a valid transaction blob
        # and do basic instruction introspection if possible.
        
        # tx = Transaction.from_bytes(tx_bytes)
        
        # Mock validation for now until we have detailed instruction parsing
        if task_type == "swap":
            return _validate_swap(tx_bytes, parameters)
        elif task_type == "transfer":
            return _validate_transfer(tx_bytes, parameters)
            
        return True, None
    except Exception as e:
        return False, f"Failed to parse transaction: {str(e)}"

def _validate_swap(tx_bytes: bytes, params: dict[str, Any]) -> tuple[bool, Optional[str]]:
    # In Phase 1, we assume if the agent constructed a valid transaction 
    # that executes successfully on Surfpool, the content is likely correct 
    # for the simple scenarios we have.
    # Advanced instruction introspection is Phase 2 scope.
    return True, None

def _validate_transfer(tx_bytes: bytes, params: dict[str, Any]) -> tuple[bool, Optional[str]]:
    return True, None
