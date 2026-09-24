import base64

import numpy as np

from .engine import (
    LMMEngineAnthropic,
    LMMEngineAzureOpenAI,
    LMMEngineHuggingFace,
    LMMEngineOpenAI,
    LMMEngineLybic,
    LMMEngineOpenRouter,
    LMMEnginevLLM,
    LMMEngineGemini,
    LMMEngineQwen,
    LMMEngineDoubao,
    LMMEngineDeepSeek,
    LMMEngineZhipu,
    LMMEngineGroq,
    LMMEngineSiliconflow,
    LMMEngineMonica,
    LMMEngineAWSBedrock,
    OpenAIEmbeddingEngine,
    GeminiEmbeddingEngine,
    AzureOpenAIEmbeddingEngine,
    DashScopeEmbeddingEngine,
    DoubaoEmbeddingEngine,
    JinaEmbeddingEngine,
    BochaAISearchEngine,
    ExaResearchEngine,
)

class CostManager:
    """Cost manager, responsible for adding currency symbols based on engine type"""
    
    # Chinese engines use CNY
    CNY_ENGINES = {
        LMMEngineQwen, LMMEngineDoubao, LMMEngineDeepSeek, LMMEngineZhipu, 
        LMMEngineSiliconflow, DashScopeEmbeddingEngine, DoubaoEmbeddingEngine
    }
    # Other engines use USD
    USD_ENGINES = {
        LMMEngineOpenAI, LMMEngineLybic, LMMEngineAnthropic, LMMEngineAzureOpenAI, LMMEngineGemini,
        LMMEngineOpenRouter, LMMEnginevLLM, LMMEngineHuggingFace, LMMEngineGroq,
        LMMEngineMonica, LMMEngineAWSBedrock, OpenAIEmbeddingEngine, 
        GeminiEmbeddingEngine, AzureOpenAIEmbeddingEngine, JinaEmbeddingEngine
    }
    
    @classmethod
    def get_currency_symbol(cls, engine) -> str:
        engine_type = type(engine)
        
        if engine_type in cls.CNY_ENGINES:
            return "￥"
        elif engine_type in cls.USD_ENGINES:
            return "$"
        else:
            return "$"
    
    @classmethod
    def format_cost(cls, cost: float, engine) -> str:
        currency = cls.get_currency_symbol(engine)
        return f"{cost:.7f}{currency}"
    
    @classmethod
    def add_costs(cls, cost1: str, cost2: str) -> str:
        currency_symbols = ["$", "￥", "¥", "€", "£"]
        currency1 = currency2 = "$"
        value1 = value2 = 0.0
        
        if isinstance(cost1, (int, float)):
            value1 = float(cost1)
            currency1 = "$"
        else:
            cost1_str = str(cost1)
            for symbol in currency_symbols:
                if symbol in cost1_str:
                    value1 = float(cost1_str.replace(symbol, "").strip())
                    currency1 = symbol
                    break
            else:
                try:
                    value1 = float(cost1_str)
                    currency1 = "$"
                except:
                    value1 = 0.0
        
        if isinstance(cost2, (int, float)):
            value2 = float(cost2)
            currency2 = "$"
        else:
            cost2_str = str(cost2)
            for symbol in currency_symbols:
                if symbol in cost2_str:
                    value2 = float(cost2_str.replace(symbol, "").strip())
                    currency2 = symbol
                    break
            else:
                try:
                    value2 = float(cost2_str)
                    currency2 = "$"
                except:
                    value2 = 0.0
        
        if currency1 != currency2:
            print(f"Warning: Different currencies in cost accumulation: {currency1} and {currency2}")
            currency = currency1
        else:
            currency = currency1
        
        total_value = value1 + value2
        return f"{total_value:.6f}{currency}"

