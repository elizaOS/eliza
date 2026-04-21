# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0
#
# Portions derived from  https://github.com/microsoft/autogen are under the MIT License.
# SPDX-License-Identifier: MIT

from typing import Any, Literal, TypedDict, Union

MessageContentType = Union[str, list[Union[dict[str, Any], str]], None]


class UserMessageTextContentPart(TypedDict):
    """Represents a text content part of a user message"""

    type: Literal["text"]
    """The type of the content part. Always "text" for text content parts."""
    text: str
    """The text content of the part."""


class UserMessageImageContentPart(TypedDict):
    """Represents an image content part of a user message"""

    type: Literal["input_image"]
    """The type of the content part. Always "input_image" for image content parts."""
    # Ignoring the other "detail param for now"
    image_url: str
    """The URL of the image."""
