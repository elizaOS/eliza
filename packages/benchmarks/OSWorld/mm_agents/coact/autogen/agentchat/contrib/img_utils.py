# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0
#
# Portions derived from  https://github.com/microsoft/autogen are under the MIT License.
# SPDX-License-Identifier: MIT
import base64
import copy
import os
import re
from io import BytesIO
from math import ceil
from typing import Any, Union

import requests

from ...import_utils import optional_import_block, require_optional_import
from .. import utils

with optional_import_block():
    from PIL import Image


# Parameters for token counting for images for different models
MODEL_PARAMS = {
    "gpt-4-vision": {
        "max_edge": 2048,
        "min_edge": 768,
        "tile_size": 512,
        "base_token_count": 85,
        "token_multiplier": 170,
    },
    "gpt-4o-mini": {
        "max_edge": 2048,
        "min_edge": 768,
        "tile_size": 512,
        "base_token_count": 2833,
        "token_multiplier": 5667,
    },
    "gpt-4o": {"max_edge": 2048, "min_edge": 768, "tile_size": 512, "base_token_count": 85, "token_multiplier": 170},
}


@require_optional_import("PIL", "unknown")
def get_pil_image(image_file: Union[str, "Image.Image"]) -> "Image.Image":
    """Loads an image from a file and returns a PIL Image object.

    Parameters:
        image_file (str, or Image): The filename, URL, URI, or base64 string of the image file.

    Returns:
        Image.Image: The PIL Image object.
    """
    if isinstance(image_file, Image.Image):
        # Already a PIL Image object
        return image_file

    # Remove quotes if existed
    if image_file.startswith('"') and image_file.endswith('"'):
        image_file = image_file[1:-1]
    if image_file.startswith("'") and image_file.endswith("'"):
        image_file = image_file[1:-1]

    if image_file.startswith("http://") or image_file.startswith("https://"):
        # A URL file
        response = requests.get(image_file)
        content = BytesIO(response.content)
        image = Image.open(content)
    # Match base64-encoded image URIs for supported formats: jpg, jpeg, png, gif, bmp, webp
    elif re.match(r"data:image/(?:jpg|jpeg|png|gif|bmp|webp);base64,", image_file):
        # A URI. Remove the prefix and decode the base64 string.
        base64_data = re.sub(r"data:image/(?:jpg|jpeg|png|gif|bmp|webp);base64,", "", image_file)
        image = _to_pil(base64_data)
    elif os.path.exists(image_file):
        # A local file
        image = Image.open(image_file)
    else:
        # base64 encoded string
        image = _to_pil(image_file)

    return image.convert("RGB")


@require_optional_import("PIL", "unknown")
def get_image_data(image_file: Union[str, "Image.Image"], use_b64=True) -> bytes:
    """Loads an image and returns its data either as raw bytes or in base64-encoded format.

    This function first loads an image from the specified file, URL, or base64 string using
    the `get_pil_image` function. It then saves this image in memory in PNG format and
    retrieves its binary content. Depending on the `use_b64` flag, this binary content is
    either returned directly or as a base64-encoded string.

    Parameters:
        image_file (str, or Image): The path to the image file, a URL to an image, or a base64-encoded
                          string of the image.
        use_b64 (bool): If True, the function returns a base64-encoded string of the image data.
                        If False, it returns the raw byte data of the image. Defaults to True.

    Returns:
        bytes: The image data in raw bytes if `use_b64` is False, or a base64-encoded string
               if `use_b64` is True.
    """
    image = get_pil_image(image_file)

    buffered = BytesIO()
    image.save(buffered, format="PNG")
    content = buffered.getvalue()

    if use_b64:
        return base64.b64encode(content).decode("utf-8")
    else:
        return content


@require_optional_import("PIL", "unknown")
def llava_formatter(prompt: str, order_image_tokens: bool = False) -> tuple[str, list[str]]:
    """Formats the input prompt by replacing image tags and returns the new prompt along with image locations.

    Parameters:
        - prompt (str): The input string that may contain image tags like `<img ...>`.
        - order_image_tokens (bool, optional): Whether to order the image tokens with numbers.
            It will be useful for GPT-4V. Defaults to False.

    Returns:
        - Tuple[str, List[str]]: A tuple containing the formatted string and a list of images (loaded in b64 format).
    """
    # Initialize variables
    new_prompt = prompt
    image_locations = []
    images = []
    image_count = 0

    # Regular expression pattern for matching <img ...> tags
    img_tag_pattern = re.compile(r"<img ([^>]+)>")

    # Find all image tags
    for match in img_tag_pattern.finditer(prompt):
        image_location = match.group(1)

        try:
            img_data = get_image_data(image_location)
        except Exception as e:
            # Remove the token
            print(f"Warning! Unable to load image from {image_location}, because of {e}")
            new_prompt = new_prompt.replace(match.group(0), "", 1)
            continue

        image_locations.append(image_location)
        images.append(img_data)

        # Increment the image count and replace the tag in the prompt
        new_token = f"<image {image_count}>" if order_image_tokens else "<image>"

        new_prompt = new_prompt.replace(match.group(0), new_token, 1)
        image_count += 1

    return new_prompt, images


