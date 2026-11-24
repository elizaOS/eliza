# GitHub

The connected GitHub account supplies pull requests, inbox notifications and issue operations. It may be the owner's selected account or the agent's selected account. This specification follows the promoted `GITHUB` actions in `plugins/plugin-github/src/actions/` on `develop` at `51aad7ee8a82e1b8e6fa1908ed76d0c344c75d55`. See also [device sign-in](./deviceFlow.md).

## Story: List pull requests and triage notifications under the selected account

> As an owner, I want to read the pull requests and notifications available to the account I selected.

### Pull request listing requires an explicit repository or author, and me uses the selected account's login

Repository components and login names come from the GitHub boundary parser, which reads the operation and the pull request state without surrounding space or letter case. When the owner names both a repository and an author, both apply. Notification triage requests the selected account's own notifications without obtaining mutation authority.

```quint
type GitHubPrState = OpenPrs | ClosedPrs | AllPrs
type GitHubRead = ListPrs({ repoOwner: str, repoName: str, author: str, prState: GitHubPrState }) | TriageNotifications
pure def validGitHubRead(query: GitHubRead, accountLogin: str): bool = accountLogin != "" and (match query {
  | ListPrs(q) => ((q.repoOwner != "") == (q.repoName != "")) and (q.repoOwner != "" or q.author != "")
  | TriageNotifications => true
})
pure def effectiveGitHubAuthor(author: str, accountLogin: str): str = if (author == "@me") accountLogin else author
pure def lawMeIsSelectedGitHubAccount(accountLogin: str): bool = effectiveGitHubAuthor("@me", accountLogin) == accountLogin
```

## Story: Review the exact GitHub operation before it changes a repository

> As an owner, I want to review the issue or pull request operation with its account and exact target before it is sent.

### Each GitHub mutation requires the fields appropriate to its operation

A new issue needs a title. Existing issue operations need a positive issue number. Assign and label need names, and commenting needs a body. A pull request review binds its approval, change request or comment event; the boundary parser reads the operation and review action without surrounding space or letter case, and `request_changes` names the change request as `request-changes` does. The selected account, credential epoch, repository and request identifier travel with the complete operation.

```quint
type GitHubReviewKind = ApproveReview | RequestChanges | ReviewComment
type GitHubMutation = CreateIssue({ title: str, body: str, labels: List[str], assignees: List[str] }) | AssignIssue({ issue: int, assignees: List[str] }) | CloseIssue({ issue: int }) | ReopenIssue({ issue: int }) | CommentIssue({ issue: int, body: str }) | LabelIssue({ issue: int, labels: List[str] }) | ReviewPr({ pullRequest: int, reviewKind: GitHubReviewKind, reviewBody: str })
type GitHubRequest = { requestId: str, accountId: str, credentialEpoch: int, repoOwner: str, repoName: str, mutation: GitHubMutation }
pure def githubNamesPresent(names: List[str]): bool = names.every(name => name != "")
pure def validGitHubMutation(mutation: GitHubMutation): bool = match mutation {
  | CreateIssue(p) => p.title != "" and githubNamesPresent(p.labels) and githubNamesPresent(p.assignees)
  | AssignIssue(p) => p.issue > 0 and p.assignees.length() > 0 and githubNamesPresent(p.assignees)
  | CloseIssue(p) => p.issue > 0
  | ReopenIssue(p) => p.issue > 0
  | CommentIssue(p) => p.issue > 0 and p.body != ""
  | LabelIssue(p) => p.issue > 0 and p.labels.length() > 0 and githubNamesPresent(p.labels)
  | ReviewPr(p) => p.pullRequest > 0
}
pure def validGitHubRequest(proposal: GitHubRequest): bool = proposal.requestId != "" and proposal.accountId != "" and proposal.credentialEpoch > 0 and proposal.repoOwner != "" and proposal.repoName != "" and validGitHubMutation(proposal.mutation)
```

### Only the owner may approve the exact preview while the captured account is current

An owner decline or changed credential epoch ends the preview. The account and epoch are obtained from the trusted account manager. The approved operation is reserved durably before sending, and the same review cannot dispatch twice. An operation whose provider outcome is ambiguous remains eligible for a receipt observation, with no second dispatch authorization.

