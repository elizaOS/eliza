---
name: gpt-multimodal
description: Analyze images and multi-frame sequences using OpenAI GPT series
---

# OpenAI Vision Analysis Skill

## Purpose
This skill enables image analysis, scene understanding, text extraction, and multi-frame comparison using OpenAI's vision-capable GPT models (e.g., `gpt-4o`, `gpt-5`). It supports single and multiple images analysis and sequential frames for temporal analysis.

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
- **Image quality**: Clear and legible; minimum 512×512px recommended
- **File size**: Under 20MB per image recommended
- **Maximum per request**: Up to 500 images, 50MB total payload
- **URL or Base64**: Images can be provided as URLs or base64-encoded data

## Output Schema
All analysis results should be returned as valid JSON conforming to this schema:

```json
{
  "success": true,
  "model": "gpt-5",
  "analysis": "Detailed description or analysis of the image content...",
  "metadata": {
    "image_count": 1,
    "detail_level": "high",
    "tokens_used": 850,
    "processing_time_ms": 1234
  },
  "extracted_data": {
    "objects": ["car", "person", "building"],
    "text_found": "Sample text from image",
    "colors": ["blue", "white", "gray"],
    "scene_type": "urban street"
  },
  "warnings": []
}
```

### Field Descriptions

- `success`: Boolean indicating whether the API call succeeded
- `model`: The GPT model used for analysis (e.g., "gpt-4o", "gpt-5")
- `analysis`: Complete textual analysis or description from the model
- `metadata.image_count`: Number of images analyzed in this request
- `metadata.detail_level`: Detail parameter used ("low", "high", or "auto")
- `metadata.tokens_used`: Approximate token count for the request
- `metadata.processing_time_ms`: Time taken to process the request
- `extracted_data`: Structured information extracted from the image(s)
- `warnings`: Array of issues or limitations encountered


## Code Examples

### Basic Image Analysis

```python
from openai import OpenAI
import base64

def analyze_image(image_path, prompt="What's in this image?"):
    """Analyze a single image using GPT-5 Vision."""
    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    
    # Read and encode image
    with open(image_path, "rb") as image_file:
        base64_image = base64.b64encode(image_file.read()).decode('utf-8')
    
    response = client.chat.completions.create(
        model="gpt-5",
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/jpeg;base64,{base64_image}"
                        }
                    }
                ]
            }
        ],
        max_tokens=300
    )
    
    return response.choices[0].message.content
```

### Using Image URLs

```python
from openai import OpenAI

def analyze_image_url(image_url, prompt="Describe this image"):
    """Analyze an image from a URL."""
    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    
    response = client.chat.completions.create(
        model="gpt-5",
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {"url": image_url}
                    }
                ]
            }
        ]
    )
    
    return response.choices[0].message.content
```

### Multiple Images Analysis

```python
from openai import OpenAI
import base64

def analyze_multiple_images(image_paths, prompt="Compare these images"):
    """Analyze multiple images in a single request."""
    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    
    # Build content array with text and all images
    content = [{"type": "text", "text": prompt}]
    
    for image_path in image_paths:
        with open(image_path, "rb") as image_file:
            base64_image = base64.b64encode(image_file.read()).decode('utf-8')
        
        content.append({
            "type": "image_url",
            "image_url": {
                "url": f"data:image/jpeg;base64,{base64_image}"
            }
        })
    
    response = client.chat.completions.create(
        model="gpt-5",
        messages=[{"role": "user", "content": content}],
        max_tokens=500
    )
    
    return response.choices[0].message.content
```

### Full Analysis with JSON Output

```python
from openai import OpenAI
import base64
import json
import time

def analyze_image_to_json(image_path, prompt="Analyze this image"):
    """Analyze image and return structured JSON output."""
    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    
    start_time = time.time()
    warnings = []
    
    try:
        # Read and encode image
        with open(image_path, "rb") as image_file:
            base64_image = base64.b64encode(image_file.read()).decode('utf-8')
        
        # Make API call
        response = client.chat.completions.create(
            model="gpt-5",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{base64_image}",
                                "detail": "high"
                            }
                        }
                    ]
                }
            ],
            max_tokens=500
        )
        
        analysis = response.choices[0].message.content
        tokens_used = response.usage.total_tokens
        processing_time = int((time.time() - start_time) * 1000)
        
        result = {
            "success": True,
            "model": "gpt-5",
            "analysis": analysis,
            "metadata": {
                "image_count": 1,
                "detail_level": "high",
                "tokens_used": tokens_used,
                "processing_time_ms": processing_time
            },
            "extracted_data": {},
            "warnings": warnings
        }
        
    except Exception as e:
        result = {
            "success": False,
            "model": "gpt-5",
            "analysis": "",
            "metadata": {
                "image_count": 0,
                "detail_level": "high",
                "tokens_used": 0,
                "processing_time_ms": 0
            },
            "extracted_data": {},
            "warnings": [f"API call failed: {str(e)}"]
        }
    
    return result

# Usage
result = analyze_image_to_json("photo.jpg", "Describe what you see in detail")
print(json.dumps(result, indent=2))
```