@require_optional_import("PIL", "unknown")
def pil_to_data_uri(image: "Image.Image") -> str:
    """Converts a PIL Image object to a data URI.

    Parameters:
        image (Image.Image): The PIL Image object.

    Returns:
        str: The data URI string.
    """
    buffered = BytesIO()
    image.save(buffered, format="PNG")
    content = buffered.getvalue()
    return convert_base64_to_data_uri(base64.b64encode(content).decode("utf-8"))


def convert_base64_to_data_uri(base64_image):
    def _get_mime_type_from_data_uri(base64_image):
        # Decode the base64 string
        image_data = base64.b64decode(base64_image)
        # Check the first few bytes for known signatures
        if image_data.startswith(b"\xff\xd8\xff"):
            return "image/jpeg"
        elif image_data.startswith(b"\x89PNG\r\n\x1a\n"):
            return "image/png"
        elif image_data.startswith(b"GIF87a") or image_data.startswith(b"GIF89a"):
            return "image/gif"
        elif image_data.startswith(b"RIFF") and image_data[8:12] == b"WEBP":
            return "image/webp"
        return "image/jpeg"  # use jpeg for unknown formats, best guess.

    mime_type = _get_mime_type_from_data_uri(base64_image)
    data_uri = f"data:{mime_type};base64,{base64_image}"
    return data_uri


@require_optional_import("PIL", "unknown")
def gpt4v_formatter(prompt: str, img_format: str = "uri") -> list[Union[str, dict[str, Any]]]:
    """Formats the input prompt by replacing image tags and returns a list of text and images.

    Args:
        prompt (str): The input string that may contain image tags like `<img ...>`.
        img_format (str): what image format should be used. One of "uri", "url", "pil".

    Returns:
        List[Union[str, dict[str, Any]]]: A list of alternating text and image dictionary items.
    """
    assert img_format in ["uri", "url", "pil"]

    output = []
    last_index = 0
    image_count = 0

    # Find all image tags
    for parsed_tag in utils.parse_tags_from_content("img", prompt):
        image_location = parsed_tag["attr"]["src"]
        try:
            if img_format == "pil":
                img_data = get_pil_image(image_location)
            elif img_format == "uri":
                img_data = get_image_data(image_location)
                img_data = convert_base64_to_data_uri(img_data)
            elif img_format == "url":
                img_data = image_location
            else:
                raise ValueError(f"Unknown image format {img_format}")
        except Exception as e:
            # Warning and skip this token
            print(f"Warning! Unable to load image from {image_location}, because {e}")
            continue

        # Add text before this image tag to output list
        output.append({"type": "text", "text": prompt[last_index : parsed_tag["match"].start()]})

        # Add image data to output list
        output.append({"type": "image_url", "image_url": {"url": img_data}})

        last_index = parsed_tag["match"].end()
        image_count += 1

    # Add remaining text to output list
    if last_index < len(prompt):
        output.append({"type": "text", "text": prompt[last_index:]})
    return output


def extract_img_paths(paragraph: str) -> list:
    """Extract image paths (URLs or local paths) from a text paragraph.

    Parameters:
        paragraph (str): The input text paragraph.

    Returns:
        list: A list of extracted image paths.
    """
    # Regular expression to match image URLs and file paths.
    # This regex detects URLs and file paths with common image extensions, including support for the webp format.
    img_path_pattern = re.compile(
        r"\b(?:http[s]?://\S+\.(?:jpg|jpeg|png|gif|bmp|webp)|\S+\.(?:jpg|jpeg|png|gif|bmp|webp))\b", re.IGNORECASE
    )

    # Find all matches in the paragraph
    img_paths = re.findall(img_path_pattern, paragraph)
    return img_paths


@require_optional_import("PIL", "unknown")
def _to_pil(data: str) -> "Image.Image":
    """Converts a base64 encoded image data string to a PIL Image object.

    This function first decodes the base64 encoded string to bytes, then creates a BytesIO object from the bytes,
    and finally creates and returns a PIL Image object from the BytesIO object.

    Parameters:
        data (str): The encoded image data string.

    Returns:
        Image.Image: The PIL Image object created from the input data.
    """
    return Image.open(BytesIO(base64.b64decode(data)))


