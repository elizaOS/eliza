"""Synthetic distractor actions for ADHDBench.

The benchmark scales action-list size by registering plausible, non-bootstrap
actions. These lightweight action objects are enough for baselines and local
smoke runs; real elizaOS integration can adapt the same specs into runtime
plugin actions.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class DistractorActionSpec:
    name: str
    description: str
    similes: tuple[str, ...]
    tags: tuple[str, ...]
    domain: str


@dataclass(frozen=True)
class DistractorAction:
    name: str
    description: str
    similes: tuple[str, ...]
    tags: tuple[str, ...]
    domain: str

    async def handler(self, *_args: Any, **_kwargs: Any) -> dict[str, str]:
        return {"status": "noop", "action": self.name}

    async def validate(self, *_args: Any, **_kwargs: Any) -> bool:
        return True


def _spec(domain: str, name: str, description: str, *similes: str) -> DistractorActionSpec:
    return DistractorActionSpec(
        name=name,
        description=description,
        similes=similes or (name.lower().replace("_", " "),),
        tags=(domain,),
        domain=domain,
    )


DEFI_ACTIONS: tuple[DistractorActionSpec, ...] = (
    _spec("defi", "SWAP_TOKEN", "Swap one crypto token for another.", "trade token", "exchange asset"),
    _spec("defi", "STAKE_TOKEN", "Stake a token into a rewards contract.", "stake asset"),
    _spec("defi", "UNSTAKE_TOKEN", "Remove a token from staking.", "withdraw stake"),
    _spec("defi", "BRIDGE_ASSET", "Bridge an asset between chains.", "cross-chain transfer"),
    _spec("defi", "CLAIM_REWARDS", "Claim protocol rewards.", "collect yield"),
    _spec("defi", "CHECK_WALLET_RISK", "Inspect wallet risk indicators.", "wallet safety check"),
)

SOCIAL_ACTIONS: tuple[DistractorActionSpec, ...] = (
    _spec("social", "POST_UPDATE", "Publish a social status update.", "post status"),
    _spec("social", "LIKE_POST", "Like a social post.", "favorite post"),
    _spec("social", "SHARE_POST", "Share a social post.", "repost"),
    _spec("social", "FOLLOW_USER", "Follow a user profile.", "subscribe user"),
    _spec("social", "UNFOLLOW_USER", "Unfollow a user profile.", "unsubscribe user"),
    _spec("social", "REPORT_POST", "Report a problematic post.", "flag post"),
)

PRODUCTIVITY_ACTIONS: tuple[DistractorActionSpec, ...] = (
    _spec("productivity", "CREATE_TASK", "Create a task in a task list.", "add todo"),
    _spec("productivity", "COMPLETE_TASK", "Mark a task complete.", "finish todo"),
    _spec("productivity", "PRIORITIZE_TASK", "Change task priority.", "rank todo"),
    _spec("productivity", "START_TIMER", "Start a work timer.", "begin timer"),
    _spec("productivity", "STOP_TIMER", "Stop a work timer.", "end timer"),
    _spec("productivity", "SUMMARIZE_NOTES", "Summarize a note collection.", "condense notes"),
)

FILE_ACTIONS: tuple[DistractorActionSpec, ...] = (
    _spec("files", "CREATE_FILE", "Create a file.", "new file"),
    _spec("files", "DELETE_FILE", "Delete a file.", "remove file"),
    _spec("files", "MOVE_FILE", "Move a file.", "relocate file"),
    _spec("files", "RENAME_FILE", "Rename a file.", "change filename"),
    _spec("files", "SEARCH_FILES", "Search files.", "find files"),
    _spec("files", "SHARE_FILE", "Share a file.", "send file link"),
)

COMMUNICATION_ACTIONS: tuple[DistractorActionSpec, ...] = (
    _spec("communication", "SEND_EMAIL", "Send an email.", "email person"),
    _spec("communication", "DRAFT_EMAIL", "Draft an email.", "compose email"),
    _spec("communication", "ARCHIVE_EMAIL", "Archive an email.", "file email"),
    _spec("communication", "CREATE_MEETING", "Create a meeting.", "schedule meeting"),
    _spec("communication", "CANCEL_MEETING", "Cancel a meeting.", "delete meeting"),
    _spec("communication", "TRANSCRIBE_CALL", "Transcribe a call.", "call transcript"),
)

ANALYTICS_ACTIONS: tuple[DistractorActionSpec, ...] = (
    _spec("analytics", "QUERY_METRICS", "Query product metrics.", "fetch metrics"),
    _spec("analytics", "BUILD_CHART", "Build a chart.", "plot data"),
    _spec("analytics", "EXPORT_REPORT", "Export an analytics report.", "download report"),
    _spec("analytics", "COMPARE_COHORTS", "Compare user cohorts.", "segment comparison"),
    _spec("analytics", "DETECT_ANOMALY", "Detect metric anomalies.", "find outlier"),
    _spec("analytics", "FORECAST_TREND", "Forecast a metric trend.", "predict trend"),
)

MODERATION_ACTIONS: tuple[DistractorActionSpec, ...] = (
    _spec("moderation", "WARN_USER", "Warn a user.", "issue warning"),
    _spec("moderation", "BAN_USER", "Ban a user.", "block user"),
    _spec("moderation", "UNBAN_USER", "Unban a user.", "restore user"),
    _spec("moderation", "PIN_MESSAGE", "Pin a message.", "highlight message"),
    _spec("moderation", "DELETE_MESSAGE", "Delete a message.", "remove message"),
    _spec("moderation", "LOCK_THREAD", "Lock a thread.", "close discussion"),
)

CONTENT_ACTIONS: tuple[DistractorActionSpec, ...] = (
    _spec("content", "GENERATE_TITLE", "Generate a content title.", "write headline"),
    _spec("content", "GENERATE_SUMMARY", "Generate a content summary.", "summarize article"),
    _spec("content", "TRANSLATE_TEXT", "Translate text.", "convert language"),
    _spec("content", "REWRITE_TEXT", "Rewrite text.", "rephrase copy"),
    _spec("content", "TAG_CONTENT", "Apply content tags.", "classify content"),
    _spec("content", "CHECK_PLAGIARISM", "Check text for plagiarism.", "originality check"),
)

GAMING_ACTIONS: tuple[DistractorActionSpec, ...] = (
    _spec("gaming", "START_MATCH", "Start a game match.", "begin match"),
    _spec("gaming", "SUBMIT_SCORE", "Submit a game score.", "record score"),
)

ALL_DISTRACTOR_SPECS: tuple[DistractorActionSpec, ...] = (
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


def _to_action(spec: DistractorActionSpec, name: str | None = None) -> DistractorAction:
    return DistractorAction(
        name=name or spec.name,
        description=spec.description,
        similes=spec.similes,
        tags=spec.tags,
        domain=spec.domain,
    )


def get_distractor_actions(count: int) -> list[DistractorAction]:
    """Return ``count`` unique distractor actions, generating variants as needed."""
    if count <= 0:
        return []

    actions = [_to_action(spec) for spec in ALL_DISTRACTOR_SPECS[: min(count, len(ALL_DISTRACTOR_SPECS))]]
    if count <= len(actions):
        return actions

    suffix = 2
    while len(actions) < count:
        for spec in ALL_DISTRACTOR_SPECS:
            if len(actions) >= count:
                break
            actions.append(_to_action(spec, f"{spec.name}_V{suffix}"))
        suffix += 1
    return actions


def get_distractor_plugin_actions_for_scale(
    scale_action_count: int,
    bootstrap_action_count: int,
) -> list[DistractorAction]:
    """Return the number of distractors needed to reach a target action count."""
    return get_distractor_actions(max(0, scale_action_count - bootstrap_action_count))
