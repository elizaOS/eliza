from elizaos_plugin_github.actions.create_branch import CreateBranchAction
from elizaos_plugin_github.actions.create_comment import CreateCommentAction
from elizaos_plugin_github.actions.create_issue import CreateIssueAction
from elizaos_plugin_github.actions.create_pull_request import CreatePullRequestAction
from elizaos_plugin_github.actions.merge_pull_request import MergePullRequestAction
from elizaos_plugin_github.actions.push_code import PushCodeAction
from elizaos_plugin_github.actions.review_pull_request import ReviewPullRequestAction

__all__ = [
    "CreateIssueAction",
    "CreatePullRequestAction",
    "ReviewPullRequestAction",
    "CreateCommentAction",
    "CreateBranchAction",
    "PushCodeAction",
    "MergePullRequestAction",
]

all_actions = [
    CreateIssueAction(),
    CreatePullRequestAction(),
    ReviewPullRequestAction(),
    CreateCommentAction(),
    CreateBranchAction(),
    PushCodeAction(),
    MergePullRequestAction(),
]
