# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from pathlib import Path
from typing import Annotated, Literal, Optional, Union

from .....doc_utils import export_module
from .....import_utils import optional_import_block
from .... import Toolkit, tool
from ..model import GoogleFileInfo
from ..toolkit_protocol import GoogleToolkitProtocol
from .drive_functions import download_file, list_files_and_folders

with optional_import_block():
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

__all__ = [
    "GoogleDriveToolkit",
]


@export_module("autogen.tools.experimental.google.drive")
class GoogleDriveToolkit(Toolkit, GoogleToolkitProtocol):
    """A tool map for Google Drive."""

    def __init__(  # type: ignore[no-any-unimported]
        self,
        *,
        credentials: "Credentials",
        download_folder: Union[Path, str],
        exclude: Optional[list[Literal["list_drive_files_and_folders", "download_file_from_drive"]]] = None,
        api_version: str = "v3",
    ) -> None:
        """Initialize the Google Drive tool map.

        Args:
            credentials: The Google OAuth2 credentials.
            download_folder: The folder to download files to.
            exclude: The tool names to exclude.
            api_version: The Google Drive API version to use."
        """
        self.service = build(serviceName="drive", version=api_version, credentials=credentials)

        if isinstance(download_folder, str):
            download_folder = Path(download_folder)
        download_folder.mkdir(parents=True, exist_ok=True)

        @tool(description="List files and folders in a Google Drive")
        def list_drive_files_and_folders(
            page_size: Annotated[int, "The number of files to list per page."] = 10,
            folder_id: Annotated[
                Optional[str],
                "The ID of the folder to list files from. If not provided, lists all files in the root folder.",
            ] = None,
        ) -> list[GoogleFileInfo]:
            return list_files_and_folders(service=self.service, page_size=page_size, folder_id=folder_id)

        @tool(description="download a file from Google Drive")
        def download_file_from_drive(
            file_info: Annotated[GoogleFileInfo, "The file info to download."],
            subfolder_path: Annotated[
                Optional[str],
                "The subfolder path to save the file in. If not provided, saves in the main download folder.",
            ] = None,
        ) -> str:
            return download_file(
                service=self.service,
                file_id=file_info.id,
                file_name=file_info.name,
                mime_type=file_info.mime_type,
                download_folder=download_folder,
                subfolder_path=subfolder_path,
            )

        if exclude is None:
            exclude = []

        tools = [tool for tool in [list_drive_files_and_folders, download_file_from_drive] if tool.name not in exclude]
        super().__init__(tools=tools)

    @classmethod
    def recommended_scopes(cls) -> list[str]:
        """Return the recommended scopes manatory for using tools from this tool map."""
        return [
            "https://www.googleapis.com/auth/drive.readonly",
        ]
