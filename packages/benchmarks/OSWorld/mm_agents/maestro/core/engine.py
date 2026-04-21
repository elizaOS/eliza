import os
import json
import logging
import backoff

logger = logging.getLogger()
doubao_logger = logging.getLogger("doubao_api")
import requests
from typing import List, Dict, Any, Optional, Union
import numpy as np
from anthropic import Anthropic
from openai import (
    AzureOpenAI,
    APIConnectionError,
    APIError,
    AzureOpenAI,
    OpenAI,
    RateLimitError,
)
from google import genai
from google.genai import types
from zhipuai import ZhipuAI
from groq import Groq
import boto3
import exa_py
from typing import List, Dict, Any, Optional, Union, Tuple

class ModelPricing:
    def __init__(self, pricing_file: str = "model_pricing.json"):
        self.pricing_file = pricing_file
        self.pricing_data = self._load_pricing()
    
    def _load_pricing(self) -> Dict:
        if os.path.exists(self.pricing_file):
            try:
                with open(self.pricing_file, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception as e:
                print(f"Warning: Failed to load pricing file {self.pricing_file}: {e}")
        
        return {
            "default": {"input": 0, "output": 0}
        }
    
    def get_price(self, model: str) -> Dict[str, float]:
        # Handle nested pricing data structure
        if "llm_models" in self.pricing_data:
            # Iterate through all LLM model categories
            for category, models in self.pricing_data["llm_models"].items():
                # Direct model name matching
                if model in models:
                    pricing = models[model]
                    return self._parse_pricing(pricing)
                
                # Fuzzy matching for model names
                for model_name in models:
                    if model_name in model or model in model_name:
                        pricing = models[model_name]
                        return self._parse_pricing(pricing)
        
        # Handle embedding models
        if "embedding_models" in self.pricing_data:
            for category, models in self.pricing_data["embedding_models"].items():
                if model in models:
                    pricing = models[model]
                    return self._parse_pricing(pricing)
                
                for model_name in models:
                    if model_name in model or model in model_name:
                        pricing = models[model_name]
                        return self._parse_pricing(pricing)
        
        # Default pricing
        return {"input": 0, "output": 0}
    
    def _parse_pricing(self, pricing: Dict[str, str]) -> Dict[str, float]:
        """Parse pricing strings and convert to numeric values"""
        result = {}
        
        for key, value in pricing.items():
            if isinstance(value, str):
                # Remove currency symbols and units, convert to float
                clean_value = value.replace('$', '').replace('￥', '').replace(',', '')
                try:
                    result[key] = float(clean_value)
                except ValueError:
                    result[key] = 0.0
            else:
                result[key] = float(value) if value else 0.0
        
        return result
    
    def calculate_cost(self, model: str, input_tokens: int, output_tokens: int) -> float:
        pricing = self.get_price(model)
        input_cost = (input_tokens / 1000000) * pricing["input"]
        output_cost = (output_tokens / 1000000) * pricing["output"]
        return input_cost + output_cost

# Initialize pricing manager with correct pricing file path
pricing_file = os.path.join(os.path.dirname(__file__), 'model_pricing.json')
pricing_manager = ModelPricing(pricing_file)

def extract_token_usage(response, provider: str) -> Tuple[int, int]:
    if "-" in provider:
        api_type, vendor = provider.split("-", 1)
    else:
        api_type, vendor = "llm", provider

    if api_type == "llm":
        if vendor in ["openai", "qwen", "deepseek", "doubao", "siliconflow", "monica", "vllm", "groq", "zhipu", "gemini", "openrouter", "azureopenai", "huggingface", "exa", "lybic"]:
            if hasattr(response, 'usage') and response.usage:
                return response.usage.prompt_tokens, response.usage.completion_tokens
        
        elif vendor == "anthropic":
            if hasattr(response, 'usage') and response.usage:
                return response.usage.input_tokens, response.usage.output_tokens
        
        elif vendor == "bedrock":
            if isinstance(response, dict) and "usage" in response:
                usage = response["usage"]
                return usage.get("input_tokens", 0), usage.get("output_tokens", 0)
    
    elif api_type == "embedding":
        if vendor in ["openai", "azureopenai", "qwen", "doubao"]:
            if hasattr(response, 'usage') and response.usage:
                return response.usage.prompt_tokens, 0
        
        elif vendor == "jina":
            if isinstance(response, dict) and "usage" in response:
                total_tokens = response["usage"].get("total_tokens", 0)
                return total_tokens, 0
        
        elif vendor == "gemini":
            if hasattr(response, 'usage') and response.usage:
                return response.usage.prompt_tokens, 0

    return 0, 0

def calculate_tokens_and_cost(response, provider: str, model: str) -> Tuple[List[int], float]:
    input_tokens, output_tokens = extract_token_usage(response, provider)
    total_tokens = input_tokens + output_tokens
    cost = pricing_manager.calculate_cost(model, input_tokens, output_tokens)
    
    return [input_tokens, output_tokens, total_tokens], cost

class LMMEngine:
    pass

# ==================== LLM ====================

class LMMEngineOpenAI(LMMEngine):
    def __init__(
        self, base_url=None, api_key=None, model=None, rate_limit=-1, **kwargs
    ):
        assert model is not None, "model must be provided"
        self.model = model
        self.provider = "llm-openai"

        api_key = api_key or os.getenv("OPENAI_API_KEY")
        if api_key is None:
            raise ValueError(
                "An API Key needs to be provided in either the api_key parameter or as an environment variable named OPENAI_API_KEY"
            )

        self.base_url = base_url

        self.api_key = api_key
        self.request_interval = 0 if rate_limit == -1 else 60.0 / rate_limit

        if not self.base_url:
            self.llm_client = OpenAI(api_key=self.api_key)
        else:
            self.llm_client = OpenAI(base_url=self.base_url, api_key=self.api_key)

    @backoff.on_exception(
        backoff.expo, (APIConnectionError, APIError, RateLimitError), max_time=60
    )
    def generate(self, messages, temperature=0.0, max_new_tokens=None, **kwargs):
        """Generate the next message based on previous messages"""
        response = self.llm_client.chat.completions.create(
            model=self.model,
            messages=messages,
            max_completion_tokens=max_new_tokens if max_new_tokens else 8192,
            **({} if self.model in ["o3", "o3-pro"] else {"temperature": temperature}),
            **kwargs,
        )
        
        content = response.choices[0].message.content
        total_tokens, cost = calculate_tokens_and_cost(response, self.provider, self.model)
        
        return content, total_tokens, cost


class LMMEngineLybic(LMMEngine):
    def __init__(
        self, base_url=None, api_key=None, model=None, rate_limit=-1, **kwargs
    ):
        assert model is not None, "model must be provided"
        self.model = model
        self.provider = "llm-lybic"

        api_key = api_key or os.getenv("LYBIC_LLM_API_KEY")
        if api_key is None:
            raise ValueError(
                "An API Key needs to be provided in either the api_key parameter or as an environment variable named LYBIC_LLM_API_KEY"
            )

        self.base_url = base_url or "https://aigw.lybicai.com/v1"
        self.api_key = api_key
        self.request_interval = 0 if rate_limit == -1 else 60.0 / rate_limit

        self.llm_client = OpenAI(base_url=self.base_url, api_key=self.api_key)

    @backoff.on_exception(
        backoff.expo, (APIConnectionError, APIError, RateLimitError), max_time=60
    )
    def generate(self, messages, temperature=1, max_new_tokens=None, **kwargs):
        """Generate the next message based on previous messages"""
        response = self.llm_client.chat.completions.create(
            model=self.model,
            messages=messages,
            max_completion_tokens=max_new_tokens if max_new_tokens else 8192,
            # temperature=temperature,
            **kwargs,
        )
        
        content = response.choices[0].message.content
        total_tokens, cost = calculate_tokens_and_cost(response, self.provider, self.model)
        
        return content, total_tokens, cost


class LMMEngineQwen(LMMEngine):
    def __init__(
        self, base_url=None, api_key=None, model=None, rate_limit=-1, enable_thinking=False, **kwargs
    ):
        assert model is not None, "model must be provided"
        self.model = model
        self.enable_thinking = enable_thinking
        self.provider = "llm-qwen"

        api_key = api_key or os.getenv("DASHSCOPE_API_KEY")
        if api_key is None:
            raise ValueError(
                "An API Key needs to be provided in either the api_key parameter or as an environment variable named DASHSCOPE_API_KEY"
            )

        self.base_url = base_url or "https://dashscope.aliyuncs.com/compatible-mode/v1"
        self.api_key = api_key
        self.request_interval = 0 if rate_limit == -1 else 60.0 / rate_limit

        self.llm_client = OpenAI(base_url=self.base_url, api_key=self.api_key)

    @backoff.on_exception(
        backoff.expo, (APIConnectionError, APIError, RateLimitError), max_time=60
    )
    def generate(self, messages, temperature=0.0, max_new_tokens=None, **kwargs):
        """Generate the next message based on previous messages"""
        # For Qwen3 models, we need to handle thinking mode
        extra_body = {}
        if self.model.startswith("qwen3") and not self.enable_thinking:
            extra_body["enable_thinking"] = False

        response = self.llm_client.chat.completions.create(
            model=self.model,
            messages=messages,
            max_completion_tokens=max_new_tokens if max_new_tokens else 8192,
            temperature=temperature,
            **extra_body,
            **kwargs,
        )
        
        content = response.choices[0].message.content
        total_tokens, cost = calculate_tokens_and_cost(response, self.provider, self.model)
        
        return content, total_tokens, cost


class LMMEngineDoubao(LMMEngine):
    def __init__(
        self, base_url=None, api_key=None, model=None, rate_limit=-1, **kwargs
    ):
        assert model is not None, "model must be provided"
        self.model = model
        self.provider = "llm-doubao"

        api_key = api_key or os.getenv("ARK_API_KEY")
        if api_key is None:
            raise ValueError(
                "An API Key needs to be provided in either the api_key parameter or as an environment variable named ARK_API_KEY"
            )

        self.base_url = base_url or "https://ark.cn-beijing.volces.com/api/v3"
        self.api_key = api_key
        self.request_interval = 0 if rate_limit == -1 else 60.0 / rate_limit

        self.llm_client = OpenAI(base_url=self.base_url, api_key=self.api_key)

    @backoff.on_exception(
        backoff.expo, (APIConnectionError, APIError, RateLimitError), max_time=60
    )
    def generate(self, messages, temperature=0.0, max_new_tokens=None, **kwargs):
        """Generate the next message based on previous messages"""
        
        # doubao_logger.info(f"Doubao API Call - Model: {self.model}, Temperature: {temperature}, Max Tokens: {max_new_tokens}")
        # doubao_logger.info(f"Doubao API Input - Messages count: {len(messages)}")
        # doubao_logger.info(f"Doubao API Input - messages: {messages}")
        
        response = self.llm_client.chat.completions.create(
            model=self.model,
            messages=messages,
            max_completion_tokens=max_new_tokens if max_new_tokens else 8192,
            temperature=temperature,
            extra_body={
                "thinking": {
                    "type": "disabled",
                    # "type": "enabled",
                    # "type": "auto",
                }
            },
            **kwargs,
        )
        
        content = response.choices[0].message.content
        total_tokens, cost = calculate_tokens_and_cost(response, self.provider, self.model)
        
        # doubao_logger.info(f"Doubao API Response - Content length: {len(content) if content else 0}, Tokens: {total_tokens}, Cost: {cost}")

        # doubao_logger.info(f"Doubao API Response - Content: {content}")
        
        return content, total_tokens, cost


class LMMEngineAnthropic(LMMEngine):
    def __init__(
        self, base_url=None, api_key=None, model=None, thinking=False, **kwargs
    ):
        assert model is not None, "model must be provided"
        self.model = model
        self.thinking = thinking
        self.provider = "llm-anthropic"

        api_key = api_key or os.getenv("ANTHROPIC_API_KEY")
        if api_key is None:
            raise ValueError(
                "An API Key needs to be provided in either the api_key parameter or as an environment variable named ANTHROPIC_API_KEY"
            )

        self.api_key = api_key

        self.llm_client = Anthropic(api_key=self.api_key)

    @backoff.on_exception(
        backoff.expo, (APIConnectionError, APIError, RateLimitError), max_time=60
    )
    def generate(self, messages, temperature=0.0, max_new_tokens=None, **kwargs):
        """Generate the next message based on previous messages"""
        if self.thinking:
            response = self.llm_client.messages.create(
                system=messages[0]["content"][0]["text"],
                model=self.model,
                messages=messages[1:],
                max_tokens=8192,
                thinking={"type": "enabled", "budget_tokens": 4096},
                **kwargs,
            )
            thoughts = response.content[0].thinking
            print("CLAUDE 3.7 THOUGHTS:", thoughts)
            content = response.content[1].text
        else:
            response = self.llm_client.messages.create(
                system=messages[0]["content"][0]["text"],
                model=self.model,
                messages=messages[1:],
                max_tokens=max_new_tokens if max_new_tokens else 8192,
                temperature=temperature,
                **kwargs,
            )
            content = response.content[0].text
        
        total_tokens, cost = calculate_tokens_and_cost(response, self.provider, self.model)
        return content, total_tokens, cost


class LMMEngineGemini(LMMEngine):
    def __init__(
        self, base_url=None, api_key=None, model=None, rate_limit=-1, **kwargs
    ):
        assert model is not None, "model must be provided"
        self.model = model
        self.provider = "llm-gemini"

        api_key = api_key or os.getenv("GEMINI_API_KEY")
        if api_key is None:
            raise ValueError(
                "An API Key needs to be provided in either the api_key parameter or as an environment variable named GEMINI_API_KEY"
            )

        self.base_url = base_url or os.getenv("GEMINI_ENDPOINT_URL")
        if self.base_url is None:
            raise ValueError(
                "An endpoint URL needs to be provided in either the endpoint_url parameter or as an environment variable named GEMINI_ENDPOINT_URL"
            )

        self.api_key = api_key
        self.request_interval = 0 if rate_limit == -1 else 60.0 / rate_limit

        self.llm_client = OpenAI(base_url=self.base_url, api_key=self.api_key)

    @backoff.on_exception(
        backoff.expo, (APIConnectionError, APIError, RateLimitError), max_time=60
    )
    def generate(self, messages, temperature=0.0, max_new_tokens=None, **kwargs):
        """Generate the next message based on previous messages"""
        response = self.llm_client.chat.completions.create(
            model=self.model,
            messages=messages,
            max_completion_tokens=max_new_tokens if max_new_tokens else 8192,
            temperature=temperature,
            # reasoning_effort="low",
            extra_body={
                'extra_body': {
                    "google": {
                        "thinking_config": {
                            "thinking_budget": 128,
                            "include_thoughts": True
                        }
                    }
                }
            },
            **kwargs,
        )
        
        content = response.choices[0].message.content
        total_tokens, cost = calculate_tokens_and_cost(response, self.provider, self.model)
        
        return content, total_tokens, cost



class LMMEngineOpenRouter(LMMEngine):
    def __init__(
        self, base_url=None, api_key=None, model=None, rate_limit=-1, **kwargs
    ):
        assert model is not None, "model must be provided"
        self.model = model
        self.provider = "llm-openrouter"

        api_key = api_key or os.getenv("OPENROUTER_API_KEY")
        if api_key is None:
            raise ValueError(
                "An API Key needs to be provided in either the api_key parameter or as an environment variable named OPENROUTER_API_KEY"
            )

        self.base_url = base_url or os.getenv("OPEN_ROUTER_ENDPOINT_URL")
        if self.base_url is None:
            raise ValueError(
                "An endpoint URL needs to be provided in either the endpoint_url parameter or as an environment variable named OPEN_ROUTER_ENDPOINT_URL"
            )

        self.api_key = api_key
        self.request_interval = 0 if rate_limit == -1 else 60.0 / rate_limit

        self.llm_client = OpenAI(base_url=self.base_url, api_key=self.api_key)

    @backoff.on_exception(
        backoff.expo, (APIConnectionError, APIError, RateLimitError), max_time=60
    )
    def generate(self, messages, temperature=0.0, max_new_tokens=None, **kwargs):
        """Generate the next message based on previous messages"""
        response = self.llm_client.chat.completions.create(
            model=self.model,
            messages=messages,
            max_completion_tokens=max_new_tokens if max_new_tokens else 8192,
            temperature=temperature,
            **kwargs,
        )
        
        content = response.choices[0].message.content
        total_tokens, cost = calculate_tokens_and_cost(response, self.provider, self.model)
        
        return content, total_tokens, cost


class LMMEngineAzureOpenAI(LMMEngine):
    def __init__(
        self,
        base_url=None,
        api_key=None,
        azure_endpoint=None,
        model=None,
        api_version=None,
        rate_limit=-1,
        **kwargs
    ):
        assert model is not None, "model must be provided"
        self.model = model
        self.provider = "llm-azureopenai"

        assert api_version is not None, "api_version must be provided"
        self.api_version = api_version

        api_key = api_key or os.getenv("AZURE_OPENAI_API_KEY")
        if api_key is None:
            raise ValueError(
                "An API Key needs to be provided in either the api_key parameter or as an environment variable named AZURE_OPENAI_API_KEY"
            )

        self.api_key = api_key

        azure_endpoint = azure_endpoint or os.getenv("AZURE_OPENAI_ENDPOINT")
        if azure_endpoint is None:
            raise ValueError(
                "An Azure API endpoint needs to be provided in either the azure_endpoint parameter or as an environment variable named AZURE_OPENAI_ENDPOINT"
            )

        self.azure_endpoint = azure_endpoint
        self.request_interval = 0 if rate_limit == -1 else 60.0 / rate_limit

        self.llm_client = AzureOpenAI(
            azure_endpoint=self.azure_endpoint,
            api_key=self.api_key,
            api_version=self.api_version,
        )
        self.cost = 0.0

    # @backoff.on_exception(backoff.expo, (APIConnectionError, APIError, RateLimitError), max_tries=10)
    def generate(self, messages, temperature=0.0, max_new_tokens=None, **kwargs):
        """Generate the next message based on previous messages"""
        response = self.llm_client.chat.completions.create(
            model=self.model,
            messages=messages,
            max_completion_tokens=max_new_tokens if max_new_tokens else 8192,
            temperature=temperature,
            **kwargs,
        )
        content = response.choices[0].message.content
        total_tokens, cost = calculate_tokens_and_cost(response, self.provider, self.model)
        return content, total_tokens, cost


class LMMEnginevLLM(LMMEngine):
    def __init__(
        self, base_url=None, api_key=None, model=None, rate_limit=-1, **kwargs
    ):
        assert model is not None, "model must be provided"
        self.model = model
        self.api_key = api_key
        self.provider = "llm-vllm"

        self.base_url = base_url or os.getenv("vLLM_ENDPOINT_URL")
        if self.base_url is None:
            raise ValueError(
                "An endpoint URL needs to be provided in either the endpoint_url parameter or as an environment variable named vLLM_ENDPOINT_URL"
            )

        self.request_interval = 0 if rate_limit == -1 else 60.0 / rate_limit

        self.llm_client = OpenAI(base_url=self.base_url, api_key=self.api_key)

    # @backoff.on_exception(backoff.expo, (APIConnectionError, APIError, RateLimitError), max_tries=10)
    # TODO: Default params chosen for the Qwen model
    def generate(
        self,
        messages,
        temperature=0.0,
        top_p=0.8,
        repetition_penalty=1.05,
        max_new_tokens=512,
        **kwargs
    ):
        """Generate the next message based on previous messages"""
        response = self.llm_client.chat.completions.create(
            model=self.model,
            messages=messages,
            max_completion_tokens=max_new_tokens if max_new_tokens else 8192,
            temperature=temperature,
            top_p=top_p,
            extra_body={"repetition_penalty": repetition_penalty},
        )
        content = response.choices[0].message.content
        total_tokens, cost = calculate_tokens_and_cost(response, self.provider, self.model)
        return content, total_tokens, cost


class LMMEngineHuggingFace(LMMEngine):
    def __init__(self, base_url=None, api_key=None, rate_limit=-1, **kwargs):
        assert base_url is not None, "HuggingFace endpoint must be provided"
        self.base_url = base_url
        self.model = base_url.split('/')[-1] if base_url else "huggingface-tgi"
        self.provider = "llm-huggingface"

        api_key = api_key or os.getenv("HF_TOKEN")
        if api_key is None:
            raise ValueError(
                "A HuggingFace token needs to be provided in either the api_key parameter or as an environment variable named HF_TOKEN"
            )

        self.api_key = api_key
        self.request_interval = 0 if rate_limit == -1 else 60.0 / rate_limit

        self.llm_client = OpenAI(base_url=self.base_url, api_key=self.api_key)

    @backoff.on_exception(
        backoff.expo, (APIConnectionError, APIError, RateLimitError), max_time=60
    )
    def generate(self, messages, temperature=0.0, max_new_tokens=None, **kwargs):
        """Generate the next message based on previous messages"""
        response = self.llm_client.chat.completions.create(
            model="tgi",
            messages=messages,
            max_completion_tokens=max_new_tokens if max_new_tokens else 8192,
            temperature=temperature,
            **kwargs,
        )
        
        content = response.choices[0].message.content
        total_tokens, cost = calculate_tokens_and_cost(response, self.provider, self.model)
        
        return content, total_tokens, cost


class LMMEngineDeepSeek(LMMEngine):
    def __init__(
        self, base_url=None, api_key=None, model=None, rate_limit=-1, **kwargs
    ):
        assert model is not None, "model must be provided"
        self.model = model
        self.provider = "llm-deepseek"

        api_key = api_key or os.getenv("DEEPSEEK_API_KEY")
        if api_key is None:
            raise ValueError(
                "An API Key needs to be provided in either the api_key parameter or as an environment variable named DEEPSEEK_API_KEY"
            )

        self.base_url = base_url or "https://api.deepseek.com"
        self.api_key = api_key
        self.request_interval = 0 if rate_limit == -1 else 60.0 / rate_limit

        self.llm_client = OpenAI(base_url=self.base_url, api_key=self.api_key)

    @backoff.on_exception(
        backoff.expo, (APIConnectionError, APIError, RateLimitError), max_time=60
    )
    def generate(self, messages, temperature=0.0, max_new_tokens=None, **kwargs):
        """Generate the next message based on previous messages"""
        response = self.llm_client.chat.completions.create(
            model=self.model,
            messages=messages,
            max_completion_tokens=max_new_tokens if max_new_tokens else 8192,
            temperature=temperature,
            **kwargs,
        )
        
        content = response.choices[0].message.content
        total_tokens, cost = calculate_tokens_and_cost(response, self.provider, self.model)
        return content, total_tokens, cost


class LMMEngineZhipu(LMMEngine):
    def __init__(
        self, base_url=None, api_key=None, model=None, rate_limit=-1, **kwargs
    ):
        assert model is not None, "model must be provided"
        self.model = model
        self.provider = "llm-zhipu"

        api_key = api_key or os.getenv("ZHIPU_API_KEY")
        if api_key is None:
            raise ValueError(
                "An API Key needs to be provided in either the api_key parameter or as an environment variable named ZHIPU_API_KEY"
            )

        self.api_key = api_key
        self.request_interval = 0 if rate_limit == -1 else 60.0 / rate_limit

        # Use ZhipuAI client directly instead of OpenAI compatibility layer
        self.llm_client = ZhipuAI(api_key=self.api_key)

    @backoff.on_exception(
        backoff.expo, (APIConnectionError, APIError, RateLimitError), max_time=60
    )
    def generate(self, messages, temperature=0.0, max_new_tokens=None, **kwargs):
        """Generate the next message based on previous messages"""
        response = self.llm_client.chat.completions.create(
            model=self.model,
            messages=messages,
            max_tokens=max_new_tokens if max_new_tokens else 8192,
            temperature=temperature,
            **kwargs,
        )
        
        content = response.choices[0].message.content # type: ignore
        total_tokens, cost = calculate_tokens_and_cost(response, self.provider, self.model)
        return content, total_tokens, cost



class LMMEngineGroq(LMMEngine):
    def __init__(
        self, base_url=None, api_key=None, model=None, rate_limit=-1, **kwargs
    ):
        assert model is not None, "model must be provided"
        self.model = model
        self.provider = "llm-groq"

        api_key = api_key or os.getenv("GROQ_API_KEY")
        if api_key is None:
            raise ValueError(
                "An API Key needs to be provided in either the api_key parameter or as an environment variable named GROQ_API_KEY"
            )

        self.api_key = api_key
        self.request_interval = 0 if rate_limit == -1 else 60.0 / rate_limit

        # Use Groq client directly
        self.llm_client = Groq(api_key=self.api_key)

    @backoff.on_exception(
        backoff.expo, (APIConnectionError, APIError, RateLimitError), max_time=60
    )
    def generate(self, messages, temperature=0.0, max_new_tokens=None, **kwargs):
        """Generate the next message based on previous messages"""
        response = self.llm_client.chat.completions.create(
            model=self.model,
            messages=messages,
            max_completion_tokens=max_new_tokens if max_new_tokens else 8192,
            temperature=temperature,
            **kwargs,
        )
        
        content = response.choices[0].message.content
        total_tokens, cost = calculate_tokens_and_cost(response, self.provider, self.model)
        return content, total_tokens, cost


class LMMEngineSiliconflow(LMMEngine):
    def __init__(
        self, base_url=None, api_key=None, model=None, rate_limit=-1, **kwargs
    ):
        assert model is not None, "model must be provided"
        self.model = model
        self.provider = "llm-siliconflow"

        api_key = api_key or os.getenv("SILICONFLOW_API_KEY")
        if api_key is None:
            raise ValueError(
                "An API Key needs to be provided in either the api_key parameter or as an environment variable named SILICONFLOW_API_KEY"
            )

        self.base_url = base_url or "https://api.siliconflow.cn/v1"
        self.api_key = api_key
        self.request_interval = 0 if rate_limit == -1 else 60.0 / rate_limit

        self.llm_client = OpenAI(base_url=self.base_url, api_key=self.api_key)

    @backoff.on_exception(
        backoff.expo, (APIConnectionError, APIError, RateLimitError), max_time=60
    )
    def generate(self, messages, temperature=0.0, max_new_tokens=None, **kwargs):
        """Generate the next message based on previous messages"""
        response = self.llm_client.chat.completions.create(
            model=self.model,
            messages=messages,
            max_completion_tokens=max_new_tokens if max_new_tokens else 8192,
            temperature=temperature,
            **kwargs,
        )
        
        content = response.choices[0].message.content
        total_tokens, cost = calculate_tokens_and_cost(response, self.provider, self.model)
        return content, total_tokens, cost


class LMMEngineMonica(LMMEngine):
    def __init__(
        self, base_url=None, api_key=None, model=None, rate_limit=-1, **kwargs
    ):
        assert model is not None, "model must be provided"
        self.model = model
        self.provider = "llm-monica"

        api_key = api_key or os.getenv("MONICA_API_KEY")
        if api_key is None:
            raise ValueError(
                "An API Key needs to be provided in either the api_key parameter or as an environment variable named MONICA_API_KEY"
            )

        self.base_url = base_url or "https://openapi.monica.im/v1"
        self.api_key = api_key
        self.request_interval = 0 if rate_limit == -1 else 60.0 / rate_limit

        self.llm_client = OpenAI(base_url=self.base_url, api_key=self.api_key)

    @backoff.on_exception(
        backoff.expo, (APIConnectionError, APIError, RateLimitError), max_time=60
    )
    def generate(self, messages, temperature=0.0, max_new_tokens=None, **kwargs):
        """Generate the next message based on previous messages"""
        response = self.llm_client.chat.completions.create(
            model=self.model,
            messages=messages,
            max_completion_tokens=max_new_tokens if max_new_tokens else 8192,
            temperature=temperature,
            **kwargs,
        )
        
        content = response.choices[0].message.content
        total_tokens, cost = calculate_tokens_and_cost(response, self.provider, self.model)
        return content, total_tokens, cost


class LMMEngineAWSBedrock(LMMEngine):
    def __init__(
        self,
        aws_access_key=None,
        aws_secret_key=None,
        aws_region=None,
        model=None,
        rate_limit=-1,
        **kwargs
    ):
        assert model is not None, "model must be provided"
        self.model = model
        self.provider = "llm-bedrock"

        # Claude model mapping for AWS Bedrock
        self.claude_model_map = {
            "claude-opus-4": "anthropic.claude-opus-4-20250514-v1:0",
            "claude-sonnet-4": "anthropic.claude-sonnet-4-20250514-v1:0",
            "claude-3-7-sonnet": "anthropic.claude-3-7-sonnet-20250219-v1:0",
            "claude-3-5-sonnet": "anthropic.claude-3-5-sonnet-20241022-v2:0",
            "claude-3-5-sonnet-20241022": "anthropic.claude-3-5-sonnet-20241022-v2:0",
            "claude-3-5-sonnet-20240620": "anthropic.claude-3-5-sonnet-20240620-v1:0",
            "claude-3-5-haiku": "anthropic.claude-3-5-haiku-20241022-v1:0",
            "claude-3-haiku": "anthropic.claude-3-haiku-20240307-v1:0",
            "claude-3-sonnet": "anthropic.claude-3-sonnet-20240229-v1:0",
            "claude-3-opus": "anthropic.claude-3-opus-20240229-v1:0",
        }

        # Get the actual Bedrock model ID
        self.bedrock_model_id = self.claude_model_map.get(model, model)

        # AWS credentials
        aws_access_key = aws_access_key or os.getenv("AWS_ACCESS_KEY_ID")
        aws_secret_key = aws_secret_key or os.getenv("AWS_SECRET_ACCESS_KEY")
        aws_region = aws_region or os.getenv("AWS_DEFAULT_REGION") or "us-west-2"

        if aws_access_key is None:
            raise ValueError(
                "AWS Access Key needs to be provided in either the aws_access_key parameter or as an environment variable named AWS_ACCESS_KEY_ID"
            )
        if aws_secret_key is None:
            raise ValueError(
                "AWS Secret Key needs to be provided in either the aws_secret_key parameter or as an environment variable named AWS_SECRET_ACCESS_KEY"
            )

        self.aws_region = aws_region
        self.request_interval = 0 if rate_limit == -1 else 60.0 / rate_limit

        # Initialize Bedrock client
        self.bedrock_client = boto3.client(
            service_name="bedrock-runtime",
            region_name=aws_region,
            aws_access_key_id=aws_access_key,
            aws_secret_access_key=aws_secret_key
        )

    @backoff.on_exception(
        backoff.expo, (APIConnectionError, APIError, RateLimitError), max_time=60
    )
    def generate(self, messages, temperature=0.0, max_new_tokens=None, **kwargs):
        """Generate the next message based on previous messages"""

        # Convert messages to Bedrock format
        # Extract system message if present
        system_message = None
        user_messages = []

        for message in messages:
            if message["role"] == "system":
                if isinstance(message["content"], list):
                    system_message = message["content"][0]["text"]
                else:
                    system_message = message["content"]
            else:
                # Handle both list and string content formats
                if isinstance(message["content"], list):
                    content = message["content"][0]["text"] if message["content"] else ""
                else:
                    content = message["content"]

                user_messages.append({
                    "role": message["role"],
                    "content": content
                })

        # Prepare the body for Bedrock
        body = {
            "max_completion_tokens": max_new_tokens if max_new_tokens else 8192,
            "messages": user_messages,
            "anthropic_version": "bedrock-2023-05-31"
        }

        if temperature > 0:
            body["temperature"] = temperature

        if system_message:
            body["system"] = system_message

        try:
            response = self.bedrock_client.invoke_model(
                body=json.dumps(body),
                modelId=self.bedrock_model_id
            )

            response_body = json.loads(response.get("body").read())

            if "content" in response_body and response_body["content"]:
                content = response_body["content"][0]["text"]
            else:
                raise ValueError("No content in response")
            
            total_tokens, cost = calculate_tokens_and_cost(response_body, self.provider, self.model)
            return content, total_tokens, cost

        except Exception as e:
            print(f"AWS Bedrock error: {e}")
            raise

# ==================== Embedding ====================

class OpenAIEmbeddingEngine(LMMEngine):
    def __init__(
        self,
        embedding_model: str = "text-embedding-3-small",
        api_key=None,
        **kwargs
    ):
        """Init an OpenAI Embedding engine

        Args:
            embedding_model (str, optional): Model name. Defaults to "text-embedding-3-small".
            api_key (_type_, optional): Auth key from OpenAI. Defaults to None.
        """
        self.model = embedding_model
        self.provider = "embedding-openai"

        api_key = api_key or os.getenv("OPENAI_API_KEY")
        if api_key is None:
            raise ValueError(
                "An API Key needs to be provided in either the api_key parameter or as an environment variable named OPENAI_API_KEY"
            )
        self.api_key = api_key

    @backoff.on_exception(
        backoff.expo,
        (
            APIError,
            RateLimitError,
            APIConnectionError,
        ),
    )
    def get_embeddings(self, text: str) -> Tuple[np.ndarray, List[int], float]:
        client = OpenAI(api_key=self.api_key)
        response = client.embeddings.create(model=self.model, input=text)
        
        embeddings = np.array([data.embedding for data in response.data])
        total_tokens, cost = calculate_tokens_and_cost(response, self.provider, self.model)
        
        return embeddings, total_tokens, cost



class GeminiEmbeddingEngine(LMMEngine):
    def __init__(
        self,
        embedding_model: str = "text-embedding-004",
        api_key=None,
        **kwargs
    ):
        """Init an Gemini Embedding engine

        Args:
            embedding_model (str, optional): Model name. Defaults to "text-embedding-004".
            api_key (_type_, optional): Auth key from Gemini. Defaults to None.
        """
        self.model = embedding_model
        self.provider = "embedding-gemini"

        api_key = api_key or os.getenv("GEMINI_API_KEY")
        if api_key is None:
            raise ValueError(
                "An API Key needs to be provided in either the api_key parameter or as an environment variable named GEMINI_API_KEY"
            )
        self.api_key = api_key

    @backoff.on_exception(
        backoff.expo,
        (
            APIError,
            RateLimitError,
            APIConnectionError,
        ),
    )
    def get_embeddings(self, text: str) -> Tuple[np.ndarray, List[int], float]:
        client = genai.Client(api_key=self.api_key)

        result = client.models.embed_content(
            model=self.model,
            contents=text,
            config=types.EmbedContentConfig(task_type="SEMANTIC_SIMILARITY"),
        )

        embeddings = np.array([i.values for i in result.embeddings]) # type: ignore
        total_tokens, cost = calculate_tokens_and_cost(result, self.provider, self.model)
        
        return embeddings, total_tokens, cost



class AzureOpenAIEmbeddingEngine(LMMEngine):
    def __init__(
        self,
        embedding_model: str = "text-embedding-3-small",
        api_key=None,
        api_version=None,
        endpoint_url=None,
        **kwargs
    ):
        """Init an Azure OpenAI Embedding engine

        Args:
            embedding_model (str, optional): Model name. Defaults to "text-embedding-3-small".
            api_key (_type_, optional): Auth key from Azure OpenAI. Defaults to None.
            api_version (_type_, optional): API version. Defaults to None.
            endpoint_url (_type_, optional): Endpoint URL. Defaults to None.
        """
        self.model = embedding_model
        self.provider = "embedding-azureopenai"

        api_key = api_key or os.getenv("AZURE_OPENAI_API_KEY")
        if api_key is None:
            raise ValueError(
                "An API Key needs to be provided in either the api_key parameter or as an environment variable named AZURE_OPENAI_API_KEY"
            )
        self.api_key = api_key

        api_version = api_version or os.getenv("OPENAI_API_VERSION")
        if api_version is None:
            raise ValueError(
                "An API Version needs to be provided in either the api_version parameter or as an environment variable named OPENAI_API_VERSION"
            )
        self.api_version = api_version

        endpoint_url = endpoint_url or os.getenv("AZURE_OPENAI_ENDPOINT")
        if endpoint_url is None:
            raise ValueError(
                "An Endpoint URL needs to be provided in either the endpoint_url parameter or as an environment variable named AZURE_OPENAI_ENDPOINT"
            )
        self.endpoint_url = endpoint_url

    @backoff.on_exception(
        backoff.expo,
        (
            APIError,
            RateLimitError,
            APIConnectionError,
        ),
    )
    def get_embeddings(self, text: str) -> Tuple[np.ndarray, List[int], float]:
        client = AzureOpenAI(
            api_key=self.api_key,
            api_version=self.api_version,
            azure_endpoint=self.endpoint_url,
        )
        response = client.embeddings.create(input=text, model=self.model)
        
        embeddings = np.array([data.embedding for data in response.data])
        total_tokens, cost = calculate_tokens_and_cost(response, self.provider, self.model)
        
        return embeddings, total_tokens, cost


class DashScopeEmbeddingEngine(LMMEngine):
    def __init__(
        self,
        embedding_model: str = "text-embedding-v4",
        api_key=None,
        dimensions: int = 1024,
        **kwargs
    ):
        """Init a DashScope Embedding engine

        Args:
            embedding_model (str, optional): Model name. Defaults to "text-embedding-v4".
            api_key (_type_, optional): Auth key from DashScope. Defaults to None.
            dimensions (int, optional): Embedding dimensions. Defaults to 1024.
        """
        self.model = embedding_model
        self.dimensions = dimensions
        self.provider = "embedding-qwen"

        api_key = api_key or os.getenv("DASHSCOPE_API_KEY")
        if api_key is None:
            raise ValueError(
                "An API Key needs to be provided in either the api_key parameter or as an environment variable named DASHSCOPE_API_KEY"
            )
        self.api_key = api_key

        # Initialize OpenAI client with DashScope base URL
        self.client = OpenAI(
            api_key=self.api_key,
            base_url="https://dashscope.aliyuncs.com/compatible-mode/v1"
        )

    @backoff.on_exception(
        backoff.expo,
        (
                APIError,
                RateLimitError,
                APIConnectionError,
        ),
    )
    def get_embeddings(self, text: str) -> Tuple[np.ndarray, List[int], float]:
        response = self.client.embeddings.create(
            model=self.model,
            input=text,
            dimensions=self.dimensions,
            encoding_format="float"
        )
        
        embeddings = np.array([data.embedding for data in response.data])
        total_tokens, cost = calculate_tokens_and_cost(response, self.provider, self.model)
        
        return embeddings, total_tokens, cost



class DoubaoEmbeddingEngine(LMMEngine):
    def __init__(
        self,
        embedding_model: str = "doubao-embedding-256",
        api_key=None,
        **kwargs
    ):
        """Init a Doubao Embedding engine

        Args:
            embedding_model (str, optional): Model name. Defaults to "doubao-embedding-256".
            api_key (_type_, optional): Auth key from Doubao. Defaults to None.
        """
        self.model = embedding_model
        self.provider = "embedding-doubao"

        api_key = api_key or os.getenv("ARK_API_KEY")
        if api_key is None:
            raise ValueError(
                "An API Key needs to be provided in either the api_key parameter or as an environment variable named ARK_API_KEY"
            )
        self.api_key = api_key
        self.base_url = "https://ark.cn-beijing.volces.com/api/v3"

        # Use OpenAI-compatible client for text embeddings
        self.client = OpenAI(
            api_key=self.api_key,
            base_url=self.base_url
        )

    @backoff.on_exception(
        backoff.expo,
        (
                APIError,
                RateLimitError,
                APIConnectionError,
        ),
    )
    def get_embeddings(self, text: str) -> Tuple[np.ndarray, List[int], float]:
        # Log embedding request
        logger.info(f"Doubao Embedding API Call - Model: {self.model}, Text length: {len(text)}")
        doubao_logger.info(f"Doubao Embedding API Call - Model: {self.model}, Text length: {len(text)}")
        
        response = self.client.embeddings.create(
            model=self.model,
            input=text,
            encoding_format="float"
        )
        
        embeddings = np.array([data.embedding for data in response.data])
        total_tokens, cost = calculate_tokens_and_cost(response, self.provider, self.model)
        
        # Log embedding response
        logger.info(f"Doubao Embedding API Response - Embedding dimension: {embeddings.shape}, Tokens: {total_tokens}, Cost: {cost}")
        doubao_logger.info(f"Doubao Embedding API Response - Embedding dimension: {embeddings.shape}, Tokens: {total_tokens}, Cost: {cost}")
        
        return embeddings, total_tokens, cost


class JinaEmbeddingEngine(LMMEngine):
    def __init__(
        self,
        embedding_model: str = "jina-embeddings-v4",
        api_key=None,
        task: str = "retrieval.query",
        **kwargs
    ):
        """Init a Jina AI Embedding engine

        Args:
            embedding_model (str, optional): Model name. Defaults to "jina-embeddings-v4".
            api_key (_type_, optional): Auth key from Jina AI. Defaults to None.
            task (str, optional): Task type. Options: "retrieval.query", "retrieval.passage", "text-matching". Defaults to "retrieval.query".
        """
        self.model = embedding_model
        self.task = task
        self.provider = "embedding-jina" 

        api_key = api_key or os.getenv("JINA_API_KEY")
        if api_key is None:
            raise ValueError(
                "An API Key needs to be provided in either the api_key parameter or as an environment variable named JINA_API_KEY"
            )
        self.api_key = api_key
        self.base_url = "https://api.jina.ai/v1"

    @backoff.on_exception(
        backoff.expo,
        (
                APIError,
                RateLimitError,
                APIConnectionError,
        ),
    )
    def get_embeddings(self, text: str) -> Tuple[np.ndarray, List[int], float]:
        import requests

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}"
        }

        data = {
            "model": self.model,
            "task": self.task,
            "input": [
                {
                    "text": text
                }
            ]
        }

        response = requests.post(
            f"{self.base_url}/embeddings",
            headers=headers,
            json=data
        )

        if response.status_code != 200:
            raise Exception(f"Jina AI API error: {response.text}")

        result = response.json()
        embeddings = np.array([data["embedding"] for data in result["data"]])
        
        total_tokens, cost = calculate_tokens_and_cost(result, self.provider, self.model)
    
        return embeddings, total_tokens, cost


