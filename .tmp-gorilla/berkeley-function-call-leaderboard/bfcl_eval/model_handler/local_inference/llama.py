from bfcl_eval.model_handler.local_inference.base_oss_handler import OSSHandler
from overrides import override


class LlamaHandler(OSSHandler):
    """
    This the handler for the Llama models in function calling mode.
    According to the Llama model card, function calling should be handled differently
    than what is suggested by the standard Hugging Face chat template. 
    For more details, see: 
    https://www.llama.com/docs/model-cards-and-prompt-formats/llama4_omni/#-zero-shot-function-calling---system-message-
    This applies to all Llama 3 and Llama 4 series models, except for Llama 3.1.
    
    In addition, because Llama uses the same system prompt as the default BFCL system
    prompt that's normally provided to the model in "prompt mode", the constructed 
    formatted prompt string remains same in both modes. 
    As a result, we will not have separate "prompt mode" for Llama models to avoid confusion.
    """

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
        self.model_name_huggingface = model_name.replace("-FC", "")

    @override
    def _format_prompt(self, messages, function):
        # For Llama 4 series, they use a different set of tokens than Llama 3
        if "Llama-4" in self.model_name:
            formatted_prompt = "<|begin_of_text|>"

            for message in messages:
                formatted_prompt += f"<|header_start|>{message['role']}<|header_end|>\n\n{message['content'].strip()}<|eot|>"

            formatted_prompt += f"<|header_start|>assistant<|header_end|>\n\n"
        # For Llama 3 series
        else:
            formatted_prompt = "<|begin_of_text|>"

            for message in messages:
                formatted_prompt += f"<|start_header_id|>{message['role']}<|end_header_id|>\n\n{message['content'].strip()}<|eot_id|>"

            formatted_prompt += f"<|start_header_id|>assistant<|end_header_id|>\n\n"

        return formatted_prompt

    @override
    def _add_execution_results_prompting(
        self, inference_data: dict, execution_results: list[str], model_response_data: dict
    ) -> dict:
        for execution_result in execution_results:
            # Llama uses the `ipython` role for execution results
            inference_data["message"].append(
                {
                    "role": "ipython",
                    "content": execution_result,
                }
            )

        return inference_data
