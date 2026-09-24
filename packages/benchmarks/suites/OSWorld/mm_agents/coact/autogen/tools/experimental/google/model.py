# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from typing import Annotated

from pydantic import BaseModel, Field

__all__ = [
    "GoogleFileInfo",
]


class GoogleFileInfo(BaseModel):
    name: Annotated[str, Field(description="The name of the file.")]
    id: Annotated[str, Field(description="The ID of the file.")]
    mime_type: Annotated[str, Field(alias="mimeType", description="The MIME type of the file.")]
