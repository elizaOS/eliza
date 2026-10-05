import httpx
import mm_agents.uipath.utils as utils
import os

class GrounderClient(object):
    def __init__(self):
        # Proxy for hosting finetuned Qwen3VL + UiElementPredictor
        # Could be replaced with a VLLM server and grounder specific processing
        self.url = ""

    async def predict(
        self, image_base64: str, action_description: str, action: str, element_description: str | None = None,
    ) -> utils.GroundingOutput:
        request = utils.GroundingRequest(
            description=action_description,
            image_base64=image_base64,
            action_type=action,
            element_description=element_description
        )
        api_key = os.getenv("SERVICE_KEY")
        async with httpx.AsyncClient() as client:
            response = await client.post(
                self.url,
                json={
                    "image_base64": request.image_base64,
                    "action_description": request.description,
                    "action": request.action_type,
                    "element_description": request.element_description,
                },
                headers={
                    "X-API-KEY": api_key
                },
                timeout=100.0,
            )

        if response.status_code != 200:
            raise ValueError(f"Prediction failed: {response.text}")

        data = response.json()
        if tuple(data["position"]) == (-1, -1):
            raise utils.GroundingOutputValidationException(f"Element {request.description} not found in image", request.description)
        return utils.GroundingOutput(
            description=data["description"],
            position=tuple(data["position"]),
        )
