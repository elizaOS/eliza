from bfcl_eval.model_handler.local_inference.base_oss_handler import OSSHandler
from overrides import override

"""
Note: 
This handler only have the `_format_prompt` method overridden to apply the chat template automatically. Other methods are inherited from the OSSHandler.
We DO NOT recommend using this handler directly. This handler only serve as a fallback, or for quick testing.
Formatting the prompt manually give us better control over the final formatted prompt and is generally recommended for advanced use cases.
"""


class QuickTestingOSSHandler(OSSHandler):
    def __init__(
        self,
        model_name,
        temperature,
        registry_name,
        is_fc_model,
        dtype="bfloat16",
        **kwargs,
    ) -> None:
        super().__init__(model_name, temperature, registry_name, is_fc_model, **kwargs)

    @override
    def _format_prompt(self, messages, function):

        formatted_prompt = self.tokenizer.apply_chat_template(
            messages, add_generation_prompt=True, tokenize=False
        )

        return formatted_prompt
