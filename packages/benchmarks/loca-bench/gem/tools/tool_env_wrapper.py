# Copyright 2025 AxonRL Team. All Rights Reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from typing import Any, List, Optional, SupportsFloat, Tuple

from gem.core import Env, EnvWrapper
from gem.tools.base_tool import BaseTool
import json

class ToolEnvWrapper(EnvWrapper):
    def __init__(
        self,
        env: Env,
        tools: List[BaseTool],
        tool_reward: float = 0.0,
        tool_success_reward: float = 0.0,
        tool_execute_error_reward: float = 0.0,
        max_tool_uses: Optional[int] = 10,
    ):
        super().__init__(env)
        self.tools = tools
        self.tool_reward = tool_reward
        self.tool_success_reward = tool_success_reward
        self.tool_execute_error_reward = tool_execute_error_reward
        if self.tool_execute_error_reward != 0:
            assert self.tool_execute_error_reward < 0, "Error reward should be negative"
            assert (
                self.tool_reward == 0
            ), "tool reward is not compatible with tool execute error reward"
            assert (
                self.tool_success_reward == 0
            ), "tool success reward is not compatible with tool execute error reward"

        self.max_tool_uses = (
            max_tool_uses if max_tool_uses is not None else float("inf")
        )
        self.tool_use_counter = 0
        self.tool_success_counter = 0

    def reset(self, seed: Optional[int] = None, **kwargs) -> Tuple[str, dict[str, Any]]:
        prev_ep_tool_uses = self.tool_use_counter
        prev_ep_tool_success = self.tool_success_counter
        self.tool_use_counter = 0
        self.tool_success_counter = 0
        obs, info = self.env.reset(seed=seed, **kwargs)
        tool_instructions = "\n".join(
            [tool.instruction_string() for tool in self.tools]
        )
        if len(self.tools) > 1:
            tool_instructions = f"Available tools:\n{tool_instructions}"
        obs = f"{obs}\n{tool_instructions}"
        info["tool_use_counter"] = self.tool_use_counter
        info["prev_ep_tool_use_counter"] = prev_ep_tool_uses
        info["tool_success_counter"] = self.tool_success_counter
        info["prev_ep_tool_success_counter"] = prev_ep_tool_success
        info["use_tool"] = False  # The initial context is not a tool result
        return obs, info

    def step(
        self,
        action: str,
        verbose: bool = False,
    ) -> Tuple[str, SupportsFloat, bool, bool, dict[str, Any]]:
        # try to execute the action with each tool
        tool_parsed = False
        if self.tool_use_counter < self.max_tool_uses:
            for tool in self.tools:
                tool_parsed, tool_execute_error, observation, parsed_action = (
                    tool.execute_action(action)
                )
                if tool_parsed and (not tool_execute_error):
                    break

        reward = 0
        if tool_parsed:
            self.tool_use_counter += 1
            if self.tool_use_counter == self.max_tool_uses:
                observation = f"{observation}\n\nReached the maximum number of tool use. Please output final answer directly."
            reward += self.tool_reward
            terminated, truncated = False, False
            info = {"parsed_action": parsed_action, "tool_type": tool.tool_type}
            if verbose:
                print(
                    f"Tool parsed: {tool.name}, tool use count: {self.tool_use_counter}"
                )
            if not tool_execute_error:
                self.tool_success_counter += 1
                reward += self.tool_success_reward
                if verbose:
                    print(
                        f"Tool executed: {tool.name}, tool use count: {self.tool_use_counter}"
                    )
            elif self.tool_execute_error_reward != 0:
                reward = self.tool_execute_error_reward
        
            info["use_tool"] = True
            
        # if no tool was executed, step the environment
        else:
            observation, reward, terminated, truncated, info = self.env.step(action)
            info["use_tool"] = False
            
        info["tool_use_counter"] = self.tool_use_counter
        info["tool_success_counter"] = self.tool_success_counter
        
        return observation, reward, terminated, truncated, info

    def get_state(self) -> dict[str, Any]:
        state = self.env.get_state()
        state["tool_use_counter"] = self.tool_use_counter
        state["tool_success_counter"] = self.tool_success_counter
        return state

    def set_state(self, state: dict[str, Any]) -> None:
        self.env.set_state(state)
        self.tool_use_counter = state.get("tool_use_counter", 0)
        self.tool_success_counter = state.get("tool_success_counter", 0)



