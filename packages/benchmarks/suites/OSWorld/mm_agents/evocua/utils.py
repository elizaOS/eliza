import base64
import re
import ast
import logging
from io import BytesIO
import json
from PIL import Image

from mm_agents.utils.qwen_vl_utils import smart_resize

logger = logging.getLogger("desktopenv.evocua.utils")

def encode_image(image_content):
    """Encode image bytes to base64 string."""
    return base64.b64encode(image_content).decode("utf-8")


def process_image(image_bytes, factor=32):
    """
    Process an image for VL models.
    factor: 32 for S2 mode, 28 for S1 mode default
    """
    image = Image.open(BytesIO(image_bytes))
    width, height = image.size

    resized_height, resized_width = smart_resize(
        height=height,
        width=width,
        factor=factor,
        max_pixels=16 * 16 * 4 * 12800, # Large buffer
    )

    image = image.resize((resized_width, resized_height))

    buffer = BytesIO()
    image.save(buffer, format="PNG")
    processed_bytes = buffer.getvalue()

    return base64.b64encode(processed_bytes).decode("utf-8"), resized_width, resized_height

def _fallback_rewrite_pyautogui_text_inputs(code: str) -> str:
    """
    Regex-based fallback to handle malformed pyautogui.write/typewrite calls.
    """
    logger.info(f"SyntaxError detected in code, using regex fallback. Original code: {code}")
    
    def _replacer(match):
        call_content = match.group(0)
        m = re.search(r'pyautogui\.(?:write|typewrite)\s*\(', call_content)
        if not m:
            return call_content
            
        args_part = call_content[m.end():].strip()
        args_part = re.sub(r'^(?:message|text)\s*=\s*', '', args_part)
        
        text_content = ""
        if args_part.startswith(("'''", '"""')):
            quote_type = args_part[:3]
            content = args_part[3:]
            end_idx = content.rfind(quote_type)
            if end_idx != -1:
                text_content = content[:end_idx]
            else:
                text_content = content[:-1] if content.endswith(')') else content
        elif args_part.startswith(("'", '"')):
            quote_type = args_part[0]
            content = args_part[1:]
            if content.endswith(quote_type + ")"):
                text_content = content[:-2]
            elif content.endswith(")"):
                if len(content) > 1 and content[-2] == quote_type:
                    text_content = content[:-2]
                else:
                    text_content = content[:-1]
            elif content.endswith(quote_type):
                text_content = content[:-1]
            else:
                text_content = content
        else:
            text_content = args_part[:-1] if args_part.endswith(')') else args_part

        new_cmds = []
        for char in text_content:
            p = "enter" if char == "\n" else char
            p_esc = p.replace("'", "\\'")
            new_cmds.append(f"pyautogui.press('{p_esc}')")
        
        return "; ".join(new_cmds)

    pattern = r"pyautogui\.(?:write|typewrite)\s*\(.*?(?=\s*;|\s*$|\n)"
    new_code = re.sub(pattern, _replacer, code)
    
    if new_code == code and ("pyautogui.write" in code or "pyautogui.typewrite" in code):
        new_code = re.sub(r"pyautogui\.(?:write|typewrite)\s*\(.*", _replacer, code)
            
    return new_code

def rewrite_pyautogui_text_inputs(code: str) -> str:
    """
    Expand pyautogui.write/typewrite string literals into per-character presses.
    """
    try:
        tree = ast.parse(code)
        
        class _TextCallRewriter(ast.NodeTransformer):
            def _extract_text(self, call: ast.Call):
                if not (
                    isinstance(call.func, ast.Attribute)
                    and isinstance(call.func.value, ast.Name)
                    and call.func.value.id == "pyautogui"
                    and call.func.attr in ("write", "typewrite")
                ):
                    return None

                message_node = call.args[0] if call.args else None
                if message_node is None:
                    for kw in call.keywords:
                        if kw.arg in ("message", "text"):
                            message_node = kw.value
                            break

                if isinstance(message_node, ast.Constant) and isinstance(message_node.value, str):
                    return message_node.value
                return None

            def visit_Expr(self, node):
                self.generic_visit(node)
                if isinstance(node.value, ast.Call):
                    text = self._extract_text(node.value)
                    if text is not None:
                        new_nodes = []
                        for char in text:
                            press_value = "enter" if char == "\n" else char
                            press_call = ast.Expr(
                                value=ast.Call(
                                    func=ast.Attribute(
                                        value=ast.Name(id="pyautogui", ctx=ast.Load()),
                                        attr="press",
                                        ctx=ast.Load(),
                                    ),
                                    args=[ast.Constant(value=press_value)],
                                    keywords=[],
                                )
                            )
                            new_nodes.append(press_call)
                        return new_nodes if new_nodes else node
                return node

        tree = _TextCallRewriter().visit(tree)
        tree = ast.fix_missing_locations(tree)
        new_code = ast.unparse(tree)
        return new_code

    except (SyntaxError, Exception):
        return _fallback_rewrite_pyautogui_text_inputs(code)



