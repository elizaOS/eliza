# Video processing

Local video processing exposes metadata, download, conversion and
transcription through the video service. The shell runs yt-dlp and FFmpeg,
controls temporary files, and obtains model transcription when captions
cannot provide the result.

## Story: Read metadata and captions from a video

> As an agent, I want validated metadata and the best usable transcript for
> a supported video.

### Media and caption sources have separate byte limits

The shell classifies inputs as local files or validated public URLs and
enforces the chosen size cap while reading. Redirects are checked before
following them. Local source authority and executable verification belong to
the shell.

```quint
type VideoInputKind = DirectVideo | VideoPage | LocalVideo | SubtitleDownload
type VideoInput = { sourceRef: str, kind: VideoInputKind, sourceAllowed: bool }
pure val captionByteLimit = 10485760
pure val directVideoByteLimit = 268435456
pure def requestedDownloadLimit(kind: VideoInputKind): int =
  if (kind == SubtitleDownload) captionByteLimit else directVideoByteLimit
pure def mediaReadAllowed(input: VideoInput, bytesRead: int): bool =
  input.sourceAllowed and input.sourceRef != "" and bytesRead >= 0 and bytesRead <= requestedDownloadLimit(input.kind)
pure val inputValues: Set[VideoInput] = Set(
  { sourceRef: "caption-track", kind: SubtitleDownload, sourceAllowed: true },
  { sourceRef: "private-media", kind: DirectVideo, sourceAllowed: false },
  { sourceRef: "video", kind: DirectVideo, sourceAllowed: true })
pure val bytesReadValues = Set(-1, 0, 10485759, 10485760, 10485761, 268435456, 268435457)
pure def lawCaptionLimitHolds(input: VideoInput, bytesRead: int): bool =
  input.kind == SubtitleDownload and mediaReadAllowed(input, bytesRead) implies bytesRead <= captionByteLimit
```

### Manual English captions outrank automatic English captions and audio

A manual track keyed `en`, or `en-` and a region or name such as `en-US`
or `en-GB`, is an English manual track. The `en` track is tried first, then
the others in the order the extractor lists them, and the first that has a
usable SRT, WebVTT or untyped variant is selected, ahead of automatic
captions and audio. For the selected English manual track, use SRT, WebVTT,
or an untyped variant, in that order. For automatic captions use JSON or an
untyped variant. Fall back to transcription after a missing or unusable
caption path. The shell validates and normalizes metadata, caption text, and
extractor formats independently of selection.

```quint
type SubtitleOutput = Srt | WebVtt | JsonCaptions | UntypedCaptions | ExtractAudio
type PinnedCaption = { sourceUrl: str, formatKind: SubtitleOutput }
pure def selectVideoCaption(manualSrt: str, manualVtt: str, manualUnknown: str, autoJson: str, autoUnknown: str): PinnedCaption =
  if (manualSrt != "") { sourceUrl: manualSrt, formatKind: Srt }
  else if (manualVtt != "") { sourceUrl: manualVtt, formatKind: WebVtt }
  else if (manualUnknown != "") { sourceUrl: manualUnknown, formatKind: UntypedCaptions }
  else if (autoJson != "") { sourceUrl: autoJson, formatKind: JsonCaptions }
  else if (autoUnknown != "") { sourceUrl: autoUnknown, formatKind: UntypedCaptions }
  else { sourceUrl: "", formatKind: ExtractAudio }
type ManualCaptionTrack = { primaryEnglish: bool, srtUrl: str, vttUrl: str, untypedUrl: str }
pure val noManualCaptionTrack: ManualCaptionTrack = { primaryEnglish: false, srtUrl: "", vttUrl: "", untypedUrl: "" }
pure def manualCaptionUsable(track: ManualCaptionTrack): bool = track.srtUrl != "" or track.vttUrl != "" or track.untypedUrl != ""
pure def selectManualCaptionTrack(tracks: List[ManualCaptionTrack]): ManualCaptionTrack = {
  val primary = tracks.select(track => track.primaryEnglish and manualCaptionUsable(track))
  val regional = tracks.select(track => not(track.primaryEnglish) and manualCaptionUsable(track))
  if (primary.length() > 0) primary.nth(0) else if (regional.length() > 0) regional.nth(0) else noManualCaptionTrack
}
pure val tracksValues = Set(List(), List({ ...noManualCaptionTrack, srtUrl: "en-GB.srt" }), List({ ...noManualCaptionTrack, srtUrl: "en-US.srt" }, { ...noManualCaptionTrack, primaryEnglish: true, vttUrl: "en.vtt" }), List({ ...noManualCaptionTrack, primaryEnglish: true }, { ...noManualCaptionTrack, untypedUrl: "en-US" }))
pure def lawAUsableEnglishTrackIsSelected(tracks: List[ManualCaptionTrack]): bool = tracks.some(track => manualCaptionUsable(track)) iff manualCaptionUsable(selectManualCaptionTrack(tracks))
pure def lawManualSrtWins(manualSrt: str, manualVtt: str, manualUnknown: str, autoJson: str, autoUnknown: str): bool =
  manualSrt != "" implies selectVideoCaption(manualSrt, manualVtt, manualUnknown, autoJson, autoUnknown) == { sourceUrl: manualSrt, formatKind: Srt }
pure def leapVideoYear(year: int): bool = year % 400 == 0 or (year % 4 == 0 and year % 100 != 0)
pure def maxVideoDay(year: int, month: int): int =
  if (month == 2) { if (leapVideoYear(year)) 29 else 28 }
  else if (month == 4 or month == 6 or month == 9 or month == 11) 30
  else 31
pure def compactVideoDateValid(year: int, month: int, day: int): bool =
  year >= 0 and year <= 9999 and month >= 1 and month <= 12 and day >= 1 and day <= maxVideoDay(year, month)
pure def lawFebruaryNeverHasThirty(year: int): bool = not(compactVideoDateValid(year, 2, 30))
```

