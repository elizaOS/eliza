"""50 distractor actions across 9 domains for semantic disambiguation pressure."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.types.components import (
    Action,
    ActionParameter,
    ActionParameterSchema,
    ActionResult,
    HandlerOptions,
)

if TYPE_CHECKING:
    from elizaos.types.memory import Memory
    from elizaos.types.runtime import IAgentRuntime
    from elizaos.types.state import State


@dataclass
class DistractorSpec:
    """Declarative specification for a distractor action."""

    name: str
    description: str
    similes: list[str]
    tags: list[str]
    domain: str
    parameters: list[dict[str, str]] = field(default_factory=list)



async def _noop_handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
    options: HandlerOptions | None,
    callback: object | None,
    responses: list[Memory] | None,
) -> ActionResult:
    result = ActionResult()
    result.success = True
    return result


async def _always_valid(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None,
) -> bool:
    return True


DEFI_ACTIONS: list[DistractorSpec] = [
    DistractorSpec(
        name="SWAP_TOKENS",
        description="Swap one cryptocurrency token for another on a decentralised exchange",
        similes=["trade tokens", "exchange crypto", "convert tokens", "token swap"],
        tags=["defi", "trading", "blockchain"],
        domain="defi",
        parameters=[
            {"name": "from_token", "type": "string", "description": "Token to sell"},
            {"name": "to_token", "type": "string", "description": "Token to buy"},
            {"name": "amount", "type": "string", "description": "Amount to swap"},
        ],
    ),
    DistractorSpec(
        name="BRIDGE_ASSETS",
        description="Bridge tokens from one blockchain network to another",
        similes=["cross-chain transfer", "bridge tokens", "move assets between chains"],
        tags=["defi", "bridge", "blockchain"],
        domain="defi",
        parameters=[
            {"name": "token", "type": "string", "description": "Token to bridge"},
            {"name": "from_chain", "type": "string", "description": "Source chain"},
            {"name": "to_chain", "type": "string", "description": "Destination chain"},
            {"name": "amount", "type": "string", "description": "Amount to bridge"},
        ],
    ),
    DistractorSpec(
        name="CHECK_BALANCE",
        description="Check the token balance of a wallet address",
        similes=["wallet balance", "check holdings", "portfolio balance", "how much do I have"],
        tags=["defi", "wallet", "balance"],
        domain="defi",
        parameters=[
            {"name": "token", "type": "string", "description": "Token to check (optional, all if omitted)"},
        ],
    ),
    DistractorSpec(
        name="APPROVE_SPENDING",
        description="Approve a smart contract to spend tokens on your behalf",
        similes=["token approval", "approve contract", "set allowance"],
        tags=["defi", "approval", "blockchain"],
        domain="defi",
        parameters=[
            {"name": "token", "type": "string", "description": "Token to approve"},
            {"name": "spender", "type": "string", "description": "Contract address"},
            {"name": "amount", "type": "string", "description": "Approval amount"},
        ],
    ),
    DistractorSpec(
        name="STAKE_TOKENS",
        description="Stake tokens in a protocol to earn yield or rewards",
        similes=["stake crypto", "delegate tokens", "earn yield", "lock tokens"],
        tags=["defi", "staking", "yield"],
        domain="defi",
        parameters=[
            {"name": "token", "type": "string", "description": "Token to stake"},
            {"name": "amount", "type": "string", "description": "Amount to stake"},
            {"name": "protocol", "type": "string", "description": "Staking protocol"},
        ],
    ),
    DistractorSpec(
        name="SEND_TOKENS",
        description="Send cryptocurrency tokens to another wallet address",
        similes=["transfer tokens", "send crypto", "wire tokens", "pay address"],
        tags=["defi", "transfer", "blockchain"],
        domain="defi",
        parameters=[
            {"name": "token", "type": "string", "description": "Token to send"},
            {"name": "to_address", "type": "string", "description": "Recipient wallet address"},
            {"name": "amount", "type": "string", "description": "Amount to send"},
        ],
    ),
]

SOCIAL_ACTIONS: list[DistractorSpec] = [
    DistractorSpec(
        name="POST_TWEET",
        description="Post a tweet or status update to a social media platform",
        similes=["tweet", "post update", "share on social", "publish post"],
        tags=["social", "twitter", "posting"],
        domain="social",
        parameters=[
            {"name": "text", "type": "string", "description": "Tweet content"},
        ],
    ),
    DistractorSpec(
        name="REPLY_TWEET",
        description="Reply to a specific tweet or social media post",
        similes=["respond to tweet", "comment on post", "reply to post"],
        tags=["social", "twitter", "reply"],
        domain="social",
        parameters=[
            {"name": "tweet_id", "type": "string", "description": "ID of tweet to reply to"},
            {"name": "text", "type": "string", "description": "Reply content"},
        ],
    ),
    DistractorSpec(
        name="LIKE_POST",
        description="Like or favourite a social media post",
        similes=["favourite post", "heart tweet", "like tweet", "upvote"],
        tags=["social", "engagement"],
        domain="social",
        parameters=[
            {"name": "post_id", "type": "string", "description": "ID of post to like"},
        ],
    ),
    DistractorSpec(
        name="FOLLOW_USER",
        description="Follow a user on a social media platform",
        similes=["subscribe to user", "follow account", "add follower"],
        tags=["social", "follow"],
        domain="social",
        parameters=[
            {"name": "username", "type": "string", "description": "Username to follow"},
        ],
    ),
    DistractorSpec(
        name="REPOST_CONTENT",
        description="Repost or retweet someone else's content",
        similes=["retweet", "share post", "amplify content", "boost post"],
        tags=["social", "sharing"],
        domain="social",
        parameters=[
            {"name": "post_id", "type": "string", "description": "ID of post to repost"},
        ],
    ),
    DistractorSpec(
        name="DIRECT_MESSAGE",
        description="Send a direct private message to a user on social media",
        similes=["DM user", "private message", "send DM", "message privately"],
        tags=["social", "messaging", "private"],
        domain="social",
        parameters=[
            {"name": "username", "type": "string", "description": "Recipient username"},
            {"name": "text", "type": "string", "description": "Message content"},
        ],
    ),
]

PRODUCTIVITY_ACTIONS: list[DistractorSpec] = [
    DistractorSpec(
        name="CREATE_TASK",
        description="Create a new task or to-do item in a project management system",
        similes=["add task", "new todo", "create ticket", "add work item"],
        tags=["productivity", "tasks", "project"],
        domain="productivity",
        parameters=[
            {"name": "title", "type": "string", "description": "Task title"},
            {"name": "description", "type": "string", "description": "Task description"},
            {"name": "assignee", "type": "string", "description": "Person assigned"},
        ],
    ),
    DistractorSpec(
        name="SET_REMINDER",
        description="Set a personal reminder for a specific date and time",
        similes=["remind me", "create reminder", "set alarm", "notify me later"],
        tags=["productivity", "reminders", "scheduling"],
        domain="productivity",
        parameters=[
            {"name": "text", "type": "string", "description": "Reminder content"},
            {"name": "time", "type": "string", "description": "When to remind"},
        ],
    ),
    DistractorSpec(
        name="SEARCH_DOCS",
        description="Search through documentation or knowledge base articles",
        similes=["find document", "search knowledge base", "look up docs", "find article"],
        tags=["productivity", "search", "documentation"],
        domain="productivity",
        parameters=[
            {"name": "query", "type": "string", "description": "Search query"},
        ],
    ),
    DistractorSpec(
        name="CREATE_NOTE",
        description="Create a new note or document for future reference",
        similes=["write note", "save note", "jot down", "record note"],
        tags=["productivity", "notes"],
        domain="productivity",
        parameters=[
            {"name": "title", "type": "string", "description": "Note title"},
            {"name": "content", "type": "string", "description": "Note content"},
        ],
    ),
    DistractorSpec(
        name="ADD_CALENDAR_EVENT",
        description="Add an event to the calendar with date, time, and attendees",
        similes=["schedule event", "book meeting", "create appointment", "add to calendar"],
        tags=["productivity", "calendar", "scheduling"],
        domain="productivity",
        parameters=[
            {"name": "title", "type": "string", "description": "Event title"},
            {"name": "start_time", "type": "string", "description": "Start date/time"},
            {"name": "end_time", "type": "string", "description": "End date/time"},
            {"name": "attendees", "type": "string", "description": "Comma-separated attendee names"},
        ],
    ),
    DistractorSpec(
        name="GENERATE_REPORT",
        description="Generate a summary report from available data and metrics",
        similes=["create report", "build summary", "compile report", "produce analysis"],
        tags=["productivity", "reporting", "analytics"],
        domain="productivity",
        parameters=[
            {"name": "report_type", "type": "string", "description": "Type of report"},
            {"name": "time_range", "type": "string", "description": "Time period to cover"},
        ],
    ),
]

FILE_ACTIONS: list[DistractorSpec] = [
    DistractorSpec(
        name="UPLOAD_FILE",
        description="Upload a file to cloud storage or a shared workspace",
        similes=["upload document", "share file", "attach file", "send file"],
        tags=["files", "upload", "storage"],
        domain="files",
        parameters=[
            {"name": "file_path", "type": "string", "description": "Path to the file"},
            {"name": "destination", "type": "string", "description": "Upload destination"},
        ],
    ),
    DistractorSpec(
        name="DOWNLOAD_FILE",
        description="Download a file from a URL or cloud storage",
        similes=["get file", "fetch document", "save file locally", "pull file"],
        tags=["files", "download"],
        domain="files",
        parameters=[
            {"name": "url", "type": "string", "description": "File URL or path"},
        ],
    ),
    DistractorSpec(
        name="LIST_FILES",
        description="List files in a directory or cloud storage bucket",
        similes=["show files", "directory listing", "browse files", "what files are there"],
        tags=["files", "listing"],
        domain="files",
        parameters=[
            {"name": "path", "type": "string", "description": "Directory path"},
        ],
    ),
    DistractorSpec(
        name="DELETE_FILE",
        description="Delete a file from storage",
        similes=["remove file", "trash file", "erase document"],
        tags=["files", "deletion"],
        domain="files",
        parameters=[
            {"name": "file_path", "type": "string", "description": "Path to file to delete"},
        ],
    ),
    DistractorSpec(
        name="READ_FILE",
        description="Read and display the contents of a text file",
        similes=["open file", "show file contents", "view document", "cat file"],
        tags=["files", "reading"],
        domain="files",
        parameters=[
            {"name": "file_path", "type": "string", "description": "Path to file"},
        ],
    ),
    DistractorSpec(
        name="WRITE_FILE",
        description="Write content to a file, creating it if it does not exist",
        similes=["save to file", "create file", "write document", "output to file"],
        tags=["files", "writing"],
        domain="files",
        parameters=[
            {"name": "file_path", "type": "string", "description": "Path to file"},
            {"name": "content", "type": "string", "description": "Content to write"},
        ],
    ),
]

COMMUNICATION_ACTIONS: list[DistractorSpec] = [
    DistractorSpec(
        name="SEND_EMAIL",
        description="Send an email to one or more recipients",
        similes=["email someone", "mail message", "send mail", "compose email"],
        tags=["communication", "email"],
        domain="communication",
        parameters=[
            {"name": "to", "type": "string", "description": "Recipient email address(es)"},
            {"name": "subject", "type": "string", "description": "Email subject"},
            {"name": "body", "type": "string", "description": "Email body"},
        ],
    ),
    DistractorSpec(
        name="FORWARD_MESSAGE",
        description="Forward a message from one channel or conversation to another",
        similes=["relay message", "pass along", "share message", "forward to"],
        tags=["communication", "messaging"],
        domain="communication",
        parameters=[
            {"name": "message_id", "type": "string", "description": "Message to forward"},
            {"name": "target", "type": "string", "description": "Destination channel/user"},
        ],
    ),
    DistractorSpec(
        name="CREATE_CHANNEL",
        description="Create a new communication channel or group chat",
        similes=["new channel", "create group", "start chat room", "open channel"],
        tags=["communication", "channels"],
        domain="communication",
        parameters=[
            {"name": "name", "type": "string", "description": "Channel name"},
            {"name": "description", "type": "string", "description": "Channel description"},
        ],
    ),
    DistractorSpec(
        name="INVITE_USER",
        description="Invite a user to join a channel, room, or workspace",
        similes=["add user to channel", "invite to room", "bring someone in", "invite member"],
        tags=["communication", "invitation"],
        domain="communication",
        parameters=[
            {"name": "username", "type": "string", "description": "User to invite"},
            {"name": "channel", "type": "string", "description": "Channel to invite into"},
        ],
    ),
    DistractorSpec(
        name="PIN_MESSAGE",
        description="Pin an important message in a channel for easy reference",
        similes=["bookmark message", "save message", "pin to top", "highlight message"],
        tags=["communication", "pinning"],
        domain="communication",
        parameters=[
            {"name": "message_id", "type": "string", "description": "Message to pin"},
        ],
    ),
    DistractorSpec(
        name="TRANSLATE_MESSAGE",
        description="Translate a message from one language to another",
        similes=["translate text", "convert language", "interpret message"],
        tags=["communication", "translation"],
        domain="communication",
        parameters=[
            {"name": "text", "type": "string", "description": "Text to translate"},
            {"name": "target_language", "type": "string", "description": "Language to translate into"},
        ],
    ),
]

ANALYTICS_ACTIONS: list[DistractorSpec] = [
    DistractorSpec(
        name="GET_METRICS",
        description="Retrieve performance metrics and statistics",
        similes=["show stats", "get analytics", "performance data", "dashboard metrics"],
        tags=["analytics", "metrics"],
        domain="analytics",
        parameters=[
            {"name": "metric_type", "type": "string", "description": "Type of metric"},
            {"name": "time_range", "type": "string", "description": "Time period"},
        ],
    ),
    DistractorSpec(
        name="RUN_QUERY",
        description="Execute a data query against a database or data warehouse",
        similes=["query data", "run SQL", "fetch data", "data lookup"],
        tags=["analytics", "data", "query"],
        domain="analytics",
        parameters=[
            {"name": "query", "type": "string", "description": "Query string"},
            {"name": "database", "type": "string", "description": "Target database"},
        ],
    ),
    DistractorSpec(
        name="CREATE_DASHBOARD",
        description="Create a new data visualization dashboard",
        similes=["build dashboard", "set up visualisation", "create charts"],
        tags=["analytics", "visualisation"],
        domain="analytics",
        parameters=[
            {"name": "title", "type": "string", "description": "Dashboard title"},
            {"name": "widgets", "type": "string", "description": "Widget configuration"},
        ],
    ),
    DistractorSpec(
        name="EXPORT_DATA",
        description="Export data to CSV, JSON, or another format",
        similes=["download data", "export to csv", "save data", "data dump"],
        tags=["analytics", "export"],
        domain="analytics",
        parameters=[
            {"name": "format", "type": "string", "description": "Export format (csv, json, xlsx)"},
            {"name": "dataset", "type": "string", "description": "Which dataset to export"},
        ],
    ),
    DistractorSpec(
        name="SCHEDULE_REPORT",
        description="Schedule a recurring analytics report to be generated automatically",
        similes=["automate report", "periodic report", "scheduled analytics", "report subscription"],
        tags=["analytics", "scheduling", "reporting"],
        domain="analytics",
        parameters=[
            {"name": "report_type", "type": "string", "description": "Type of report"},
            {"name": "frequency", "type": "string", "description": "How often to generate (daily, weekly, monthly)"},
        ],
    ),
    DistractorSpec(
        name="TRACK_EVENT",
        description="Track a custom analytics event for monitoring",
        similes=["log event", "record metric", "track activity", "emit event"],
        tags=["analytics", "tracking"],
        domain="analytics",
        parameters=[
            {"name": "event_name", "type": "string", "description": "Event identifier"},
            {"name": "properties", "type": "string", "description": "Event properties as JSON"},
        ],
    ),
]

MODERATION_ACTIONS: list[DistractorSpec] = [
    DistractorSpec(
        name="BAN_USER",
        description="Ban a user from a channel or platform permanently",
        similes=["block user", "remove user", "kick and ban", "permanent ban"],
        tags=["moderation", "banning"],
        domain="moderation",
        parameters=[
            {"name": "username", "type": "string", "description": "User to ban"},
            {"name": "reason", "type": "string", "description": "Ban reason"},
        ],
    ),
    DistractorSpec(
        name="WARN_USER",
        description="Issue a warning to a user for policy violations",
        similes=["caution user", "issue warning", "yellow card", "flag behaviour"],
        tags=["moderation", "warnings"],
        domain="moderation",
        parameters=[
            {"name": "username", "type": "string", "description": "User to warn"},
            {"name": "reason", "type": "string", "description": "Warning reason"},
        ],
    ),
    DistractorSpec(
        name="DELETE_MESSAGE",
        description="Delete a specific message from a channel for moderation",
        similes=["remove message", "censor message", "take down post", "purge message"],
        tags=["moderation", "deletion"],
        domain="moderation",
        parameters=[
            {"name": "message_id", "type": "string", "description": "Message to delete"},
        ],
    ),
    DistractorSpec(
        name="SILENCE_USER",
        description="Temporarily mute a user so they cannot post messages",
        similes=["timeout user", "temp mute", "quiet user", "restrict posting"],
        tags=["moderation", "muting"],
        domain="moderation",
        parameters=[
            {"name": "username", "type": "string", "description": "User to silence"},
            {"name": "duration", "type": "string", "description": "Silence duration"},
        ],
    ),
    DistractorSpec(
        name="SET_SLOWMODE",
        description="Enable slow mode in a channel to limit message frequency",
        similes=["rate limit", "slow down chat", "limit messages", "cooldown mode"],
        tags=["moderation", "rate_limiting"],
        domain="moderation",
        parameters=[
            {"name": "channel", "type": "string", "description": "Channel to apply slow mode to"},
            {"name": "interval_seconds", "type": "string", "description": "Minimum seconds between messages"},
        ],
    ),
    DistractorSpec(
        name="REVIEW_REPORT",
        description="Review a user-submitted report about content or behaviour",
        similes=["handle report", "check complaint", "review flag", "assess report"],
        tags=["moderation", "reports"],
        domain="moderation",
        parameters=[
            {"name": "report_id", "type": "string", "description": "Report to review"},
        ],
    ),
]

CONTENT_ACTIONS: list[DistractorSpec] = [
    DistractorSpec(
        name="GENERATE_AUDIO",
        description="Generate audio content such as speech or music from text",
        similes=["text to speech", "create audio", "synthesise voice", "make sound"],
        tags=["content", "audio", "tts"],
        domain="content",
        parameters=[
            {"name": "text", "type": "string", "description": "Text to convert to audio"},
            {"name": "voice", "type": "string", "description": "Voice style"},
        ],
    ),
    DistractorSpec(
        name="GENERATE_VIDEO",
        description="Generate a short video clip from a text description",
        similes=["create video", "make clip", "produce video", "text to video"],
        tags=["content", "video", "generation"],
        domain="content",
        parameters=[
            {"name": "prompt", "type": "string", "description": "Video description"},
            {"name": "duration", "type": "string", "description": "Duration in seconds"},
        ],
    ),
    DistractorSpec(
        name="EDIT_IMAGE",
        description="Edit or modify an existing image based on instructions",
        similes=["modify image", "image editing", "change picture", "alter image"],
        tags=["content", "image", "editing"],
        domain="content",
        parameters=[
            {"name": "image_id", "type": "string", "description": "Image to edit"},
            {"name": "instructions", "type": "string", "description": "Edit instructions"},
        ],
    ),
    DistractorSpec(
        name="SUMMARIZE_TEXT",
        description="Create a concise summary of a longer piece of text",
        similes=["summarise", "TLDR", "condense text", "shorten article", "brief summary"],
        tags=["content", "summarisation"],
        domain="content",
        parameters=[
            {"name": "text", "type": "string", "description": "Text to summarise"},
            {"name": "max_length", "type": "string", "description": "Maximum summary length"},
        ],
    ),
    DistractorSpec(
        name="TRANSCRIBE_AUDIO",
        description="Transcribe audio or video content into text",
        similes=["speech to text", "transcribe recording", "convert audio to text", "caption audio"],
        tags=["content", "transcription", "audio"],
        domain="content",
        parameters=[
            {"name": "audio_url", "type": "string", "description": "URL or path to audio file"},
            {"name": "language", "type": "string", "description": "Language of the audio"},
        ],
    ),
    DistractorSpec(
        name="DESIGN_LOGO",
        description="Design a logo or brand mark from a description",
        similes=["create logo", "make brand image", "design icon", "logo generation"],
        tags=["content", "design", "branding"],
        domain="content",
        parameters=[
            {"name": "description", "type": "string", "description": "Logo description"},
            {"name": "style", "type": "string", "description": "Design style"},
        ],
    ),
]


GAMING_ACTIONS: list[DistractorSpec] = [
    DistractorSpec(
        name="ROLL_DICE",
        description="Roll dice for a game or random decision making",
        similes=["throw dice", "random number", "roll D20", "dice roll"],
        tags=["gaming", "random"],
        domain="gaming",
        parameters=[
            {"name": "sides", "type": "string", "description": "Number of sides on the die"},
            {"name": "count", "type": "string", "description": "Number of dice to roll"},
        ],
    ),
    DistractorSpec(
        name="START_POLL",
        description="Start a poll or vote in a channel for group decision making",
        similes=["create poll", "start vote", "group decision", "survey"],
        tags=["gaming", "voting", "social"],
        domain="gaming",
        parameters=[
            {"name": "question", "type": "string", "description": "Poll question"},
            {"name": "options", "type": "string", "description": "Comma-separated poll options"},
        ],
    ),
]

ALL_DISTRACTOR_SPECS: list[DistractorSpec] = (
    DEFI_ACTIONS
    + SOCIAL_ACTIONS
    + PRODUCTIVITY_ACTIONS
    + FILE_ACTIONS
    + COMMUNICATION_ACTIONS
    + ANALYTICS_ACTIONS
    + MODERATION_ACTIONS
    + CONTENT_ACTIONS
    + GAMING_ACTIONS
)

_ALL_DISTRACTOR_NAMES: frozenset[str] = frozenset(s.name for s in ALL_DISTRACTOR_SPECS)


def _spec_to_parameters(spec: DistractorSpec) -> list[ActionParameter]:
    """Convert a DistractorSpec's parameter dicts to ActionParameter protos."""
    params: list[ActionParameter] = []
    for p in spec.parameters:
        schema = ActionParameterSchema()
        schema.type = p.get("type", "string")
        schema.description = p.get("description", "")
        param = ActionParameter()
        param.name = p["name"]
        param.required = p.get("required", "true").lower() == "true" if isinstance(p.get("required"), str) else True
        param.schema.CopyFrom(schema)
        params.append(param)
    return params


