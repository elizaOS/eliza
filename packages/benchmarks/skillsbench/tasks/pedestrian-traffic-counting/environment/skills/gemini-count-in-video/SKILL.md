---
name: gemini-count-in-video
description: Analyze and count objects in videos using Google Gemini API (object counting, pedestrian detection, vehicle tracking, and surveillance video analysis).
---

# Gemini Video Understanding Skill

## Purpose
This skill enables video analysis and object counting using the Google Gemini API, with a focus on **counting pedestrians**, **detecting objects**, **tracking movement**, and **analyzing surveillance footage**. It supports precise prompting for differentiated counting (e.g., pedestrians vs cyclists vs vehicles).

## When to Use
- Counting pedestrians, vehicles, or other objects in surveillance videos
- Distinguishing between different types of objects (walkers vs cyclists, cars vs trucks)
- Analyzing traffic patterns and movement through a scene
- Processing multiple videos for batch object counting
- Extracting structured count data from video footage

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
  - Use the File API upload flow for larger videos (most surveillance footage).
  - Always wait for processing to complete before analysis.
- **Video quality**: Higher resolution provides better counting accuracy for distant objects
- **Duration**: Longer videos may require longer processing times; consider the full video length for accurate counting

## Output Schema
For object counting tasks, structure results as JSON:

```json
{
  "success": true,
  "video_file": "surveillance_001.mp4",
  "model": "gemini-2.0-flash-exp",
  "counts": {
    "pedestrians": 12,
    "cyclists": 3,
    "vehicles": 5
  },
  "notes": "Optional observations about the counting process or edge cases"
}
```

### Field Descriptions
- `success`: Whether the analysis completed successfully
- `video_file`: Name of the analyzed video file
- `model`: Gemini model used for the request
- `counts`: Object counts by category
- `notes`: Any clarifications or warnings about the count

## Code Examples

### Basic Pedestrian Counting (File API Upload)

```python
from google import genai
import os
import time
import re

client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

# Upload video (File API for >20MB)
myfile = client.files.upload(file="surveillance.mp4")

# Wait for processing
while myfile.state.name == "PROCESSING":
    time.sleep(5)
    myfile = client.files.get(name=myfile.name)

if myfile.state.name == "FAILED":
    raise ValueError("Video processing failed")

# Prompt for counting pedestrians with clear exclusion criteria
prompt = """Count the total number of pedestrians who are WALKING through the scene in this surveillance video.

IMPORTANT RULES:
- ONLY count people who are walking on foot
- DO NOT count people riding bicycles
- DO NOT count people driving cars or other vehicles
- Count each unique pedestrian only once, even if they appear in multiple frames

Provide your answer as a single integer number representing the total count of pedestrians.
Answer with just the number, nothing else.
Your answer should be enclosed in <answer> and </answer> tags, such as <answer>5</answer>.
"""

response = client.models.generate_content(
    model="gemini-2.0-flash-exp",
    contents=[prompt, myfile],
)

# Parse the response
response_text = response.text.strip()
match = re.search(r"<answer>(\d+)</answer>", response_text)
if match:
    count = int(match.group(1))
    print(f"Pedestrian count: {count}")
else:
    print("Could not parse count from response")
```

### Batch Processing Multiple Videos

```python
from google import genai
import os
import time
import re

def upload_and_wait(client, file_path: str, max_wait_s: int = 300):
    """Upload video and wait for processing."""
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

client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

# Process all videos in directory
video_dir = "/app/video"
video_extensions = {".mp4", ".mkv", ".avi", ".mov"}
results = {}

for filename in os.listdir(video_dir):
    if any(filename.lower().endswith(ext) for ext in video_extensions):
        video_path = os.path.join(video_dir, filename)
        
        print(f"Processing {filename}...")
        
        # Upload and analyze
        myfile = upload_and_wait(client, video_path)
        
        response = client.models.generate_content(
            model="gemini-2.0-flash-exp",
            contents=["Count pedestrians walking through the scene. Answer with just the number.", myfile],
        )
        
        # Extract count
        count = int(re.search(r'\d+', response.text).group())
        results[filename] = count
        print(f"  Count: {count}")

print(f"\nProcessed {len(results)} videos")
# Results dictionary can now be used for further processing or saving
```

### Differentiating Object Types

