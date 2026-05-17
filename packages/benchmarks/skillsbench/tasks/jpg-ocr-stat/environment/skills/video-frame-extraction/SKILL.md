---
name: video-frame-extraction
description: Extract frames from video files and save them as images using OpenCV
---

# Video Frame Extraction Skill

## Purpose
This skill enables extraction of individual frames from video files (MP4, AVI, MOV, etc.) using OpenCV. Extracted frames are saved as image files in a specified output directory. It is suitable for video analysis, creating training datasets, thumbnail generation, and preprocessing video content for further processing.

## When to Use
- Extracting frames for machine learning training data
- Creating image sequences from video content
- Generating video thumbnails or preview images
- Preprocessing videos for object detection or tracking
- Converting video segments to image collections for analysis
- Sampling frames at specific intervals for time-lapse effects

## Required Libraries

The following Python libraries are required:

```python
import cv2
import os
import json
from pathlib import Path
```

## Input Requirements
- **File formats**: MP4, AVI, MOV, MKV, WMV, FLV, WEBM
- **Video codec**: Must be readable by OpenCV (most common codecs supported)
- **File access**: Read permissions on source video
- **Output directory**: Write permissions on destination folder
- **Disk space**: Ensure sufficient space for extracted frames (uncompressed images)

## Output Schema
All extraction results must be returned as valid JSON conforming to this schema:

```json
{
  "success": true,
  "source_video": "sample.mp4",
  "output_directory": "/path/to/frames",
  "frames_extracted": 150,
  "extraction_params": {
    "interval": 1,
    "start_frame": 0,
    "end_frame": null,
    "output_format": "jpg"
  },
  "video_metadata": {
    "total_frames": 300,
    "fps": 30.0,
    "duration_seconds": 10.0,
    "resolution": [1920, 1080]
  },
  "output_files": [
    "frame_000001.jpg",
    "frame_000002.jpg"
  ],
  "warnings": []
}
```


### Field Descriptions

- `success`: Boolean indicating whether frame extraction completed
- `source_video`: Original video filename
- `output_directory`: Path where frames were saved
- `frames_extracted`: Total number of frames successfully saved
- `extraction_params.interval`: Frame sampling interval (1 = every frame, 2 = every other frame, etc.)
- `extraction_params.start_frame`: First frame index extracted
- `extraction_params.end_frame`: Last frame index extracted (null if extracted to end)
- `extraction_params.output_format`: Image format used for saving frames
- `video_metadata.total_frames`: Total frame count in source video
- `video_metadata.fps`: Frames per second of source video
- `video_metadata.duration_seconds`: Video duration in seconds
- `video_metadata.resolution`: Video dimensions as [width, height]
- `output_files`: List of generated frame filenames
- `warnings`: Array of issues encountered during extraction


## Code Examples

### Basic Frame Extraction

```python
import cv2
import os

def extract_all_frames(video_path, output_dir):
    """Extract all frames from a video file."""
    os.makedirs(output_dir, exist_ok=True)
    
    cap = cv2.VideoCapture(video_path)
    frame_count = 0
    
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        filename = os.path.join(output_dir, f"frame_{frame_count:06d}.jpg")
        cv2.imwrite(filename, frame)
        frame_count += 1
    
    cap.release()
    return frame_count
```

### Interval-Based Frame Extraction

```python
import cv2
import os

def extract_frames_at_interval(video_path, output_dir, interval=1):
    """Extract frames at specified intervals."""
    os.makedirs(output_dir, exist_ok=True)
    
    cap = cv2.VideoCapture(video_path)
    frame_index = 0
    saved_count = 0
    
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        if frame_index % interval == 0:
            filename = os.path.join(output_dir, f"frame_{saved_count:06d}.jpg")
            cv2.imwrite(filename, frame)
            saved_count += 1
        
        frame_index += 1
    
    cap.release()
    return saved_count
```

### Full Extraction with JSON Output

