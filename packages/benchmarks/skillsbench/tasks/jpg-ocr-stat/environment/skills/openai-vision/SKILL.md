---
name: openai-vision
description: Analyze images and multi-frame sequences using OpenAI GPT vision models
---

# OpenAI Vision Analysis Skill

## Purpose
This skill enables image analysis, scene understanding, text extraction, and multi-frame comparison using OpenAI's vision-capable GPT models (e.g., `gpt-4o`, `gpt-4o-mini`). It supports single images, multiple images for comparison, and sequential frames for temporal analysis.

## When to Use
- Analyzing image content (objects, scenes, colors, spatial relationships)
- Extracting and reading text from images (OCR via vision models)
- Comparing multiple images to detect differences or changes
- Processing video frames to understand temporal progression
- Generating detailed image descriptions or captions
- Answering questions about visual content

## Required Libraries

The following Python libraries are required:

```python
from openai import OpenAI
import base64
import json
import os
from pathlib import Path
```

## Input Requirements
- **File formats**: JPG, JPEG, PNG, WEBP, non-animated GIF
- **Image sources**: URL, Base64-encoded data, or local file paths
- **Size limits**: Up to 20MB per image; total request payload under 50MB
- **Maximum images**: Up to 500 images per request
- **Image quality**: Clear, legible content; avoid watermarks or heavy distortions

## Output Schema
Analysis results should be returned as valid JSON conforming to this schema:

```json
{
  "success": true,
  "images_analyzed": 1,
  "analysis": {
    "description": "A detailed scene description...",
    "objects": [
      {"name": "car", "color": "red", "position": "foreground center"},
      {"name": "tree", "count": 3, "position": "background"}
    ],
    "text_content": "Any text visible in the image...",
    "colors": ["blue", "green", "white"],
    "scene_type": "outdoor/urban"
  },
  "comparison": {
    "differences": ["Object X appeared", "Color changed from A to B"],
    "similarities": ["Background unchanged", "Layout consistent"]
  },
  "metadata": {
    "model_used": "gpt-4o",
    "detail_level": "high",
    "token_usage": {"prompt": 1500, "completion": 200}
  },
  "warnings": []
}
```

### Field Descriptions

- `success`: Boolean indicating whether analysis completed
- `images_analyzed`: Number of images processed in the request
- `analysis.description`: Natural language description of the image content
- `analysis.objects`: Array of detected objects with attributes
- `analysis.text_content`: Any text extracted from the image
- `analysis.colors`: Dominant colors identified
- `analysis.scene_type`: Classification of the scene
- `comparison`: Present when multiple images are analyzed; describes differences and similarities
- `metadata.model_used`: The GPT model used for analysis
- `metadata.detail_level`: Resolution level used (`low`, `high`, or `auto`)
- `metadata.token_usage`: Token consumption for cost tracking
- `warnings`: Array of any issues or limitations encountered


## Code Examples

### Basic Image Analysis from URL

```python
from openai import OpenAI

client = OpenAI()

def analyze_image_url(image_url, prompt="Describe this image in detail."):
    """Analyze an image from a URL using GPT-4o vision."""
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": image_url,
                            "detail": "high"
                        }
                    }
                ]
            }
        ],
        max_tokens=1000
    )
    return response.choices[0].message.content
```

### Image Analysis from Local File (Base64)

```python
from openai import OpenAI
import base64

client = OpenAI()

def encode_image_to_base64(image_path):
    """Encode a local image file to base64."""
    with open(image_path, "rb") as image_file:
        return base64.standard_b64encode(image_file.read()).decode("utf-8")

def get_image_media_type(image_path):
    """Determine the media type based on file extension."""
    ext = image_path.lower().split('.')[-1]
    media_types = {
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'webp': 'image/webp'
    }
    return media_types.get(ext, 'image/jpeg')

def analyze_local_image(image_path, prompt="Describe this image in detail."):
    """Analyze a local image file using GPT-4o vision."""
    base64_image = encode_image_to_base64(image_path)
    media_type = get_image_media_type(image_path)
    
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{media_type};base64,{base64_image}",
                            "detail": "high"
                        }
                    }
                ]
            }
        ],
        max_tokens=1000
    )
    return response.choices[0].message.content
```

