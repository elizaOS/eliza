from ast import parse
import logging
import json
from typing import List, Dict, Any, Optional, Tuple
from mm_agents.os_symphony.utils.common_utils import (
    call_llm_formatted,
    enhance_observation,
    parse_code_from_string
)
from functools import partial
from mm_agents.os_symphony.utils.formatters import JSON_ANSWER_FORMATTER
from mm_agents.os_symphony.core.mllm import LMMAgent
from mm_agents.os_symphony.memory.procedural_memory import PROCEDURAL_MEMORY
import imagehash
import io
import os
from PIL import Image
import numpy as np
from skimage.metrics import structural_similarity as ssim

logger = logging.getLogger("desktopenv.agent")


class StepBehavior:
    """
    Narrative Step Behavior.
    Description of each step, cosists of generative agent (main agent)'s output, screenshot (if this step is milestone), and textual description.
    The textual description shows that how the agent thought and did, and how the state changes. 
    """
    def __init__(self, is_milestone: bool, gen_output: str, summary: str, obs: Dict, action_dict: Dict):
        self.is_milestone = is_milestone
        self.gen_output = gen_output
        self.obs = obs
        self.summary = summary
        self.action_dict = action_dict
        # Variants for opyimizing the time complexity of loop detection
        # --- 1. pHash ---
        self.phash = None
        # --- 2. SSIM ---
        self.ssim_list = []
    
    def _update_phash_ssim(self, history: List):
        # Calculate the ssim_list of current obs
        # Update pHash
        cur_img = Image.open(io.BytesIO(self.obs["screenshot"]))
        cur_img_gray = cur_img.convert('L')
        cur_img_np = np.array(cur_img_gray)
        self.phash = imagehash.phash(cur_img)
        # Update ssim_list
        for hs in history:
            compare_img = Image.open(io.BytesIO(hs.obs["screenshot"]))
            compare_img_gray = compare_img.convert('L')
            compare_img_np = np.array(compare_img_gray)
            self.ssim_list.append(ssim(cur_img_np, compare_img_np, data_range=cur_img_np.max() - compare_img_np.min()))

