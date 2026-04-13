"""
Module: perplexity_search_tool
Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
SPDX-License-Identifier: Apache-2.0

This module provides classes for interacting with the Perplexity AI search API.
It defines data models for responses and a tool for executing web and conversational searches.
"""

import json
import os
from typing import Any, Optional, Union

import requests
from pydantic import BaseModel, ValidationError

from autogen.tools import Tool


class Message(BaseModel):
    """
    Represents a message in the chat conversation.

    Attributes:
        role (str): The role of the message sender (e.g., "system", "user").
        content (str): The text content of the message.
    """

    role: str
    content: str


class Usage(BaseModel):
    """
    Model representing token usage details.

    Attributes:
        prompt_tokens (int): The number of tokens used for the prompt.
        completion_tokens (int): The number of tokens generated in the completion.
        total_tokens (int): The total number of tokens (prompt + completion).
        search_context_size (str): The size context used in the search (e.g., "high").
    """

    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    search_context_size: str


class Choice(BaseModel):
    """
    Represents one choice in the response from the Perplexity API.

    Attributes:
        index (int): The index of this choice.
        finish_reason (str): The reason why the API finished generating this choice.
        message (Message): The message object containing the response text.
    """

    index: int
    finish_reason: str
    message: Message


class PerplexityChatCompletionResponse(BaseModel):
    """
    Represents the full chat completion response from the Perplexity API.

    Attributes:
        id (str): Unique identifier for the response.
        model (str): The model name used for generating the response.
        created (int): Timestamp when the response was created.
        usage (Usage): Token usage details.
        citations (list[str]): list of citation strings included in the response.
        object (str): Type of the response object.
        choices (list[Choice]): list of choices returned by the API.
    """

    id: str
    model: str
    created: int
    usage: Usage
    citations: list[str]
    object: str
    choices: list[Choice]


class SearchResponse(BaseModel):
    """
    Represents the response from a search query.

    Attributes:
        content (Optional[str]): The textual content returned from the search.
        citations (Optional[list[str]]): A list of citation URLs relevant to the search result.
        error (Optional[str]): An error message if the search failed.
    """

    content: Union[str, None]
    citations: Union[list[str], None]
    error: Union[str, None]


