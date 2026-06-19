import re
import base64
from loguru import logger
from typing import List, Optional
from PIL import Image
from io import BytesIO
import tempfile
import os
import math

def encode_image(image_content):
    return base64.b64encode(image_content).decode("utf-8")

def smart_resize(
    height: int,
    width: int,
    factor: int = 28,
    min_pixels: int = 56 * 56,
    max_pixels: int = 14 * 14 * 4 * 1280,
    max_aspect_ratio_allowed: Optional[float] = None,
    size_can_be_smaller_than_factor: bool = False,
):
    """Rescales the image so that the following conditions are met:

    1. Both dimensions (height and width) are divisible by 'factor'.

    2. The total number of pixels is within the range ['min_pixels', 'max_pixels'].

    3. The aspect ratio of the image is maintained as closely as possible.

    """
    if not size_can_be_smaller_than_factor and (height < factor or width < factor):
        raise ValueError(
            f"height:{height} or width:{width} must be larger than factor:{factor} "
            f"(when size_can_be_smaller_than_factor is False)"
        )
    elif (
        max_aspect_ratio_allowed is not None
        and max(height, width) / min(height, width) > max_aspect_ratio_allowed
    ):
        raise ValueError(
            f"absolute aspect ratio must be smaller than {max_aspect_ratio_allowed}, "
            f"got {max(height, width) / min(height, width)}"
            f"(when max_aspect_ratio_allowed is not None)"
        )
    h_bar = max(1, round(height / factor)) * factor
    w_bar = max(1, round(width / factor)) * factor
    if h_bar * w_bar > max_pixels:
        beta = math.sqrt((height * width) / max_pixels)
        h_bar = max(1, math.floor(height / beta / factor)) * factor
        w_bar = max(1, math.floor(width / beta / factor)) * factor
    elif h_bar * w_bar < min_pixels:
        beta = math.sqrt(min_pixels / (height * width))
        h_bar = math.ceil(height * beta / factor) * factor
        w_bar = math.ceil(width * beta / factor) * factor
    return h_bar, w_bar
    
def call_openai_naive(model, payload, address_hint=None):
    """
    Naive OpenAI API call using requests.
    """
    # Extract fields from payload
    model = payload.get("model")
    payload["model"] = model.model_id if hasattr(model, "model_id") else "None"
    # address_hint not used here
    base_url = model.base_url
    # logger.warning(f"Base URL: {base_url}, Payload model: {payload['model']}")
    url = f"{base_url}/chat/completions"
    headers = {
        "Content-Type": "application/json",
    }
    data = {
        **payload,
        "n": 1,
    }
    max_retry = 5
    chat_completions = None
    success = False
    while success is False and max_retry > 0:
        try:
            json_data = json.dumps(data)
            response = requests.post(
                url, headers=headers, data=json_data, timeout=120, verify=False
            )
            if response.status_code == 200:
                chat_completions = response.json()
                try:
                    finish_reason = chat_completions["choices"][0].get("finish_reason")
                    if (
                        finish_reason is not None and finish_reason == "stop"
                    ):  # for most of the time, length will not exceed max_tokens
                        success = True
                    else:
                        time.sleep(5)
                        max_retry -= 1
                except Exception as e:
                    logger.error(f"Error in processing chat completion: {e}")
                    time.sleep(5)
                    max_retry -= 1
            else:
                logger.error(f"Failed to call OpenAI API: {response.text}")
                time.sleep(5)
                max_retry -= 1
        except requests.exceptions.ReadTimeout:
            # timeout is normal, don't print trace
            max_retry -= 1
            logger.warning(f"Timeout in OpenAI API call, left retries: {max_retry}")
            time.sleep(5)

        except Exception as e:
            max_retry -= 1
            logger.exception(f"Failed to call OpenAI API: {e}")
            time.sleep(5)

    if chat_completions is None:
        raise RuntimeError("Failed to call OpenAI API, max_retry used up")
    try:
        infos = {}
        if "choices" in chat_completions:
            infos["finish_reason"] = chat_completions["choices"][0].get("finish_reason")
            infos["n"] = len(chat_completions["choices"])
            if "tool_calls" in chat_completions["choices"][0]["message"]:
                infos["tool_calls"] = chat_completions["choices"][0]["message"][
                    "tool_calls"
                ]
            infos["choices"] = chat_completions["choices"]  # for the case of n > 1
        if "usage" in chat_completions:
            infos["usage"] = chat_completions["usage"]
        return chat_completions["choices"][0]["message"]["content"], infos
    except Exception as e:
        logger.error(f"Error in processing chat completion {e}")
        return "", {"n": 1, "usage": 0, "finish_reason": f"error {e}"}


