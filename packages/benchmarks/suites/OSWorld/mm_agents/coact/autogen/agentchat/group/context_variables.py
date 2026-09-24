# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any, Generator, Iterable, Optional

from pydantic import BaseModel, Field

__all__ = ["ContextVariables"]

# Parameter name for context variables
# Use the value in functions and they will be substituted with the context variables:
# e.g. def my_function(context_variables: ContextVariables, my_other_parameters: Any) -> Any:
__CONTEXT_VARIABLES_PARAM_NAME__ = "context_variables"


class ContextVariables(BaseModel):
    """
    Stores and manages context variables for agentic workflows.

    Utilises a dictionary-like interface for setting, getting, and removing variables.
    """

    # Internal storage for context variables
    data: dict[str, Any] = Field(default_factory=dict)

    def __init__(self, data: Optional[dict[str, Any]] = None, **kwargs: Any) -> None:
        """Initialize with data dictionary as an optional positional parameter.

        Args:
            data: Initial dictionary of context variables (optional)
            kwargs: Additional keyword arguments for the parent class
        """
        init_data = data or {}
        super().__init__(data=init_data, **kwargs)

    def get(self, key: str, default: Optional[Any] = None) -> Optional[Any]:
        """
        Get a value from the context by key.

        Args:
            key: The key to retrieve
            default: The default value to return if key is not found

        Returns:
            The value associated with the key or default if not found
        """
        return self.data.get(key, default)

    def set(self, key: str, value: Any) -> None:
        """
        Set a value in the context by key.

        Args:
            key: The key to set
            value: The value to store
        """
        self.data[key] = value

    def remove(self, key: str) -> bool:
        """
        Remove a key from the context.

        Args:
            key: The key to remove

        Returns:
            True if the key was removed, False if it didn't exist
        """
        if key in self.data:
            del self.data[key]
            return True
        return False

    def keys(self) -> Iterable[str]:
        """
        Get all keys in the context.

        Returns:
            An iterable of all keys
        """
        return self.data.keys()

    def values(self) -> Iterable[Any]:
        """
        Get all values in the context.

        Returns:
            An iterable of all values
        """
        return self.data.values()

    def items(self) -> Iterable[tuple[str, Any]]:
        """
        Get all key-value pairs in the context.

        Returns:
            An iterable of all key-value pairs
        """
        return self.data.items()

    def clear(self) -> None:
        """Clear all keys and values from the context."""
        self.data.clear()

    def contains(self, key: str) -> bool:
        """
        Check if a key exists in the context.

        Args:
            key: The key to check

        Returns:
            True if the key exists, False otherwise
        """
        return key in self.data

    def update(self, other: dict[str, Any]) -> None:
        """
        Update context with key-value pairs from another dictionary.

        Args:
            other: Dictionary containing key-value pairs to add
        """
        self.data.update(other)

    def to_dict(self) -> dict[str, Any]:
        """
        Convert context variables to a dictionary.

        Returns:
            Dictionary representation of all context variables
        """
        return self.data.copy()

    # Dictionary-compatible interface
    def __getitem__(self, key: str) -> Any:
        """Get a value using dictionary syntax: context[key]"""
        try:
            return self.data[key]
        except KeyError:
            raise KeyError(f"Context variable '{key}' not found")

    def __setitem__(self, key: str, value: Any) -> None:
        """Set a value using dictionary syntax: context[key] = value"""
        self.data[key] = value

    def __delitem__(self, key: str) -> None:
        """Delete a key using dictionary syntax: del context[key]"""
        try:
            del self.data[key]
        except KeyError:
            raise KeyError(f"Cannot delete non-existent context variable '{key}'")

    def __contains__(self, key: str) -> bool:
        """Check if key exists using 'in' operator: key in context"""
        return key in self.data

    def __len__(self) -> int:
        """Get the number of items: len(context)"""
        return len(self.data)

    def __iter__(self) -> Generator[tuple[str, Any], None, None]:
        """Iterate over keys: for key in context"""
        for key in self.data:
            yield (key, self.data[key])

    def __str__(self) -> str:
        """String representation of context variables."""
        return f"ContextVariables({self.data})"

    def __repr__(self) -> str:
        """Detailed representation of context variables."""
        return f"ContextVariables(data={self.data!r})"

    # Utility methods
    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ContextVariables":
        """
        Create a new ContextVariables instance from a dictionary.

        E.g.:
        my_context = {"user_id": "12345", "settings": {"theme": "dark"}}
        context = ContextVariables.from_dict(my_context)

        Args:
            data: Dictionary of key-value pairs

        Returns:
            New ContextVariables instance
        """
        return cls(data=data)