class PerplexitySearchTool(Tool):
    """
    Tool for interacting with the Perplexity AI search API.

    This tool uses the Perplexity API to perform web search, news search,
    and conversational search, returning concise and precise responses.

    Attributes:
        url (str): API endpoint URL.
        model (str): Name of the model to be used.
        api_key (str): API key for authenticating with the Perplexity API.
        max_tokens (int): Maximum tokens allowed for the API response.
        search_domain_filters (Optional[list[str]]): Optional list of domain filters for the search.
    """

    def __init__(
        self,
        model: str = "sonar",
        api_key: Optional[str] = None,
        max_tokens: int = 1000,
        search_domain_filter: Optional[list[str]] = None,
    ):
        """
        Initializes a new instance of the PerplexitySearchTool.

        Args:
            model (str, optional): The model to use. Defaults to "sonar".
            api_key (Optional[str], optional): API key for authentication.
            max_tokens (int, optional): Maximum number of tokens for the response. Defaults to 1000.
            search_domain_filter (Optional[list[str]], optional): list of domain filters to restrict search.

        Raises:
            ValueError: If the API key is missing, the model is empty, max_tokens is not positive,
                        or if search_domain_filter is not a list when provided.
        """
        self.api_key = api_key or os.getenv("PERPLEXITY_API_KEY")
        self._validate_tool_config(model, self.api_key, max_tokens, search_domain_filter)
        self.url = "https://api.perplexity.ai/chat/completions"
        self.model = model
        self.max_tokens = max_tokens
        self.search_domain_filters = search_domain_filter
        super().__init__(
            name="perplexity-search",
            description="Perplexity AI search tool for web search, news search, and conversational search "
            "for finding answers to everyday questions, conducting in-depth research and analysis.",
            func_or_tool=self.search,
        )

    @staticmethod
    def _validate_tool_config(
        model: str, api_key: Union[str, None], max_tokens: int, search_domain_filter: Union[list[str], None]
    ) -> None:
        """
        Validates the configuration parameters for the search tool.

        Args:
            model (str): The model to use.
            api_key (Union[str, None]): The API key for authentication.
            max_tokens (int): Maximum tokens allowed.
            search_domain_filter (Union[list[str], None]): Domain filters for search.

        Raises:
            ValueError: If the API key is missing, model is empty, max_tokens is not positive,
                        or search_domain_filter is not a list.
        """
        if not api_key:
            raise ValueError("Perplexity API key is missing")
        if not model:
            raise ValueError("model cannot be empty")
        if max_tokens <= 0:
            raise ValueError("max_tokens must be positive")
        if search_domain_filter is not None and not isinstance(search_domain_filter, list):
            raise ValueError("search_domain_filter must be a list")

    def _execute_query(self, payload: dict[str, Any]) -> "PerplexityChatCompletionResponse":
        """
        Executes a query by sending a POST request to the Perplexity API.

        Args:
            payload (dict[str, Any]): The payload to send in the API request.

        Returns:
            PerplexityChatCompletionResponse: Parsed response from the Perplexity API.

        Raises:
            RuntimeError: If there is a network error, HTTP error, JSON parsing error, or if the response
                          cannot be parsed into a PerplexityChatCompletionResponse.
        """
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        response = requests.request("POST", self.url, json=payload, headers=headers, timeout=10)
        try:
            response.raise_for_status()
        except requests.exceptions.Timeout as e:
            raise RuntimeError(
                f"Perplexity API => Request timed out: {response.text}. Status code: {response.status_code}"
            ) from e
        except requests.exceptions.HTTPError as e:
            raise RuntimeError(
                f"Perplexity API => HTTP error occurred: {response.text}. Status code: {response.status_code}"
            ) from e
        except requests.exceptions.RequestException as e:
            raise RuntimeError(
                f"Perplexity API => Error during request: {response.text}. Status code: {response.status_code}"
            ) from e

        try:
            response_json = response.json()
        except json.JSONDecodeError as e:
            raise RuntimeError(f"Perplexity API => Invalid JSON response received. Error: {e}") from e

        try:
            # This may raise a pydantic.ValidationError if the response structure is not as expected.
            perp_resp = PerplexityChatCompletionResponse(**response_json)
        except ValidationError as e:
            raise RuntimeError("Perplexity API => Validation error when parsing API response: " + str(e)) from e
        except Exception as e:
            raise RuntimeError(
                "Perplexity API => Failed to parse API response into PerplexityChatCompletionResponse: " + str(e)
            ) from e

        return perp_resp

    def search(self, query: str) -> "SearchResponse":
        """
        Perform a search query using the Perplexity AI API.

        Constructs the payload, executes the query, and parses the response to return
        a concise search result along with any provided citations.

        Args:
            query (str): The search query.

        Returns:
            SearchResponse: A model containing the search result content and citations.

        Raises:
            ValueError: If the search query is invalid.
            RuntimeError: If there is an error during the search process.
        """
        if not query or not isinstance(query, str):
            raise ValueError("A valid non-empty query string must be provided.")

        payload = {
            "model": self.model,
            "messages": [{"role": "system", "content": "Be precise and concise."}, {"role": "user", "content": query}],
            "max_tokens": self.max_tokens,
            "search_domain_filter": self.search_domain_filters,
            "web_search_options": {"search_context_size": "high"},
        }

        try:
            perplexity_response = self._execute_query(payload)
            content = perplexity_response.choices[0].message.content
            citations = perplexity_response.citations
            return SearchResponse(content=content, citations=citations, error=None)
        except Exception as e:
            # Return a SearchResponse with an error message if something goes wrong.
            return SearchResponse(content=None, citations=None, error=f"{e}")
