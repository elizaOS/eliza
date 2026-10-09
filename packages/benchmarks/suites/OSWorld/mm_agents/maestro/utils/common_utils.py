import json
import re
from typing import List
import time
import tiktoken
import numpy as np
import os
import platform
import io
from PIL import Image
import logging

from typing import Tuple, List, Union, Dict, Optional

from pydantic import BaseModel, ValidationError

import pickle


class Node(BaseModel):
    name: str
    info: str
    # New fields for failed task analysis
    assignee_role: Optional[str] = None
    error_type: Optional[str] = None  # Error type: UI_ERROR, EXECUTION_ERROR, PLANNING_ERROR, etc.
    error_message: Optional[str] = None  # Specific error message
    failure_count: Optional[int] = 0  # Failure count
    last_failure_time: Optional[str] = None  # Last failure time
    suggested_action: Optional[str] = None  # Suggested repair action


class Dag(BaseModel):
    nodes: List[Node]
    edges: List[List[Node]]

class SafeLoggingFilter(logging.Filter):
    """
    Safe logging filter that prevents logging format errors
    Handles cases where log message format strings don't match arguments
    """
    
    def filter(self, record):
        """
        Filter log records to prevent format errors
        """
        try:
            # Try to format the message to catch format errors early
            if hasattr(record, 'msg') and hasattr(record, 'args') and record.args:
                try:
                    # Test if the message can be formatted with the provided args
                    if isinstance(record.msg, str) and '%s' in record.msg:
                        # Count %s placeholders in the message
                        placeholder_count = record.msg.count('%s')
                        args_count = len(record.args)
                        
                        if placeholder_count != args_count:
                            # Mismatch detected, create safe message
                            record.msg = f"[Format mismatch prevented] Msg: {record.msg[:100]}{'...' if len(str(record.msg)) > 100 else ''}, Args count: {args_count}"
                            record.args = ()
                            return True
                    
                    # Test if the message can be formatted with the provided args
                    _ = record.msg % record.args
                except (TypeError, ValueError) as e:
                    # If formatting fails, create a safe message
                    record.msg = f"[Logging format error prevented] Original message: {str(record.msg)[:100]}{'...' if len(str(record.msg)) > 100 else ''}, Args: {record.args}"
                    record.args = ()
            return True
        except Exception as e:
            # If anything goes wrong, allow the record through but with a safe message
            record.msg = f"[Logging filter error: {e}] Original message could not be processed safely"
            record.args = ()
            return True

class ImageDataFilter(logging.Filter):
    """
    Custom log filter for filtering log records containing image binary data
    Specifically designed to filter image data in multimodal model API calls
    """
    
    # Image data characteristic identifiers
    IMAGE_INDICATORS = [
        'data:image',           # data URL format
        'iVBORw0KGgo',         # PNG base64 beginning
        '/9j/',                # JPEG base64 beginning
        'R0lGOD',              # GIF base64 beginning
        'UklGR',               # WEBP base64 beginning
        'Qk0',                 # BMP base64 beginning
    ]
    
    # Binary file headers
    BINARY_HEADERS = [
        b'\xff\xd8\xff',       # JPEG file header
        b'\x89PNG\r\n\x1a\n',  # PNG file header
        b'GIF87a',             # GIF87a file header
        b'GIF89a',             # GIF89a file header
        b'RIFF',               # WEBP/WAV file header
        b'BM',                 # BMP file header
    ]
    
    def filter(self, record):
        """
        Filter image data from log records
        """
        try:
            # Process log message
            if hasattr(record, 'msg') and record.msg:
                record.msg = self._filter_message(record.msg)
            
            # Process log arguments
            if hasattr(record, 'args') and record.args:
                record.args = self._filter_args(record.args)
                
        except Exception as e:
            # If filtering process fails, log error but don't block log output
            record.msg = f"[Log filter error: {e}] Original message may contain image data"
            record.args = ()
        
        return True
    
    def _filter_message(self, msg):
        """
        Filter image data from messages
        """
        msg_str = str(msg)
        
        # If message is very long, it may contain image data
        if len(msg_str) > 5000:  # Lower threshold to 5KB
            # Check if contains image data characteristics
            if self._contains_image_data(msg_str):
                return f"[LLM Call Log] Contains image data (size: {len(msg_str)} characters) - filtered"
            
            # Check if contains binary data characteristics
            if self._contains_binary_data(msg_str):
                return f"[LLM Call Log] Contains binary data (size: {len(msg_str)} characters) - filtered"
        
        return msg
    
    def _filter_args(self, args):
        """
        Filter image data from arguments
        """
        filtered_args = []
        
        for arg in args:
            if isinstance(arg, (bytes, bytearray)):
                # Process binary data
                if len(arg) > 1000:  # Binary data larger than 1KB
                    if self._is_image_binary(arg):
                        filtered_args.append(f"[Image binary data filtered, size: {len(arg)} bytes]")
                    else:
                        filtered_args.append(f"[Binary data filtered, size: {len(arg)} bytes]")
                else:
                    filtered_args.append(arg)
            
            elif isinstance(arg, str):
                # Process string data
                if len(arg) > 5000:  # Strings larger than 5KB
                    if self._contains_image_data(arg):
                        filtered_args.append(f"[Image string data filtered, size: {len(arg)} characters]")
                    else:
                        filtered_args.append(arg)
                else:
                    filtered_args.append(arg)
            
            else:
                # Keep other data types directly
                filtered_args.append(arg)
        
        return tuple(filtered_args)
    
    def _contains_image_data(self, text):
        """
        Check if text contains image data
        """
        text_lower = text.lower()
        return any(indicator in text_lower for indicator in self.IMAGE_INDICATORS)
    
    def _contains_binary_data(self, text):
        """
        Check if text contains large amounts of binary data
        """
        # Check if contains large amounts of non-ASCII characters (possibly base64-encoded binary data)
        non_ascii_count = sum(1 for char in text if ord(char) > 127)
        non_ascii_ratio = non_ascii_count / len(text) if len(text) > 0 else 0
        
        # If non-ASCII character ratio exceeds 10%, it might be binary data
        return non_ascii_ratio > 0.1
    
    def _is_image_binary(self, data):
        """
        Check if binary data is an image
        """
        if len(data) < 10:
            return False
        
        # Check file headers
        for header in self.BINARY_HEADERS:
            if data.startswith(header):
                return True
        
        return False

