import logging
from typing import Dict, List, Tuple, Optional

from mm_agents.os_symphony.memory.procedural_memory import PROCEDURAL_MEMORY
from mm_agents.os_symphony.utils.common_utils import call_llm_safe, parse_code_from_string
from mm_agents.os_symphony.core.mllm import LMMAgent

logger = logging.getLogger("desktopenv.coder_agent")


def extract_code_block(action: str) -> Tuple[Optional[str], Optional[str]]:
    """Extract code and determine type from action string."""
    if "```python" in action:
        code_type = "python"
        code = action.split("```python")[1].split("```")[0].strip()
    elif "```bash" in action:
        code_type = "bash"
        code = action.split("```bash")[1].split("```")[0].strip()
    elif "```" in action:
        code_type = None
        code = action.split("```")[1].split("```")[0].strip()
    else:
        code_type = None
        code = None

    logger.debug(
        f"Extracted code block: type={code_type}, length={len(code) if code else 0}"
    )
    return code_type, code


def execute_code(code_type: str, code: str, env_controller) -> Dict:
    """Execute code based on its type."""
    # Log the full code being executed (untruncated)
    logger.info(f"CODING_AGENT_CODE_EXECUTION - Type: {code_type}\nCode:\n{code}")

    try:
        if code_type == "bash":
            result = env_controller.run_bash_script(code, timeout=30)
        elif code_type == "python":
            result = env_controller.run_python_script(code)
        else:
            result = {"status": "error", "error": f"Unknown code type: {code_type}"}

        return result

    except Exception as e:
        logger.error(f"Error executing {code_type} code: {e}")
        return {"status": "error", "error": str(e)}


def format_result(result: Dict, step_count: int) -> str:
    """Format execution result into context string."""
    if not result:
        logger.warning(f"Step {step_count + 1}: No result returned from execution")
        return f"""
Step {step_count + 1} Error:
Error: No result returned from execution
"""

    status = result.get("status", "unknown")
    return_code = result.get("returncode", result.get("return_code", -1))

    # Handle different response structures for bash vs python
    if "returncode" in result:
        # Bash script response
        output = result.get("output", "")  # Contains both stdout and stderr merged
        error = result.get("error", "")  # Always empty for bash
    else:
        # Python script response
        output = result.get("output", "")  # stdout only
        error = result.get("error", "")  # stderr only

    logger.debug(f"Step {step_count + 1}: Status={status}, Return Code={return_code}")

    # Format with better structure for multi-line outputs
    result_text = f"Step {step_count + 1} Result:\n"
    result_text += f"Status: {status}\n"
    result_text += f"Return Code: {return_code}\n"

    if output:
        result_text += f"Output:\n{output}\n"

    if error:
        result_text += f"Error:\n{error}\n"

    return result_text


