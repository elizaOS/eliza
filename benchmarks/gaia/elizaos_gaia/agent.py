"""
GAIA Agent Implementation

An agent specialized for solving GAIA benchmark tasks using ElizaOS runtime.
Supports multiple LLM providers: Groq (default), OpenAI, Anthropic, Ollama,
LocalAI, OpenRouter, Google GenAI, and XAI.
"""

import logging
import re
import time
import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from elizaos.runtime import AgentRuntime

from elizaos_gaia.providers import (
    ModelConfig,
    call_provider,
)
from elizaos_gaia.tools import (
    Calculator,
    CodeExecutor,
    FileProcessor,
    WebBrowserTool,
    WebSearchTool,
)
from elizaos_gaia.types import (
    GAIAConfig,
    GAIAQuestion,
    GAIAResult,
    StepRecord,
    ToolType,
)

logger = logging.getLogger(__name__)


class GAIAAgent:
    """Agent specialized for solving GAIA benchmark questions."""

    SYSTEM_PROMPT = """You are a helpful AI assistant solving GAIA benchmark tasks.

Your goal is to answer questions accurately by using available tools when needed.

Available tools:
{available_tools}

Instructions:
1. Analyze the question carefully
2. Break down complex questions into steps
3. Use tools when you need external information or computation
4. For web searches, formulate specific queries
5. For calculations, write Python code when complex
6. Always verify your intermediate results
7. Provide a final answer that directly answers the question

When you have the final answer, respond with:
FINAL ANSWER: [your answer]

The answer should be concise and match what is being asked (a number, name, date, etc.)."""

    TOOL_DESCRIPTIONS = {
        ToolType.WEB_SEARCH: "web_search(query) - Search the web for information",
        ToolType.WEB_BROWSE: "browse(url) - Navigate to a URL and extract content",
        ToolType.FILE_READ: "read_file(path) - Read content from a file",
        ToolType.PDF_READ: "read_pdf(path) - Extract text from a PDF file",
        ToolType.SPREADSHEET_READ: "read_spreadsheet(path) - Read Excel/CSV file",
        ToolType.IMAGE_ANALYSIS: "analyze_image(path) - Analyze an image file",
        ToolType.CODE_EXEC: "execute_code(code) - Execute Python code",
        ToolType.CALCULATOR: "calculate(expression) - Evaluate math expression",
    }

    def __init__(
        self,
        config: GAIAConfig,
        runtime: Optional["AgentRuntime"] = None,
    ):
        """
        Initialize GAIA agent.

        Args:
            config: GAIA benchmark configuration
            runtime: Optional ElizaOS runtime for LLM access
        """
        if not isinstance(config, GAIAConfig):
            raise TypeError(f"config must be GAIAConfig, got {type(config).__name__}")

        self.config = config
        self.runtime = runtime
        self.max_iterations = config.max_iterations

        # Initialize model configuration
        self._init_model_config()

        # Initialize tools
        self.web_search = WebSearchTool(
            api_key=config.web_search_api_key,
            engine="duckduckgo" if not config.web_search_api_key else "serper",
        )
        self.web_browser = WebBrowserTool()
        self.file_processor = FileProcessor()
        self.code_executor = CodeExecutor(
            timeout_seconds=config.code_timeout_seconds,
            use_docker=config.code_execution_sandbox,
        )
        self.calculator = Calculator()

        # Conversation history for current question
        self._history: list[dict[str, str]] = []

    def _init_model_config(self) -> None:
        """Initialize model configuration from GAIAConfig."""
        # Build model string with provider if specified
        if self.config.provider:
            model_string = f"{self.config.provider}/{self.config.model_name}"
        else:
            model_string = self.config.model_name

        # Create model config from string
        self.model_config = ModelConfig.from_model_string(
            model_string,
            temperature=self.config.temperature,
            max_tokens=self.config.max_tokens,
            api_key=self.config.api_key or "",
            api_base=self.config.api_base or "",
        )

        # Override with explicit values if set
        if self.config.api_key:
            self.model_config.api_key = self.config.api_key
        if self.config.api_base:
            self.model_config.api_base = self.config.api_base

        logger.info(
            f"Model configured: {self.model_config.provider.value}/{self.model_config.model_name}"
        )

    @property
    def model_identifier(self) -> str:
        """Get a unique identifier for the current model configuration."""
        return f"{self.model_config.provider.value}_{self.model_config.model_name}".replace("/", "_").replace(":", "_")

    async def solve(self, question: GAIAQuestion) -> GAIAResult:
        """
        Attempt to solve a GAIA question.

        Args:
            question: The GAIA question to solve

        Returns:
            GAIAResult with the predicted answer and metrics
        """
        # Canonical Eliza runtime path: route through AgentRuntime.message_service
        if self.runtime is not None and self.config.use_eliza_runtime:
            return await self._solve_with_eliza_runtime(question)

        start_time = time.time()
        steps: list[StepRecord] = []
        tools_used: list[ToolType] = []
        total_tokens = 0

        logger.info(f"Solving question {question.task_id} (Level {question.level.value})")

        # Build system prompt with available tools
        available_tools = self._get_available_tools(question)
        system_prompt = self.SYSTEM_PROMPT.format(
            available_tools="\n".join(
                f"- {self.TOOL_DESCRIPTIONS.get(t, str(t))}"
                for t in available_tools
            )
        )

        # Initialize conversation
        self._history = [
            {"role": "system", "content": system_prompt},
        ]

        # Add question with file context if present
        user_message = self._build_question_prompt(question)
        self._history.append({"role": "user", "content": user_message})

        predicted_answer = ""
        error_message = None

        try:
            # Agent loop
            for iteration in range(self.max_iterations):
                step_start = time.time()

                # Get agent response
                response, tokens = await self._get_llm_response()
                total_tokens += tokens

                # Parse response
                final_answer = self._extract_final_answer(response)
                if final_answer:
                    predicted_answer = final_answer
                    steps.append(StepRecord(
                        step_number=iteration + 1,
                        action="final_answer",
                        reasoning=response,
                        timestamp_ms=time.time() * 1000,
                        duration_ms=(time.time() - step_start) * 1000,
                    ))
                    break

                # Check for tool calls
                tool_call = self._extract_tool_call(response)
                if tool_call:
                    tool_name, tool_input = tool_call

                    # Execute tool
                    tool_result = await self._execute_tool(
                        tool_name, tool_input, question
                    )

                    # Record step
                    tool_type = self._tool_name_to_type(tool_name)
                    if tool_type:
                        tools_used.append(tool_type)

                    steps.append(StepRecord(
                        step_number=iteration + 1,
                        action=f"tool:{tool_name}",
                        tool_used=tool_type,
                        tool_input=tool_input,
                        tool_output=tool_result[:2000],  # Truncate for storage
                        reasoning=response,
                        timestamp_ms=time.time() * 1000,
                        duration_ms=(time.time() - step_start) * 1000,
                        success=not tool_result.startswith("Error:"),
                    ))

                    # Add tool result to history
                    self._history.append({"role": "assistant", "content": response})
                    self._history.append({
                        "role": "user",
                        "content": f"Tool result:\n{tool_result}\n\nContinue solving the question.",
                    })
                else:
                    # No tool call and no final answer - add to history and continue
                    self._history.append({"role": "assistant", "content": response})
                    self._history.append({
                        "role": "user",
                        "content": "Please continue and provide a final answer or use a tool.",
                    })

                    steps.append(StepRecord(
                        step_number=iteration + 1,
                        action="reasoning",
                        reasoning=response,
                        timestamp_ms=time.time() * 1000,
                        duration_ms=(time.time() - step_start) * 1000,
                    ))

            # If no final answer found, try to extract from last response
            if not predicted_answer and self._history:
                last_response = self._history[-1].get("content", "")
                predicted_answer = self._extract_any_answer(last_response)

        except TimeoutError:
            error_message = "Timeout exceeded"
            logger.warning(f"Question {question.task_id} timed out")
        except Exception as e:
            error_message = str(e)
            logger.error(f"Error solving question {question.task_id}: {e}")

        latency_ms = (time.time() - start_time) * 1000

        return GAIAResult(
            task_id=question.task_id,
            level=question.level,
            question=question.question,
            predicted_answer=predicted_answer,
            expected_answer=question.final_answer,
            is_correct=False,  # Will be set by evaluator
            steps_taken=steps,
            tools_used=list(set(tools_used)),
            latency_ms=latency_ms,
            token_usage=total_tokens,
            error=error_message,
        )

    async def _solve_with_eliza_runtime(self, question: GAIAQuestion) -> GAIAResult:
        """Solve a question using the canonical Eliza runtime message loop."""
        from elizaos.types.memory import Memory
        from elizaos.types.primitives import Content, as_uuid, string_to_uuid

        runtime = self.runtime
        if runtime is None:
            raise RuntimeError("runtime is required for Eliza runtime mode")

        start_time = time.time()
        steps: list[StepRecord] = []
        tools_used: list[ToolType] = []

        # Token accounting is tracked by the model handler as a runtime attribute
        setattr(runtime, "_gaia_total_tokens", 0)

        room_id = string_to_uuid(f"gaia:{question.task_id}")
        user_id = string_to_uuid("gaia-benchmark-user")

        # Initial message includes file context if present
        user_text = self._build_question_prompt(question)

        predicted_answer = ""
        error_message: str | None = None

        # Capture any response texts emitted via callbacks (including action callbacks)
        emitted_texts: list[str] = []

        async def _capture(content: Content) -> list[Memory]:
            if content.text:
                emitted_texts.append(str(content.text))
            return []

        try:
            for iteration in range(self.max_iterations):
                emitted_texts.clear()
                step_start = time.time()

                message = Memory(
                    id=as_uuid(str(uuid.uuid4())),
                    entity_id=user_id,
                    agent_id=runtime.agent_id,
                    room_id=room_id,
                    content=Content(text=user_text),
                    created_at=int(time.time() * 1000),
                )

                result = await runtime.message_service.handle_message(runtime, message, _capture)

                # Prefer the latest callback text (captures REPLY action outputs too)
                response_text = ""
                if emitted_texts:
                    response_text = emitted_texts[-1]
                elif result.response_content and result.response_content.text:
                    response_text = str(result.response_content.text)

                # Token usage since start (best-effort)
                total_tokens_raw = getattr(runtime, "_gaia_total_tokens", 0)
                total_tokens = int(total_tokens_raw) if isinstance(total_tokens_raw, int) else 0

                # Record step (high-level)
                steps.append(
                    StepRecord(
                        step_number=iteration + 1,
                        action="eliza_message",
                        reasoning=response_text,
                        timestamp_ms=time.time() * 1000,
                        duration_ms=(time.time() - step_start) * 1000,
                    )
                )

                # Check for final answer
                final_answer = self._extract_final_answer(response_text)
                if final_answer:
                    predicted_answer = final_answer
                    break

                # If the model didn't plan any non-trivial actions, treat the message as a final attempt.
                planned_actions: list[str] = []
                if result.response_messages:
                    planned_actions = [
                        a
                        for a in (result.response_messages[0].content.actions or [])
                        if isinstance(a, str)
                    ]
                non_reply = [a for a in planned_actions if a not in ("REPLY", "IGNORE")]
                if not non_reply and response_text and "?" not in response_text and len(response_text) <= 300:
                    guessed = self._extract_any_answer(response_text)
                    # Only accept short, answer-like outputs here to avoid stopping
                    # on explanatory text.
                    if guessed and len(guessed) <= 80 and len(guessed.split()) <= 12:
                        predicted_answer = guessed
                        break

                # If actions were executed, pull their results and feed back into the conversation
                action_results = runtime.get_action_results(message.id)
                tool_lines: list[str] = []
                for ar in action_results:
                    # Map actionName (if present) to ToolType
                    action_name = None
                    if ar.data and isinstance(ar.data, dict):
                        raw = ar.data.get("actionName")
                        if isinstance(raw, str):
                            action_name = raw
                    if action_name:
                        mapped = self._tool_name_to_type(action_name.lower())
                        if mapped:
                            tools_used.append(mapped)

                    if ar.text:
                        label = action_name or "ACTION"
                        tool_lines.append(f"{label}: {ar.text}")

                if tool_lines:
                    user_text = (
                        "Tool results:\n"
                        + "\n\n".join(tool_lines[:8])
                        + "\n\nContinue solving. When ready, respond with:\nFINAL ANSWER: <answer>"
                    )
                else:
                    user_text = (
                        "Continue solving. If you need to, use the available actions.\n"
                        "When ready, respond with:\nFINAL ANSWER: <answer>"
                    )

        except TimeoutError:
            error_message = "Timeout exceeded"
            logger.warning(f"Question {question.task_id} timed out")
        except Exception as e:
            error_message = str(e)
            logger.error(f"Error solving question {question.task_id}: {e}")

        latency_ms = (time.time() - start_time) * 1000
        total_tokens_raw = getattr(runtime, "_gaia_total_tokens", 0)
        total_tokens = int(total_tokens_raw) if isinstance(total_tokens_raw, int) else 0

        # Fallback: if we never extracted FINAL ANSWER, try to salvage from last emitted text
        if not predicted_answer and emitted_texts:
            predicted_answer = self._extract_any_answer(emitted_texts[-1])

        return GAIAResult(
            task_id=question.task_id,
            level=question.level,
            question=question.question,
            predicted_answer=predicted_answer,
            expected_answer=question.final_answer,
            is_correct=False,  # evaluator sets
            steps_taken=steps,
            tools_used=list(set(tools_used)),
            latency_ms=latency_ms,
            token_usage=total_tokens,
            error=error_message,
        )

    def _get_available_tools(self, question: GAIAQuestion) -> list[ToolType]:
        """Determine available tools for a question."""
        tools = []

        if self.config.enable_web_search:
            tools.append(ToolType.WEB_SEARCH)

        if self.config.enable_web_browse:
            tools.append(ToolType.WEB_BROWSE)

        if self.config.enable_code_execution:
            tools.append(ToolType.CODE_EXEC)

        tools.append(ToolType.CALCULATOR)

        if self.config.enable_file_processing:
            if question.file_name:
                ext = Path(question.file_name).suffix.lower()
                if ext == ".pdf":
                    tools.append(ToolType.PDF_READ)
                elif ext in [".xlsx", ".xls", ".csv"]:
                    tools.append(ToolType.SPREADSHEET_READ)
                elif ext in [".png", ".jpg", ".jpeg", ".gif", ".webp"]:
                    tools.append(ToolType.IMAGE_ANALYSIS)
                else:
                    tools.append(ToolType.FILE_READ)

        return tools

    def _build_question_prompt(self, question: GAIAQuestion) -> str:
        """Build the question prompt including file context."""
        prompt = f"Question: {question.question}"

        if question.file_path and question.file_path.exists():
            prompt += f"\n\nA file is attached: {question.file_name}"
            prompt += f"\nFile path: {question.file_path}"

        return prompt

    async def _get_llm_response(self) -> tuple[str, int]:
        """Get response from LLM using configured provider."""
        if self.runtime:
            # Use ElizaOS runtime
            from elizaos.types.model import ModelType

            result = await self.runtime.use_model(
                ModelType.TEXT_LARGE,
                {
                    "messages": self._history,
                    "temperature": self.config.temperature,
                    "max_tokens": self.config.max_tokens,
                    "model": self.model_config.model_name,
                    "provider": self.model_config.provider.value,
                },
            )

            if isinstance(result, dict):
                return result.get("text", ""), result.get("tokens", 0)
            return str(result), 0
        else:
            # Use multi-provider system
            return await self._call_provider()

    async def _call_provider(self) -> tuple[str, int]:
        """Call configured provider directly.

        Supports: Groq, OpenAI, Anthropic, Ollama, LocalAI, OpenRouter, Google, XAI

        Returns:
            Tuple of (response_text, token_count)
        """
        return await call_provider(self.model_config, self._history)

    def _extract_final_answer(self, response: str) -> str | None:
        """Extract final answer from response."""
        import re

        # Look for "FINAL ANSWER:" pattern
        patterns = [
            r"FINAL ANSWER:\s*(.+?)(?:\n|$)",
            r"Final Answer:\s*(.+?)(?:\n|$)",
            r"The answer is:?\s*(.+?)(?:\n|$)",
            r"Answer:\s*(.+?)(?:\n|$)",
        ]

        for pattern in patterns:
            match = re.search(pattern, response, re.IGNORECASE)
            if match:
                answer = match.group(1).strip()
                # Clean up the answer
                answer = answer.strip('"\'')
                return answer

        return None

    def _extract_any_answer(self, response: str) -> str:
        """Try to extract any reasonable answer from response."""
        text = response.strip()
        if not text:
            return ""

        # Prefer explicit markers if present anywhere
        if final := self._extract_final_answer(text):
            return final

        lines = [ln.strip() for ln in text.split("\n") if ln.strip()]
        if not lines:
            return ""

        # Choose last meaningful line
        line = ""
        for candidate in reversed(lines):
            if not candidate.startswith(("#", "-", "*", "/")):
                line = candidate
                break
        if not line:
            return ""

        # Strip common prefixes
        line = re.sub(r"^(therefore|thus|so|hence)[,:]?\s*", "", line, flags=re.I)
        line = re.sub(r"^(the answer is|answer:)\s*", "", line, flags=re.I)

        # If there is an explicit '=' or 'is/equals' statement, take the RHS (most likely the answer)
        if "=" in line:
            rhs = line.rsplit("=", 1)[-1].strip()
            if rhs:
                line = rhs
        else:
            m = re.search(r"\b(is|was|are|equals?|equal to)\b\s*(.+)$", line, flags=re.I)
            if m:
                tail = m.group(2).strip()
                if tail:
                    line = tail

        # Trim surrounding punctuation/quotes
        line = line.strip().strip(" .,:;\"'`")

        # If the line still contains multiple clauses, prefer the final clause.
        if "," in line and len(line) > 80:
            line = line.split(",")[-1].strip()

        return line[:500]

    def _extract_tool_call(self, response: str) -> tuple[str, str] | None:
        """Extract tool call from response."""
        # Look for tool call patterns
        patterns = [
            # Function-style: tool_name("input")
            r"(\w+)\s*\(\s*[\"'](.+?)[\"']\s*\)",
            # Action-style: [TOOL: tool_name] input
            r"\[TOOL:\s*(\w+)\]\s*(.+?)(?:\n|$)",
            # Command-style: /tool_name input
            r"/(\w+)\s+(.+?)(?:\n|$)",
        ]

        tool_mapping = {
            "web_search": "web_search",
            "search": "web_search",
            "google": "web_search",
            "browse": "browse",
            "navigate": "browse",
            "open_url": "browse",
            "read_file": "read_file",
            "read_pdf": "read_pdf",
            "read_spreadsheet": "read_spreadsheet",
            "read_excel": "read_spreadsheet",
            "analyze_image": "analyze_image",
            "execute_code": "execute_code",
            "python": "execute_code",
            "run_code": "execute_code",
            "calculate": "calculate",
            "calc": "calculate",
        }

        for pattern in patterns:
            match = re.search(pattern, response, re.IGNORECASE | re.DOTALL)
            if match:
                tool_name = match.group(1).lower()
                tool_input = match.group(2).strip()

                # Map to standard tool name
                if tool_name in tool_mapping:
                    return (tool_mapping[tool_name], tool_input)

        return None

    async def _execute_tool(
        self,
        tool_name: str,
        tool_input: str,
        question: GAIAQuestion,
    ) -> str:
        """Execute a tool and return the result."""
        try:
            if tool_name == "web_search":
                result = await self.web_search.search(tool_input)
                if result.success:
                    output = f"Found {len(result.results)} results:\n"
                    for r in result.results[:5]:
                        output += f"\n{r.position}. {r.title}\n   {r.url}\n   {r.snippet}\n"
                    return output
                return f"Error: {result.error}"

            elif tool_name == "browse":
                result = await self.web_browser.navigate(tool_input)
                if result.success:
                    return f"Title: {result.title}\n\nContent:\n{result.text[:5000]}"
                return f"Error: {result.error}"

            elif tool_name in ["read_file", "read_pdf", "read_spreadsheet"]:
                # Use the question's file path if available
                file_path = question.file_path or Path(tool_input)
                result = await self.file_processor.process(file_path)
                if result.success:
                    return f"File content:\n{result.content}"
                return f"Error: {result.error}"

            elif tool_name == "analyze_image":
                file_path = question.file_path or Path(tool_input)
                result = await self.file_processor.process(file_path)
                if result.success:
                    return f"Image analysis:\n{result.content}"
                return f"Error: {result.error}"

            elif tool_name == "execute_code":
                result = await self.code_executor.execute_python(tool_input)
                return self.code_executor.format_result(result)

            elif tool_name == "calculate":
                result = self.calculator.calculate(tool_input)
                if result.success:
                    return f"Result: {result.formatted}"
                return f"Error: {result.error}"

            else:
                return f"Error: Unknown tool '{tool_name}'"

        except Exception as e:
            logger.error(f"Tool execution error ({tool_name}): {e}")
            return f"Error: {str(e)}"

    def _tool_name_to_type(self, tool_name: str) -> ToolType | None:
        """Convert tool name to ToolType."""
        mapping = {
            "web_search": ToolType.WEB_SEARCH,
            "browse": ToolType.WEB_BROWSE,
            "read_file": ToolType.FILE_READ,
            "read_pdf": ToolType.PDF_READ,
            "read_spreadsheet": ToolType.SPREADSHEET_READ,
            "analyze_image": ToolType.IMAGE_ANALYSIS,
            "execute_code": ToolType.CODE_EXEC,
            "calculate": ToolType.CALCULATOR,
        }
        return mapping.get(tool_name)

    async def close(self) -> None:
        """Clean up resources."""
        await self.web_search.close()
        await self.web_browser.close()
