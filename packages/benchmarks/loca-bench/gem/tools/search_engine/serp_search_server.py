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

# Adapted from https://github.com/PeterGriffinJin/Search-R1.

import argparse
import json
import os
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Optional

import requests
from mosec import Runtime, Server, Worker
from mosec.mixin import TypedMsgPackMixin
from msgspec import Struct


# --- Online Search Wrapper ---
class OnlineSearchEngine:
    def __init__(self, config):
        self.config = config

    def _search_query(self, query: str):
        params = {
            "engine": self.config.serp_engine,
            "q": query,
            "api_key": self.config.serp_api_key,
        }
        response = requests.get(self.config.search_url, params=params)
        return response.json()

    def batch_search(self, queries: List[str]):
        # TODO: @changyu maybe add per request topk
        results = []
        with ThreadPoolExecutor() as executor:
            for result in executor.map(self._search_query, queries):
                results.append(self._process_result(result))
        return results

    def _process_result(self, search_result: Dict):
        results = []

        answer_box = search_result.get("answer_box", {})
        if answer_box:
            title = answer_box.get("title", "No title.")
            snippet = answer_box.get("snippet", "No snippet available.")
            results.append(
                {
                    "document": {"contents": f'"{title}"\n{snippet}'},
                }
            )

        organic_results = search_result.get("organic_results", [])
        for _, result in enumerate(organic_results[: self.config.topk]):
            title = result.get("title", "No title.")
            snippet = result.get("snippet", "No snippet available.")
            results.append(
                {
                    "document": {"contents": f'"{title}"\n{snippet}'},
                }
            )

        related_results = search_result.get("related_questions", [])
        for _, result in enumerate(related_results[: self.config.topk]):
            title = result.get("question", "No title.")  # question is the title here
            snippet = result.get("snippet", "No snippet available.")
            results.append(
                {
                    "document": {"contents": f'"{title}"\n{snippet}'},
                }
            )

        return results


#####################################
# Mosec server
#####################################


class SearchRequest(Struct):
    query: str


class SearchResponse(Struct):
    result: List[Dict]


class Config:
    def __init__(
        self,
        search_url: str = "https://serpapi.com/search",
        topk: int = 3,
        serp_api_key: Optional[str] = None,
        serp_engine: Optional[str] = None,
    ):
        self.search_url = search_url
        self.topk = topk
        self.serp_api_key = serp_api_key
        self.serp_engine = serp_engine


class SearchWorker(TypedMsgPackMixin, Worker):
    def __init__(self):
        super().__init__()
        self.config = Config(**json.loads(os.environ.get("CONFIG")))
        self.engine = OnlineSearchEngine(self.config)

    def forward(self, requests: List[SearchRequest]) -> List[SearchResponse]:
        query_list = [request.query for request in requests]
        results = self.engine.batch_search(query_list)

        return [SearchResponse(result=result) for result in results]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Launch online search server.")
    parser.add_argument(
        "--search_url",
        type=str,
        default="https://serpapi.com/search",
        help="URL for search engine (e.g. https://serpapi.com/search)",
    )
    parser.add_argument(
        "--topk", type=int, default=3, help="Number of results to return per query"
    )
    parser.add_argument(
        "--serp_api_key", type=str, default=None, help="SerpAPI key for online search"
    )
    parser.add_argument(
        "--serp_engine",
        type=str,
        default="google",
        help="SerpAPI engine for online search",
    )
    parser.add_argument(
        "--max_wait_time",
        type=int,
        default=10,
        help="Maximum wait time for batching requests",
    )
    parser.add_argument(
        "--max_batch_size",
        type=int,
        default=10,
        help="Maximum batch size for the search server.",
    )
    parser.add_argument(
        "--num_workers",
        type=int,
        default=1,
        help="Number of worker processes for the search server.",
    )

    args = parser.parse_args()

    # Build config to pass to workers via environment variable
    config = {
        "search_url": args.search_url,
        "topk": args.topk,
        "serp_api_key": args.serp_api_key,
        "serp_engine": args.serp_engine,
    }

    server = Server()
    runtime = Runtime(
        worker=SearchWorker,
        num=args.num_workers,
        max_batch_size=args.max_batch_size,
        max_wait_time=args.max_wait_time,
        timeout=30,
        env=[{"CONFIG": json.dumps(config)} for _ in range(args.num_workers)],
    )

    server.register_runtime(
        {
            "/retrieve": [runtime],
        }
    )

    server.run()
