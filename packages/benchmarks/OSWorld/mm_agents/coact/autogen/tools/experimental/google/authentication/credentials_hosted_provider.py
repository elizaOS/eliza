# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0


from .....doc_utils import export_module
from .....import_utils import optional_import_block
from .credentials_provider import GoogleCredentialsProvider

with optional_import_block():
    from google.oauth2.credentials import Credentials


__all__ = ["GoogleCredenentialsHostedProvider"]


@export_module("autogen.tools.experimental.google.authentication")
class GoogleCredenentialsHostedProvider(GoogleCredentialsProvider):
    def __init__(
        self,
        host: str,
        port: int = 8080,
        *,
        kwargs: dict[str, str],
    ) -> None:
        self._host = host
        self._port = port
        self._kwargs = kwargs

        raise NotImplementedError("This class is not implemented yet.")

    @property
    def host(self) -> str:
        """The host from which to get the credentials."""
        return self._host

    @property
    def port(self) -> int:
        """The port from which to get the credentials."""
        return self._port

    def get_credentials(self) -> "Credentials":  # type: ignore[no-any-unimported]
        raise NotImplementedError("This class is not implemented yet.")