class CoderAgent:
    """A dedicated agent for executing code with a budget of steps."""

    def __init__(self, engine_params: Dict, client_password: str, platform: str = "linux"):
        """Initialize the CodeAgent."""
        if not engine_params:
            raise ValueError("engine_params cannot be None or empty")

        self.engine_params = engine_params
        self.budget = engine_params.get("budget", 20)
        self.temperature = engine_params.get("temperature", 0.1)
        self.agent = None
        self.platform = platform
        self.client_password = client_password

        logger.info(f"CodeAgent initialized with budget={self.budget} and platform={self.platform}")
        self.reset()

    def reset(self):
        """Reset the code agent state."""
        logger.debug("Resetting CodeAgent state")
        self.agent = LMMAgent(
            engine_params=self.engine_params,
            system_prompt=PROCEDURAL_MEMORY.construct_coder_procedural_memory(platform=self.platform, client_password=self.client_password)
        )

    def execute(self, task_instruction: str, screenshot: str, env_controller) -> Dict:
        """Execute code for the given task with a budget of steps."""
        if env_controller is None:
            raise ValueError("env_controller is required for code execution")

        print(f"\n🚀 STARTING CODE EXECUTION")
        print("=" * 60)
        print(f"Task: {task_instruction}")
        print(f"Budget: {self.budget} steps")
        print("=" * 60)

        logger.info(f"Starting code execution for task: {task_instruction}")
        logger.info(f"Budget: {self.budget} steps")

        self.reset()


        # Add initial task instruction and screenshot context as user message
        context = (
            f"Task: {task_instruction}\n\nCurrent screenshot is provided for context."
        )
        self.agent.add_message(context, image_content=screenshot, role="user")

        step_count = 0
        execution_history = []
        execution_result_history = []
        while step_count < self.budget:
            logger.info(f"Step {step_count + 1}/{self.budget}")

            # Get assistant response (thoughts and code)
            response = call_llm_safe(self.agent, temperature=self.temperature)

            # Print to terminal for immediate visibility
            # print(f"\n🤖 CODING AGENT RESPONSE - Step {step_count + 1}/{self.budget}")
            # print("=" * 60)
            # print(response)
            # print("=" * 60)

            # Log the latest message from the coding agent (untruncated)
            logger.info(
                f"CODING_AGENT_LATEST_MESSAGE - Step {step_count + 1}:\n{response}"
            )

            # Check if response is None or empty
            if not response or response.strip() == "":
                error_msg = f"Step {step_count + 1}: LLM returned empty response"
                logger.error(error_msg)
                raise RuntimeError(error_msg)

            # Parse the response to extract action
            action = parse_code_from_string(response)
            thoughts = response

            execution_history.append(
                {"step": step_count + 1, "action": action, "thoughts": thoughts}
            )

            # Check for completion signals
            action_upper = action.upper().strip()
            if action_upper == "DONE":
                print(f"\n✅ TASK COMPLETED - Step {step_count + 1}")
                print("=" * 60)
                print("Agent signaled task completion")
                print("=" * 60)
                logger.info(f"Step {step_count + 1}: Task completed successfully")
                completion_reason = "DONE"
                break
            elif action_upper == "FAIL":
                print(f"\n❌ TASK FAILED - Step {step_count + 1}")
                print("=" * 60)
                print("Agent signaled task failure")
                print("=" * 60)
                logger.info(f"Step {step_count + 1}: Task failed by agent request")
                completion_reason = "FAIL"
                break
            elif action_upper == 'INFEASIBLE':     
                print(f"\n❌ TASK INFEASIBLE - Step {step_count + 1}")
                print("=" * 60)
                print("Agent signaled task infeasible")
                print("=" * 60)
                logger.info(f"Step {step_count + 1}: Task infeasible by agent request")
                completion_reason = "INFEASIBLE"
                break

            # Extract and execute code
            code_type, code = extract_code_block(response.split("(Answer)")[-1])     

            if code:
                result = execute_code(code_type, code, env_controller)
                execution_result_history.append(
                    {"step": step_count + 1, "result": result}
                )
                # Prepare formatted output and error for logging
                output = result.get("output", "")
                error = result.get("error", "")
                message = result.get("message", "")
                status = result.get("status", "")

                # Print execution result to terminal for immediate visibility
                print(f"\n⚡ CODE EXECUTION RESULT - Step {step_count + 1}")
                print("-" * 50)
                print(f"Status: {status}")
                if output:
                    print(f"Output:\n{output}")
                if error:
                    print(f"Error:\n{error}")
                if message and not output and not error:
                    print(f"Message:\n{message}")
                print("-" * 50)

                log_lines = [
                    f"CODING_AGENT_EXECUTION_RESULT - Step {step_count + 1}:",
                    f"Status: {status}" if status else None,
                ]

                if output:
                    log_lines.append(
                        "Output:\n" + ("-" * 40) + f"\n{output}\n" + ("-" * 40)
                    )
                if error:
                    log_lines.append(
                        "Error:\n" + ("!" * 40) + f"\n{error}\n" + ("!" * 40)
                    )
                if message and not output and not error:
                    log_lines.append(
                        "Message:\n" + ("-" * 40) + f"\n{message}\n" + ("-" * 40)
                    )

                # Remove None entries and join
                formatted_log = "\n".join([line for line in log_lines if line])
                logger.info(formatted_log)
            else:
                print(f"\n⚠️  NO CODE BLOCK FOUND - Step {step_count + 1}")
                print("-" * 50)
                print("Action did not contain executable code")
                print("-" * 50)

                logger.warning(f"Step {step_count + 1}: No code block found in action")
                result = {"status": "skipped", "message": "No code block found"}
                logger.info(
                    f"CODING_AGENT_EXECUTION_RESULT - Step {step_count + 1}:\n"
                    f"Status: skipped\n"
                    f"Message:\n{'-' * 40}\n{result['message']}\n{'-' * 40}"
                )
            # Add assistant's thoughts and code to message history
            self.agent.add_message(response, role="assistant")

            # Process result and add formatted environment results as user message
            result_context = format_result(result, step_count)
            self.agent.add_message(result_context, role="user")

            step_count += 1

        # Handle budget exhaustion
        if "completion_reason" not in locals():
            print(f"\n⏰ BUDGET EXHAUSTED - {step_count} steps completed")
            print("=" * 60)
            print(f"Maximum budget of {self.budget} steps reached")
            print("=" * 60)
            logger.info(f"Budget exhausted after {step_count} steps")
            completion_reason = f"BUDGET_EXHAUSTED_AFTER_{step_count}_STEPS"

        # Generate final summary
        logger.info("Generating execution summary")
        summary = self._generate_summary(execution_history, task_instruction)

        result = {
            "task_instruction": task_instruction,
            "completion_reason": completion_reason,
            "summary": summary,
            "execution_history": execution_history,
            "execution_result_history": execution_result_history,
            "steps_executed": step_count,
            "budget": self.budget
        }

        logger.info(f"Code execution completed: steps={step_count}")
        return result

    def _generate_summary(
        self, execution_history: List[Dict], task_instruction: str
    ) -> str:
        """Generate summary of code execution session."""
        if not execution_history:
            logger.info("No execution history to summarize")
            return "No actions were executed."

        logger.info(f"Generated summary for {len(execution_history)} steps")

        # Build detailed execution context for summary agent
        execution_context = f"Task: {task_instruction}\n\nExecution Steps:\n"

        for step in execution_history:
            step_num = step["step"]
            thoughts = step.get("thoughts", "")
            action = step.get("action", "")

            execution_context += f"\nStep {step_num}:\n"
            if thoughts:
                execution_context += f"Thoughts: {thoughts}\n"
            execution_context += f"Code: {action}\n"

        # Create summary prompt with same context as coding agent
        summary_prompt = f"""
{execution_context}

Please provide a concise summary of the code execution session. Focus on:

1. The code logic implemented at each step
2. The outputs and results produced by each code execution
3. The progression of the solution approach

Do not make judgments about success or failure. Simply describe what was attempted and what resulted.

Keep the summary under 150 words and use clear, factual language.
"""

        # Generate summary using LLM with dedicated summary system prompt
        try:
            summary_agent = LMMAgent(
                engine_params=self.engine_params,
                system_prompt=PROCEDURAL_MEMORY.CODE_SUMMARY_AGENT_PROMPT,
            )
            summary_agent.add_message(summary_prompt, role="user")
            summary = call_llm_safe(summary_agent, temperature=self.temperature)

            if not summary or summary.strip() == "":
                summary = "Summary generation failed - no response from LLM"
                logger.warning("Summary generation failed - empty response from LLM")

        except Exception as e:
            summary = f"Summary generation failed: {str(e)}"
            logger.error(f"Error generating summary: {e}")

        return summary