### Batch Processing with Sequential Frames

```python
from openai import OpenAI
import base64
from pathlib import Path

def process_video_frames(frames_directory, analysis_prompt):
    """Process sequential video frames for temporal analysis."""
    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    
    image_extensions = {'.jpg', '.jpeg', '.png', '.webp'}
    frame_paths = sorted([
        f for f in Path(frames_directory).iterdir() 
        if f.suffix.lower() in image_extensions
    ])
    
    # Analyze frames in groups (e.g., 5 frames at a time)
    batch_size = 5
    results = []
    
    for i in range(0, len(frame_paths), batch_size):
        batch = frame_paths[i:i+batch_size]
        
        # Build content with all frames in batch
        content = [{"type": "text", "text": analysis_prompt}]
        
        for frame_path in batch:
            with open(frame_path, "rb") as f:
                base64_image = base64.b64encode(f.read()).decode('utf-8')
            
            content.append({
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/jpeg;base64,{base64_image}",
                    "detail": "low"  # Use low detail for video frames to save tokens
                }
            })
        
        response = client.chat.completions.create(
            model="gpt-5",
            messages=[{"role": "user", "content": content}],
            max_tokens=800
        )
        
        results.append({
            "batch_index": i // batch_size,
            "frame_range": f"{batch[0].name} to {batch[-1].name}",
            "analysis": response.choices[0].message.content
        })
    
    return results
```

### Text Extraction from Images (OCR Alternative)

```python
from openai import OpenAI
import base64

def extract_text_with_gpt(image_path):
    """Extract text from image using GPT Vision as OCR alternative."""
    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    
    with open(image_path, "rb") as image_file:
        base64_image = base64.b64encode(image_file.read()).decode('utf-8')
    
    response = client.chat.completions.create(
        model="gpt-5",
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "text", 
                        "text": "Extract all text from this image. Return only the text content, preserving the layout and structure."
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/jpeg;base64,{base64_image}",
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


## Model Selection and Configuration

### Available Models

```python
# GPT-4o - Best for general vision tasks, fast and cost-effective
model = "gpt-4o"

# GPT-5-nano - Faster and cheaper for simple vision tasks
model = "gpt-5-nano"

# GPT-5 - More capable for complex reasoning
model = "gpt-5"
```

### Detail Level Configuration

Control how much visual detail the model processes:

```python
# Low detail - 512×512px resolution, fewer tokens, faster
"image_url": {
    "url": image_url,
    "detail": "low"
}

# High detail - Full resolution with tiling, more tokens, better accuracy
"image_url": {
    "url": image_url,
    "detail": "high"
}

# Auto - Model chooses appropriate detail level
"image_url": {
    "url": image_url,
    "detail": "auto"
}
```

**When to use each detail level:**
- **Low**: Video frames, simple scene classification, color/shape detection
- **High**: Text extraction, detailed object detection, fine-grained analysis
- **Auto**: General purpose when unsure; model optimizes cost vs. quality


## Token Cost Management

### Understanding Image Tokens

Image tokens count toward your request limits and costs:

- **Low detail**: Fixed ~85 tokens per image (gpt-5)
- **High detail**: Base tokens + tile tokens based on image dimensions
  - Images are scaled to fit within 2048×2048px
  - Divided into 512×512px tiles
  - Each tile costs additional tokens

### Cost Calculation Examples

```python
# For gpt-5 with high detail:
# - Base: 85 tokens
# - Per tile: 170 tokens
# - Example: 1024×1024 image = 85 + (2×2 tiles × 170) = 765 tokens

def estimate_tokens_high_detail(width, height):
    """Estimate token cost for high-detail image (gpt-5)."""
    # Scale to fit within 2048×2048
    scale = min(2048 / width, 2048 / height, 1.0)
    scaled_w = int(width * scale)
    scaled_h = int(height * scale)
    
    # Calculate tiles (512×512)
    tiles_x = (scaled_w + 511) // 512
    tiles_y = (scaled_h + 511) // 512
    total_tiles = tiles_x * tiles_y
    
    # Token calculation
    base_tokens = 85
    tile_tokens = total_tiles * 170
    
    return base_tokens + tile_tokens
```

### Cost Optimization Strategies

1. **Use low detail for video frames** - Temporal analysis doesn't need high resolution
2. **Resize large images before uploading** - Reduce dimensions to 1024×1024 if high detail not needed
3. **Batch related questions** - Analyze multiple aspects in one API call
4. **Cache analysis results** - Store results for repeated processing


## Advanced Use Cases

### Image Comparison

```python
def compare_images(image1_path, image2_path):
    """Compare two images and identify differences."""
    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    
    images = []
    for path in [image1_path, image2_path]:
        with open(path, "rb") as f:
            base64_image = base64.b64encode(f.read()).decode('utf-8')
            images.append(base64_image)
    
    response = client.chat.completions.create(
        model="gpt-5",
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "Compare these two images. List all differences you observe, including changes in objects, colors, positions, or any other visual elements."
                    },
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{images[0]}"}},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{images[1]}"}}
                ]
            }
        ]
    )
    
    return response.choices[0].message.content