class ToolEnvWrapperClaimDone(EnvWrapper):
    """Wrapper that handles claim_done tool specially by calling env.step()"""
    
    def __init__(
        self,
        env: Env,
        tools: List[BaseTool],
        tool_reward: float = 0.0,
        tool_success_reward: float = 0.1,
        max_tool_uses: Optional[int] = 10,
    ):
        super().__init__(env)
        self.tools = tools
        self.tool_reward = tool_reward
        self.tool_success_reward = tool_success_reward
        self.max_tool_uses = (
            max_tool_uses if max_tool_uses is not None else float("inf")
        )
        self.tool_use_counter = 0
        self.tool_success_counter = 0

    def reset(self, seed: Optional[int] = None) -> Tuple[str, dict[str, Any]]:
        prev_ep_tool_uses = self.tool_use_counter
        prev_ep_tool_success = self.tool_success_counter
        self.tool_use_counter = 0
        self.tool_success_counter = 0
        obs, info = self.env.reset(seed=seed)
        tool_instructions = "\n".join(
            [tool.instruction_string() for tool in self.tools]
        )
        if len(self.tools) > 1:
            tool_instructions = f"Available tools:\n{tool_instructions}"
        obs = f"{obs}\n{tool_instructions}"
        info["tool_use_counter"] = self.tool_use_counter
        info["prev_ep_tool_use_counter"] = prev_ep_tool_uses
        info["tool_success_counter"] = self.tool_success_counter
        info["prev_ep_tool_success_counter"] = prev_ep_tool_success
        info["use_tool"] = False  # The initial context is not a tool result
        return obs, info

    def step(
        self,
        action: str,
        verbose: bool = False,
    ) -> Tuple[str, SupportsFloat, bool, bool, dict[str, Any]]:
        # try to execute the action with each tool
        tool_parsed = False
        claim_done_tool = None
        claim_done_observation = None
        claim_done_parsed_action = None
        
        if self.tool_use_counter < self.max_tool_uses:
            for tool in self.tools:
                tool_parsed, tool_execute_error, observation, parsed_action = (
                    tool.execute_action(action)
                )

                print(f"Tool parsed: {tool.tool_type}, tool use count: {self.tool_use_counter}")
                print(f"Tool execute error: {tool_execute_error}")
                print(f"Observation: {observation}")
                print(f"Parsed action: {parsed_action}")
                if tool_parsed and (not tool_execute_error):
                    # Check if this is the claim_done tool
                    if tool.tool_type == "claim_done" or "claim_done" in tool.tool_type:
                        claim_done_tool = tool
                        claim_done_observation = observation
                        claim_done_parsed_action = parsed_action
                    break

        reward = 0
        if tool_parsed:
            self.tool_use_counter += 1
            
            # If claim_done was called, execute env.step first
            if claim_done_tool is not None:
                # Execute the environment step to signal completion
                env_observation, env_reward, terminated, truncated, info = self.env.step(action)
                
                # Then use the claim_done tool's observation
                observation = claim_done_observation
                reward = env_reward + self.tool_reward
                info["parsed_action"] = claim_done_parsed_action
                info["tool_type"] = claim_done_tool.tool_type
                info["env_observation"] = env_observation  # Store env response
                
                if verbose:
                    print(f"Claim done tool detected - executed env.step()")
                    print(f"Tool use count: {self.tool_use_counter}")
                
                self.tool_success_counter += 1
                reward += self.tool_success_reward
            else:
                # Normal tool execution (not claim_done)
                if self.tool_use_counter == self.max_tool_uses:
                    observation = f"{observation}\n\nReached the maximum number of tool use. Please output final answer directly."
                reward += self.tool_reward
                terminated, truncated = False, False
                info = {"parsed_action": parsed_action, "tool_type": tool.tool_type}
                if verbose:
                    print(
                        f"Tool parsed: {tool.tool_type}, tool use count: {self.tool_use_counter}"
                    )
                if not tool_execute_error:
                    self.tool_success_counter += 1
                    reward += self.tool_success_reward
                    if verbose:
                        print(
                            f"Tool executed: {tool.tool_type}, tool use count: {self.tool_use_counter}"
                        )
        # if no tool was executed, step the environment
        else:
            observation, reward, terminated, truncated, info = self.env.step(action)

        info["tool_use_counter"] = self.tool_use_counter
        info["tool_success_counter"] = self.tool_success_counter
        info["use_tool"] = tool_parsed
        return observation, reward, terminated, truncated, info

    def get_state(self) -> dict[str, Any]:
        state = self.env.get_state()
        state["tool_use_counter"] = self.tool_use_counter
        state["tool_success_counter"] = self.tool_success_counter
        return state

    def set_state(self, state: dict[str, Any]) -> None:
        self.env.set_state(state)
        self.tool_use_counter = state.get("tool_use_counter", 0)
        self.tool_success_counter = state.get("tool_success_counter", 0)