def preprocess_for_naive_openai(self, payload):
    if isinstance(payload["model"], str):
        payload["model"] = getattr(self, "openai_client", None)
    return payload

def encoded_img_to_pil_img(data_str):
    base64_str = data_str.replace("data:image/png;base64,", "")
    image_data = base64.b64decode(base64_str)
    return Image.open(BytesIO(image_data))


def save_to_tmp_img_file(data_str):
    base64_str = data_str.replace("data:image/png;base64,", "")
    image_data = base64.b64decode(base64_str)
    image = Image.open(BytesIO(image_data))

    tmp_img_path = os.path.join(tempfile.mkdtemp(), "tmp_img.png")
    image.save(tmp_img_path)

    return tmp_img_path


def bbox_to_center_1000(bbox: str) -> tuple[int, int]:
    regex_list = [
        r"<\|box_start\|>\((\d+),(\d+)\),\((\d+),(\d+)\)<\|box_end\|>",  # '<|box_start|>(576,12),(592,42)<|box_end|>'
        r"<\|box_start\|>\[\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]\]<\|box_end\|>",  # '<|box_start|>[[576, 12, 592, 42]]<|box_end|>'
        r"<\|box_start\|>\[\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]<\|box_end\|>",  # '<|box_start|>[[576, 12, 592, 42]<|box_end|>', this is actually wrong format, but we parse it anyway
        r"<\|box_start\|>\((\d+),\s*(\d+),\s*(\d+),\s*(\d+)\)<\|box_end\|>",  # '<|box_start|>(576, 12, 592, 42)<|box_end|>', this is actually wrong format, but we parse it anyway
        r"\((\d+),(\d+)\),\((\d+),(\d+)\)",  # Versions without the 'bbox' special tokens
        r"\[\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]\]",
        r"\[\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]",
        r"\((\d+),\s*(\d+),\s*(\d+),\s*(\d+)\)",
    ]
    for regex in regex_list:
        match = re.search(regex, bbox)
        if match:
            break
    if not match:
        raise ValueError(
            f"Bounding box coordinates not found in the input string: {bbox}"
        )
    x_top_left, y_top_left, x_bottom_right, y_bottom_right = map(int, match.groups())
    x_center = (x_top_left + x_bottom_right) // 2
    y_center = (y_top_left + y_bottom_right) // 2
    return x_center, y_center


def bbox_to_center_1(bbox: str) -> tuple[int, int]:
    regex_list = [
        r"\[\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*\]",
    ]
    for regex in regex_list:
        match = re.search(regex, bbox)
        if match:
            break
    if not match:
        raise ValueError(
            f"Bounding box coordinates not found in the input string: {bbox}"
        )
    coordinates = tuple(map(float, match.groups()))
    coordinates = [int(coord * 1000) for coord in coordinates]
    x_center = (coordinates[0] + coordinates[2]) // 2
    y_center = (coordinates[1] + coordinates[3]) // 2
    return x_center, y_center

def _coordinate_projection(x, y, screen_width, screen_height, coordinate_type):
    if coordinate_type == "relative":
        return int(round(x * screen_width)), int(round(y * screen_height))
    elif coordinate_type == "absolute":
        return x, y
    elif coordinate_type == "qwen25":
        height, width = smart_resize(
            height=screen_height,
            width=screen_width,
            factor=28,
            min_pixels=3136,
            max_pixels=12845056,
        )
        return int(x / width * screen_width), int(y / height * screen_height)
    elif coordinate_type == "relative1000":
        if screen_width == 0 or screen_height == 0:
            raise ValueError(
                "Screen width and height must be greater than zero for relative1000 coordinates."
            )
        x_abs = int(round(x * screen_width / 1000))
        y_abs = int(round(y * screen_height / 1000))
        return x_abs, y_abs
    else:
        raise ValueError(f"Unsupported coordinate type: {coordinate_type}")