NUM_IMAGE_TOKEN = 1105  # Value set of screen of size 1920x1080 for openai vision

def calculate_tokens(messages, num_image_token=NUM_IMAGE_TOKEN) -> Tuple[int, int]:

    num_input_images = 0
    output_message = messages[-1]

    input_message = messages[:-1]

    input_string = """"""
    for message in input_message:
        input_string += message["content"][0]["text"] + "\n"
        if len(message["content"]) > 1:
            num_input_images += 1

    input_text_tokens = get_input_token_length(input_string)

    input_image_tokens = num_image_token * num_input_images

    output_tokens = get_input_token_length(output_message["content"][0]["text"])

    return (input_text_tokens + input_image_tokens), output_tokens

def parse_dag(text):
    """
    Try extracting JSON from <json>…</json> tags first;
    if not found, try ```json … ``` Markdown fences.
    If both fail, try to parse the entire text as JSON.
    """
    logger = logging.getLogger("desktopenv.agent")

    def _extract(pattern):
        m = re.search(pattern, text, re.DOTALL)
        return m.group(1).strip() if m else None

    # 1) look for <json>…</json>
    json_str = _extract(r"<json>(.*?)</json>")
    # 2) fallback to ```json … ```
    if json_str is None:
        json_str = _extract(r"```json\s*(.*?)\s*```")
        if json_str is None:
            # 3) try other possible code block formats
            json_str = _extract(r"```\s*(.*?)\s*```")

    # 4) if still not found, try to parse the entire text
    if json_str is None:
        logger.warning("JSON markers not found, attempting to parse entire text")
        json_str = text.strip()

    # Log the extracted JSON string
    logger.debug(f"Extracted JSON string: {json_str[:100]}...")

    try:
        # Try to parse as JSON directly
        payload = json.loads(json_str)
    except json.JSONDecodeError as e:
        logger.error(f"JSON parsing error: {e}")
        
        # Try to fix common JSON format issues
        try:
            # Replace single quotes with double quotes
            fixed_json = json_str.replace("'", "\"")
            payload = json.loads(fixed_json)
            logger.info("Successfully fixed JSON by replacing single quotes with double quotes")
        except json.JSONDecodeError:
            # Try to find and extract possible JSON objects
            try:
                # Look for content between { and }
                match = re.search(r"\{(.*)\}", json_str, re.DOTALL)
                if match:
                    fixed_json = "{" + match.group(1) + "}"
                    payload = json.loads(fixed_json)
                    logger.info("Successfully fixed JSON by extracting JSON object")
                else:
                    logger.error("Unable to fix JSON format")
                    return None
            except Exception:
                logger.error("All JSON fixing attempts failed")
        return None

    # Check if payload contains dag key
    if "dag" not in payload:
        logger.warning("'dag' key not found in JSON, attempting to use entire JSON object")
        # If no dag key, try to use the entire payload
        try:
            # Check if payload directly conforms to Dag structure
            if "nodes" in payload and "edges" in payload:
                return Dag(**payload)
            else:
                # Iterate through top-level keys to find possible dag structure
                for key, value in payload.items():
                    if isinstance(value, dict) and "nodes" in value and "edges" in value:
                        logger.info(f"Found DAG structure in key '{key}'")
                        return Dag(**value)
                
                logger.error("Could not find valid DAG structure in JSON")
                return None
        except ValidationError as e:
            logger.error(f"Data structure validation error: {e}")
        return None

    # Normal case, use value of dag key
    try:
        return Dag(**payload["dag"])
    except ValidationError as e:
        logger.error(f"DAG data structure validation error: {e}")
        return None
    except Exception as e:
        logger.error(f"Unknown error parsing DAG: {e}")
        return None


