# Native plugin shared types

Swabble and Talk Mode consume the platform speech recognizer through local callbacks. The package also exposes the shared listener contract.

## Story: Read the speech updates the platform actually delivered

> As a speech client, I want reliable final and interim results from the browser recognizer, so previous results and malformed entries are kept out of the current update.

### Only changed in-range results with a valid confidence reach the listener

The boundary parses the recognizer's list, keeps the platform's final marker and normalizes confidence to millionths. Unsupported constructors yield unavailable before listeners are installed.

```quint
type SpeechProvider = StandardRecognition | WebkitRecognition | RecognitionUnavailable
type SpeechStability = InterimSpeech | FinalSpeech
type RecognitionSegment = { transcript: str, stability: SpeechStability, confidenceMillionths: int }
pure def speechProvider(standardPresent: bool, webkitPresent: bool): SpeechProvider =
  if (standardPresent) StandardRecognition else
  if (webkitPresent) WebkitRecognition else RecognitionUnavailable
pure def mayReadResult(index: int, firstChangedIndex: int, resultCount: int): bool =
  firstChangedIndex >= 0 and index >= firstChangedIndex and index < resultCount
pure def validSegment(segment: RecognitionSegment): bool =
  segment.transcript != "" and segment.confidenceMillionths >= 0 and segment.confidenceMillionths <= 1000000
pure def lawPreviousSpeechIsOmitted(index: int, firstChangedIndex: int, resultCount: int): bool =
  index < firstChangedIndex implies not(mayReadResult(index, firstChangedIndex, resultCount))
pure def lawMissingRecognizerIsUnavailable(standardPresent: bool, webkitPresent: bool): bool =
  (not(standardPresent) and not(webkitPresent)) implies speechProvider(standardPresent, webkitPresent) == RecognitionUnavailable
```
