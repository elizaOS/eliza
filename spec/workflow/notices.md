# Workflow run notices

The agent posts a notice when a run settles or reaches a device step that
needs the owner's approval. A notice names the exact run route it was
posted for: the workflow, the run and the reviewed version. The device's
[notice routes](../os/android/noticeRoutes.md) own delivery, the owner fence
and taps; this spec owns what a tap may open and when a pending approval may
be offered again. A tap is a request to read: it never starts, retries,
approves or decides anything.

## Story: Reopen the exact run a workflow notice names

> As the owner, I want a workflow notice I tap to open the run it was posted
> for, at the version I reviewed, and to show nothing when that run is gone
> or another version replaced it.

### A notice opens only its own run, at its own version, of a workflow still present

A notice opens its run only while the workflow is present and not removed,
the run belongs to that workflow and still names the notice's version. Any
other read opens nothing, so a notice never reaches a run or version it was
not posted for. The run's identity is retained, so a later edit of the
workflow never redirects an older notice to a newer run.

```quint
type NoticeOpen = OpenRun | OpenNothing
type NoticeRoute = { workflowId: str, runId: str, versionId: str }
type NoticeRead = { definitionPresent: bool, definitionRemoved: bool, runPresent: bool, runWorkflow: str, runVersion: str }
pure def openNotice(route: NoticeRoute, read: NoticeRead): NoticeOpen =
  if (read.definitionPresent and not(read.definitionRemoved) and read.runPresent and read.runWorkflow == route.workflowId and read.runVersion == route.versionId) OpenRun
  else OpenNothing
pure val routeValues = Set({ workflowId: "w1", runId: "r1", versionId: "v1" }, { workflowId: "w1", runId: "r1", versionId: "v2" })
pure val readValues = Set(
  { definitionPresent: true, definitionRemoved: false, runPresent: true, runWorkflow: "w1", runVersion: "v1" },
  { definitionPresent: true, definitionRemoved: true, runPresent: true, runWorkflow: "w1", runVersion: "v1" },
  { definitionPresent: true, definitionRemoved: false, runPresent: true, runWorkflow: "w2", runVersion: "v1" },
  { definitionPresent: false, definitionRemoved: false, runPresent: false, runWorkflow: "", runVersion: "" })
pure def lawNoticeOpensOnlyItsRun(route: NoticeRoute, read: NoticeRead): bool =
  openNotice(route, read) == OpenRun implies (read.runWorkflow == route.workflowId and read.runVersion == route.versionId and not(read.definitionRemoved))
pure def lawRemovedWorkflowOpensNothing(route: NoticeRoute, read: NoticeRead): bool =
  read.definitionRemoved implies openNotice(route, read) == OpenNothing
```

### A pending approval is offered again only while its run is unchanged and unsettled

When its owner returns, a suspended approval notice resumes only while the
run is unfinished and not being cancelled at the notice's version and the
same approval is still pending with the same expiry; otherwise it is
withdrawn. A settled approval unlocks nothing and is never offered again. A phone can
find candidates in the resident’s bounded workflow notification list. The
list carries no permission to present an approval. It supplies its exact
workflow, run, version, proposal and expiry for the fresh approval read.

```quint
type ApprovalNoticeRead = { runFinished: bool, cancellationRequested: bool, versionMatches: bool, approvalPending: bool, sameExpiry: bool, expired: bool }
pure def resumesApprovalNotice(approval: ApprovalNoticeRead): bool =
  not(approval.runFinished) and not(approval.cancellationRequested) and approval.versionMatches and approval.approvalPending and approval.sameExpiry and not(approval.expired)
pure val approvalValues = Set(
  { runFinished: false, cancellationRequested: false, versionMatches: true, approvalPending: true, sameExpiry: true, expired: false },
  { runFinished: true, cancellationRequested: false, versionMatches: true, approvalPending: true, sameExpiry: true, expired: false },
  { runFinished: false, cancellationRequested: false, versionMatches: true, approvalPending: false, sameExpiry: true, expired: false })
pure def lawSettledApprovalNeverResumes(approval: ApprovalNoticeRead): bool =
  (approval.runFinished or not(approval.approvalPending)) implies not(resumesApprovalNotice(approval))
```
