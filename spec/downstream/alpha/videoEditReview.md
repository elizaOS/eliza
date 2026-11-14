# AlphaPhone video edit review

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` opens
`apps/app/src/prototype/video-edit-review.ts` from Photos. The
pinned `VideoEditReview.qnt` models the editor lifecycle.
[Android video copy](../mobileVideoCopy.md) owns export and provider
custody. [Saved media requests](./mediaCopyIntent.md) owns the durable
intent and result publication.

## Story: Preview a trim and submit the exact edits once

### Review starts from the complete video and clamps each handle to the other

One review has one source duration and starts at the full range with
rotation zero and no crop. The model takes an admitted duration and
normalized positions in milliseconds. Require a loaded source to change
the edit or start playback. Start is clamped between zero and end minus
100 ms. End is clamped between start plus 100 ms and the source duration.
Moving either handle pauses playback and seeks to the corresponding
position. Keyboard steps are 100 ms or one second with Shift; Home
and End request the limits. Preview begins at start when the playhead
is outside the selected range and pauses when reaching end. Rotate in
clockwise quarter turns, or toggle the centered crop. Display the clock
rounded to tenths before splitting minutes and seconds, so rounding
59.96 seconds does not display a 60-second field.

```quint
type ReviewTrim = { startMs: int, endMs: int, rotation: int, crop: bool }
type VideoReviewReply = ReviewSleeping | ReviewSaved | ReviewNotSaved | ReviewUnconfirmed | ReviewDropped
type VideoReview = { durationMs: int, ready: bool, loaded: bool, closed: bool, playing: bool,
  submitted: bool, abortSignal: bool, edit: ReviewTrim, frozen: ReviewTrim, reply: VideoReviewReply }
type TrimHandle = ReviewStart | ReviewEnd
pure val emptyTrim: ReviewTrim = { startMs: 0, endMs: 0, rotation: 0, crop: false }
pure val initial: VideoReview = { durationMs: 0, ready: false, loaded: false, closed: false, playing: false,
  submitted: false, abortSignal: false, edit: emptyTrim, frozen: emptyTrim, reply: ReviewSleeping }
pure def canSetReviewDuration(s: VideoReview, durationMs: int): bool =
  not(s.ready or s.closed) and durationMs >= 100 and durationMs <= 300000
pure def setReviewDuration(s: VideoReview, durationMs: int): VideoReview =
  { ...s, ready: true, durationMs: durationMs, edit: { ...emptyTrim, endMs: durationMs } }
pure def canLoadVideoReview(s: VideoReview): bool = s.ready and not(s.closed or s.loaded)
pure def loadVideoReview(s: VideoReview): VideoReview = { ...s, loaded: true }
pure def canLoseVideoReview(s: VideoReview): bool = s.loaded and not(s.closed)
pure def loseVideoReview(s: VideoReview): VideoReview = { ...s, loaded: false, playing: false }
pure def editableReview(s: VideoReview): bool = s.ready and s.loaded and not(s.closed or s.submitted)
pure def boundReviewPosition(lowMs: int, highMs: int, targetMs: int): int =
  if (targetMs < lowMs) lowMs else if (targetMs > highMs) highMs else targetMs
pure def canTrimVideoReview(s: VideoReview): bool = editableReview(s)
pure def trimVideoReview(s: VideoReview, hand: TrimHandle, targetMs: int): VideoReview =
  { ...s, playing: false,
    edit: if (hand == ReviewStart) { ...s.edit, startMs: boundReviewPosition(0,s.edit.endMs - 100,targetMs) }
    else { ...s.edit, endMs: boundReviewPosition(s.edit.startMs + 100,s.durationMs,targetMs) } }
pure def canRotateVideoReview(s: VideoReview): bool = editableReview(s)
pure def rotateVideoReview(s: VideoReview): VideoReview = { ...s, edit: { ...s.edit, rotation: (s.edit.rotation + 90) % 360 } }
pure def canCropVideoReview(s: VideoReview): bool = editableReview(s)
pure def cropVideoReview(s: VideoReview): VideoReview = { ...s, edit: { ...s.edit, crop: not(s.edit.crop) } }
pure def canPlayVideoReview(s: VideoReview): bool = editableReview(s) and not(s.playing)
pure def playVideoReview(s: VideoReview): VideoReview = { ...s, playing: true }
pure def canPauseVideoReview(s: VideoReview): bool = s.playing
pure def pauseVideoReview(s: VideoReview): VideoReview = { ...s, playing: false }
pure def reviewClockMinutes(roundedTenths: int): int = roundedTenths / 600
pure def reviewClockSecondTenths(roundedTenths: int): int = roundedTenths % 600
pure def lawClockSecondsNeverReachSixty(roundedTenths: int): bool =
  roundedTenths >= 0 implies reviewClockSecondTenths(roundedTenths) >= 0 and reviewClockSecondTenths(roundedTenths) < 600