def rescale_coord(
    coord: tuple[int, int],
    original_width: int,
    original_height: int,
    scaled_width=1000,
    scaled_height=1000,
) -> tuple[int, int]:
    # According to https://huggingface.co/spaces/maxiw/OS-ATLAS/blob/398c3256a4fec409a074e0e4b5ac1d1d5bf7c240/app.py#L36
    # It seems that OS-ATLAS model are rescaled to output 1000x1000 images
    # So we need to rescale the coordinates back to the original image size
    x_scale = original_width / scaled_width
    y_scale = original_height / scaled_height
    return int(coord[0] * x_scale), int(coord[1] * y_scale)


def _pyautogui_code_to_absolute_coordinates(
    pyautogui_code_relative_coordinates,
    logical_screen_size,
    coordinate_type="relative",
    model_input_size=None,
):
    """
    Convert the relative coordinates in the pyautogui code to absolute coordinates based on the logical screen size.
    """
    import re
    import ast

    if coordinate_type not in ["relative", "relative1000", "absolute", "qwen25"]:
        raise ValueError(
            f"Invalid coordinate type: {coordinate_type}. Expected one of ['relative', 'relative1000', 'absolute', 'qwen25']."
        )

    screen_width, screen_height = logical_screen_size
    if model_input_size is not None:
        model_width, model_height = model_input_size
        width_scale, height_scale = (
            screen_width / model_width,
            screen_height / model_height,
        )
    else:
        width_scale, height_scale = 1, 1

    pattern = r"(pyautogui\.\w+\([^\)]*\))"

    matches = re.findall(pattern, pyautogui_code_relative_coordinates)

    new_code = pyautogui_code_relative_coordinates

    for full_call in matches:
        func_name_pattern = r"(pyautogui\.\w+)\((.*)\)"
        func_match = re.match(func_name_pattern, full_call, re.DOTALL)
        if not func_match:
            continue

        func_name = func_match.group(1)
        args_str = func_match.group(2)

        try:
            parsed = ast.parse(f"func({args_str})").body[0].value
            parsed_args = parsed.args
            parsed_keywords = parsed.keywords
        except SyntaxError:
            return pyautogui_code_relative_coordinates

        function_parameters = {
            "click": ["x", "y", "clicks", "interval", "button", "duration", "pause"],
            "moveTo": ["x", "y", "duration", "tween", "pause"],
            "moveRel": ["xOffset", "yOffset", "duration", "tween", "pause"],
            "dragTo": ["x", "y", "duration", "button", "mouseDownUp", "pause"],
            "dragRel": [
                "xOffset",
                "yOffset",
                "duration",
                "button",
                "mouseDownUp",
                "pause",
            ],
            "doubleClick": ["x", "y", "interval", "button", "duration", "pause"],
        }

        func_base_name = func_name.split(".")[-1]

        param_names = function_parameters.get(func_base_name, [])

        args = {}
        for idx, arg in enumerate(parsed_args):
            if idx < len(param_names):
                param_name = param_names[idx]
                arg_value = ast.literal_eval(arg)
                args[param_name] = arg_value

        try:
            for kw in parsed_keywords:
                param_name = kw.arg
                arg_value = ast.literal_eval(kw.value)
                args[param_name] = arg_value
        except Exception as e:
            logger.error(f"Error parsing keyword arguments: {e}")
            return pyautogui_code_relative_coordinates

        updated = False
        if "x" in args and "y" in args:
            try:
                x_rel = float(args["x"])
                y_rel = float(args["y"])
                x_abs, y_abs = _coordinate_projection(
                    x_rel, y_rel, screen_width, screen_height, coordinate_type
                )
                # logger.warning(f"Projecting coordinates: ({x_rel}, {y_rel}) to ({x_abs}, {y_abs}) using {coordinate_type} projection.")
                args["x"] = x_abs * width_scale
                args["y"] = y_abs * height_scale
                updated = True
            except ValueError:
                pass

        if "xOffset" in args and "yOffset" in args:
            try:
                x_rel = float(args["xOffset"])
                y_rel = float(args["yOffset"])
                x_abs, y_abs = _coordinate_projection(
                    x_rel, y_rel, screen_width, screen_height, coordinate_type
                )
                args["xOffset"] = x_abs * width_scale
                args["yOffset"] = y_abs * height_scale
                updated = True
            except ValueError:
                pass

        if updated:
            reconstructed_args = []
            for idx, param_name in enumerate(param_names):
                if param_name in args:
                    arg_value = args[param_name]
                    if isinstance(arg_value, str):
                        arg_repr = f"'{arg_value}'"
                    else:
                        arg_repr = str(arg_value)
                    reconstructed_args.append(arg_repr)
                else:
                    break

            used_params = set(param_names[: len(reconstructed_args)])
            for kw in parsed_keywords:
                if kw.arg not in used_params:
                    arg_value = args[kw.arg]
                    if isinstance(arg_value, str):
                        arg_repr = f"{kw.arg}='{arg_value}'"
                    else:
                        arg_repr = f"{kw.arg}={arg_value}"
                    reconstructed_args.append(arg_repr)

            new_args_str = ", ".join(reconstructed_args)
            new_full_call = f"{func_name}({new_args_str})"
            new_code = new_code.replace(full_call, new_full_call)

    return new_code