```quint
type GitHubCaller = GitHubOwner | GitHubAdapter | GitHubExternal
type GitHubPhase = GitHubIdle | GitHubReview | GitHubApproved | GitHubReserved | GitHubUnknown | GitHubApplied | GitHubRefused
type GitHubOperation = { proposal: GitHubRequest, phase: GitHubPhase, receiptId: str, lastEpoch: int, dispatchCount: int }
type GitHubEffect = SendGitHubMutation({ request: GitHubRequest })
type GitHubStep = { state: GitHubOperation, out: List[GitHubEffect] }
pure val sampleRequest: GitHubRequest = { requestId: "git-1", accountId: "account", credentialEpoch: 1, repoOwner: "octo", repoName: "projects", mutation: CommentIssue({ issue: 3, body: "comment" }) }
pure val initial: GitHubOperation = { proposal: { ...sampleRequest, requestId: "", accountId: "", credentialEpoch: 0 }, phase: GitHubIdle, receiptId: "", lastEpoch: 0, dispatchCount: 0 }
pure val proposalValues = Set(sampleRequest, { ...sampleRequest, mutation: CloseIssue({ issue: 3 }) }, { ...sampleRequest, credentialEpoch: 2 }, { ...sampleRequest, repoOwner: "" })
pure val activeEpochValues = Set(0, 1, 2)
pure def canPreviewGitHub(s: GitHubOperation, by: GitHubCaller, proposal: GitHubRequest): bool = by == GitHubAdapter and s.phase == GitHubIdle and validGitHubRequest(proposal)
pure def previewGitHub(s: GitHubOperation, by: GitHubCaller, proposal: GitHubRequest): GitHubOperation = { ...s, proposal: proposal, phase: GitHubReview, lastEpoch: proposal.credentialEpoch }
pure def canDecideGitHub(s: GitHubOperation, by: GitHubCaller, proposal: GitHubRequest, approve: bool, activeEpoch: int): bool = by == GitHubOwner and s.phase == GitHubReview and s.proposal == proposal
pure def decideGitHub(s: GitHubOperation, by: GitHubCaller, proposal: GitHubRequest, approve: bool, activeEpoch: int): GitHubOperation = { ...s, phase: if (approve and activeEpoch == proposal.credentialEpoch) GitHubApproved else GitHubRefused }
pure def canReserveGitHub(s: GitHubOperation, by: GitHubCaller, activeEpoch: int): bool = by == GitHubAdapter and s.phase == GitHubApproved and activeEpoch == s.lastEpoch
pure def reserveGitHub(s: GitHubOperation, by: GitHubCaller, activeEpoch: int): GitHubOperation = { ...s, phase: GitHubReserved }
pure def canDispatchGitHub(s: GitHubOperation, by: GitHubCaller, activeEpoch: int): bool = by == GitHubAdapter and s.phase == GitHubReserved and activeEpoch == s.lastEpoch and s.dispatchCount == 0
pure def dispatchGitHub(s: GitHubOperation, by: GitHubCaller, activeEpoch: int): GitHubStep = { state: { ...s, phase: GitHubUnknown, dispatchCount: 1 }, out: List(SendGitHubMutation({ request: s.proposal })) }
pure def canRetireGitHub(s: GitHubOperation, by: GitHubCaller, activeEpoch: int): bool = by == GitHubAdapter and (s.phase == GitHubReview or s.phase == GitHubApproved or s.phase == GitHubReserved) and activeEpoch != s.lastEpoch
pure def retireGitHub(s: GitHubOperation, by: GitHubCaller, activeEpoch: int): GitHubOperation = { ...s, phase: GitHubRefused }
pure def stepGitHubDispatchHasReservation(before: GitHubOperation, after: GitHubOperation, out: List[GitHubEffect]): bool = out.length() > 0 implies (before.phase == GitHubReserved and before.dispatchCount == 0 and out == List(SendGitHubMutation({ request: before.proposal })) and after.dispatchCount == 1)
pure def alwaysGitHubHasAtMostOneDispatch(s: GitHubOperation): bool = s.dispatchCount >= 0 and s.dispatchCount <= 1
```

### A GitHub completion applies only to the dispatched request and uses the provider's receipt

Only the adapter reports completion. It must carry the same request, account, credential epoch, target and operation. A confirmed provider rejection is recorded as such. A successful provider reply need not have applied every requested label or assignee. The reported omissions are the difference between the requested and provider-observed names.

```quint
type GitHubObservation = GitHubSuccess({ providerReceipt: str }) | GitHubRejection({ providerReceipt: str })
pure val observationValues = Set(GitHubSuccess({ providerReceipt: "provider-123" }), GitHubRejection({ providerReceipt: "provider-reject" }), GitHubSuccess({ providerReceipt: "" }))
pure def githubReceipt(observation: GitHubObservation): str = match observation {
  | GitHubSuccess(r) => r.providerReceipt
  | GitHubRejection(r) => r.providerReceipt
}
pure def canObserveGitHub(s: GitHubOperation, by: GitHubCaller, proposal: GitHubRequest, observation: GitHubObservation): bool = by == GitHubAdapter and s.phase == GitHubUnknown and s.proposal == proposal and githubReceipt(observation) != ""
pure def observeGitHub(s: GitHubOperation, by: GitHubCaller, proposal: GitHubRequest, observation: GitHubObservation): GitHubOperation = {
  val nextPhase = match observation { | GitHubSuccess(_) => GitHubApplied | GitHubRejection(_) => GitHubRefused }
  { ...s, phase: nextPhase, receiptId: githubReceipt(observation) }
}
pure def githubMissingNames(requested: List[str], observed: List[str]): List[str] = requested.select(name => not(observed.includes(name)))
pure def lawGitHubOmissionsWereRequested(requested: List[str], observed: List[str]): bool = githubMissingNames(requested, observed).every(name => requested.includes(name) and not(observed.includes(name)))
pure def alwaysGitHubSuccessHasReceipt(s: GitHubOperation): bool = s.phase == GitHubApplied implies (s.dispatchCount == 1 and s.receiptId != "")
pure def alwaysGitHubUnknownHasDispatch(s: GitHubOperation): bool = s.phase == GitHubUnknown implies s.dispatchCount == 1
pure def sometimesGitHubDelivered(s: GitHubOperation): bool = s.phase == GitHubApplied
pure val eval_witness_sometimesGitHubDelivered = (("previewGitHub", GitHubAdapter, sampleRequest), ("decideGitHub", GitHubOwner, sampleRequest, true, 1), ("reserveGitHub", GitHubAdapter, 1), ("dispatchGitHub", GitHubAdapter, 1), ("observeGitHub", GitHubAdapter, sampleRequest, GitHubSuccess({ providerReceipt: "provider-123" })))
```