def project_coordinate_to_absolute_scale(pyautogui_code_relative_coordinates, screen_width, screen_height, coordinate_type="relative", resize_factor=28):
    """
    Convert the relative coordinates in the pyautogui code to absolute coordinates based on the logical screen size.
    """
    def _coordinate_projection(x, y, screen_width, screen_height, coordinate_type):
        if coordinate_type == "qwen25":
            height, width = smart_resize(
                height=screen_height, 
                width=screen_width, 
                factor=resize_factor, 
                min_pixels=3136, 
                max_pixels=12845056
            )
            if 0 <= x <= 1 and 0 <= y <= 1:
                # If already normalized, treat like "relative"
                return int(round(x * width)), int(round(y * height))
            return int(x / width * screen_width), int(y / height * screen_height)
        else:
            raise ValueError(f"Invalid coordinate type: {coordinate_type}. Expected 'qwen25'")

    pattern = r'(pyautogui\.\w+\([^\)]*\))'
    matches = re.findall(pattern, pyautogui_code_relative_coordinates)

    new_code = pyautogui_code_relative_coordinates

    for full_call in matches:
        func_name_pattern = r'(pyautogui\.\w+)\((.*)\)'
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
            continue

        function_parameters = {
            'click': ['x', 'y', 'clicks', 'interval', 'button', 'duration', 'pause'],
            'rightClick':  ['x', 'y', 'duration', 'tween', 'pause'],
            'middleClick': ['x', 'y', 'duration', 'tween', 'pause'],
            'doubleClick': ['x', 'y', 'interval', 'button', 'duration', 'pause'],
            'tripleClick': ['x', 'y', 'interval', 'button', 'duration', 'pause'],
            'moveTo': ['x', 'y', 'duration', 'tween', 'pause'],
            'dragTo': ['x', 'y', 'duration', 'button', 'mouseDownUp', 'pause'],
        }

        func_base_name = func_name.split('.')[-1]

        param_names = function_parameters.get(func_base_name, [])

        args = {}
        for idx, arg in enumerate(parsed_args):
            if idx < len(param_names):
                param_name = param_names[idx]
                try:
                    arg_value = ast.literal_eval(arg)
                    args[param_name] = arg_value
                except:
                    pass

        try:
            for kw in parsed_keywords:
                param_name = kw.arg
                arg_value = ast.literal_eval(kw.value)
                args[param_name] = arg_value
        except Exception as e:
            logger.error(f"Error parsing keyword arguments: {e}")
            continue

        updated = False
        if 'x' in args and 'y' in args:
            try:
                x_rel = float(args['x'])
                y_rel = float(args['y'])
                # Only project if they look like relative coords (e.g. <= 1.0 or depending on type)
                # Projection applies unconditionally if type is relative
                x_abs, y_abs = _coordinate_projection(x_rel, y_rel, screen_width, screen_height, coordinate_type)
                
                # Apply coordinate transformation
                args['x'] = x_abs
                args['y'] = y_abs
                updated = True
            except (ValueError, TypeError):
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

            used_params = set(param_names[:len(reconstructed_args)])
            for kw in parsed_keywords:
                if kw.arg not in used_params:
                    arg_value = args[kw.arg]
                    if isinstance(arg_value, str):
                        arg_repr = f"{kw.arg}='{arg_value}'"
                    else:
                        arg_repr = f"{kw.arg}={arg_value}"
                    reconstructed_args.append(arg_repr)

            new_args_str = ', '.join(reconstructed_args)
            new_full_call = f"{func_name}({new_args_str})"
            new_code = new_code.replace(full_call, new_full_call)

    return new_code


def log_messages(messages, prefix="LLM Messages"):
    """Log messages with truncated base64 images"""
    try:
        log_msgs = []
        for msg in messages:
            msg_copy = msg.copy()
            content = msg.get("content")
            if isinstance(content, list):
                new_content = []
                for item in content:
                    if isinstance(item, dict) and item.get("type") == "image_url":
                        item_copy = item.copy()
                        url = item_copy.get("image_url", {}).get("url", "")
                        if len(url) > 100:
                            item_copy["image_url"] = {"url": url[:30] + "...[base64_truncated]..." + url[-10:]}
                        new_content.append(item_copy)
                    else:
                        new_content.append(item)
                msg_copy["content"] = new_content
            log_msgs.append(msg_copy)
        logger.info(f"{prefix}:\n{json.dumps(log_msgs, indent=2, ensure_ascii=False)}")
    except Exception as e:
        logger.warning(f"Failed to log messages: {e}")