```python
import cv2
import os
import json
from pathlib import Path

def extract_frames_to_json(video_path, output_dir, interval=1, 
                           start_frame=0, end_frame=None, output_format="jpg"):
    """Extract frames and return results as JSON."""
    video_name = os.path.basename(video_path)
    warnings = []
    output_files = []
    
    try:
        os.makedirs(output_dir, exist_ok=True)
        cap = cv2.VideoCapture(video_path)
        
        if not cap.isOpened():
            raise ValueError(f"Cannot open video: {video_path}")
        
        # Get video metadata
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = cap.get(cv2.CAP_PROP_FPS)
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        duration = total_frames / fps if fps > 0 else 0
        
        # Set end frame if not specified
        if end_frame is None:
            end_frame = total_frames
        
        # Seek to start frame
        if start_frame > 0:
            cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
        
        frame_index = start_frame
        saved_count = 0
        
        while frame_index < end_frame:
            ret, frame = cap.read()
            if not ret:
                if frame_index < end_frame:
                    warnings.append(f"Video ended early at frame {frame_index}")
                break
            
            if (frame_index - start_frame) % interval == 0:
                filename = f"frame_{saved_count:06d}.{output_format}"
                filepath = os.path.join(output_dir, filename)
                cv2.imwrite(filepath, frame)
                output_files.append(filename)
                saved_count += 1
            
            frame_index += 1
        
        cap.release()
        
        result = {
            "success": True,
            "source_video": video_name,
            "output_directory": str(output_dir),
            "frames_extracted": saved_count,
            "extraction_params": {
                "interval": interval,
                "start_frame": start_frame,
                "end_frame": end_frame,
                "output_format": output_format
            },
            "video_metadata": {
                "total_frames": total_frames,
                "fps": fps,
                "duration_seconds": round(duration, 2),
                "resolution": [width, height]
            },
            "output_files": output_files,
            "warnings": warnings
        }
        
    except Exception as e:
        result = {
            "success": False,
            "source_video": video_name,
            "output_directory": str(output_dir),
            "frames_extracted": 0,
            "extraction_params": {
                "interval": interval,
                "start_frame": start_frame,
                "end_frame": end_frame,
                "output_format": output_format
            },
            "video_metadata": {
                "total_frames": 0,
                "fps": 0,
                "duration_seconds": 0,
                "resolution": [0, 0]
            },
            "output_files": [],
            "warnings": [f"Extraction failed: {str(e)}"]
        }
    
    return result

# Usage
result = extract_frames_to_json("video.mp4", "./frames", interval=10)
print(json.dumps(result, indent=2))
```

### Time-Based Frame Extraction

```python
import cv2
import os

def extract_frames_by_seconds(video_path, output_dir, seconds_interval=1.0):
    """Extract frames at specific time intervals (in seconds)."""
    os.makedirs(output_dir, exist_ok=True)
    
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    frame_interval = int(fps * seconds_interval)
    
    if frame_interval < 1:
        frame_interval = 1
    
    frame_index = 0
    saved_count = 0
    
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        if frame_index % frame_interval == 0:
            filename = os.path.join(output_dir, f"frame_{saved_count:06d}.jpg")
            cv2.imwrite(filename, frame)
            saved_count += 1
        
        frame_index += 1
    
    cap.release()
    return saved_count
```

### Batch Processing Multiple Videos

```python
import cv2
import os
import json
from pathlib import Path

def process_video_directory(video_dir, output_base_dir, interval=1):
    """Process all videos in a directory and extract frames."""
    video_extensions = {'.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm'}
    results = []
    
    for video_file in sorted(Path(video_dir).iterdir()):
        if video_file.suffix.lower() in video_extensions:
            video_output_dir = os.path.join(
                output_base_dir, 
                video_file.stem
            )
            result = extract_frames_to_json(
                str(video_file), 
                video_output_dir, 
                interval=interval
            )
            results.append(result)
            print(f"Processed: {video_file.name} -> {result['frames_extracted']} frames")
    
    return results
```


## Extraction Configuration Options

### Output Image Formats

```python
# JPEG format (default, good balance of quality and size)
cv2.imwrite("frame.jpg", frame)

# PNG format (lossless, larger files)
cv2.imwrite("frame.png", frame)

# JPEG with custom quality (0-100)
cv2.imwrite("frame.jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 95])

# PNG with compression level (0-9)
cv2.imwrite("frame.png", frame, [cv2.IMWRITE_PNG_COMPRESSION, 3])
```

