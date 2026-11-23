# Native browser surface

The [OS browser](../os/browser/surface/lifecycle.md) owns Android presentation and browser [commands](../os/browser/surface/commands.md). This contract describes the identity fence shared by the Android out-of-process WebView and the Apple WKWebView pool.

## Story: Keep browser commands and native page prompts within my current tab

> As the person, I want a prompt or command to affect only the live tab document it came from.

### A response needs the live surface, profile and committed document generation

Navigation, destruction, ownership reconciliation and profile expiry retire old request bindings. Browser view, task-origin and permission policy are supplied by their existing owners. Protected sign-in stays under the [OS sign-in rules](../os/index.md).

```quint
type BrowserSurfaceBinding = { surfaceId: str, profileId: str, epoch: int }
type BrowserPrompt = BrowserDialog | BrowserFileChooser | BrowserSitePermission | BrowserDownload
type BrowserRequest = { binding: BrowserSurfaceBinding, requestId: str, prompt: BrowserPrompt }
type SurfaceVisibility = SurfaceClosed | SurfacePaused | SurfaceVisible
pure def mayAnswerBrowserRequest(live: BrowserSurfaceBinding, visibility: SurfaceVisibility, request: BrowserRequest, chosenId: str): bool =
  visibility == SurfaceVisible and live == request.binding and chosenId != "" and chosenId == request.requestId
pure def lawOldBrowserDocumentCannotReceiveAnswer(live: BrowserSurfaceBinding, visibility: SurfaceVisibility, request: BrowserRequest, chosenId: str): bool =
  live.epoch != request.binding.epoch implies not(mayAnswerBrowserRequest(live, visibility, request, chosenId))
pure def mayExposeSurfaceCapture(visibility: SurfaceVisibility, protectedSignIn: bool, ownerApproved: bool): bool =
  visibility == SurfaceVisible and not(protectedSignIn) and ownerApproved
pure def lawProtectedSurfaceCannotBeCaptured(visibility: SurfaceVisibility, ownerApproved: bool): bool =
  not(mayExposeSurfaceCapture(visibility, true, ownerApproved))
pure val liveValues = Set(
  { surfaceId: "tab1", profileId: "owner-profile", epoch: 1 },
  { surfaceId: "tab1", profileId: "owner-profile", epoch: 2 },
  { surfaceId: "tab1", profileId: "temporary-sign-in", epoch: 2 })
pure val requestValues = Set(
  { binding: { surfaceId: "tab1", profileId: "owner-profile", epoch: 1 }, requestId: "prompt1", prompt: BrowserDialog },
  { binding: { surfaceId: "tab1", profileId: "temporary-sign-in", epoch: 2 }, requestId: "prompt2", prompt: BrowserSitePermission })
pure val chosenIdValues = Set("", "prompt1", "prompt2")
```
