import re
from typing import Any, Dict, List

import pytesseract
from PIL import Image
import io
from mm_agents.os_symphony.core.mllm import LMMAgent
from mm_agents.os_symphony.utils.common_utils import call_llm_safe, smart_resize
from mm_agents.os_symphony.memory.procedural_memory import PROCEDURAL_MEMORY
import logging

logger = logging.getLogger("desktopenv.agent")

class GrounderAgent:
    """
    Class designed for interacting with GUI, serving for Grounding Agent and VLMSearcher
    """
    def __init__(self, engine_params: Dict, screen_width: int, screen_height: int):
        self.engine_params_for_grounder = engine_params # grounder_params
        system_prompt, self.user_message = PROCEDURAL_MEMORY.construct_grounder_procedural_memory(model_name=engine_params["model"])
        self.grounding_model = LMMAgent(engine_params, system_prompt=system_prompt)
        # Width and height for Grounding Agent!
        self.width = engine_params['grounding_width']
        self.height = engine_params['grounding_height']
        print(f"[Grounder]: initialized width is {self.width}, height is {self.height}")
        # Width and height for actual screen!
        self.screen_width = screen_width
        self.screen_height = screen_height

    # Given the state and worker's referring expression, use the grounding model to generate (x,y)
    def generate_coords(self, ref_expr: str, obs: Dict, detail=False, expansion_pixels=400, **kwargs) -> List:
        cur_screenshot = obs["screenshot"]
        
        # store global offset
        global_offset_x = 0
        global_offset_y = 0
        
        # final coordinates for output
        final_global_x = 0
        final_global_y = 0

        cur_width, cur_height = self.screen_width, self.screen_height
        
        print(f"[Grounder] start to ground!")
        self.grounding_model.reset()

        # Configure the context
        prompt = self.user_message.replace("REF_EXPR", ref_expr)

        # cosistent with the system prompt presented in the paper of GTA-1
        if 'gta' in self.engine_params_for_grounder['model']:
            self.grounding_model.add_system_prompt("You are a GUI agent. You are given a task and a screenshot of the screen. You need to perform a series of pyautogui actions to complete the task.")
        
        self.grounding_model.add_message(
            text_content=prompt, image_content=cur_screenshot, put_text_last=True, role="user"
        )

        # Generate and parse coordinates
        response = call_llm_safe(self.grounding_model, temperature=0.05, **kwargs)
        print(f"[Grounder] prompt: {prompt}\nmodel: {self.engine_params_for_grounder['model']}, \nresponse: {response}")


        # 1. highest priority: (x1="...", y1="...", x="...", y="...")
        numericals = re.findall(r'(?:x1|y1|x|y)=["\']?(\d+)["\']?', response)
        # 2. second highest priority: just like <points>653 42</points> or [653, 42]
        if len(numericals) < 2:
            clean_response = re.sub(r'[xXyY]\d', '', response)
            numericals = re.findall(r'\d+', clean_response)
        assert len(numericals) >= 2
        
        print(f"[Grounder] the parsed coordinates: {numericals}")

        local_x, local_y = self._resize_coordinates([int(numericals[0]), int(numericals[1])], width=cur_width, height=cur_height)
        
        # current global coordinates = local ordinates + global offset 
        final_global_x = local_x + global_offset_x
        final_global_y = local_y + global_offset_y

        if detail:
            return [cur_screenshot, global_offset_x, global_offset_y]
        else:
            return [final_global_x, final_global_y]
    
    def dynamic_set_width_height(self, width: int, height: int):
        self.width = width
        self.height = height
        
    # Resize from grounding model dim into OSWorld dim (1920 * 1080)
    def _resize_coordinates(self, coordinates: List[int], width:int, height:int) -> List[int]:
        """
            width, height: for current observation
            grounding_width, grounding_height: width and height for Grounding model 1000x1000 or 1280x800)
        """
        grounding_width = self.engine_params_for_grounder["grounding_width"]
        grounding_height = self.engine_params_for_grounder["grounding_height"]
        grounding_smart_resize = self.engine_params_for_grounder["grounding_smart_resize"]

        
        if not grounding_smart_resize:
            return [
                round(coordinates[0] * width / grounding_width),
                round(coordinates[1] * height / grounding_height),
            ]
        else:
            smart_height, smart_width = smart_resize(height, width)
            return [
                round(coordinates[0] * width / smart_width),
                round(coordinates[1] * height / smart_height)
            ]
