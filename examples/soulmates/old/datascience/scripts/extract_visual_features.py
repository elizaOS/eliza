#!/usr/bin/env python3
"""
Extract detailed visual features from profile images using GPT-4 Vision.

This script:
1. Loads each profile image
2. Uses GPT-4 Vision to extract detailed visual descriptions
3. Saves structured visual features for each persona
4. Features are used for accurate couple scene generation

Usage:
    python extract_visual_features.py [--limit 5] [--persona-id D-SF-001]

Environment:
    OPENAI_API_KEY: Your OpenAI API key
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
from pathlib import Path
from typing import TypedDict


class VisualFeatures(TypedDict):
    """Structured visual features extracted from an image."""
    hair_color: str
    hair_length: str
    hair_style: str
    eye_color: str
    skin_tone: str
    face_shape: str
    nose_description: str
    distinctive_features: list[str]
    apparent_ethnicity: str
    apparent_gender: str
    apparent_age_range: str
    build_visible: str
    clothing_description: str
    expression: str
    overall_description: str


def encode_image_base64(image_path: Path) -> str:
    """Encode an image to base64."""
    with open(image_path, "rb") as f:
        return base64.standard_b64encode(f.read()).decode("utf-8")


def extract_features_from_image(image_path: Path, api_key: str) -> VisualFeatures | None:
    """Use GPT-4 Vision to extract detailed visual features from an image."""
    import urllib.request
    
    base64_image = encode_image_base64(image_path)
    
    prompt = """Analyze this dating profile photo and extract detailed visual features for the person shown.

Return a JSON object with these exact fields:
{
    "hair_color": "specific color like 'dark brown', 'jet black', 'auburn', 'dirty blonde', 'gray'",
    "hair_length": "very short/short/medium/long/very long",
    "hair_style": "straight/wavy/curly/coily, plus style like 'slicked back', 'messy', 'braided', 'ponytail'",
    "eye_color": "brown/dark brown/hazel/green/blue/gray",
    "skin_tone": "very fair/fair/light/medium/olive/tan/brown/dark brown/deep",
    "face_shape": "oval/round/square/heart/oblong",
    "nose_description": "small/medium/large, straight/curved/button/aquiline/wide",
    "distinctive_features": ["list specific features like 'dimples', 'freckles', 'beauty mark', 'gap teeth', 'thick eyebrows', 'high cheekbones'"],
    "apparent_ethnicity": "your best assessment of ethnic background",
    "apparent_gender": "man/woman/androgynous",
    "apparent_age_range": "early 20s/mid 20s/late 20s/early 30s/mid 30s/late 30s/40s",
    "build_visible": "thin/slender/athletic/average/stocky/heavyset (if visible)",
    "clothing_description": "brief description of visible clothing",
    "expression": "smiling/serious/neutral/laughing/pensive",
    "overall_description": "A 2-3 sentence description capturing how this specific person looks, written to distinguish them from others"
}

Be specific and accurate. The description will be used to generate images of this exact person."""

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}"
    }
    
    payload = {
        "model": "gpt-4o",
        "messages": [
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
        "max_tokens": 1000
    }
    
    try:
        req = urllib.request.Request(
            "https://api.openai.com/v1/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST"
        )
        
        with urllib.request.urlopen(req, timeout=60) as response:
            result = json.loads(response.read().decode("utf-8"))
            content = result["choices"][0]["message"]["content"]
            
            # Parse JSON from response (handle markdown code blocks)
            if "```json" in content:
                content = content.split("```json")[1].split("```")[0]
            elif "```" in content:
                content = content.split("```")[1].split("```")[0]
            
            features: VisualFeatures = json.loads(content.strip())
            return features
            
    except Exception as e:
        print(f"  Error extracting features: {e}")
        return None


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Extract visual features from profile images using GPT-4 Vision"
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Limit the number of images to process (0 = all)",
    )
    parser.add_argument(
        "--persona-id",
        type=str,
        help="Process a specific persona ID only",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=1.0,
        help="Delay between API calls in seconds",
    )
    parser.add_argument(
        "--skip-existing",
        action="store_true",
        help="Skip personas that already have visual features",
    )
    
    args = parser.parse_args()
    
    # Check for API key
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print("Error: OPENAI_API_KEY environment variable not set")
        sys.exit(1)
    
    # Paths
    root = Path(__file__).parent.parent
    images_dir = root / "data" / "dating" / "images"
    output_path = root / "data" / "dating" / "visual_features.json"
    
    # Load existing features if any
    existing_features: dict[str, VisualFeatures] = {}
    if output_path.exists():
        with open(output_path, "r", encoding="utf-8") as f:
            existing_features = json.load(f)
        print(f"Loaded {len(existing_features)} existing visual features")
    
    # Find all profile images
    image_files = sorted(images_dir.glob("D-*.jpg"))
    print(f"Found {len(image_files)} profile images")
    
    if args.persona_id:
        image_files = [f for f in image_files if f.stem == args.persona_id]
        if not image_files:
            print(f"No image found for {args.persona_id}")
            return
    
    processed = 0
    skipped = 0
    failed = 0
    
    for i, image_path in enumerate(image_files):
        if args.limit > 0 and processed >= args.limit:
            break
        
        persona_id = image_path.stem
        
        # Skip existing if requested
        if args.skip_existing and persona_id in existing_features:
            print(f"Skipping {persona_id} (already has features)")
            skipped += 1
            continue
        
        print(f"\n[{processed + 1}/{args.limit or len(image_files)}] Extracting features for {persona_id}...")
        
        features = extract_features_from_image(image_path, api_key)
        
        if features:
            existing_features[persona_id] = features
            processed += 1
            print(f"  Hair: {features['hair_color']} {features['hair_length']} {features['hair_style']}")
            print(f"  Eyes: {features['eye_color']}, Skin: {features['skin_tone']}")
            print(f"  Description: {features['overall_description'][:80]}...")
            
            # Save after each successful extraction
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(existing_features, f, indent=2)
        else:
            failed += 1
        
        # Delay between calls
        if i < len(image_files) - 1:
            time.sleep(args.delay)
    
    # Final summary
    print(f"\n{'=' * 40}")
    print(f"Summary:")
    print(f"  Processed: {processed}")
    print(f"  Skipped:   {skipped}")
    print(f"  Failed:    {failed}")
    print(f"  Total in file: {len(existing_features)}")
    print(f"\nSaved to: {output_path}")


if __name__ == "__main__":
    main()