class LLMAgent:
    def __init__(self, engine_params=None, system_prompt=None, engine=None):
        if engine is None:
            if engine_params is not None:
                engine_type = engine_params.get("engine_type")
                if engine_type == "openai":
                    self.engine = LMMEngineOpenAI(**engine_params)
                elif engine_type == "lybic":
                    self.engine = LMMEngineLybic(**engine_params)
                elif engine_type == "anthropic":
                    self.engine = LMMEngineAnthropic(**engine_params)
                elif engine_type == "azure":
                    self.engine = LMMEngineAzureOpenAI(**engine_params)
                elif engine_type == "vllm":
                    self.engine = LMMEnginevLLM(**engine_params)
                elif engine_type == "huggingface":
                    self.engine = LMMEngineHuggingFace(**engine_params)
                elif engine_type == "gemini":
                    self.engine = LMMEngineGemini(**engine_params)
                elif engine_type == "openrouter":
                    self.engine = LMMEngineOpenRouter(**engine_params)
                elif engine_type == "dashscope":
                    self.engine = LMMEngineQwen(**engine_params)
                elif engine_type == "doubao":
                    self.engine = LMMEngineDoubao(**engine_params)
                elif engine_type == "deepseek":
                    self.engine = LMMEngineDeepSeek(**engine_params)
                elif engine_type == "zhipu":
                    self.engine = LMMEngineZhipu(**engine_params)
                elif engine_type == "groq":
                    self.engine = LMMEngineGroq(**engine_params)
                elif engine_type == "siliconflow":
                    self.engine = LMMEngineSiliconflow(**engine_params)
                elif engine_type == "monica":
                    self.engine = LMMEngineMonica(**engine_params)
                elif engine_type == "aws_bedrock":
                    self.engine = LMMEngineAWSBedrock(**engine_params)
                else:
                    raise ValueError("engine_type is not supported")
            else:
                raise ValueError("engine_params must be provided")
        else:
            self.engine = engine

        self.messages = []  # Empty messages

        if system_prompt:
            self.add_system_prompt(system_prompt)
        else:
            self.add_system_prompt("You are a helpful assistant.")

    def encode_image(self, image_content):
        # if image_content is a path to an image file, check type of the image_content to verify
        if isinstance(image_content, str):
            with open(image_content, "rb") as image_file:
                return base64.b64encode(image_file.read()).decode("utf-8")
        else:
            return base64.b64encode(image_content).decode("utf-8")

    def reset(
        self,
    ):

        self.messages = [
            {
                "role": "system",
                "content": [{"type": "text", "text": self.system_prompt}],
            }
        ]

    def add_system_prompt(self, system_prompt):
        self.system_prompt = system_prompt
        if len(self.messages) > 0:
            self.messages[0] = {
                "role": "system",
                "content": [{"type": "text", "text": self.system_prompt}],
            }
        else:
            self.messages.append(
                {
                    "role": "system",
                    "content": [{"type": "text", "text": self.system_prompt}],
                }
            )

    def remove_message_at(self, index):
        """Remove a message at a given index"""
        if index < len(self.messages):
            self.messages.pop(index)

    def replace_message_at(
        self, index, text_content, image_content=None, image_detail="high"
    ):
        """Replace a message at a given index"""
        if index < len(self.messages):
            self.messages[index] = {
                "role": self.messages[index]["role"],
                "content": [{"type": "text", "text": text_content}],
            }
            if image_content:
                base64_image = self.encode_image(image_content)
                self.messages[index]["content"].append(
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/png;base64,{base64_image}",
                            "detail": image_detail,
                        },
                    }
                )

    def add_message(
        self,
        text_content,
        image_content=None,
        role=None,
        image_detail="high",
        put_text_last=False,
    ):
        """Add a new message to the list of messages"""

        # API-style inference from OpenAI and similar services
        if isinstance(
            self.engine,
            (
                LMMEngineAnthropic,
                LMMEngineAzureOpenAI,
                LMMEngineHuggingFace,
                LMMEngineOpenAI,
                LMMEngineLybic,
                LMMEngineOpenRouter,
                LMMEnginevLLM,
                LMMEngineGemini,
                LMMEngineQwen,
                LMMEngineDoubao,
                LMMEngineDeepSeek,
                LMMEngineZhipu,
                LMMEngineGroq,
                LMMEngineSiliconflow,
                LMMEngineMonica,
                LMMEngineAWSBedrock,
            ),
        ):
            # infer role from previous message
            if role != "user":
                if self.messages[-1]["role"] == "system":
                    role = "user"
                elif self.messages[-1]["role"] == "user":
                    role = "assistant"
                elif self.messages[-1]["role"] == "assistant":
                    role = "user"

            message = {
                "role": role,
                "content": [{"type": "text", "text": text_content}],
            }

            if isinstance(image_content, np.ndarray) or image_content:
                # Check if image_content is a list or a single image
                if isinstance(image_content, list):
                    # If image_content is a list of images, loop through each image
                    for image in image_content:
                        base64_image = self.encode_image(image)
                        message["content"].append(
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:image/png;base64,{base64_image}",
                                    "detail": image_detail,
                                },
                            }
                        )
                else:
                    # If image_content is a single image, handle it directly
                    base64_image = self.encode_image(image_content)
                    message["content"].append(
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/png;base64,{base64_image}",
                                "detail": image_detail,
                            },
                        }
                    )

            # Rotate text to be the last message if desired
            if put_text_last:
                text_content = message["content"].pop(0)
                message["content"].append(text_content)

            self.messages.append(message)

        # For API-style inference from Anthropic
        elif isinstance(self.engine, (LMMEngineAnthropic, LMMEngineAWSBedrock)):
            # infer role from previous message
            if role != "user":
                if self.messages[-1]["role"] == "system":
                    role = "user"
                elif self.messages[-1]["role"] == "user":
                    role = "assistant"
                elif self.messages[-1]["role"] == "assistant":
                    role = "user"

            message = {
                "role": role,
                "content": [{"type": "text", "text": text_content}],
            }

            if image_content:
                # Check if image_content is a list or a single image
                if isinstance(image_content, list):
                    # If image_content is a list of images, loop through each image
                    for image in image_content:
                        base64_image = self.encode_image(image)
                        message["content"].append(
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": "image/png",
                                    "data": base64_image,
                                },
                            }
                        )
                else:
                    # If image_content is a single image, handle it directly
                    base64_image = self.encode_image(image_content)
                    message["content"].append(
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/png",
                                "data": base64_image,
                            },
                        }
                    )
            self.messages.append(message)

        # Locally hosted vLLM model inference
        elif isinstance(self.engine, LMMEnginevLLM):
            # infer role from previous message
            if role != "user":
                if self.messages[-1]["role"] == "system":
                    role = "user"
                elif self.messages[-1]["role"] == "user":
                    role = "assistant"
                elif self.messages[-1]["role"] == "assistant":
                    role = "user"

            message = {
                "role": role,
                "content": [{"type": "text", "text": text_content}],
            }

            if image_content:
                # Check if image_content is a list or a single image
                if isinstance(image_content, list):
                    # If image_content is a list of images, loop through each image
                    for image in image_content:
                        base64_image = self.encode_image(image)
                        message["content"].append(
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:image;base64,{base64_image}"
                                },
                            }
                        )
                else:
                    # If image_content is a single image, handle it directly
                    base64_image = self.encode_image(image_content)
                    message["content"].append(
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image;base64,{base64_image}"},
                        }
                    )

            self.messages.append(message)
        else:
            raise ValueError("engine_type is not supported")

    def get_response(
        self,
        user_message=None,
        messages=None,
        temperature=0.0,
        max_new_tokens=None,
        **kwargs,
    ):
        """Generate the next response based on previous messages"""
        if messages is None:
            messages = self.messages
        if user_message:
            messages.append(
                {"role": "user", "content": [{"type": "text", "text": user_message}]}
            )
    
        if isinstance(self.engine, LMMEngineLybic):
            content, total_tokens, cost = self.engine.generate(
                messages,
                max_new_tokens=max_new_tokens,  # type: ignore
                **kwargs,
            )
        else:
            content, total_tokens, cost = self.engine.generate(
                messages,
                temperature=temperature,
                max_new_tokens=max_new_tokens,  # type: ignore
                **kwargs,
            )
        
        cost_string = CostManager.format_cost(cost, self.engine)
        
        return content, total_tokens, cost_string