pure def alwaysTrimRemainsInsideVideo(s: VideoReview): bool =
  s.ready implies s.edit.startMs >= 0 and s.edit.endMs <= s.durationMs and
  s.edit.startMs + 100 <= s.edit.endMs and Set(0,90,180,270).contains(s.edit.rotation)
pure def alwaysPlayingNeedsEditableVideo(s: VideoReview): bool = s.playing implies editableReview(s)
pure def sometimesVideoReviewHasTightTrim(s: VideoReview): bool =
  s.ready and s.edit.endMs - s.edit.startMs == 100 and s.edit.startMs > 0
pure val durationMsValues = Set(0,99,100,400,4000)
pure val targetMsValues = Set(-20,0,100,200,300,400,4001)
pure val roundedTenthsValues = Set(0,599,600,1199,1200)
pure val weight_setReviewDuration = 5
pure val weight_loadVideoReview = 6
pure val weight_trimVideoReview = 5
```

### A submitted edit stays frozen and closure drops late results

Save validates the edit, pauses preview and captures a copy of the
parameters. The editor stays busy after a failed or unconfirmed save.
A new save needs a new editor. A saved result closes the current
review. Back, page hide, launcher Home and explicit close retire it
and abort the signal. Retiring the UI does not reverse a dispatched
provider effect. A completion after retirement cannot publish to the
dialog. Close stops animation frames, releases the media source and
object URL, and restores the previously focused element if connected.

Discovered by the proof: a submitted edit still belongs to the review
whose source duration initialized it. Otherwise an uninitialized
review could reset a frozen submission.

Native playback uses the admitted same-origin range source. The
browser fetches the admitted source once and creates a URL. Loaded
and source-error callbacks own the enabled controls. Error pauses the
preview. Only active playback schedules paint, with a roughly 30 fps
limit and drawing only when the frame position changed. Real time,
decoder frames, signal effects, and focus remain renderer ports.

```quint
type SettledReview = VideoSaveConfirmed | VideoSaveRefused | VideoSaveUnknown
pure def canSubmitVideoReview(s: VideoReview, editAdmitted: bool): bool = editableReview(s) and editAdmitted
pure def submitVideoReview(s: VideoReview, editAdmitted: bool): VideoReview =
  { ...s, submitted: true, frozen: s.edit, playing: false }
pure def canCloseVideoReview(s: VideoReview): bool = not(s.closed)
pure def closeVideoReview(s: VideoReview): VideoReview = { ...s, closed: true, abortSignal: true, playing: false }
pure def canSettleVideoReview(s: VideoReview): bool = s.submitted and s.reply == ReviewSleeping
pure def settleVideoReview(s: VideoReview, saveReply: SettledReview): VideoReview =
  if (s.closed) { ...s, reply: ReviewDropped }
  else if (saveReply == VideoSaveConfirmed) { ...s, reply: ReviewSaved, closed: true, abortSignal: true, playing: false }
  else { ...s, reply: if (saveReply == VideoSaveRefused) ReviewNotSaved else ReviewUnconfirmed }
pure def alwaysSubmittedEditIsFrozen(s: VideoReview): bool = s.submitted implies s.ready and s.edit == s.frozen
pure def alwaysClosedPreviewHasStopped(s: VideoReview): bool = s.closed implies s.abortSignal and not(s.playing)
pure def alwaysSavedResultClosesReview(s: VideoReview): bool = s.reply == ReviewSaved implies s.closed
pure def stepNoSecondSave(before: VideoReview, via: str, after: VideoReview): bool =
  via == "submitVideoReview" implies not(before.submitted) and after.submitted
pure def stepSubmittedCopyRemainsExact(before: VideoReview, after: VideoReview): bool =
  before.submitted implies after.submitted and after.frozen == before.frozen
pure def sometimesLateVideoResultDrops(s: VideoReview): bool = s.reply == ReviewDropped
pure def sometimesSavedVideoReview(s: VideoReview): bool = s.reply == ReviewSaved and s.frozen.rotation == 90
pure def sometimesVideoSaveRefused(s: VideoReview): bool = s.reply == ReviewNotSaved and not(s.closed)
pure val weight_submitVideoReview = 7
pure val weight_settleVideoReview = 7
pure val weight_rotateVideoReview = 4
```

The pinned `test/quint-video-edit-review.test.mjs` drives the actual
renderer through the original Quint lifecycle. Chromium exercises
the pointer and media transfer through Photos, including Back, page
hide and Home while the save is pending.