def spec_to_action(spec: DistractorSpec) -> Action:
    """Convert a DistractorSpec into an Eliza Action with a no-op handler."""
    return Action(
        name=spec.name,
        description=spec.description,
        handler=_noop_handler,
        validate=_always_valid,
        similes=spec.similes,
        tags=spec.tags,
        parameters=_spec_to_parameters(spec),
    )


def get_distractor_actions(count: int) -> list[Action]:
    """Return up to ``count`` distractor actions.

    For counts <= 50, returns a deterministic subset from the canonical list.
    For counts > 50, generates additional variant actions by appending domain
    suffixes (e.g. SWAP_TOKENS_V2, SWAP_TOKENS_ADVANCED) with slightly modified
    descriptions to create a denser semantic space.
    """
    if count <= 0:
        return []

    base_count = min(count, len(ALL_DISTRACTOR_SPECS))
    actions = [spec_to_action(spec) for spec in ALL_DISTRACTOR_SPECS[:base_count]]

    if count <= len(ALL_DISTRACTOR_SPECS):
        return actions

    # Generate variants for counts > 50
    variant_suffixes = ["_V2", "_PRO", "_ADVANCED", "_LITE", "_PLUS", "_AUTO", "_BATCH", "_QUICK"]
    variant_prefixes_desc = [
        "An enhanced version that can",
        "A streamlined tool to",
        "An advanced capability to",
        "A lightweight alternative to",
        "An upgraded tool that can",
        "An automated way to",
        "A batch operation to",
        "A quick shortcut to",
    ]

    remaining = count - len(actions)
    variant_idx = 0

    for base_spec in ALL_DISTRACTOR_SPECS:
        if remaining <= 0:
            break
        suffix_idx = variant_idx % len(variant_suffixes)
        variant_name = base_spec.name + variant_suffixes[suffix_idx]
        variant_desc = f"{variant_prefixes_desc[suffix_idx]} {base_spec.description.lower()}"

        variant_spec = DistractorSpec(
            name=variant_name,
            description=variant_desc,
            similes=[s + " (variant)" for s in base_spec.similes],
            tags=base_spec.tags + ["variant"],
            domain=base_spec.domain,
            parameters=base_spec.parameters,
        )
        actions.append(spec_to_action(variant_spec))
        remaining -= 1
        variant_idx += 1

    # If we still need more, generate hashed unique names
    hash_round = 0
    while remaining > 0:
        for base_spec in ALL_DISTRACTOR_SPECS:
            if remaining <= 0:
                break
            h = hashlib.md5(f"{base_spec.name}_{hash_round}".encode()).hexdigest()[:4].upper()
            variant_name = f"{base_spec.name}_{h}"
            variant_spec = DistractorSpec(
                name=variant_name,
                description=f"Variant of {base_spec.description.lower()} (build {h})",
                similes=base_spec.similes,
                tags=base_spec.tags + ["generated"],
                domain=base_spec.domain,
                parameters=base_spec.parameters,
            )
            actions.append(spec_to_action(variant_spec))
            remaining -= 1
        hash_round += 1

    return actions


def get_distractor_plugin_actions_for_scale(
    scale_action_count: int,
    bootstrap_action_count: int,
) -> list[Action]:
    """Given a target total action count and how many bootstrap actions exist,
    return the right number of distractors to reach the target.
    """
    needed = max(0, scale_action_count - bootstrap_action_count)
    return get_distractor_actions(needed)