```

### Structured Data Extraction

```python
def extract_structured_data(image_path, schema_description):
    """Extract structured information from image based on schema."""
    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    
    with open(image_path, "rb") as f:
        base64_image = base64.b64encode(f.read()).decode('utf-8')
    
    prompt = f"""Analyze this image and extract information in JSON format following this schema:
{schema_description}

Return only valid JSON, no additional text."""
    
    response = client.chat.completions.create(
        model="gpt-5",
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/jpeg;base64,{base64_image}",
                            "detail": "high"
                        }
                    }
                ]
            }
        ],
        response_format={"type": "json_object"}
    )
    
    return json.loads(response.choices[0].message.content)

# Usage example
schema = """
{
  "products": [{"name": string, "price": number, "quantity": number}],
  "total": number,
  "date": string
}
"""
data = extract_structured_data("receipt.jpg", schema)
```


## Error Handling

### Common Issues and Solutions

**Issue**: API authentication failed

```python
# Verify API key is set
import os
api_key = os.environ.get("OPENAI_API_KEY")
if not api_key:
    raise ValueError("OPENAI_API_KEY environment variable not set")
```

**Issue**: Image too large

```python
from PIL import Image

def resize_if_needed(image_path, max_size=2048):
    """Resize image if dimensions exceed maximum."""
    img = Image.open(image_path)
    
    if max(img.size) > max_size:
        img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
        resized_path = image_path.replace('.', '_resized.')
        img.save(resized_path, quality=95)
        return resized_path
    
    return image_path
```

**Issue**: Token limit exceeded

```python
# Reduce max_tokens or use low detail mode
response = client.chat.completions.create(
    model="gpt-5",
    messages=[...],
    max_tokens=300  # Reduce from default
)
```

**Issue**: Rate limit errors

```python
import time
from openai import RateLimitError

def analyze_with_retry(image_path, max_retries=3):
    """Analyze image with exponential backoff on rate limits."""
    for attempt in range(max_retries):
        try:
            return analyze_image(image_path)
        except RateLimitError:
            if attempt < max_retries - 1:
                wait_time = 2 ** attempt  # Exponential backoff
                print(f"Rate limit hit, waiting {wait_time}s...")
                time.sleep(wait_time)
            else:
                raise
```


## Best Practices

### Prompt Engineering for Vision

1. **Be specific**: "Count the number of people wearing red shirts" vs "Analyze this image"
2. **Request structured output**: Ask for JSON, lists, or tables when appropriate
3. **Provide context**: "This is a medical diagram showing..." helps the model understand
4. **Use examples**: Show the format you want in your prompt

### Image Quality Guidelines

- Use clear, well-lit images
- Ensure text is readable at original size
- Avoid extreme angles or distortions
- Crop to relevant content to save tokens
- Use standard orientations (avoid rotated images)

### Multi-Image Analysis

- Order matters: Present images in logical sequence
- Reference images explicitly: "In the first image..." 
- Limit to 10-20 images per request for best results
- Use low detail for large batches of similar images


## Quality Self-Check

Before returning results, verify:

- [ ] Output is valid JSON (use `json.loads()` to validate)
- [ ] All required fields are present and properly typed
- [ ] API errors are caught and handled gracefully
- [ ] Token usage is tracked and within limits
- [ ] Image formats are supported (JPG, PNG, WEBP, GIF)
- [ ] Base64 encoding is correct (no corruption)
- [ ] Model name is valid and available
- [ ] Results are consistent with the prompt request


## Limitations

### Vision Model Limitations

- **Not for medical diagnosis**: Cannot interpret CT scans, X-rays, or provide medical advice
- **Poor text recognition**: Struggles with rotated, upside-down, or very small text (< 10pt)
- **Non-Latin scripts**: Reduced accuracy for non-Latin alphabets and special characters
- **Spatial reasoning**: Weak at precise localization tasks (e.g., chess positions, exact coordinates)
- **Graph interpretation**: Cannot reliably distinguish line styles (solid vs dashed) or precise color gradients
- **Object counting**: Provides approximate counts; may miss or double-count objects
- **Panoramic/fisheye**: Distorted perspectives reduce accuracy
- **Metadata loss**: Original EXIF data and exact dimensions are not preserved

### Performance Considerations

- **Latency**: High-detail mode takes longer to process
- **Token costs**: Multiple images can quickly consume token budgets
- **Rate limits**: Vision requests count toward TPM (tokens per minute) limits
- **File size**: 20MB per image practical limit; 50MB total per request
- **Batch size**: Over 20 images may degrade quality or hit timeouts

