---
name: gemini-video-understanding
description: Analyze videos with Google Gemini API (summaries, Q&A, transcription with timestamps + visual context, scene/timeline detection, video clipping, FPS control, multi-video comparison, and YouTube URL analysis).
---

# Gemini Video Understanding Skill

## Purpose
This skill enables video understanding workflows using the Google Gemini API, including **video summarization**, **question answering**, **transcription with optional visual descriptions**, **timestamp-based queries (MM:SS)**, **scene/timeline detection**, **video clipping**, **custom FPS sampling**, **multi-video comparison**, and **YouTube URL analysis**.

## When to Use
- Summarizing a video into key points or chapters
- Answering questions about what happens at specific timestamps (MM:SS)
- Producing a transcript (optionally with visual context) and speaker labels
- Detecting scene changes or building a timeline of events
- Analyzing long videos by clipping to relevant segments or reducing FPS
- Comparing multiple videos (up to 10 videos on Gemini 2.5+)
- Analyzing public YouTube videos directly via URL

## Required Libraries

The following Python libraries are required:

```python
from google import genai
from google.genai import types
import os
import time
```

## Input Requirements
- **File formats**: MP4, MPEG, MOV, AVI, FLV, MPG, WebM, WMV, 3GPP
- **Size constraints**:
  - Use inline bytes for small files (rule of thumb: <20MB).
  - Use the File API upload flow for larger videos (most real videos).
- **YouTube**:
  - Video must be **public** (not private/unlisted) and not age-restricted.
  - Provide a valid YouTube URL.
- **Duration / context window** (model-dependent):
  - 2M-token models: ~2 hours (default resolution) or ~6 hours (low-res).
  - 1M-token models: ~1 hour (default) or ~3 hours (low-res).
- **Timestamps**: Use **MM:SS** (e.g., `01:15`) when requesting time-based answers.

## Output Schema
All extracted/derived content should be returned as valid JSON conforming to this schema:

```json
{
  "success": true,
  "source": {
    "type": "file|youtube",
    "id": "video.mp4|VIDEO_ID_OR_URL",
    "model": "gemini-2.5-flash"
  },
  "summary": "Concise summary of the video...",
  "transcript": {
    "available": true,
    "text": "Full transcript text (may include speaker labels)...",
    "includes_visual_descriptions": true
  },
  "events": [
    {
      "timestamp": "MM:SS",
      "description": "What happens at this time",
      "category": "scene_change|key_point|action|other"
    }
  ],
  "warnings": [
    "Optional warnings about limitations, missing timestamps, or low confidence areas"
  ]
}
```

### Field Descriptions
- `success`: Whether the analysis completed successfully
- `source.type`: `file` for uploaded/local content, `youtube` for YouTube analysis
- `source.id`: Filename for local uploads, or URL/ID for YouTube
- `source.model`: Gemini model used for the request
- `summary`: High-level video summary
- `transcript.*`: Transcript payload (may be omitted or `available=false` if not requested)
- `events`: Timeline items with **MM:SS** timestamps (chapters, scene changes, key actions)
- `warnings`: Any issues that could affect correctness (e.g., “timestamp not found”, “long video clipped”)

## Code Examples

### Basic Video Analysis (Local Video + File API)

```python
from google import genai
import os
import time

client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

# Upload video (File API for >20MB)
myfile = client.files.upload(file="video.mp4")

# Wait for processing
while myfile.state.name == "PROCESSING":
    time.sleep(1)
    myfile = client.files.get(name=myfile.name)

if myfile.state.name == "FAILED":
    raise ValueError("Video processing failed")

response = client.models.generate_content(
    model="gemini-2.5-flash",
    contents=["Summarize this video in 3 key points", myfile],
)

print(response.text)
```

### YouTube Video Analysis (Public Videos Only)

```python
from google import genai
from google.genai import types
import os

client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

response = client.models.generate_content(
    model="gemini-2.5-flash",
    contents=[
        "Summarize the main topics discussed",
        types.Part.from_uri(
            uri="https://www.youtube.com/watch?v=VIDEO_ID",
            mime_type="video/mp4",
        ),
    ],
)

print(response.text)
```

### Inline Video (<20MB)

```python
from google import genai
from google.genai import types
import os

client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

with open("short-clip.mp4", "rb") as f:
    video_bytes = f.read()

response = client.models.generate_content(
    model="gemini-2.5-flash",
    contents=[
        "What happens in this video?",
        types.Part.from_bytes(data=video_bytes, mime_type="video/mp4"),
    ],
)

print(response.text)
```