### Multi-Image Comparison

```python
from openai import OpenAI
import base64

client = OpenAI()

def compare_images(image_paths, comparison_prompt=None):
    """Compare multiple images and identify differences."""
    if comparison_prompt is None:
        comparison_prompt = (
            "Compare these images carefully. "
            "List all differences and similarities you observe. "
            "Describe any changes in objects, colors, positions, or text."
        )
    
    content = [{"type": "text", "text": comparison_prompt}]
    
    for i, image_path in enumerate(image_paths):
        base64_image = encode_image_to_base64(image_path)
        media_type = get_image_media_type(image_path)
        
        # Add label for each image
        content.append({
            "type": "text", 
            "text": f"Image {i + 1}:"
        })
        content.append({
            "type": "image_url",
            "image_url": {
                "url": f"data:{media_type};base64,{base64_image}",
                "detail": "high"
            }
        })
    
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": content}],
        max_tokens=2000
    )
    return response.choices[0].message.content
```

### Multi-Frame Video Analysis

```python
from openai import OpenAI
import base64
from pathlib import Path

client = OpenAI()

def analyze_video_frames(frame_paths, analysis_prompt=None):
    """Analyze a sequence of video frames for temporal understanding."""
    if analysis_prompt is None:
        analysis_prompt = (
            "These are sequential frames from a video. "
            "Describe what is happening over time. "
            "Identify any motion, changes, or events that occur across the frames."
        )
    
    content = [{"type": "text", "text": analysis_prompt}]
    
    for i, frame_path in enumerate(frame_paths):
        base64_image = encode_image_to_base64(frame_path)
        media_type = get_image_media_type(frame_path)
        
        content.append({
            "type": "text",
            "text": f"Frame {i + 1}:"
        })
        content.append({
            "type": "image_url",
            "image_url": {
                "url": f"data:{media_type};base64,{base64_image}",
                "detail": "auto"  # Use auto for frames to balance cost
            }
        })
    
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": content}],
        max_tokens=2000
    )
    return response.choices[0].message.content
```

### Full Analysis with JSON Output

```python
from openai import OpenAI
import base64
import json
import os

client = OpenAI()

def analyze_image_to_json(image_path, extract_text=True):
    """Perform comprehensive image analysis and return structured JSON."""
    filename = os.path.basename(image_path)
    
    prompt = """Analyze this image and return a JSON object with the following structure:
{
    "description": "detailed scene description",
    "objects": [{"name": "object name", "attributes": "color, size, position"}],
    "text_content": "any visible text or null if none",
    "colors": ["dominant", "colors"],
    "scene_type": "indoor/outdoor/abstract/etc",
    "people_count": 0,
    "notable_features": ["list of notable visual elements"]
}

Return ONLY valid JSON, no other text."""

    try:
        base64_image = encode_image_to_base64(image_path)
        media_type = get_image_media_type(image_path)
        
        response = client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{media_type};base64,{base64_image}",
                                "detail": "high"
                            }
                        }
                    ]
                }
            ],
            max_tokens=1500
        )
        
        # Parse the response as JSON
        analysis_text = response.choices[0].message.content
        # Remove markdown code blocks if present
        if analysis_text.startswith("```"):
            analysis_text = analysis_text.split("```")[1]
            if analysis_text.startswith("json"):
                analysis_text = analysis_text[4:]
        analysis = json.loads(analysis_text.strip())
        
        result = {
            "success": True,
            "filename": filename,
            "analysis": analysis,
            "metadata": {
                "model_used": "gpt-4o",
                "detail_level": "high",
                "token_usage": {
                    "prompt": response.usage.prompt_tokens,
                    "completion": response.usage.completion_tokens
                }
            },
            "warnings": []
        }
        
    except json.JSONDecodeError as e:
        result = {
            "success": False,
            "filename": filename,
            "analysis": {"raw_response": response.choices[0].message.content},
            "metadata": {"model_used": "gpt-4o"},
            "warnings": [f"Failed to parse JSON: {str(e)}"]
        }
    except Exception as e:
        result = {
            "success": False,
            "filename": filename,
            "analysis": {},
            "metadata": {},
            "warnings": [f"Analysis failed: {str(e)}"]
        }
    
    return result