```python
# Count different categories separately
prompt = """Analyze this surveillance video and count:
1. Pedestrians (people walking on foot)
2. Cyclists (people riding bicycles)
3. Vehicles (cars, trucks, motorcycles)

RULES:
- Count each unique individual/vehicle only once
- If someone switches from walking to cycling, count them in their primary mode
- Provide counts as three separate numbers

Format your answer as:
Pedestrians: <number>
Cyclists: <number>
Vehicles: <number>
"""

response = client.models.generate_content(
    model="gemini-2.0-flash-exp",
    contents=[prompt, myfile],
)

# Parse multiple counts
text = response.text
pedestrians = int(re.search(r'Pedestrians:\s*(\d+)', text).group(1))
cyclists = int(re.search(r'Cyclists:\s*(\d+)', text).group(1))
vehicles = int(re.search(r'Vehicles:\s*(\d+)', text).group(1))
```

### Using Answer Tags for Reliable Parsing

```python
# Request structured output with XML-like tags
prompt = """Count the total number of pedestrians walking through the scene.

You should reason and think step by step. Provide your answer as a single integer.
Your answer should be enclosed in <answer> and </answer> tags, such as <answer>5</answer>.
"""

response = client.models.generate_content(
    model="gemini-2.0-flash-exp",
    contents=[prompt, myfile],
)

# Robust extraction
match = re.search(r"<answer>(\d+)</answer>", response.text)
if match:
    count = int(match.group(1))
else:
    # Fallback: try to find any number in response
    numbers = re.findall(r'\d+', response.text)
    count = int(numbers[0]) if numbers else 0
```


## Best Practices
- **Use the File API** for all surveillance videos (typically >20MB) and always wait for processing to complete.
- **Be specific in prompts**: Clearly define what to count and what to exclude (e.g., "walking pedestrians only, not cyclists").
- **Use structured output formats**: Request answers in specific formats (like `<answer>N</answer>`) for reliable parsing.
- **Ask for reasoning**: Include "think step by step" to improve counting accuracy.
- **Handle edge cases**: Specify rules for partial appearances, people entering/exiting frame, and mode changes.
- **Use gemini-2.0-flash-exp or gemini-2.5-flash**: These models provide good balance of speed and accuracy for object counting.
- **Test with sample videos**: Verify prompt effectiveness on representative samples before batch processing.

## Error Handling

```python
import time

def upload_and_wait(client, file_path: str, max_wait_s: int = 300):
    """Upload video and wait for processing with timeout."""
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

def count_with_fallback(client, video_path):
    """Count pedestrians with error handling and fallback."""
    try:
        myfile = upload_and_wait(client, video_path)
        
        prompt = """Count pedestrians walking through the scene.
        Answer with just the number in <answer></answer> tags."""
        
        response = client.models.generate_content(
            model="gemini-2.0-flash-exp",
            contents=[prompt, myfile],
        )
        
        # Try structured parsing first
        match = re.search(r"<answer>(\d+)</answer>", response.text)
        if match:
            return int(match.group(1))
        
        # Fallback to any number found
        numbers = re.findall(r'\d+', response.text)
        if numbers:
            return int(numbers[0])
        
        print(f"Warning: Could not parse count, defaulting to 0")
        return 0
        
    except Exception as e:
        print(f"Error processing video: {e}")
        return 0
```

Common issues:
- **Upload processing stuck**: Use timeout logic and fail gracefully after max wait time
- **Ambiguous responses**: Use structured output tags like `<answer></answer>` for reliable parsing
- **Rate limits**: Add retry logic with exponential backoff for batch processing
- **Inconsistent counts**: Be very explicit in prompts about counting rules and exclusions

## Limitations
- Counting accuracy depends on video quality, camera angle, and object size/distance
- Very crowded scenes may have higher counting variance
- Occlusion (objects blocking each other) can affect accuracy
- Long videos require longer processing times (typically 5-30 seconds per video)
- The model may occasionally misclassify similar objects (e.g., motorcyclist as cyclist)
- For highest accuracy, use clear prompts with explicit inclusion/exclusion criteria

## Version History
- **1.0.0** (2026-01-21): Tailored for pedestrian traffic counting with focus on object counting, differentiation, and batch processing


## Resources

- [Video API Docs](https://ai.google.dev/gemini-api/docs/video-understanding)
- [Get API Key](https://aistudio.google.com/apikey)
- [Pricing](https://ai.google.dev/pricing)
- [Python SDK Documentation](https://ai.google.dev/gemini-api/docs/quickstart?lang=python)