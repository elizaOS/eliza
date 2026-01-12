from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.bootstrap.utils.xml import parse_key_value_xml
from elizaos.prompts import IMAGE_GENERATION_TEMPLATE
from elizaos.types import Action, ActionExample, ActionResult, Content, ModelType

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State


@dataclass
class GenerateImageAction:
    name: str = "GENERATE_IMAGE"
    similes: list[str] = field(
        default_factory=lambda: [
            "CREATE_IMAGE",
            "MAKE_IMAGE",
            "DRAW",
            "PAINT",
            "VISUALIZE",
            "RENDER_IMAGE",
        ]
    )
    description: str = (
        "Generate an image using AI image generation models. "
        "Use this when the user requests visual content or imagery."
    )

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
        return [
            [
                ActionExample(
                    name="{{name1}}",
                    content=Content(text="Can you draw a sunset over the ocean?"),
                ),
                ActionExample(
                    name="{{name2}}",
                    content=Content(
                        text="I'll generate that image for you.",
                        actions=["GENERATE_IMAGE"],
                    ),
                ),
            ],
            [
                ActionExample(
                    name="{{name1}}",
                    content=Content(text="Create an image of a futuristic city."),
                ),
                ActionExample(
                    name="{{name2}}",
                    content=Content(
                        text="Generating a futuristic cityscape...",
                        actions=["GENERATE_IMAGE"],
                    ),
                ),
            ],
        ]


generate_image_action = Action(
    name=GenerateImageAction.name,
    similes=GenerateImageAction().similes,
    description=GenerateImageAction.description,
    validate=GenerateImageAction().validate,
    handler=GenerateImageAction().handler,
    examples=GenerateImageAction().examples,
)