# Usage
result = analyze_image_to_json("photo.jpg")
print(json.dumps(result, indent=2))
```

### Batch Processing Directory

```python
from openai import OpenAI
import base64
import json
from pathlib import Path

client = OpenAI()

def process_image_directory(directory_path, output_file, prompt=None):
    """Process all images in a directory and save results."""
    if prompt is None:
        prompt = "Describe this image briefly, including any visible text."
    
    image_extensions = {'.jpg', '.jpeg', '.png', '.webp', '.gif'}
    results = []
    
    for file_path in sorted(Path(directory_path).iterdir()):
        if file_path.suffix.lower() in image_extensions:
            print(f"Processing: {file_path.name}")
            
            try:
                analysis = analyze_local_image(str(file_path), prompt)
                results.append({
                    "filename": file_path.name,
                    "success": True,
                    "analysis": analysis
                })
            except Exception as e:
                results.append({
                    "filename": file_path.name,
                    "success": False,
                    "error": str(e)
                })
    
    # Save results
    with open(output_file, 'w') as f:
        json.dump(results, f, indent=2)
    
    return results
```


## Detail Level Configuration

The `detail` parameter controls image resolution and token usage:

```python
# Low detail: 512x512 fixed, ~85 tokens per image
# Best for: Quick summaries, dominant colors, general scene type
{"detail": "low"}

# High detail: Full resolution processing
# Best for: Reading text, detecting small objects, detailed analysis
{"detail": "high"}

# Auto: Model decides based on image size
# Best for: General use when cost vs quality tradeoff is acceptable
{"detail": "auto"}
```

### Choosing Detail Level

```python
def get_recommended_detail(task_type):
    """Recommend detail level based on task type."""
    high_detail_tasks = {
        'ocr', 'text_extraction', 'document_analysis',
        'small_object_detection', 'detailed_comparison',
        'fine_grained_analysis'
    }
    
    low_detail_tasks = {
        'scene_classification', 'dominant_colors',
        'general_description', 'thumbnail_preview'
    }
    
    if task_type.lower() in high_detail_tasks:
        return "high"
    elif task_type.lower() in low_detail_tasks:
        return "low"
    else:
        return "auto"
```


## Text Extraction (Vision-based OCR)

For extracting text from images using vision models:

```python
def extract_text_from_image(image_path, preserve_layout=False):
    """Extract text from an image using GPT-4o vision."""
    if preserve_layout:
        prompt = (
            "Extract ALL text visible in this image. "
            "Preserve the original layout and formatting as much as possible. "
            "Include headers, paragraphs, captions, and any other text. "
            "Return only the extracted text, nothing else."
        )
    else:
        prompt = (
            "Extract all text visible in this image. "
            "Return the text in reading order (top to bottom, left to right). "
            "Return only the extracted text, nothing else."
        )
    
    return analyze_local_image(image_path, prompt)


def extract_structured_text(image_path):
    """Extract text with structure information as JSON."""
    prompt = """Extract all text from this image and return as JSON:
{
    "headers": ["list of headers/titles"],
    "paragraphs": ["list of paragraph texts"],
    "labels": ["list of labels or captions"],
    "other_text": ["any other text elements"],
    "reading_order": ["all text in reading order"]
}
Return ONLY valid JSON."""
    
    response = analyze_local_image(image_path, prompt)
    
    try:
        # Clean and parse JSON
        if response.startswith("```"):
            response = response.split("```")[1]
            if response.startswith("json"):
                response = response[4:]
        return json.loads(response.strip())
    except json.JSONDecodeError:
        return {"raw_text": response, "parse_error": True}
```


## Error Handling

### Common Issues and Solutions

**Issue**: API rate limits exceeded

```python
import time
from openai import RateLimitError

def analyze_with_retry(image_path, prompt, max_retries=3):
    """Analyze image with exponential backoff retry."""
    for attempt in range(max_retries):
        try:
            return analyze_local_image(image_path, prompt)
        except RateLimitError:
            if attempt < max_retries - 1:
                wait_time = 2 ** attempt  # Exponential backoff
                print(f"Rate limited, waiting {wait_time}s...")
                time.sleep(wait_time)
            else:
                raise
