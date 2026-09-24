# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0


import os
from typing import Optional

from .....doc_utils import export_module
from .....import_utils import optional_import_block, require_optional_import
from .credentials_provider import GoogleCredentialsProvider

with optional_import_block():
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow


__all__ = ["GoogleCredentialsLocalProvider"]


@export_module("autogen.tools.experimental.google.authentication")
class GoogleCredentialsLocalProvider(GoogleCredentialsProvider):
    def __init__(
        self,
        client_secret_file: str,
        scopes: list[str],  # e.g. ['https://www.googleapis.com/auth/drive/readonly']
        token_file: Optional[str] = None,
        port: int = 8080,
    ) -> None:
        """A Google credentials provider that gets the credentials locally.

        Args:
            client_secret_file (str): The path to the client secret file.
            scopes (list[str]): The scopes to request.
            token_file (str): Optional path to the token file. If not provided, the token will not be saved.
            port (int): The port from which to get the credentials.
        """
        self.client_secret_file = client_secret_file
        self.scopes = scopes
        self.token_file = token_file
        self._port = port

    @property
    def host(self) -> str:
        """Localhost is the default host."""
        return "localhost"

    @property
    def port(self) -> int:
        """The port from which to get the credentials."""
        return self._port

    @require_optional_import(
        [
            "google_auth_httplib2",
            "google_auth_oauthlib",
        ],
        "google-api",
    )
    def _refresh_or_get_new_credentials(self, creds: Optional["Credentials"]) -> "Credentials":  # type: ignore[no-any-unimported]
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())  # type: ignore[no-untyped-call]
        else:
            flow = InstalledAppFlow.from_client_secrets_file(self.client_secret_file, self.scopes)
            creds = flow.run_local_server(host=self.host, port=self.port)
        return creds  # type: ignore[return-value]

    @require_optional_import(
        [
            "google_auth_httplib2",
            "google_auth_oauthlib",
        ],
        "google-api",
    )
    def get_credentials(self) -> "Credentials":  # type: ignore[no-any-unimported]
        """Get the Google credentials."""
        creds = None
        if self.token_file and os.path.exists(self.token_file):
            creds = Credentials.from_authorized_user_file(self.token_file)  # type: ignore[no-untyped-call]

        # If there are no (valid) credentials available, let the user log in.
        if not creds or not creds.valid:
            creds = self._refresh_or_get_new_credentials(creds)

            if self.token_file:
                # Save the credentials for the next run
                with open(self.token_file, "w") as token:
                    token.write(creds.to_json())  # type: ignore[no-untyped-call]

        return creds  # type: ignore[no-any-return]
