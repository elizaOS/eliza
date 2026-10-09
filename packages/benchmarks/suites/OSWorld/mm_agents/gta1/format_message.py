
import base64
import os
from typing import Dict, Any, List, Union
import numpy as np
import cv2

class FormatMessage:
    def __init__(self):
        self.text_key = "input_text"
        self.image_key = "input_image"
    
    def encode_image(self, image_content: bytes) -> str:
        return base64.b64encode(image_content).decode('utf-8')
    
    def format_image(self, image: bytes, detail: str="high") -> Dict[str, Any]:
        return {
            "type": self.image_key,
            "image_url": f"data:image/png;base64,{self.encode_image(image)}",
            "detail": detail
        }
    
    def format_text_message(self, text: str) -> Dict[str, Any]:
        return {"type": self.text_key, "text": text}
    
    def create_system_message(self, content: str) -> Dict[str, Any]:
        return {
                "role": "system",
                "content": [self.format_text_message(content)]
            }
    
    def create_user_message(self, text: str=None, image: bytes=None, detail: str="high", image_first: bool=False) -> Dict[str, Any]:
        if text is None and image is None:
            raise ValueError("At least one of text or image must be provided")
        
        content = []
        
        # Add text if provided
        if text is not None:
            content.append(self.format_text_message(text))
        
        # Add image if provided
        if image is not None:
            content.append(self.format_image(image, detail))
        
        if image_first:
            content.reverse()
        return {
            "role": "user",
            "content": content
        }
    
    def create_assistant_message(self, text: str) -> Dict[str, Any]:
        return {
                "role": "assistant",
                "content": [{"type": "output_text", "text": text}]
            }


def encode_numpy_image_to_base64(image: np.ndarray) -> str:
    # Convert numpy array to bytes
    success, buffer = cv2.imencode('.png', image)
    if not success:
        raise ValueError("Failed to encode image to png format")
    
    # Convert bytes to base64 string
    image_bytes = buffer.tobytes()
    base64_string = base64.b64encode(image_bytes).decode('utf-8')
    
    return base64_string

def encode_image_bytes(image_content):
    return base64.b64encode(image_content).decode('utf-8')