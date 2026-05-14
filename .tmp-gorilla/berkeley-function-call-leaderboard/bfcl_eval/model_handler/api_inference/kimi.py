import os
from bfcl_eval.model_handler.api_inference.openai_completion import OpenAICompletionsHandler
from openai import OpenAI


class KimiHandler(OpenAICompletionsHandler):
    def __init__(
        self,
        model_name,
        temperature,
        registry_name,
        is_fc_model,
        **kwargs,
    ) -> None:
        super().__init__(model_name, temperature, registry_name, is_fc_model, **kwargs)

        self.client = OpenAI(
            base_url="https://api.moonshot.ai/v1", 
            # If API Key is from US platform, use the above URL
            # If API Key is from China platform, use the below URL
            # base_url="https://api.moonshot.cn/v1", 
            api_key=os.getenv("KIMI_API_KEY")
        )