class EmbeddingAgent:
    def __init__(self, engine_params=None, engine=None):
        if engine is None:
            if engine_params is not None:
                engine_type = engine_params.get("engine_type")
                if engine_type == "openai":
                    self.engine = OpenAIEmbeddingEngine(**engine_params)
                elif engine_type == "gemini":
                    self.engine = GeminiEmbeddingEngine(**engine_params)
                elif engine_type == "azure":
                    self.engine = AzureOpenAIEmbeddingEngine(**engine_params)
                elif engine_type == "dashscope":
                    self.engine = DashScopeEmbeddingEngine(**engine_params)
                elif engine_type == "doubao":
                    self.engine = DoubaoEmbeddingEngine(**engine_params)
                elif engine_type == "jina":
                    self.engine = JinaEmbeddingEngine(**engine_params)
                else:
                    raise ValueError(f"Embedding engine type '{engine_type}' is not supported")
            else:
                raise ValueError("engine_params must be provided")
        else:
            self.engine = engine

    def get_embeddings(self, text):
        """Get embeddings for the given text
        
        Args:
            text (str): The text to get embeddings for
            
        Returns:
            numpy.ndarray: The embeddings for the text
        """
        embeddings, total_tokens, cost = self.engine.get_embeddings(text)
        cost_string = CostManager.format_cost(cost, self.engine)
        return embeddings, total_tokens, cost_string

    
    def get_similarity(self, text1, text2):
        """Calculate the cosine similarity between two texts
        
        Args:
            text1 (str): First text
            text2 (str): Second text
            
        Returns:
            float: Cosine similarity score between the two texts
        """
        embeddings1, tokens1, cost1 = self.get_embeddings(text1)
        embeddings2, tokens2, cost2 = self.get_embeddings(text2)
        
        # Calculate cosine similarity
        dot_product = np.dot(embeddings1, embeddings2)
        norm1 = np.linalg.norm(embeddings1)
        norm2 = np.linalg.norm(embeddings2)
        
        similarity = dot_product / (norm1 * norm2)
        total_tokens = tokens1 + tokens2
        total_cost = CostManager.add_costs(cost1, cost2)
        
        return similarity, total_tokens, total_cost
    
    def batch_get_embeddings(self, texts):
        """Get embeddings for multiple texts
        
        Args:
            texts (List[str]): List of texts to get embeddings for
            
        Returns:
            List[numpy.ndarray]: List of embeddings for each text
        """
        embeddings = []
        total_tokens = [0, 0, 0]
        if texts:
            first_embedding, first_tokens, first_cost = self.get_embeddings(texts[0])
            embeddings.append(first_embedding)
            total_tokens[0] += first_tokens[0]
            total_tokens[1] += first_tokens[1]
            total_tokens[2] += first_tokens[2]
            total_cost = first_cost
            
            for text in texts[1:]:
                embedding, tokens, cost = self.get_embeddings(text)
                embeddings.append(embedding)
                total_tokens[0] += tokens[0]
                total_tokens[1] += tokens[1]
                total_tokens[2] += tokens[2]
                total_cost = CostManager.add_costs(total_cost, cost)
        else:
            currency = CostManager.get_currency_symbol(self.engine)
            total_cost = f"0.0{currency}"
        
        return embeddings, total_tokens, total_cost


