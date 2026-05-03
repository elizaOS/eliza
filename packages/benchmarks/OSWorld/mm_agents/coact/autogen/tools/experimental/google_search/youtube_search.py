# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0


import logging
from typing import Annotated, Any, Dict, List, Optional

from ....doc_utils import export_module
from ....import_utils import optional_import_block, require_optional_import
from ... import Depends, Tool
from ...dependency_injection import on

with optional_import_block():
    import googleapiclient.errors
    from googleapiclient.discovery import build


@require_optional_import(
    ["googleapiclient"],
    "google-search",
)
def _execute_search_query(query: str, youtube_api_key: str, max_results: int) -> Any:
    """Execute a YouTube search query using the YouTube Data API.

    Args:
        query: The search query string.
        youtube_api_key: The API key for the YouTube Data API.
        max_results: The maximum number of results to return.

    Returns:
        The search response from the YouTube Data API.
    """
    youtube = build("youtube", "v3", developerKey=youtube_api_key)

    try:
        search_response = (
            youtube.search().list(q=query, part="id,snippet", maxResults=max_results, type="video").execute()
        )

        return search_response
    except googleapiclient.errors.HttpError as e:
        logging.error(f"An HTTP error occurred: {e}")
        raise


@require_optional_import(
    ["googleapiclient"],
    "google-search",
)
def _get_video_details(video_ids: List[str], youtube_api_key: str) -> Any:
    """Get detailed information about specific YouTube videos.

    Args:
        video_ids: List of YouTube video IDs.
        youtube_api_key: The API key for the YouTube Data API.

    Returns:
        The video details response from the YouTube Data API.
    """
    if not video_ids:
        return {"items": []}

    youtube = build("youtube", "v3", developerKey=youtube_api_key)

    try:
        videos_response = (
            youtube.videos().list(id=",".join(video_ids), part="snippet,contentDetails,statistics").execute()
        )

        return videos_response
    except googleapiclient.errors.HttpError as e:
        logging.error(f"An HTTP error occurred: {e}")
        raise


def _youtube_search(
    query: str,
    youtube_api_key: str,
    max_results: int,
    include_video_details: bool = True,
) -> List[Dict[str, Any]]:
    """Search YouTube videos based on a query.

    Args:
        query: The search query string.
        youtube_api_key: The API key for the YouTube Data API.
        max_results: The maximum number of results to return.
        include_video_details: Whether to include detailed video information.

    Returns:
        A list of dictionaries containing information about the videos.
    """
    search_response = _execute_search_query(query=query, youtube_api_key=youtube_api_key, max_results=max_results)

    results = []
    video_ids = []

    # Extract basic info from search results
    for item in search_response.get("items", []):
        if item["id"]["kind"] == "youtube#video":
            video_ids.append(item["id"]["videoId"])
            video_info = {
                "title": item["snippet"]["title"],
                "description": item["snippet"]["description"],
                "publishedAt": item["snippet"]["publishedAt"],
                "channelTitle": item["snippet"]["channelTitle"],
                "videoId": item["id"]["videoId"],
                "url": f"https://www.youtube.com/watch?v={item['id']['videoId']}",
            }
            results.append(video_info)

    # If detailed info requested, get it
    if include_video_details and video_ids:
        video_details = _get_video_details(video_ids, youtube_api_key)

        # Create a mapping of videoId to details
        details_map = {item["id"]: item for item in video_details.get("items", [])}

        # Update results with additional details
        for result in results:
            video_id = result["videoId"]
            if video_id in details_map:
                details = details_map[video_id]
                result.update({
                    "viewCount": details["statistics"].get("viewCount"),
                    "likeCount": details["statistics"].get("likeCount"),
                    "commentCount": details["statistics"].get("commentCount"),
                    "duration": details["contentDetails"].get("duration"),
                    "definition": details["contentDetails"].get("definition"),
                })

    return results


@export_module("autogen.tools.experimental")
class YoutubeSearchTool(Tool):
    """YoutubeSearchTool is a tool that uses the YouTube Data API to search for videos."""

    def __init__(
        self,
        *,
        youtube_api_key: Optional[str] = None,
    ):
        """Initialize a YouTube search tool.

        Args:
            youtube_api_key: The API key for the YouTube Data API.
        """
        self.youtube_api_key = youtube_api_key

        if youtube_api_key is None:
            raise ValueError("youtube_api_key must be provided")

        def youtube_search(
            query: Annotated[str, "The search query for YouTube videos."],
            youtube_api_key: Annotated[str, Depends(on(youtube_api_key))],
            max_results: Annotated[int, "The maximum number of results to return."] = 5,
            include_video_details: Annotated[bool, "Whether to include detailed video information."] = True,
        ) -> List[Dict[str, Any]]:
            """Search for YouTube videos based on a query.

            Args:
                query: The search query string.
                youtube_api_key: The API key for the YouTube Data API.
                max_results: The maximum number of results to return.
                include_video_details: Whether to include detailed video information.

            Returns:
                A list of dictionaries containing information about the videos.
            """
            if youtube_api_key is None:
                raise ValueError("YouTube API key is required")

            return _youtube_search(query, youtube_api_key, max_results, include_video_details)

        super().__init__(
            name="youtube_search",
            description="Search for YouTube videos based on a query, optionally including detailed information.",
            func_or_tool=youtube_search,
        )