# ==================== webSearch ====================
class SearchEngine:
    """Base class for search engines"""
    pass

class BochaAISearchEngine(SearchEngine):
    def __init__(
            self,
            api_key: str|None = None,
            base_url: str = "https://api.bochaai.com/v1",
            rate_limit: int = -1,
            **kwargs
    ):
        """Init a Bocha AI Search engine

        Args:
            api_key (str, optional): Auth key from Bocha AI. Defaults to None.
            base_url (str, optional): Base URL for the API. Defaults to "https://api.bochaai.com/v1".
            rate_limit (int, optional): Rate limit per minute. Defaults to -1 (no limit).
        """
        api_key = api_key or os.getenv("BOCHA_API_KEY")
        if api_key is None:
            raise ValueError(
                "An API Key needs to be provided in either the api_key parameter or as an environment variable named BOCHA_API_KEY"
            )

        self.api_key = api_key
        self.base_url = base_url
        self.endpoint = f"{base_url}/ai-search"
        self.request_interval = 0 if rate_limit == -1 else 60.0 / rate_limit

    @backoff.on_exception(
        backoff.expo,
        (
                APIConnectionError,
                APIError,
                RateLimitError,
                requests.exceptions.RequestException,
        ),
        max_time=60
    )
    def search(
            self,
            query: str,
            freshness: str = "noLimit",
            answer: bool = True,
            stream: bool = False,
            **kwargs
    ) -> Union[Dict[str, Any], Any]:
        """Search with AI and return intelligent answer

        Args:
            query (str): Search query
            freshness (str, optional): Freshness filter. Defaults to "noLimit".
            answer (bool, optional): Whether to return answer. Defaults to True.
            stream (bool, optional): Whether to stream response. Defaults to False.

        Returns:
            Union[Dict[str, Any], Any]: AI search results with sources and answer
        """
        headers = {
            'Authorization': f'Bearer {self.api_key}',
            'Content-Type': 'application/json'
        }

        payload = {
            "query": query,
            "freshness": freshness,
            "answer": answer,
            "stream": stream,
            **kwargs
        }

        if stream:
            result = self._stream_search(headers, payload)
            return result, [0, 0, 0], 0.06
        else:
            result = self._regular_search(headers, payload)
            return result, [0, 0, 0], 0.06


    def _regular_search(self, headers: Dict[str, str], payload: Dict[str, Any]) -> Dict[str, Any]:
        """Regular non-streaming search"""
        response = requests.post(
            self.endpoint,
            headers=headers,
            json=payload
        )

        if response.status_code != 200:
            raise APIError(f"Bocha AI Search API error: {response.text}") # type: ignore

        return response.json()

    def _stream_search(self, headers: Dict[str, str], payload: Dict[str, Any]):
        """Streaming search response"""
        response = requests.post(
            self.endpoint,
            headers=headers,
            json=payload,
            stream=True
        )

        if response.status_code != 200:
            raise APIError(f"Bocha AI Search API error: {response.text}") # type: ignore

        for line in response.iter_lines():
            if line:
                line = line.decode('utf-8')
                if line.startswith('data:'):
                    data = line[5:].strip()
                    if data and data != '{"event":"done"}':
                        try:
                            yield json.loads(data)
                        except json.JSONDecodeError:
                            continue

    def get_answer(self, query: str, **kwargs) -> Tuple[str, int, float]:
        """Get AI generated answer only"""
        result, _, remaining_balance = self.search(query, answer=True, **kwargs)

        # Extract answer from messages
        messages = result.get("messages", []) # type: ignore
        answer = ""
        for message in messages:
            if message.get("type") == "answer":
                answer = message.get("content", "")
                break

        return answer, [0,0,0], remaining_balance # type: ignore


    def get_sources(self, query: str, **kwargs) -> List[Dict[str, Any]]:
        """Get source materials only"""
        result, _, remaining_balance = self.search(query, **kwargs)

        # Extract sources from messages
        sources = []
        messages = result.get("messages", []) # type: ignore
        for message in messages:
            if message.get("type") == "source":
                content_type = message.get("content_type", "")
                if content_type in ["webpage", "image", "video", "baike_pro", "medical_common"]:
                    sources.append({
                        "type": content_type,
                        "content": json.loads(message.get("content", "{}"))
                    })

        return sources, 0, remaining_balance # type: ignore


    def get_follow_up_questions(self, query: str, **kwargs) -> List[str]:
        """Get follow-up questions"""
        result, _, remaining_balance = self.search(query, **kwargs)

        # Extract follow-up questions from messages
        follow_ups = []
        messages = result.get("messages", []) # type: ignore
        for message in messages:
            if message.get("type") == "follow_up":
                follow_ups.append(message.get("content", ""))

        return follow_ups, 0, remaining_balance # type: ignore


