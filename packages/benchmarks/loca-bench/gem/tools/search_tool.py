# Copyright 2025 AxonRL Team. All Rights Reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Adapted from https://github.com/PeterGriffinJin/Search-R1

import os
import re
from typing import Tuple

import msgspec
import requests

from gem.tools.base_tool import BaseTool

# Timeout for search request in seconds
TIMEOUT = 5


class SearchTool(BaseTool):
    tool_type = "search"

    def __init__(self, num_workers=1, search_url=None, topk=3, timeout=TIMEOUT):
        super().__init__(num_workers)
        self.search_url = search_url
        self.topk = topk
        self.timeout = timeout
        self._search_url_resolved = self.search_url is not None

    def _parse_action(self, action: str) -> Tuple[str, str, bool]:
        """
        Parse the action string to extract the <search> content and the full matched tag.
        Returns (content, parsed_action, is_valid)
        """
        # only take the first match
        pattern = r"<search>(.*?)</search>"
        match = re.search(pattern, action, re.DOTALL)
        if match:
            parsed_query = match.group(1).strip()
            parsed_action = action[: match.end()]  # including thinking process
            return parsed_query, parsed_action, True
        else:
            return "", "", False

    def _search(self, query: str):
        """
        Perform a search using the configured search_url.
        Returns a formatted string of search results.
        """
        if not self._search_url_resolved:
            self.search_url = self.search_url or os.environ.get("SEARCH_URL")
            self._search_url_resolved = True

        if not self.search_url:
            raise ValueError("search_url must be provided for SearchTool.")

        payload = {"query": query, "topk": self.topk, "return_scores": True}
        try:
            response = requests.post(
                self.search_url,
                data=msgspec.msgpack.encode(payload),
                timeout=self.timeout,
            )
            response.raise_for_status()
            result = msgspec.msgpack.decode(response.content)["result"]
            return self._passages2string(result)
        except Exception as e:
            return f"[SearchTool Error: {e}]"

    def _passages2string(self, result):
        format_reference = ""
        for idx, doc_item in enumerate(result):
            content = doc_item["document"]["contents"]
            title = content.split("\n")[0]
            text = "\n".join(content.split("\n")[1:])
            format_reference += f"Doc {idx+1}(Title: {title}) {text}\n"
        return format_reference

    def instruction_string(self) -> str:
        return (
            "You have access to a search engine to help answer questions.\n\n"
            "Additional instructions:\n"
            "- If your initial reasoning in <think> shows you lack some knowledge, explain what you need to find next inside a new <think> block.\n"
            "- Then issue a search query using:\n"
            "  <search> your query here </search>\n"
            "- The search engine will provide results inside:\n"
            "  <information> ... </information>\n"
            "- You may repeat the <think> and <search> steps as many times as needed.\n"
            "- When you are ready, give your final answer in:\n"
            "  <answer> your answer here </answer>"
        )

    def execute_action(self, action: str):
        """
        Execute the parsed action for the SearchTool.

        Args:
            action: The raw action string, typically containing a search query
                within <search>...</search> tags.

        Returns:
            observation: The formatted search result, or an empty string if invalid.
            done: Always False for search tool (search does not terminate the episode).
            valid: True if a valid search query was found and executed, False otherwise.
        """
        parsed_query, parsed_action, is_valid = self._parse_action(action)
        if not is_valid:
            # observation = "No valid search query found. Please provide your query within <search>...</search> tags."
            observation = ""
            valid = False
            has_error = True
        else:
            search_result = self._search(parsed_query)
            observation = search_result
            valid = True
            has_error = "[SearchTool Error:" in search_result
        return valid, has_error, observation, parsed_action
