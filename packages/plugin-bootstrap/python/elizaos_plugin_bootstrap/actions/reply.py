"""
REPLY Action - Generate and send replies to messages.

This action generates a response using the LLM and sends it back
to the conversation. It's the default action when the agent needs
to respond with a message.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from pydantic import BaseModel

from elizaos.types import (
    Action,
    ActionExample,
    ActionResult,
    Content,
    ModelType,
)

if TYPE_CHECKING:
    from elizaos.types import (
        HandlerCallback,
        HandlerOptions,
        IAgentRuntime,
        Memory,
        State,
    )


REPLY_TEMPLATE = """# Task: Generate dialog for the character {{agentName}}.

{{providers}}

# Instructions: Write the next message for {{agentName}}.
"thought" should be a short description of what the agent is thinking about and planning.
"text" should be the next message for {{agentName}} which they will send to the conversation.

IMPORTANT CODE BLOCK FORMATTING RULES:
- If {{agentName}} includes code examples, snippets, or multi-line code in the response, ALWAYS wrap the code with ``` fenced code blocks (specify the language if known).
- ONLY use fenced code blocks for actual code. Do NOT wrap non-code text in fenced code blocks.
- If including inline code (short single words or function names), use single backticks (`) as appropriate.

Do NOT include any thinking, reasoning, or <think> sections in your response.
Go directly to the XML response format without any preamble or explanation.

Respond using XML format like this:
<response>
    <thought>Your thought here</thought>
    <text>Your message here</text>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."""


class ReplyXmlResponse(BaseModel):
    """Parsed XML response from the reply model."""

    thought: str = ""
    text: str = ""


@dataclass
class ReplyAction:
    """
    Action that generates and sends a reply to the current conversation.

    This is the default action when the agent needs to respond with a message.
    It can be used at the beginning of a chain of actions as an acknowledgement,
    or at the end of a chain as a final response.
    """

    name: str = "REPLY"
    similes: list[str] = field(
        default_factory=lambda: ["GREET", "REPLY_TO_MESSAGE", "SEND_REPLY", "RESPOND", "RESPONSE"]
    )
    description: str = (
        "Replies to the current conversation with the text from the generated message. "
        "Default if the agent is responding with a message and no other action. "
        "Use REPLY at the beginning of a chain of actions as an acknowledgement, "
        "and at the end of a chain of actions as a final response."
    )

    async def validate(self, runtime: IAgentRuntime) -> bool:
        """Always valid - agents can always reply."""
        return True

    async def handler(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        """
        Generate a reply using the LLM.

        Args:
            runtime: The agent runtime
            message: The triggering message
            state: Current conversation state
            options: Handler options including action context
            callback: Callback to send the response
            responses: Previous responses in the chain

        Returns:
            ActionResult with the generated reply
        """
        # Get providers from responses if available
        all_providers: list[str] = []
        if responses:
            for res in responses:
                if res.content and res.content.providers:
                    all_providers.extend(res.content.providers)

        # Compose state with relevant providers
        state = await runtime.compose_state(
            message, [*all_providers, "RECENT_MESSAGES", "ACTION_STATE"]
        )

        # Get the reply template from character or use default
        template = REPLY_TEMPLATE
        if runtime.character.templates and "replyTemplate" in runtime.character.templates:
            template = runtime.character.templates["replyTemplate"]

        prompt = runtime.compose_prompt_from_state(state=state, template=template)

        try:
            response = await runtime.use_model(ModelType.TEXT_LARGE, {"prompt": prompt})

            # Parse XML response
            parsed = runtime.parse_key_value_xml(response)
            thought = parsed.get("thought", "") if parsed else ""
            text = parsed.get("text", "") if parsed else ""

            # Ensure we have strings
            thought = str(thought) if thought else ""
            text = str(text) if text else ""

            response_content = Content(
                thought=thought,
                text=text,
                actions=["REPLY"],
            )

            if callback:
                await callback(response_content)

            return ActionResult(
                text=f"Generated reply: {text}",
                values={
                    "success": True,
                    "responded": True,
                    "lastReply": text,
                    "lastReplyTime": runtime.get_current_time_ms(),
                    "thoughtProcess": thought,
                },
                data={
                    "actionName": "REPLY",
                    "responseThought": thought,
                    "responseText": text,
                    "messageGenerated": True,
                },
                success=True,
            )

        except Exception as e:
            runtime.logger.error(
                {
                    "src": "plugin:bootstrap:action:reply",
                    "agentId": str(runtime.agent_id),
                    "error": str(e),
                },
                "Error generating response",
            )

            return ActionResult(
                text="Error generating reply",
                values={
                    "success": False,
                    "responded": False,
                    "error": True,
                },
                data={
                    "actionName": "REPLY",
                    "error": str(e),
                },
                success=False,
                error=e if isinstance(e, Exception) else Exception(str(e)),
            )

    @property
    def examples(self) -> list[list[ActionExample]]:
        """Example interactions demonstrating the REPLY action."""
        return [
            [
                ActionExample(name="{{name1}}", content=Content(text="Hello there!")),
                ActionExample(
                    name="{{name2}}",
                    content=Content(text="Hi! How can I help you today?", actions=["REPLY"]),
                ),
            ],
            [
                ActionExample(name="{{name1}}", content=Content(text="What's your favorite color?")),
                ActionExample(
                    name="{{name2}}",
                    content=Content(
                        text="I really like deep shades of blue. They remind me of the ocean.",
                        actions=["REPLY"],
                    ),
                ),
            ],
            [
                ActionExample(
                    name="{{name1}}",
                    content=Content(text="Can you explain how neural networks work?"),
                ),
                ActionExample(
                    name="{{name2}}",
                    content=Content(
                        text="Let me break that down for you in simple terms...",
                        actions=["REPLY"],
                    ),
                ),
            ],
        ]


# Create the action instance
reply_action = Action(
    name=ReplyAction.name,
    similes=ReplyAction().similes,
    description=ReplyAction.description,
    validate=ReplyAction().validate,
    handler=ReplyAction().handler,
    examples=ReplyAction().examples,
)