class WebSearchAgent:
    def __init__(self, engine_params=None, engine=None):
        if engine is None:
            if engine_params is not None:
                self.engine_type = engine_params.get("engine_type")
                if self.engine_type == "bocha":
                    self.engine = BochaAISearchEngine(**engine_params)
                elif self.engine_type == "exa":
                    self.engine = ExaResearchEngine(**engine_params)
                else:
                    raise ValueError(f"Web search engine type '{self.engine_type}' is not supported")
            else:
                raise ValueError("engine_params must be provided")
        else:
            self.engine = engine
    
    def get_answer(self, query, **kwargs):
        """Get a direct answer for the query
        
        Args:
            query (str): The search query
            **kwargs: Additional arguments to pass to the search engine
            
        Returns:
            str: The answer text
        """
        if isinstance(self.engine, BochaAISearchEngine):
            answer, tokens, cost = self.engine.get_answer(query, **kwargs)
            return answer, tokens, str(cost)

        elif isinstance(self.engine, ExaResearchEngine):
            # For Exa, we'll use the chat_research method which returns a complete answer
            # results, tokens, cost = self.engine.search(query, **kwargs)
            results, tokens, cost = self.engine.chat_research(query, **kwargs)
            if isinstance(results, dict) and "messages" in results:
                for message in results.get("messages", []):
                    if message.get("type") == "answer":
                        return message.get("content", ""), tokens, str(cost)
            return str(results), tokens, str(cost)

        else:
            raise ValueError(f"Web search engine type '{self.engine_type}' is not supported")
