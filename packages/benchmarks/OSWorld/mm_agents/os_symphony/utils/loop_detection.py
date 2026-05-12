import io
import math
import numpy as np
from typing import List, Tuple, Dict, Any, Optional

from PIL import Image, ImageDraw, ImageFont
from rapidfuzz import fuzz
import logging
from mm_agents.os_symphony.agents.memoryer_agent import StepBehavior

logger = logging.getLogger("desktopenv.loop_detection")

def _are_actions_similar(
    action1: Dict[str, Any],
    action2: Dict[str, Any],
    image_width: int,
    image_height: int,
    relative_coord_threshold: float,
    fuzzy_text_threshold: float,
) -> bool:
    """
    [Internal Auxiliary] Determine if two actions are similar based on detailed rules.

    Args:
        action1: The first action.
        action2: The second action.
        image_width: The width of the screenshot.
        image_height: The height of the screenshot.
        relative_coord_threshold: A relative distance threshold for coordinate comparison.
        fuzzy_text_threshold: A similarity threshold (0-100) for fuzzy text matching.

    Returns:
        Return True if the actions are similar, otherwise return False.
    """
    # ensure same action
    if action1.get("function") != action2.get("function"):
        return False

    func = action1.get("function")
    args1 = action1.get("args", {})
    args2 = action2.get("args", {})

    diagonal = math.sqrt(image_width**2 + image_height**2)
    abs_coord_thresh = relative_coord_threshold * diagonal

    def are_coords_close(x1, y1, x2, y2):
        if None in [x1, y1, x2, y2]: return False
        distance = math.sqrt((x1 - x2)**2 + (y1 - y2)**2)
        return distance < abs_coord_thresh

    if func == "click":
        return (
            are_coords_close(args1.get("x"), args1.get("y"), args2.get("x"), args2.get("y")) and
            args1.get("button") == args2.get("button") and
            args1.get("clicks") == args2.get("clicks")
        )

    elif func == "open":
        return args1.get("name") == args2.get("name")

    elif func == "type":
        if args1.get("x") and args1.get("y") and args2.get("x") and args2.get("y"):
            return (
                are_coords_close(args1.get("x"), args1.get("y"), args2.get("x"), args2.get("y")) and
                args1.get("text") == args2.get("text")
            )
        else:
            return args1.get("text") == args2.get("text")

    elif func == "drag":
        return (
            are_coords_close(args1.get("x1"), args1.get("y1"), args2.get("x1"), args2.get("y1")) and
            are_coords_close(args1.get("x2"), args1.get("y2"), args2.get("x2"), args2.get("y2"))
        )

    elif func == "set_cell_values":
        return args1.get("text") == args2.get("text")

    elif func == "scroll":
        clicks1 = args1.get("clicks", 0)
        clicks2 = args2.get("clicks", 0)
        if (clicks1 == 0 and clicks2 != 0) or (clicks1 != 0 and clicks2 == 0):
            same_direction = False
        else: 
            same_direction = math.copysign(1, clicks1) == math.copysign(1, clicks2)

        return (
            are_coords_close(args1.get("x"), args1.get("y"), args2.get("x"), args2.get("y")) and
            same_direction and
            args1.get("shift") == args2.get("shift")
        )

    elif func == "key":
        return args1.get("keys") == args2.get("keys")

    elif func == "wait":
        return True  

    elif func in ["call_code_agent", "call_search_agent"]:
        query1 = args1.get("query", "")
        query2 = args2.get("query", "")
        # use Levenshtein distance to calculate fuzzy similarity
        query_similarity = fuzz.token_set_ratio(query1, query2) 
        # print(f'query_sim: {query_similarity}')
        return (
            query_similarity >= fuzzy_text_threshold and
            args1.get("result") == args2.get("result")
        )

    else:
        return False


def _are_steps_similar_optimized(
    step1: StepBehavior,
    step2: StepBehavior,
    idx1: int,
    idx2: int,
    full_trajectory: List[StepBehavior],
    phash_threshold: int,
    ssim_threshold: float,
    # 动作比较所需的参数
    image_width: int,
    image_height: int,
    relative_coord_threshold: float,
    fuzzy_text_threshold: float,
) -> bool:
    """
    [Internal Auxiliary] use pre-calculated data to quickly determine if the two actions are similar/
    """
    
    if step1.phash is None or step2.phash is None:
        return False 

    if (step1.phash - step2.phash) > phash_threshold:
        return False

    
    later_step_idx = max(idx1, idx2)
    earlier_step_idx = min(idx1, idx2)
    
    ssim_score = full_trajectory[later_step_idx].ssim_list[earlier_step_idx]
    
    if ssim_score < ssim_threshold:
        return False

    if not _are_actions_similar(
        step1.action_dict, step2.action_dict,
        image_width, image_height, relative_coord_threshold, fuzzy_text_threshold
    ):
        return False

    return True


def detect_loop(
    full_trajectory: List[StepBehavior],
    image_width: int = 1920,
    image_height: int = 1080,
    N: int = 3,
    phash_threshold: int = 1,
    ssim_threshold: float = 0.99,
    relative_coord_threshold: float = 0.02,
    fuzzy_text_threshold: float = 85.0,
) -> Tuple[bool, Optional[Dict[str, List[int]]]]:
    """
    Efficiently detect the presence of looping patterns based on precomputed data.

    Args:
        full_trajectory (List[StepBehavior]): Full history including the current step.
        image_width (int): Width of the screenshot.
        image_height (int): Height of the screenshot.
        N (int): Number of steps in the candidate loop (sequence length).
        phash_threshold (int): Hamming distance threshold for pHash similarity. Recommended: 0–2.
        ssim_threshold (float): SSIM similarity threshold for image comparison. Recommended: 0.95–0.99.
        relative_coord_threshold (float): Relative threshold for coordinate similarity. Recommended: 0.01–0.05.
        fuzzy_text_threshold (float): Fuzzy text matching similarity threshold (0–100) for agent queries.

    Returns:
        A tuple (is_loop_detected, loop_info):
        - is_loop_detected (bool): Whether a loop is detected.
        - loop_info (Dict | None): If a loop is detected, contains the indices of the two matching sequences.
    """
    L = len(full_trajectory)

    if not isinstance(N, int) or N <= 0 or L < 2 * N:
        return False, None

    max_start_index = L - 2 * N
    for i in range(max_start_index, -1, -1):
        is_potential_match = True
        
        for j in range(N):
            idx_prev = i + j
            idx_curr = (L - N) + j
            
            step_prev = full_trajectory[idx_prev]
            step_curr = full_trajectory[idx_curr]
            
            if not _are_steps_similar_optimized(
                step_prev, step_curr, idx_prev, idx_curr, full_trajectory,
                phash_threshold, ssim_threshold,
                image_width, image_height, relative_coord_threshold, fuzzy_text_threshold
            ):
                is_potential_match = False
                break
        
        if is_potential_match:
            previous_sequence_indices = list(range(i, i + N))
            loop_info = {
                "match_sequence_indices": previous_sequence_indices
            }
            return True, loop_info

    return False, None

