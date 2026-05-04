# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0


from typing import Optional, Protocol, runtime_checkable

from .....doc_utils import export_module
from .....import_utils import optional_import_block

with optional_import_block():
    from google.oauth2.credentials import Credentials


__all__ = ["GoogleCredentialsProvider"]


@runtime_checkable
@export_module("autogen.tools.experimental.google.authentication")
class GoogleCredentialsProvider(Protocol):
    """A protocol for Google credentials provider."""

    def get_credentials(self) -> Optional["Credentials"]:  # type: ignore[no-any-unimported]
        """Get the Google credentials."""
        ...

    @property
    def host(self) -> str:
        """The host from which to get the credentials."""
        ...

    @property
    def port(self) -> int:
        """The port from which to get the credentials."""
        ...