@require_optional_import("PIL", "unknown")
def message_formatter_pil_to_b64(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Converts the PIL image URLs in the messages to base64 encoded data URIs.

    This function iterates over a list of message dictionaries. For each message,
    if it contains a 'content' key with a list of items, it looks for items
    with an 'image_url' key. The function then converts the PIL image URL
    (pointed to by 'image_url') to a base64 encoded data URI.

    Parameters:
        messages (List[Dict]): A list of message dictionaries. Each dictionary
                               may contain a 'content' key with a list of items,
                               some of which might be image URLs.

    Returns:
        List[Dict]: A new list of message dictionaries with PIL image URLs in the
                    'image_url' key converted to base64 encoded data URIs.

    Example Input:
        example 1:
        ```python
        [
            {'content': [{'type': 'text', 'text': 'You are a helpful AI assistant.'}], 'role': 'system'},
            {'content': [
                {'type': 'text', 'text': "What's the breed of this dog here?"},
                {'type': 'image_url', 'image_url': {'url': a PIL.Image.Image}},
                {'type': 'text', 'text': '.'}],
            'role': 'user'}
        ]
        ```

    Example Output:
        example 1:
        ```python
        [
            {'content': [{'type': 'text', 'text': 'You are a helpful AI assistant.'}], 'role': 'system'},
            {'content': [
                {'type': 'text', 'text': "What's the breed of this dog here?"},
                {'type': 'image_url', 'image_url': {'url': a B64 Image}},
                {'type': 'text', 'text': '.'}],
            'role': 'user'}
        ]
        ```
    """
    new_messages = []
    for message in messages:
        # deepcopy to avoid modifying the original message.
        message = copy.deepcopy(message)
        if isinstance(message, dict) and "content" in message:
            # First, if the content is a string, parse it into a list of parts.
            # This is for tool output that contains images.
            if isinstance(message["content"], str):
                message["content"] = gpt4v_formatter(message["content"], img_format="pil")

            # Second, if the content is a list, process any image parts.
            if isinstance(message["content"], list):
                for item in message["content"]:
                    if (
                        isinstance(item, dict)
                        and "image_url" in item
                        and isinstance(item["image_url"]["url"], Image.Image)
                    ):
                        item["image_url"]["url"] = pil_to_data_uri(item["image_url"]["url"])

        new_messages.append(message)

    return new_messages


@require_optional_import("PIL", "unknown")
def num_tokens_from_gpt_image(
    image_data: Union[str, "Image.Image"], model: str = "gpt-4-vision", low_quality: bool = False
) -> int:
    """Calculate the number of tokens required to process an image based on its dimensions
    after scaling for different GPT models. Supports "gpt-4-vision", "gpt-4o", and "gpt-4o-mini".
    This function scales the image so that its longest edge is at most 2048 pixels and its shortest
    edge is at most 768 pixels (for "gpt-4-vision"). It then calculates the number of 512x512 tiles
    needed to cover the scaled image and computes the total tokens based on the number of these tiles.

    Reference: https://openai.com/api/pricing/

    Args:
        image_data : Union[str, Image.Image]: The image data which can either be a base64 encoded string, a URL, a file path, or a PIL Image object.
        model: str: The model being used for image processing. Can be "gpt-4-vision", "gpt-4o", or "gpt-4o-mini".
        low_quality: bool: Whether to use low-quality processing. Defaults to False.

    Returns:
        int: The total number of tokens required for processing the image.

    Examples:
    --------
    >>> from PIL import Image
    >>> img = Image.new("RGB", (2500, 2500), color="red")
    >>> num_tokens_from_gpt_image(img, model="gpt-4-vision")
    765
    """
    image = get_pil_image(image_data)  # PIL Image
    width, height = image.size

    # Determine model parameters
    if "gpt-4-vision" in model or "gpt-4-turbo" in model or "gpt-4v" in model or "gpt-4-v" in model:
        params = MODEL_PARAMS["gpt-4-vision"]
    elif "gpt-4o-mini" in model:
        params = MODEL_PARAMS["gpt-4o-mini"]
    elif "gpt-4o" in model:
        params = MODEL_PARAMS["gpt-4o"]
    else:
        raise ValueError(
            f"Model {model} is not supported. Choose 'gpt-4-vision', 'gpt-4-turbo', 'gpt-4v', 'gpt-4-v', 'gpt-4o', or 'gpt-4o-mini'."
        )

    if low_quality:
        return params["base_token_count"]

    # 1. Constrain the longest edge
    if max(width, height) > params["max_edge"]:
        scale_factor = params["max_edge"] / max(width, height)
        width, height = int(width * scale_factor), int(height * scale_factor)

    # 2. Further constrain the shortest edge
    if min(width, height) > params["min_edge"]:
        scale_factor = params["min_edge"] / min(width, height)
        width, height = int(width * scale_factor), int(height * scale_factor)

    # 3. Count how many tiles are needed to cover the image
    tiles_width = ceil(width / params["tile_size"])
    tiles_height = ceil(height / params["tile_size"])
    total_tokens = params["base_token_count"] + params["token_multiplier"] * (tiles_width * tiles_height)

    return total_tokens