## Story: Transcribe a video and reuse only completed work

> As an agent, I want repeated processing with the same input and format to
> use a finished artifact and for a failed conversion to leave no cache entry.

### A stable source and format own the metadata download or conversion result

The shell admits a validated media reference, prepares metadata or a
temporary artifact, and publishes a verified result to the content cache.
Concurrent requests for the same stable processing key use one committed
artifact. The shell owns atomic promotion and removal of failed temporary files.

```quint
type VideoJob = InspectMetadata | DownloadOriginal | ConvertMedia | BuildTranscript
type VideoPhase = VideoIdle | ProcessingVideo | VideoArtifactReady | VideoJobFailed
type VideoRun = { phase: VideoPhase, sourceRef: str, job: VideoJob, formatName: str, artifactRef: str }
pure val initial: VideoRun = { phase: VideoIdle, sourceRef: "", job: InspectMetadata, formatName: "", artifactRef: "" }
pure def canBeginVideo(s: VideoRun, sourceRef: str, formatName: str, sourceAllowed: bool): bool =
  s.phase == VideoIdle and sourceRef != "" and formatName != "" and sourceAllowed
pure def beginVideo(s: VideoRun, sourceRef: str, job: VideoJob, formatName: str, sourceAllowed: bool): VideoRun =
  { ...s, phase: ProcessingVideo, sourceRef: sourceRef, job: job, formatName: formatName }
pure def canPublishVideo(s: VideoRun, sourceRef: str, job: VideoJob, formatName: str, artifactRef: str, verified: bool): bool =
  s.phase == ProcessingVideo and s.sourceRef == sourceRef and s.job == job and s.formatName == formatName and artifactRef != "" and verified
pure def publishVideo(s: VideoRun, sourceRef: str, job: VideoJob, formatName: str, artifactRef: str, verified: bool): VideoRun =
  { ...s, phase: VideoArtifactReady, artifactRef: artifactRef }
pure def canFailVideo(s: VideoRun): bool = s.phase == ProcessingVideo
pure def failVideo(s: VideoRun): VideoRun = { ...s, phase: VideoJobFailed }
pure def alwaysVideoHasOnlyReadyArtifact(s: VideoRun): bool =
  (s.artifactRef != "") iff (s.phase == VideoArtifactReady)
pure def sometimesTranscriptReady(s: VideoRun): bool = s.phase == VideoArtifactReady and s.job == BuildTranscript
pure val eval_witness_sometimesTranscriptReady = (("beginVideo", "video", BuildTranscript, "text", true), ("publishVideo", "video", BuildTranscript, "text", "captions", true))
```