class ToolEnvWrapperOpenAI(EnvWrapper):
    """Wrapper that handles claim_done tool specially by calling env.step()"""
    
    def __init__(
        self,
        env: Env,
        tools: List[BaseTool],
        tool_reward: float = 0.0,
        tool_success_reward: float = 0.1,
        max_tool_uses: Optional[int] = 10,
    ):
        super().__init__(env)
        self.tools = tools
        self.tool_reward = tool_reward
        self.tool_success_reward = tool_success_reward
        self.max_tool_uses = (
            max_tool_uses if max_tool_uses is not None else float("inf")
        )
        self.tool_use_counter = 0
        self.tool_success_counter = 0

    def reset(self, seed: Optional[int] = None) -> Tuple[str, dict[str, Any]]:
        prev_ep_tool_uses = self.tool_use_counter
        prev_ep_tool_success = self.tool_success_counter
        self.tool_use_counter = 0
        self.tool_success_counter = 0
        obs, info = self.env.reset(seed=seed)
        user_prompt = obs
        print("--------------------------------")
        print(self.tools)
        tool_instructions = "\n".join(
            [tool.instruction_string() for tool in self.tools]
        )

        tool_functions = [tool.get_tool_function() for tool in self.tools]
        if len(self.tools) > 1:
            tool_instructions = f"Available tools:\n{tool_instructions}"
        obs = f"{obs}\n{tool_instructions}"
        info["tool_use_counter"] = self.tool_use_counter
        info["prev_ep_tool_use_counter"] = prev_ep_tool_uses
        info["tool_success_counter"] = self.tool_success_counter
        info["prev_ep_tool_success_counter"] = prev_ep_tool_success
        info["use_tool"] = False  # The initial context is not a tool result
        return obs, info, user_prompt, tool_functions

    def step_openai(
        self, 
        action: dict[str, Any], 
        verbose: bool = False,
    ) -> Tuple[str, SupportsFloat, bool, bool, dict[str, Any]]:
        tool_parsed = False
        
        # Handle error responses
        if action["type"] == "error":
            error_msg = action.get("data", ["Unknown error"])[0] if action.get("data") else "Unknown error"
            observation = json.dumps([{"role": "assistant", "content": f"API Error: {error_msg}"}])
            reward = 0.0
            terminated = True  # Terminate on API errors
            truncated = False
            info = {"tool_type": "error", "error_message": error_msg}
            if verbose:
                print(f"Error response received: {error_msg}")
            info["tool_use_counter"] = self.tool_use_counter
            info["tool_success_counter"] = self.tool_success_counter
            info["use_tool"] = False
            return observation, reward, terminated, truncated, info
        
        if action["type"] == "tool":
            # Initialize variables
            tool_result = []
            tool_list = []
            
            # Parse all tool calls from the action
            for tool_call in action['data']:
                func_name = tool_call['function']['name']
                tool_call_id = tool_call['id']
                # Debug: print(f"Tool call: {tool_call}")
                try:
                    # Check if arguments key exists
                    if 'arguments' not in tool_call['function']:
                        # If no arguments key, use empty dict
                        func_args = {}
                        #tool_call['function']['arguments'] = "{}"
                    # If arguments is already a dict, use it directly
                    elif isinstance(tool_call['function']['arguments'], dict):
                        func_args = tool_call['function']['arguments']
                    else:
                        # Otherwise, parse the JSON string
                        func_args = json.loads(tool_call['function']['arguments'])
                        # Store the parsed dict back to ensure consistency
                        #tool_call['function']['arguments'] = func_args
                except json.JSONDecodeError as e:
                    print(f"ERROR: Failed to parse tool arguments (JSON decode error): {e}")
                    print(f"Tool name: {func_name}")
                    print(f"Arguments type: {type(tool_call['function']['arguments'])}")
                    # Show first and last 200 chars to help diagnose truncation
                    args_str = str(tool_call['function']['arguments'])
                    print(f"Arguments length: {len(args_str)} characters")
                    print(f"Arguments start: {args_str[:200]}")
                    if len(args_str) > 400:
                        print(f"Arguments end: ...{args_str[-200:]}")
                    else:
                        print(f"Arguments full: {args_str}")
                    
                    # Check if it looks like truncation
                    error_msg = str(e)
                    if "Unterminated string" in error_msg or "Expecting" in error_msg:
                        error_msg = f"[Tool execution failed: Arguments appear to be truncated. This usually means the model response exceeded max_tokens limit. Original error: {str(e)}]"
                    else:
                        error_msg = f"[Tool execution failed: Invalid JSON format - {str(e)}]"
                    
                    # Add error result for this tool call
                    tool_result.append({
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": error_msg
                    })
                    continue
                except Exception as e:
                    print(f"ERROR: Failed to parse tool arguments (unexpected error): {e}")
                    print(f"Arguments value: {tool_call['function']['arguments']}")
                    print(f"Arguments type: {type(tool_call['function']['arguments'])}")
                    # Add error result for this tool call
                    tool_result.append({
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": f"[Tool execution failed: Invalid arguments format - {str(e)}]"
                    })
                    continue
                tool_list.append({'name': func_name, 'args': func_args, 'tool_call_id': tool_call_id})
            
            # Initialize more variables
            claim_done_tool = None
            claim_done_observation = None
            claim_done_parsed_action = None
            
            # Track the last successfully executed tool
            last_executed_tool = None
            
            # Execute each tool call
            if self.tool_use_counter < self.max_tool_uses:
                for tool_call_request in tool_list:
                    tool_name = tool_call_request['name']
                    tool_args = tool_call_request['args']
                    tool_call_id = tool_call_request['tool_call_id']
                    
                    # Find the matching tool and execute it
                    tool_executed = False
                    for tool in self.tools:
                        tool_parsed, tool_execute_error, observation, returned_tool_name, returned_tool_call_id = (
                            tool.execute_tool(tool_name, tool_args, tool_call_id)
                        )
                        
                        if tool_parsed:
                            tool_executed = True
                            last_executed_tool = tool  # Track the last executed tool
                            tool_result.append({
                                "role": "tool", 
                                "tool_call_id": returned_tool_call_id, 
                                "content": observation
                            })
                            self.tool_use_counter += 1
                            
                            # Check if this is a claim_done tool
                            if tool_parsed and (not tool_execute_error):
                                if "claim_done" in returned_tool_name:
                                    claim_done_tool = tool
                                    claim_done_observation = observation
                                    claim_done_parsed_action = returned_tool_name
                                    
                            if verbose:
                                print(f"Tool executed: {returned_tool_name}, tool use count: {self.tool_use_counter}")
                                print(f"Tool execute error: {tool_execute_error}")
                                print(f"Observation: {observation}")
                            
                            break  # Found and executed the tool, move to next tool call
                    
                    if not tool_executed:
                        # Tool not found, add error message
                        error_msg = f"Tool '{tool_name}' not found"
                        tool_result.append({
                            "role": "tool",
                            "tool_call_id": tool_call_id,
                            "content": error_msg
                        })
                        if verbose:
                            print(f"Tool not found: {tool_name}")
            
            # Process results based on whether claim_done was called
            reward = 0
            if claim_done_tool is not None:
                # Special handling for claim_done tool
                env_observation, env_reward, terminated, truncated, info = self.env.step(action)
                observation = claim_done_observation

                reward = env_reward
                info["parsed_action"] = claim_done_parsed_action
                info["tool_type"] = claim_done_tool.tool_type
                info["env_observation"] = env_observation
                
                if verbose:
                    print(f"Claim done tool detected - executed env.step()")
                    print(f"Tool use count: {self.tool_use_counter}")
                
                self.tool_success_counter += 1
                #reward += self.tool_success_reward
                tool_parsed = True
            else:
                # Normal tool execution (not claim_done)
                observation = json.dumps(tool_result)
                reward += self.tool_reward
                terminated, truncated = False, False
                
                # Get tool type from the last executed tool if available
                tool_type = "unknown"
                if len(tool_result) > 0:
                    if len(tool_result) > 1:
                        tool_type = "multiple_tools"
                    elif last_executed_tool is not None:
                        tool_type = last_executed_tool.tool_type
                    else:
                        tool_type = "error"  # No tool was executed, only errors in tool_result
                    
                info = {"tool_type": tool_type}
                tool_parsed = True
                
                if verbose:
                    print(f"Tools executed: {len(tool_result)}, tool use count: {self.tool_use_counter}")
                    print(f"Observation: {observation}")
        else:
            # Not a tool action, pass to environment
            observation, reward, terminated, truncated, info = self.env.step(action)
            
        info["tool_use_counter"] = self.tool_use_counter
        info["tool_success_counter"] = self.tool_success_counter
        info["use_tool"] = tool_parsed
        return observation, reward, terminated, truncated, info

    def step(
        self,
        action: str,
        verbose: bool = False,
    ) -> Tuple[str, SupportsFloat, bool, bool, dict[str, Any]]:
        # try to execute the action with each tool
        tool_parsed = False
        claim_done_tool = None
        claim_done_observation = None
        claim_done_parsed_action = None
        
        if self.tool_use_counter < self.max_tool_uses:
            for tool in self.tools:
                tool_parsed, tool_execute_error, observation, parsed_action = (
                    tool.execute_action(action)
                )

                print(f"Tool parsed: {tool.tool_type}, tool use count: {self.tool_use_counter}")
                print(f"Tool execute error: {tool_execute_error}")
                print(f"Observation: {observation}")
                print(f"Parsed action: {parsed_action}")
                if tool_parsed and (not tool_execute_error):
                    # Check if this is the claim_done tool
                    if tool.tool_type == "claim_done" or "claim_done" in tool.tool_type:
                        claim_done_tool = tool
                        claim_done_observation = observation
                        claim_done_parsed_action = parsed_action
                    break

        reward = 0
        if tool_parsed:
            self.tool_use_counter += 1
            
            # If claim_done was called, execute env.step first
            if claim_done_tool is not None:
                # Execute the environment step to signal completion
                env_observation, env_reward, terminated, truncated, info = self.env.step(action)
                
                # Then use the claim_done tool's observation
                observation = claim_done_observation
                reward = env_reward + self.tool_reward
                info["parsed_action"] = claim_done_parsed_action
                info["tool_type"] = claim_done_tool.tool_type
                info["env_observation"] = env_observation  # Store env response
                
                if verbose:
                    print(f"Claim done tool detected - executed env.step()")
                    print(f"Tool use count: {self.tool_use_counter}")
                
                self.tool_success_counter += 1
                reward += self.tool_success_reward
            else:
                # Normal tool execution (not claim_done)
                if self.tool_use_counter == self.max_tool_uses:
                    observation = f"{observation}\n\nReached the maximum number of tool use. Please output final answer directly."
                reward += self.tool_reward
                terminated, truncated = False, False
                info = {"parsed_action": parsed_action, "tool_type": tool.tool_type}
                if verbose:
                    print(
                        f"Tool parsed: {tool.tool_type}, tool use count: {self.tool_use_counter}"
                    )
                if not tool_execute_error:
                    self.tool_success_counter += 1
                    reward += self.tool_success_reward
                    if verbose:
                        print(
                            f"Tool executed: {tool.tool_type}, tool use count: {self.tool_use_counter}"
                        )
        # if no tool was executed, step the environment
        else:
            observation, reward, terminated, truncated, info = self.env.step(action)

        info["tool_use_counter"] = self.tool_use_counter
        info["tool_success_counter"] = self.tool_success_counter
        info["use_tool"] = tool_parsed
        return observation, reward, terminated, truncated, info

    def get_state(self) -> dict[str, Any]:
        state = self.env.get_state()
        state["tool_use_counter"] = self.tool_use_counter
        state["tool_success_counter"] = self.tool_success_counter
        return state

    def set_state(self, state: dict[str, Any]) -> None:
        self.env.set_state(state)
        self.tool_use_counter = state.get("tool_use_counter", 0)
        self.tool_success_counter = state.get("tool_success_counter", 0)