### Video Clipping (Analyze a Segment Only)

```python
from google.genai import types

response = client.models.generate_content(
    model="gemini-2.5-flash",
    contents=[
        "Summarize this segment",
        types.Part.from_video_metadata(
            file_uri=myfile.uri,
            start_offset="40s",
            end_offset="80s",
        ),
    ],
)
```

### Custom Frame Rate (Token/Cost Control)

```python
from google.genai import types

# Lower FPS for static content (saves tokens)
response = client.models.generate_content(
    model="gemini-2.5-flash",
    contents=[
        "Analyze this presentation",
        types.Part.from_video_metadata(file_uri=myfile.uri, fps=0.5),
    ],
)

# Higher FPS for fast-moving content
response = client.models.generate_content(
    model="gemini-2.5-flash",
    contents=[
        "Analyze rapid movements in this sports video",
        types.Part.from_video_metadata(file_uri=myfile.uri, fps=5),
    ],
)
```

### Timeline / Scene Detection (MM:SS)

```python
response = client.models.generate_content(
    model="gemini-2.5-flash",
    contents=[
        """Create a timeline with timestamps:
        - Key events
        - Scene changes
        - Important moments
        Format: MM:SS - Description
        """,
        myfile,
    ],
)
```

### Transcription (Optional Visual Descriptions)

```python
response = client.models.generate_content(
    model="gemini-2.5-flash",
    contents=[
        """Transcribe with visual context:
        - Audio transcription
        - Visual descriptions of important moments
        - Timestamps for salient events
        """,
        myfile,
    ],
)
```

### Structured JSON Output (Schema-Guided)

```python
from pydantic import BaseModel
from typing import List
from google.genai import types as genai_types

class VideoEvent(BaseModel):
    timestamp: str  # MM:SS
    description: str
    category: str

class VideoAnalysis(BaseModel):
    summary: str
    events: List[VideoEvent]
    duration: str

response = client.models.generate_content(
    model="gemini-2.5-flash",
    contents=["Analyze this video", myfile],
    config=genai_types.GenerateContentConfig(
        response_mime_type="application/json",
        response_schema=VideoAnalysis,
    ),
)
```

## Best Practices
- **Use the File API** for most videos (>20MB) and wait for processing to complete before analysis.
- **Reduce token usage** by clipping to the relevant segment and/or lowering FPS for static content.
- **Improve accuracy** by being explicit about the desired output (timestamps format, number of events, whether you want scene changes vs actions vs chapters).
- **Use `gemini-2.5-pro`** when you need highest-quality reasoning over complex, long, or visually dense videos.

## Error Handling

```python
import time

def upload_and_wait(client, file_path: str, max_wait_s: int = 300):
    myfile = client.files.upload(file=file_path)
    waited = 0

    while myfile.state.name == "PROCESSING" and waited < max_wait_s:
        time.sleep(5)
        waited += 5
        myfile = client.files.get(name=myfile.name)

    if myfile.state.name == "FAILED":
        raise ValueError(f"Video processing failed: {myfile.state.name}")
    if myfile.state.name == "PROCESSING":
        raise TimeoutError(f"Processing timeout after {max_wait_s}s")

    return myfile
```

Common issues:
- **Upload processing stuck**: wait and poll; fail after a max timeout.
- **YouTube errors**: verify the video is public and not age-restricted.
- **Rate limits**: retry with exponential backoff.
- **Incorrect timestamps**: re-prompt with strict “MM:SS” formatting and request fewer events.

## Limitations
- Long-video support is limited by model context and token budget (default vs low-res modes).
- YouTube analysis requires public videos; live streaming analysis is not supported.
- Very long videos may require chunking (clip by time range and process in segments).
- Multi-video comparison is limited (up to 10 videos per request on Gemini 2.5+).

## Version History
- **1.0.0** (2026-01-15): Initial release focused on Gemini video understanding (summaries, Q&A, timestamps, clipping, FPS control, YouTube, and structured outputs).


## Resources

- [Audio API Docs](https://ai.google.dev/gemini-api/docs/audio)
- [Image API Docs](https://ai.google.dev/gemini-api/docs/image-understanding)
- [Video API Docs](https://ai.google.dev/gemini-api/docs/video-understanding)
- [Document API Docs](https://ai.google.dev/gemini-api/docs/document-processing)
- [Image Gen Docs](https://ai.google.dev/gemini-api/docs/image-generation)
- [Get API Key](https://aistudio.google.com/apikey)
- [Pricing](https://ai.google.dev/pricing)