### Frame Seeking Methods

```python
# Seek by frame number
cap.set(cv2.CAP_PROP_POS_FRAMES, frame_number)

# Seek by milliseconds
cap.set(cv2.CAP_PROP_POS_MSEC, milliseconds)

# Seek by ratio (0.0 to 1.0)
cap.set(cv2.CAP_PROP_POS_AVI_RATIO, 0.5)  # Middle of video
```

### Frame Resizing

```python
def extract_resized_frames(video_path, output_dir, target_size=(640, 480)):
    """Extract and resize frames to specified dimensions."""
    os.makedirs(output_dir, exist_ok=True)
    
    cap = cv2.VideoCapture(video_path)
    frame_count = 0
    
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        resized = cv2.resize(frame, target_size)
        filename = os.path.join(output_dir, f"frame_{frame_count:06d}.jpg")
        cv2.imwrite(filename, resized)
        frame_count += 1
    
    cap.release()
    return frame_count
```


## Video Metadata Retrieval

Extract video properties before processing:

```python
def get_video_info(video_path):
    """Retrieve video metadata."""
    cap = cv2.VideoCapture(video_path)
    
    if not cap.isOpened():
        return None
    
    info = {
        "total_frames": int(cap.get(cv2.CAP_PROP_FRAME_COUNT)),
        "fps": cap.get(cv2.CAP_PROP_FPS),
        "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
        "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
        "codec": int(cap.get(cv2.CAP_PROP_FOURCC)),
        "duration_seconds": cap.get(cv2.CAP_PROP_FRAME_COUNT) / cap.get(cv2.CAP_PROP_FPS)
    }
    
    cap.release()
    return info
```


## Specific Frame Extraction

For extracting frames at exact positions:

```python
def extract_specific_frames(video_path, output_dir, frame_numbers):
    """Extract specific frames by their indices."""
    os.makedirs(output_dir, exist_ok=True)
    
    cap = cv2.VideoCapture(video_path)
    extracted = []
    
    for frame_num in sorted(frame_numbers):
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_num)
        ret, frame = cap.read()
        
        if ret:
            filename = os.path.join(output_dir, f"frame_{frame_num:06d}.jpg")
            cv2.imwrite(filename, frame)
            extracted.append(frame_num)
    
    cap.release()
    return extracted
```


## Error Handling

### Common Issues and Solutions

**Issue**: Video file cannot be opened

```python
cap = cv2.VideoCapture(video_path)
if not cap.isOpened():
    print(f"Error: Cannot open video file: {video_path}")
    print("Check file path, permissions, and codec support")
```

**Issue**: Frames read as None

```python
ret, frame = cap.read()
if not ret or frame is None:
    print("Failed to read frame - video may be corrupted or ended")
```

**Issue**: Codec not supported

```python
# Check if video has valid properties
fps = cap.get(cv2.CAP_PROP_FPS)
if fps == 0:
    print("Warning: Could not detect FPS - codec may be unsupported")
```

**Issue**: Disk space exhausted

```python
import shutil

def check_disk_space(output_dir, required_mb=100):
    """Check available disk space before extraction."""
    stat = shutil.disk_usage(output_dir)
    available_mb = stat.free / (1024 * 1024)
    return available_mb >= required_mb
```


## Quality Self-Check

Before returning results, verify:

- [ ] Output is valid JSON (use `json.loads()` to validate)
- [ ] All required fields are present (`success`, `source_video`, `frames_extracted`, `video_metadata`)
- [ ] Output directory was created successfully
- [ ] Extracted frame count matches expected value based on interval
- [ ] Warnings array includes all detected issues
- [ ] Video was properly released with `cap.release()`
- [ ] Frame filenames follow consistent zero-padded numbering


## Limitations

- OpenCV may not support all video codecs; install additional codecs if needed
- Seeking in variable frame rate videos may be inaccurate
- Large videos with high frame counts require significant disk space
- Memory usage increases with video resolution
- Some container formats (MKV with certain codecs) may have seeking issues
- Encrypted or DRM-protected videos cannot be processed
- Damaged or partially corrupted videos may extract partial results


## Version History

- **1.0.0** (2026-01-21): Initial release with OpenCV video frame extraction
