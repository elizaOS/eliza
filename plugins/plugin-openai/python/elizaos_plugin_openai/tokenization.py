from functools import lru_cache

import tiktoken
from tiktoken import Encoding


@lru_cache(maxsize=16)
def get_encoding_for_model(model_name: str) -> Encoding:
    try:
        return tiktoken.encoding_for_model(model_name)
    except KeyError:
        if "4o" in model_name.lower():
            return tiktoken.get_encoding("o200k_base")
        return tiktoken.get_encoding("cl100k_base")


def tokenize(text: str, model: str = "gpt-5") -> list[int]:
    encoding = get_encoding_for_model(model)
    return encoding.encode(text)


def detokenize(tokens: list[int], model: str = "gpt-5") -> str:
    encoding = get_encoding_for_model(model)
    return encoding.decode(tokens)


def count_tokens(text: str, model: str = "gpt-5") -> int:
    return len(tokenize(text, model))


def truncate_to_token_limit(text: str, max_tokens: int, model: str = "gpt-5") -> str:
    tokens = tokenize(text, model)
    if len(tokens) <= max_tokens:
        return text
    return detokenize(tokens[:max_tokens], model)