```

**Issue**: Image too large

```python
from PIL import Image
import io

def resize_image_if_needed(image_path, max_size_mb=15):
    """Resize image if it exceeds size limit."""
    file_size_mb = os.path.getsize(image_path) / (1024 * 1024)
    
    if file_size_mb <= max_size_mb:
        return encode_image_to_base64(image_path)
    
    # Resize the image
    img = Image.open(image_path)
    
    # Calculate new dimensions (reduce by 50% iteratively)
    while file_size_mb > max_size_mb:
        new_width = img.width // 2
        new_height = img.height // 2
        img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
        
        # Check new size
        buffer = io.BytesIO()
        img.save(buffer, format='JPEG', quality=85)
        file_size_mb = len(buffer.getvalue()) / (1024 * 1024)
    
    # Encode resized image
    buffer = io.BytesIO()
    img.save(buffer, format='JPEG', quality=85)
    return base64.standard_b64encode(buffer.getvalue()).decode("utf-8")
```

**Issue**: Invalid image format

```python
def validate_image(image_path):
    """Validate image before processing."""
    valid_extensions = {'.jpg', '.jpeg', '.png', '.gif', '.webp'}
    
    path = Path(image_path)
    
    if not path.exists():
        return False, "File does not exist"
    
    if path.suffix.lower() not in valid_extensions:
        return False, f"Unsupported format: {path.suffix}"
    
    try:
        with Image.open(image_path) as img:
            img.verify()
        return True, "Valid image"
    except Exception as e:
        return False, f"Invalid image: {str(e)}"
```


## Quality Self-Check

Before returning results, verify:

- [ ] API response was received successfully
- [ ] Output is valid JSON (if structured output requested)
- [ ] All requested analysis fields are present
- [ ] Token usage is within expected bounds
- [ ] No error messages in the response
- [ ] For multi-image: all images were processed
- [ ] Confidence/warnings are included when analysis is uncertain


## Limitations

- **Medical imagery**: Not suitable for diagnostic analysis of CT scans, X-rays, or MRIs
- **Small text**: Text smaller than ~12pt may be misread; use `detail: high`
- **Rotated/skewed text**: Accuracy decreases with text rotation; pre-process if needed
- **Non-Latin scripts**: Lower accuracy for complex scripts (CJK, Arabic, etc.)
- **Object counting**: Approximate counts only; may miss or double-count similar objects
- **Spatial precision**: Cannot provide pixel-accurate bounding boxes or measurements
- **Panoramic/fisheye**: Distorted images reduce analysis accuracy
- **Graphs and charts**: May misinterpret line styles, legends, or data points
- **Metadata**: Cannot access EXIF data, camera info, or GPS coordinates from images
- **Cost**: High-detail analysis of many images can be expensive; monitor token usage


## Token Cost Estimation

Approximate token costs for image inputs:

| Detail Level | Tokens per Image | Best For |
|-------------|------------------|----------|
| low | ~85 tokens (fixed) | Quick classification, color detection |
| high | 85 + 170 per 512x512 tile | OCR, detailed analysis, small objects |
| auto | Variable | General use |

```python
def estimate_image_tokens(image_path, detail="high"):
    """Estimate token usage for an image."""
    if detail == "low":
        return 85
    
    with Image.open(image_path) as img:
        width, height = img.size
    
    # High detail: image is scaled to fit in 2048x2048, then tiled at 512x512
    scale = min(2048 / max(width, height), 1.0)
    scaled_width = int(width * scale)
    scaled_height = int(height * scale)
    
    # Ensure minimum 768 on shortest side
    if min(scaled_width, scaled_height) < 768:
        scale = 768 / min(scaled_width, scaled_height)
        scaled_width = int(scaled_width * scale)
        scaled_height = int(scaled_height * scale)
    
    # Calculate tiles
    tiles_x = (scaled_width + 511) // 512
    tiles_y = (scaled_height + 511) // 512
    total_tiles = tiles_x * tiles_y
    
    return 85 + (170 * total_tiles)
```


## Version History

- **1.0.0** (2026-01-21): Initial release with GPT-4o vision support