def split_args(args_str: str) -> List[str]:
    args = []
    current_arg = ""
    within_string = False
    string_char = ""
    prev_char = ""
    for char in args_str:
        if char in ['"', "'"]:
            if not within_string:
                within_string = True
                string_char = char
            elif within_string and prev_char != "\\" and char == string_char:
                within_string = False
        if char == "," and not within_string:
            args.append(current_arg)
            current_arg = ""
        else:
            current_arg += char
        prev_char = char
    if current_arg:
        args.append(current_arg)
    return args


def correct_pyautogui_arguments(code: str) -> str:
    function_corrections = {
        "write": {
            "incorrect_args": ["text", "content"],
            "correct_args": [],
            "keyword_arg": "message",
        },
        "press": {
            "incorrect_args": ["key", "button"],
            "correct_args": [],
            "keyword_arg": None,
        },
        "hotkey": {
            "incorrect_args": ["key1", "key2", "keys"],
            "correct_args": [],
            "keyword_arg": None,
        },
    }

    lines = code.strip().split("\n")
    corrected_lines = []

    for line in lines:
        line = line.strip()
        match = re.match(r"(pyautogui\.(\w+))\((.*)\)", line)
        if match:
            full_func_call = match.group(1)
            func_name = match.group(2)
            args_str = match.group(3)

            if func_name in function_corrections:
                func_info = function_corrections[func_name]
                args = split_args(args_str)
                corrected_args = []

                for arg in args:
                    arg = arg.strip()
                    kwarg_match = re.match(r"(\w+)\s*=\s*(.*)", arg)
                    if kwarg_match:
                        arg_name = kwarg_match.group(1)
                        arg_value = kwarg_match.group(2)

                        if arg_name in func_info["incorrect_args"]:
                            if func_info["keyword_arg"]:
                                corrected_args.append(
                                    f"{func_info['keyword_arg']}={arg_value}"
                                )
                            else:
                                corrected_args.append(arg_value)
                        else:
                            corrected_args.append(f"{arg_name}={arg_value}")
                    else:
                        corrected_args.append(arg)

                corrected_args_str = ", ".join(corrected_args)
                corrected_line = f"{full_func_call}({corrected_args_str})"
                corrected_lines.append(corrected_line)
            else:
                corrected_lines.append(line)
        else:
            corrected_lines.append(line)

    corrected_code = "\n".join(corrected_lines)
    return corrected_code

def image_message_from_obs(obs, for_training=False):
    if not for_training:
        return {
            "type": "image_url",
            "image_url": {
                "url": f"data:image/png;base64,{encode_image(obs['screenshot'])}",
                "detail": "high",
            },
        }
    else:
        return {"type": "image_url", "image_url": {"url": obs["screenshot_path"]}}