def parse_single_code_from_string(input_string):
    input_string = input_string.strip()
    if input_string.strip() in ["WAIT", "DONE", "FAIL"]:
        return input_string.strip()

    pattern = r"```(?:\w+\s+)?(.*?)```"
    matches = re.findall(pattern, input_string, re.DOTALL)
    codes = []
    for match in matches:
        match = match.strip()
        commands = ["WAIT", "DONE", "FAIL"]
        if match in commands:
            codes.append(match.strip())
        elif match.split("\n")[-1] in commands:
            if len(match.split("\n")) > 1:
                codes.append("\n".join(match.split("\n")[:-1]))
            codes.append(match.split("\n")[-1])
        else:
            codes.append(match)
    if len(codes) > 0:
        return codes[0]
    # The pattern matches function calls with balanced parentheses and quotes
    code_match = re.search(r"(\w+\.\w+\((?:[^()]*|\([^()]*\))*\))", input_string)
    if code_match:
        return code_match.group(1)
    lines = [line.strip() for line in input_string.splitlines() if line.strip()]
    if lines:
        return lines[0]
    return "fail"


def get_input_token_length(input_string):
    enc = tiktoken.encoding_for_model("gpt-4")
    tokens = enc.encode(input_string)
    return len(tokens)

def parse_screenshot_analysis(action_plan: str) -> str:
    """Parse the Screenshot Analysis section from the LLM response.
    
    Args:
        action_plan: The raw LLM response text
        
    Returns:
        The screenshot analysis text, or empty string if not found
    """
    try:
        # Look for Screenshot Analysis section
        if "(Screenshot Analysis)" in action_plan:
            # Find the start of Screenshot Analysis section
            start_idx = action_plan.find("(Screenshot Analysis)")
            # Find the next section marker
            next_sections = ["(Next Action)", "(Grounded Action)", "(Previous action verification)"]
            end_idx = len(action_plan)
            for section in next_sections:
                section_idx = action_plan.find(section, start_idx + 1)
                if section_idx != -1 and section_idx < end_idx:
                    end_idx = section_idx
            
            # Extract the content between markers
            analysis_start = start_idx + len("(Screenshot Analysis)")
            analysis_text = action_plan[analysis_start:end_idx].strip()
            return analysis_text
        return ""
    except Exception as e:
        return ""

def parse_technician_screenshot_analysis(command_plan: str) -> str:
    """Parse the Screenshot Analysis section from the technician LLM response.
    
    Args:
        command_plan: The raw LLM response text
        
    Returns:
        The screenshot analysis text, or empty string if not found
    """
    try:
        # Look for Screenshot Analysis section
        if "(Screenshot Analysis)" in command_plan:
            # Find the start of Screenshot Analysis section
            start_idx = command_plan.find("(Screenshot Analysis)")
            # Find the next section marker
            next_sections = ["(Next Action)"]
            end_idx = len(command_plan)
            for section in next_sections:
                section_idx = command_plan.find(section, start_idx + 1)
                if section_idx != -1 and section_idx < end_idx:
                    end_idx = section_idx
            
            # Extract the content between markers
            analysis_start = start_idx + len("(Screenshot Analysis)")
            analysis_text = command_plan[analysis_start:end_idx].strip()
            return analysis_text
        return ""
    except Exception as e:
        return ""

def sanitize_code(code):
    # This pattern captures the outermost double-quoted text
    if "\n" in code:
        pattern = r'(".*?")'
        # Find all matches in the text
        matches = re.findall(pattern, code, flags=re.DOTALL)
        if matches:
            # Replace the first occurrence only
            first_match = matches[0]
            code = code.replace(first_match, f'"""{first_match[1:-1]}"""', 1)
    return code