class ReflectionMemoryAgent:
    """
    Reflection Memory Agent (RMA).
    Responsible for maintaining long-term memory, extracting narratives from trajectories,
    providing reflections to the Main Agent, and validating task completion status.
    """
    def __init__(self, engine_params: Dict):
        """
        Initialize the RMA.

        Args:
        - engine_params: 
            {
                "engine_type": args.provider,
                "model": args.model,
                "base_url": args.model_url,
                "api_key": args.model_api_key,
                "temperature": getattr(args, "model_temperature", None),
            }
        - max_img_len: max image number to use in reflection process
        """

        self.engine_params = engine_params

        self.max_images = engine_params.get('max_images', 8)

        self.memoryer_level = engine_params.get('memoryer_level', 3)
        
        self.reset()

        logger.info(f"ReflectionMemoryAgent initialized with:\n {self.engine_params}")
        

    def reset(self):
        """Reset the code agent state."""
        logger.debug("Resetting RMA state")

        self.instruction = None

        self.trajectory: List[StepBehavior] = []

        self.knowledge_base: List[str] = []

        self.last_code_step_idx = -1        

        '''
        Control the count of images, we only use the maximum number of max_img_len images.
        The update logic: the 0-th screenshot is always retained. If the total number of screenshots is less than max_img_len, all are kept; otherwise, starting from index 1, milestone screenshots are managed via FIFO.
        '''
        self.active_img_idx = []        

        self.reflection_agent = LMMAgent(
            engine_params=self.engine_params,
            system_prompt=PROCEDURAL_MEMORY.REFLECTION_SYSTEM_PROMPT,
        )
        self.behavior_agent = LMMAgent(
            engine_params=self.engine_params,
            system_prompt=PROCEDURAL_MEMORY.SUMMARIZE_STEP_SYSTEM_PROMPT
        )
    
    def add_instruction(self, instruction):
        """
        [Interface] Main -> RMA
        Main agent set the instruction to RMA.
        """
        self.instruction = instruction

    def _update_trajectory(self, step_behavior):
        self.trajectory.append(step_behavior)
        if len(self.active_img_idx) >= self.max_images:
            if step_behavior.is_milestone:
                self.active_img_idx.append(len(self.trajectory) - 1)      # over max_img_len，only milestone image
                del self.active_img_idx[1]          # FIFO starts from index 1
        else:
            self.active_img_idx.append(len(self.trajectory) - 1)        # less than max_img_len, feed all images
            
        assert len(self.active_img_idx) <= self.max_images, "[RMA] Errors in updating StepBehavior!!"

    def _summarize_step_behavior(
            self, 
            generator_output: str, 
            cur_obs: Dict, 
            enhanced_obs: bytes | None, 
            is_milestone: bool,
            mode: str = "gui",
            code_exec_summary: str = "",
            action_dict: Dict = {}
        ) -> Tuple[StepBehavior, bool]:
        """
        [Interface] Main -> RMA
        The Main Agent (MA) calls this method to "feed" the information of the just-completed step to the RMA.
        RMA will internally process and store this step.
        """

        if mode == "search":
            is_success = "successful"
            # summary is fixed
            step_behavior = StepBehavior(
                False, 
                generator_output,
                "Search Agent was called last step, and a tutorial has been generated.", 
                cur_obs,
                action_dict
            )
        elif mode == "code":
            self.last_code_step_idx = len(self.trajectory)

            is_success = "successful"
            # the summary returned by the code agent
            step_behavior = StepBehavior(
                False, 
                generator_output,
                f"Code Agent was called last step, and the summary of its trajectory is: \n---\n{code_exec_summary}\n---", 
                cur_obs,
                action_dict
            )
        else:       # common gui operation, use LLM to summarize
            prev_obs = self.trajectory[-1].obs

            text_content = f"""Computer Use Agent's Output: \n{generator_output}"""
            
            
            self.behavior_agent.reset()     # don't need history messages
            
            updated_sys_prompt = (
                self.behavior_agent.system_prompt + "\n" + text_content
            )
            self.behavior_agent.add_system_prompt(updated_sys_prompt)

            self.behavior_agent.add_message(
                text_content="This is the observation before executing action (attached below).",
                image_content=prev_obs['screenshot'],
                role="user",
                put_text_last=False
            )
            self.behavior_agent.add_message(
                text_content="This is the zoom-in view, which may help you to identify the operational region (attached below).",
                image_content=enhanced_obs,
                role="user",
                put_text_last=False
            )
            self.behavior_agent.add_message(
                text_content="This is the observation after executing action (attached below).",
                image_content=cur_obs['screenshot'],
                role="user", 
                put_text_last=False
            )

            required_fields = ["summary", "evaluation"]
            format_checkers = [
                partial(JSON_ANSWER_FORMATTER, required_fields)
            ]

            full_response = call_llm_formatted(
                self.behavior_agent,
                format_checkers,
                temperature=self.engine_params.get("temperture", 0.1),
            )

            response = parse_code_from_string(full_response)

            try:
                data = json.loads(response)
                behavior_summary = data['summary']
                is_success = data["evaluation"]
            except Exception as e:
                print("[RMA] Errors in generating step summary: ", e)
                logger.info("Response is not a JSON object or miss required keys!")
                behavior_summary = response          
                is_success = "successful"


            step_behavior = StepBehavior(is_milestone, generator_output, behavior_summary, cur_obs, action_dict)

        return step_behavior, is_success == "successful"

    def get_reflection(
            self, 
            cur_obs: Dict, 
            generator_output: str, 
            coordinates: List, 
            mode: str="gui", 
            code_exec_summary: str = "",
            action_dict: Dict = {}
        ) -> Dict:
        """
        [Interface] RMA -> Main
        The Main Agent (MA) calls this method to get RMA's reflection before deciding the next action.
        
        Args:
        - cur_obs (Dict): The Main Agent's current observation (o_k).
        - generator_output (str): The thoughts, screen analysis and action of Main Agent.
        - coordinates (List): coordinates in the last operation step of Main Agent.
        - mode(str): [gui, code, search]. Indicate which agent that main agent called last step.
        - code_exec_summary: execution summary for code agent.
        - action_dict: extracted action from generator output.
        
        Returns:
        - reflection_info(Dict): all the info related to reflection
        """   
        if self.memoryer_level == 0:
            return {
                "reflection": None,
                "reflection_thoughts": None,
                "existing_knowledge": None,
                "is_milestone": False,
                "new_knowledge": None,
                "step_summary": None,
                "hint": {
                    "gui_operation_error": False,
                    "lack_of_tutorial": False,
                    "code_error": False,
                    "loop_detection": None,
                }
            } 

        reflection = None
        reflection_thought = None
        if len(self.trajectory) == 0:
            step_behavior = StepBehavior(
                True, 
                "The initial screen is provided. No action has been taken yet.",
                "The initial screen is provided. No action has been taken yet.", 
                cur_obs,
                action_dict
            )
            step_behavior._update_phash_ssim(self.trajectory)
            self._update_trajectory(step_behavior)
            reflection_info = {
                "reflection": reflection,
                "reflection_thoughts": reflection_thought,
                "existing_knowledge": "\n".join(self.knowledge_base),
                "is_milestone": True,
                "new_knowledge": "",
                "step_summary": "",
                "loop_detection": None
            } 
        else: 
            ### Step Summary
            prev_obs = self.trajectory[-1].obs
            enhanced_obs = None
            if coordinates:
                enhanced_obs, _, _, _, _ = enhance_observation(
                    prev_obs["screenshot"], 
                    coordinates,
                    draw=True
                )
        
            # generate step behavior
            step_behavior, last_gui_check = self._summarize_step_behavior(
                generator_output, 
                cur_obs, 
                enhanced_obs, 
                False, 
                mode, 
                code_exec_summary, 
                action_dict
            )    
            step_behavior._update_phash_ssim(self.trajectory)
            
            ### make additional hints
            additional_hints = []
            if not last_gui_check:
                additional_hints.append(f"\t- Warning: The last GUI operation is unsuccessful. Careful review is required to avoid GUI Operation Error.")

            code_error_hint = False

            if self.last_code_step_idx != -1 and len(self.trajectory) - self.last_code_step_idx < 0:
                code_error_hint = True
                additional_hints.append(f"\t- Warning: The Computer Use Agent might in the verification stage of Code Agent. Careful review is required to avoid Code Error.")
                
            # loop detection
            from mm_agents.os_symphony.utils.loop_detection import detect_loop
            is_loop, loop_details = detect_loop(full_trajectory=self.trajectory, N=3)
            if is_loop and loop_details:
                match_sequence_indices = loop_details["match_sequence_indices"]
                loop_hint_message = f"\t- Warning: A potential LOOP has been detected between Step {match_sequence_indices[0]} and Step {match_sequence_indices[-1]}. Careful review is required to avoid Repetitive Behavior Error."
                additional_hints.append(loop_hint_message)

            self.reflection_agent.reset()

            updated_sys_prompt = (
                PROCEDURAL_MEMORY.REFLECTION_SYSTEM_PROMPT + "\n\n" + 
                f"---\n- **user instruction**: {self.instruction}\n" + 
                "- **existing knowledge**: \n" + "\n".join(self.knowledge_base) + 
                "\n- **additional_hints**: " + "\n".join(additional_hints) + "\n---"
            )

            # update system prompt
            self.reflection_agent.add_system_prompt(updated_sys_prompt)

            
            for i, step in enumerate(self.trajectory):
                text_content = f"""### (Step {i}) history:\nsummary: '''\n{step.summary}\n'''"""
                if i in self.active_img_idx:
                    if i == 0:
                        text_content += f"\ninitial screenshot:"
                    else: 
                        text_content += f"\nscreenshot (after executing action): (attached below)"

                self.reflection_agent.add_message(
                    text_content=text_content,
                    image_content=step.obs['screenshot'] if i in self.active_img_idx else None,     
                    role="user",
                    put_text_last=False
                )
                    
            text_content = f"""### (Last Step) CUA's output (has been finished):\n---\n{generator_output}\n---\nStep Summary:\n---\n{step_behavior.summary}\n---\nlatest_screenshot:  (attached below)"""
            self.reflection_agent.add_message(
                text_content=text_content,
                image_content=cur_obs['screenshot'],
                role="user",
                put_text_last=False
            )
            
            required_fields = ["is_milestone", "reflection", "knowledge"]
        
            format_checkers = [
                partial(JSON_ANSWER_FORMATTER, required_fields)
            ]

            full_response = call_llm_formatted(
                self.reflection_agent,
                format_checkers
            )


            reflection_thought = full_response    

            response = parse_code_from_string(full_response)
            
            try:
                data = json.loads(response)
                reflection = data['reflection']
                is_milestone = data["is_milestone"]
                knowledge = data['knowledge']
            except Exception as e:
                print("[RMA] Errors in dealing with reflection: ", e)
                logger.info("Response is not a JSON object or miss required keys!")
                reflection = response       
                is_milestone = False
                knowledge = ""

            if len(knowledge) > 0:
                self.knowledge_base.append(knowledge)
            
            if isinstance(is_milestone, str):
                is_milestone = True if "true" in is_milestone.lower() else False
            
            # update trajectory and is_milestone
            self._update_trajectory(step_behavior)
            if mode == "gui":       # only gui opration can be considered as milestone
                self.trajectory[-1].is_milestone = is_milestone
            

            reflection_info = {
                "reflection": reflection,
                "reflection_thoughts": reflection_thought,
                "existing_knowledge": "\n".join(self.knowledge_base),
                "is_milestone": is_milestone,
                "new_knowledge": knowledge,
                "step_summary": step_behavior.summary,
                "hint": {
                    "gui_operation_error": not last_gui_check,
                    "lack_of_tutorial": is_loop,
                    "code_error": code_error_hint, 
                    "loop_detection": loop_details,
                }
            }
            
        return reflection_info
    
    