class ExaResearchEngine(SearchEngine):
    def __init__(
            self,
            api_key: str|None = None,
            base_url: str = "https://api.exa.ai",
            rate_limit: int = -1,
            **kwargs
    ):
        """Init an Exa Research engine

        Args:
            api_key (str, optional): Auth key from Exa AI. Defaults to None.
            base_url (str, optional): Base URL for the API. Defaults to "https://api.exa.ai".
            rate_limit (int, optional): Rate limit per minute. Defaults to -1 (no limit).
        """
        api_key = api_key or os.getenv("EXA_API_KEY")
        if api_key is None:
            raise ValueError(
                "An API Key needs to be provided in either the api_key parameter or as an environment variable named EXA_API_KEY"
            )

        self.api_key = api_key
        self.base_url = base_url
        self.request_interval = 0 if rate_limit == -1 else 60.0 / rate_limit

        # Initialize OpenAI-compatible client for chat completions
        self.chat_client = OpenAI(
            base_url=base_url,
            api_key=api_key
        )

        # Initialize Exa client for research tasks
        try:
            from exa_py import Exa
            self.exa_client = Exa(api_key=api_key)
        except ImportError:
            self.exa_client = None
            print("Warning: exa_py not installed. Research tasks will not be available.")

    @backoff.on_exception(
        backoff.expo,
        (
                APIConnectionError,
                APIError,
                RateLimitError,
        ),
        max_time=60
    )
    def search(self, query: str, **kwargs):
        """Standard Exa search with direct cost from API

        Args:
            query (str): Search query
            **kwargs: Additional search parameters

        Returns:
            tuple: (result, tokens, cost) where cost is actual API cost
        """
        headers = {
            'x-api-key': self.api_key,
            'Content-Type': 'application/json'
        }
        
        payload = {
            "query": query,
            **kwargs
        }
        
        response = requests.post(
            f"{self.base_url}/search",
            headers=headers,
            json=payload
        )
        
        if response.status_code != 200:
            raise APIError(f"Exa Search API error: {response.text}") # type: ignore
        
        result = response.json()
        
        cost = 0.0
        if "costDollars" in result:
            cost = result["costDollars"].get("total", 0.0)
        
        return result, [0, 0, 0], cost
    
    def chat_research(
            self,
            query: str,
            model: str = "exa",
            stream: bool = False,
            **kwargs
    ) -> Union[str, Any]:
        """Research using chat completions interface

        Args:
            query (str): Research query
            model (str, optional): Model name. Defaults to "exa".
            stream (bool, optional): Whether to stream response. Defaults to False.

        Returns:
            Union[str, Any]: Research result or stream
        """
        messages = [
            {"role": "user", "content": query}
        ]

        if stream:
            completion = self.chat_client.chat.completions.create(
                model=model,
                messages=messages, # type: ignore
                stream=True,
                **kwargs
            )
            return completion
        else:
            completion = self.chat_client.chat.completions.create(
                model=model,
                messages=messages, # type: ignore
                **kwargs
            )
            result = completion.choices[0].message.content # type: ignore
            return result,[0,0,0],0.005
