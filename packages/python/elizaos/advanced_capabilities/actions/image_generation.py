from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.bootstrap.utils.xml import parse_key_value_xml
from elizaos.generated.spec_helpers import require_action_spec
from elizaos.prompts import IMAGE_GENERATION_TEMPLATE
from elizaos.types import Action, ActionExample, ActionResult, Content, ModelType

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_action_spec("GENERATE_IMAGE")


def _convert_spec_examples() -> list[list[ActionExample]]:
    """Convert spec examples to ActionExample format."""
    spec_examples = _spec.get("examples", [])
    if not isinstance(spec_examples, list):
        return []
    result: list[list[ActionExample]] = []
    for example in spec_examples:
        if not isinstance(example, list):
            continue
        row: list[ActionExample] = []
        for msg in example:
            if not isinstance(msg, dict):
                continue
            content = msg.get("content", {})
            text = ""
            actions: list[str] | None = None
            if isinstance(content, dict):
                text_val = content.get("text", "")
                text = str(text_val) if text_val else ""
                actions_val = content.get("actions")
                if isinstance(actions_val, list) and all(isinstance(a, str) for a in actions_val):
                    actions = list(actions_val)
            row.append(
                ActionExample(
                    name=str(msg.get("name", "")),
                    content=Content(text=text, actions=actions),
                )
            )
        if row:
            result.append(row)
    return result


@dataclass
class GenerateImageAction:
    name: str = _spec["name"]
    similes: list[str] = field(default_factory=lambda: list(_spec.get("similes", [])))
    description: str = _spec["description"]

    async def validate(
        self, runtime: IAgentRuntime, message: Memory, _state: State | None = None
    ) -> bool:
        return runtime.has_model(ModelType.IMAGE)

    async def handler(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        if state is None:
            raise ValueError("State is required for GENERATE_IMAGE action")

        state = await runtime.compose_state(message, ["RECENT_MESSAGES", "ACTION_STATE"])

        template = (
            runtime.character.templates.get("imageGenerationTemplate")
            if runtime.character.templates
            and "imageGenerationTemplate" in runtime.character.templates
            else IMAGE_GENERATION_TEMPLATE
        )
        prompt = runtime.compose_prompt(state=state, template=template)

        prompt_response = await runtime.use_model(ModelType.TEXT_LARGE, prompt=prompt)
        parsed_xml = parse_key_value_xml(prompt_response)

        if parsed_xml is None:
            raise ValueError("Failed to parse XML response for image prompt")

        thought = str(parsed_xml.get("thought", ""))
        image_prompt = str(parsed_xml.get("prompt", ""))

        if not image_prompt:
            raise ValueError("No image prompt generated")

        image_result = await runtime.use_model(
            ModelType.IMAGE,
            prompt=image_prompt,
        )

        image_url: str | None = None
        if isinstance(image_result, str):
            image_url = image_result
        elif isinstance(image_result, dict):
            image_url = image_result.get("url") or image_result.get("data")

        if not image_url:
            raise ValueError("No image URL returned from generation")

        response_content = Content(
            text=f"Generated image with prompt: {image_prompt}",
            attachments=[{"type": "image", "url": image_url}],
            actions=["GENERATE_IMAGE"],
        )

        if callback:
            await callback(response_content)

        return ActionResult(
            text=f"Generated image: {image_prompt}",
            values={
                "success": True,
                "imageGenerated": True,
                "imageUrl": image_url,
                "imagePrompt": image_prompt,
            },
            data={
                "actionName": "GENERATE_IMAGE",
                "prompt": image_prompt,
                "thought": thought,
                "imageUrl": image_url,
            },
            success=True,
        )

    @property
    def examples(self) -> list[list[ActionExample]]:
        return _convert_spec_examples()


generate_image_action = Action(
    name=GenerateImageAction.name,
    similes=GenerateImageAction().similes,
    description=GenerateImageAction.description,
    validate=GenerateImageAction().validate,
    handler=GenerateImageAction().handler,
    examples=GenerateImageAction().examples,
)