def extract_first_agent_function(code_string):
    # Regular expression pattern to match 'agent' functions with any arguments, including nested parentheses
    pattern = r'agent\.[a-zA-Z_]+\((?:[^()\'"]|\'[^\']*\'|"[^"]*")*\)'

    # Find all matches in the string
    matches = re.findall(pattern, code_string)

    # Return the first match if found, otherwise return None
    return matches[0] if matches else None


def load_knowledge_base(kb_path: str) -> Dict:
    try:
        with open(kb_path, "r") as f:
            return json.load(f)
    except Exception as e:
        print(f"Error loading knowledge base: {e}")
        return {}


def clean_empty_embeddings(embeddings: Dict) -> Dict:
    to_delete = []
    for k, v in embeddings.items():
        arr = np.array(v)
        if arr.size == 0 or arr.shape == () or (
            isinstance(v, list) and v and isinstance(v[0], str) and v[0].startswith('Error:')
        ) or (isinstance(v, str) and v.startswith('Error:')):
            to_delete.append(k)
    for k in to_delete:
        del embeddings[k]
    return embeddings


def load_embeddings(embeddings_path: str) -> Dict:
    try:
        with open(embeddings_path, "rb") as f:
            embeddings = pickle.load(f)
        embeddings = clean_empty_embeddings(embeddings)
        return embeddings
    except Exception as e:
        # print(f"Error loading embeddings: {e}")
        print(f"Empty embeddings file: {embeddings_path}")
        return {}


def save_embeddings(embeddings_path: str, embeddings: Dict):
    try:
        import os
        os.makedirs(os.path.dirname(embeddings_path), exist_ok=True)
        with open(embeddings_path, "wb") as f:
            pickle.dump(embeddings, f)
    except Exception as e:
        print(f"Error saving embeddings: {e}")

def agent_log_to_string(agent_log: List[Dict]) -> str:
    """
    Converts a list of agent log entries into a single string for LLM consumption.

    Args:
        agent_log: A list of dictionaries, where each dictionary is an agent log entry.

    Returns:
        A formatted string representing the agent log.
    """
    if not agent_log:
        return "No agent log entries yet."

    log_strings = ["[AGENT LOG]"]
    for entry in agent_log:
        entry_id = entry.get("id", "N/A")
        entry_type = entry.get("type", "N/A").capitalize()
        content = entry.get("content", "")
        log_strings.append(f"[Entry {entry_id} - {entry_type}] {content}")

    return "\n".join(log_strings)


def show_task_completion_notification(task_status: str, error_message: str = ""):
    """
    Show a popup notification for task completion status.
    
    Args:
        task_status: Task status, supports 'success', 'failed', 'completed', 'error'
        error_message: Error message (used only when status is 'error')
    """
    try:
        current_platform = platform.system()
        
        if task_status == "success":
            title = "Maestro"
            message = "Task Completed Successfully"
            dialog_type = "info"
        elif task_status == "failed":
            title = "Maestro"
            message = "Task Failed/Rejected"
            dialog_type = "error"
        elif task_status == "completed":
            title = "Maestro"
            message = "Task Execution Completed"
            dialog_type = "info"
        elif task_status == "error":
            title = "Maestro Error"
            message = f"Task Execution Error: {error_message[:100] if error_message else 'Unknown error'}"
            dialog_type = "error"
        else:
            title = "Maestro"
            message = "Task Execution Completed"
            dialog_type = "info"
        
        if current_platform == "Darwin":
            # macOS
            os.system(
                f'osascript -e \'display dialog "{message}" with title "{title}" buttons "OK" default button "OK"\''
            )
        elif current_platform == "Linux":
            # Linux
            if dialog_type == "error":
                os.system(
                    f'zenity --error --title="{title}" --text="{message}" --width=300 --height=150'
                )
            else:
                os.system(
                    f'zenity --info --title="{title}" --text="{message}" --width=200 --height=100'
                )
        elif current_platform == "Windows":
            # Windows
            os.system(
                f'msg %username% "{message}"'
            )
        else:
            print(f"\n[{title}] {message}")
            
    except Exception as e:
        print(f"\n[Agents3] Failed to show notification: {e}")
        print(f"[Agents3] {message}")

def screenshot_bytes_to_pil_image(screenshot_bytes: bytes) -> Optional[Image.Image]:
    """
    Convert the bytes data of obs["screenshot"] to a PIL Image object, preserving the original size
    
    Args:
        screenshot_bytes: The bytes data of the screenshot
    
    Returns:
        PIL Image object, or None if conversion fails
    """
    try:
        # Create PIL Image object directly from bytes
        image = Image.open(io.BytesIO(screenshot_bytes))
        return image
    except Exception as e:
        raise RuntimeError(f"Failed to convert screenshot bytes to PIL Image: {e}")

