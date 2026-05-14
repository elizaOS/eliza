import os
from bfcl_eval.constants.enums import ModelStyle
from openai import OpenAI
from bfcl_eval.model_handler.api_inference.mining import MiningHandler

class DMCitoHandler(MiningHandler):
    def __init__(
        self,
        model_name,
        temperature,
        registry_name,
        is_fc_model,
        **kwargs,
    ) -> None:
        super().__init__(model_name, temperature, registry_name, is_fc_model, **kwargs)
        self.model_style = ModelStyle.OPENAI_COMPLETIONS
        self.client = OpenAI(
            base_url= os.getenv("DMCITO_BASE_URL"),
            api_key=os.getenv("DMCITO_API_KEY"),
        )