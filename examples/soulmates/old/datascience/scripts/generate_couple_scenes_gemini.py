#!/usr/bin/env python3
"""
Generate romantic couple scene images using Gemini (Nano Banana) with image references.

This script uses the actual profile photos as reference images to preserve
each person's face identity in the generated couple scenes.

Usage:
    python generate_couple_scenes_gemini.py [--limit 10] [--skip-existing]

Environment:
    GOOGLE_API_KEY: Your Google AI Studio API key
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import random
import sys
import time
import urllib.request
from pathlib import Path
from typing import Dict, List, Tuple

# Cute romantic scene templates
COUPLE_SCENES = [
    # Classic romantic
    "walking hand in hand on a beautiful beach at sunset, waves gently crashing, golden hour lighting",
    "sharing a cozy coffee date at a cute cafe, sitting across from each other, warm ambient lighting",
    "enjoying a romantic picnic in a beautiful park on a sunny day with a checkered blanket",
    "slow dancing together in a dimly lit room, intimate romantic atmosphere",
    "watching the sunset together from a scenic overlook, city lights in the background",
    # Fun activities
    "at an amusement park sharing cotton candy, ferris wheel in the background, colorful lights",
    "cooking dinner together in a modern kitchen, laughing while preparing food",
    "playing video games together on a couch, competitive but loving expressions",
    "hiking together on a beautiful mountain trail, nature surrounding them",
    "at a farmers market picking out fresh produce, sunny outdoor setting",
    # Cozy moments
    "cuddled up on a couch watching a movie with popcorn, cozy blankets, soft lighting",
    "sharing a romantic dinner at a candlelit Italian restaurant, pasta and wine on table",
    "reading books together in a cozy library or bookstore corner, warm lighting",
    "stargazing together on a blanket, lying on their backs looking up at stars",
    "by a fireplace in a cozy cabin, hot chocolate in hand, snow visible through window",
    # Urban/City
    "sharing an umbrella in the rain on a city street, romantic wet pavement reflections",
    "on a rooftop bar with city skyline behind them, evening drinks and twinkling lights",
    "in a trendy street food market trying different cuisines together",
    "walking through a beautiful botanical garden surrounded by flowers",
    "at a wine tasting in a rustic vineyard, golden rolling hills in background",
    # Adventure
    "at a ski lodge after skiing, cozy sweaters and hot chocolate by fire",
    "on a sailboat at sunset, wind in their hair, ocean stretching to horizon",
    "at a beach bonfire at night, marshmallows roasting, stars above",
    "ice skating together at an outdoor rink, winter wonderland setting",
    "at a music festival, colorful stage lights, happy concert atmosphere",
]


def load_image_as_base64(image_path: Path) -> str:
    """Load an image file and return as base64 string."""
    with open(image_path, "rb") as f:
        return base64.standard_b64encode(f.read()).decode("utf-8")


def load_personas(data_dir: Path) -> Dict[str, dict]:
    """Load all personas from JSON files."""
    personas: Dict[str, dict] = {}
    for city in ["sf", "ny"]:
        path = data_dir / f"personas_{city}.json"
        if path.exists():
            with open(path, "r", encoding="utf-8") as f:
                for p in json.load(f):
                    personas[p["id"]] = p
    return personas


def load_top_matches(data_dir: Path, top_n: int = 3) -> List[Tuple[str, str, int]]:
    """Load top N match pairs from LLM rankings."""
    rankings_path = data_dir / "llm_rankings.json"
    if not rankings_path.exists():
        print(f"Error: {rankings_path} not found")
        return []
    
    with open(rankings_path, "r", encoding="utf-8") as f:
        rankings = json.load(f)["rankings"]
    
    pairs: List[Tuple[str, str, int]] = []
    seen_pairs: set[tuple[str, str]] = set()
    
    for person_id, data in rankings.items():
        for match in data.get("topMatches", [])[:top_n]:
            match_id = match["id"]
            score = match.get("llmScore0to100", 50)
            
            # Only include high-scoring matches
            if score < 70:
                continue
            
            # Create canonical pair (sorted alphabetically)
            pair = tuple(sorted([person_id, match_id]))
            if pair not in seen_pairs:
                seen_pairs.add(pair)
                pairs.append((pair[0], pair[1], score))
    
    return sorted(pairs, key=lambda x: -x[2])


def generate_couple_image_gemini(
    image1_path: Path,
    image2_path: Path,
    name1: str,
    name2: str,
    scene: str,
    api_key: str,
) -> bytes | None:
    """Generate a couple scene using Gemini with image references."""
    
    img1_b64 = load_image_as_base64(image1_path)
    img2_b64 = load_image_as_base64(image2_path)
    
    prompt = f"""Create a photorealistic couple scene photograph.

SCENE: {scene}

CRITICAL IDENTITY INSTRUCTIONS:
- The LEFT person must look EXACTLY like the person in the FIRST reference image (Person A - {name1})
- The RIGHT person must look EXACTLY like the person in the SECOND reference image (Person B - {name2})
- PRESERVE each person's exact: face shape, skin tone, hair color, hair style, eye color, and distinctive features
- Do NOT blend, merge, or average the faces - keep them as two completely distinct individuals
- Each person must be clearly recognizable from their reference photo

COMPOSITION:
- {name1} is positioned on the LEFT side of the image
- {name2} is positioned on the RIGHT side of the image  
- Both people are clearly visible, facing each other or the camera
- Show upper body or full body depending on scene
- Natural, candid couple photography style

STYLE: Warm romantic lighting, shallow depth of field, professional couple portrait photography, genuine emotional connection visible between them."""

    headers = {
        "Content-Type": "application/json",
    }
    
    payload = {
        "contents": [{
            "parts": [
                {
                    "inline_data": {
                        "mime_type": "image/jpeg",
                        "data": img1_b64
                    }
                },
                {
                    "inline_data": {
                        "mime_type": "image/jpeg",
                        "data": img2_b64
                    }
                },
                {"text": prompt}
            ]
        }],
        "generationConfig": {
            "responseModalities": ["IMAGE", "TEXT"],
            "imageSafetySettings": "BLOCK_ONLY_HIGH"
        }
    }
    
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key={api_key}"
    
    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST"
        )
        
        with urllib.request.urlopen(req, timeout=120) as response:
            result = json.loads(response.read().decode("utf-8"))
            
            # Find the image in the response
            candidates = result.get("candidates", [])
            if candidates:
                parts = candidates[0].get("content", {}).get("parts", [])
                for part in parts:
                    if "inlineData" in part:
                        img_data = part["inlineData"].get("data", "")
                        return base64.standard_b64decode(img_data)
            
            print(f"  No image in response: {result}")
            return None
            
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8") if e.fp else ""
        print(f"  HTTP Error {e.code}: {error_body[:200]}")
        return None
    except Exception as e:
        print(f"  Error: {e}")
        return None


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate couple scene images using Gemini with image references"
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=10,
        help="Maximum number of couple images to generate",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=2.0,
        help="Delay between API calls in seconds",
    )
    parser.add_argument(
        "--skip-existing",
        action="store_true",
        help="Skip pairs that already have generated images",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be generated without making API calls",
    )
    
    args = parser.parse_args()
    
    # Check for API key
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key and not args.dry_run:
        print("Error: GOOGLE_API_KEY environment variable not set")
        print("Get one at: https://aistudio.google.com/app/apikey")
        sys.exit(1)
    
    # Paths
    root = Path(__file__).parent.parent
    data_dir = root / "data" / "dating"
    images_dir = data_dir / "images"
    output_dir = data_dir / "couple_scenes"
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Load data
    print("Loading personas...")
    personas = load_personas(data_dir)
    print(f"Loaded {len(personas)} personas")
    
    print("Loading top matches...")
    pairs = load_top_matches(data_dir)
    print(f"Found {len(pairs)} high-scoring match pairs")
    
    if args.dry_run:
        print("\n=== DRY RUN - Would generate these pairs ===")
        for i, (id1, id2, score) in enumerate(pairs[:args.limit]):
            p1 = personas.get(id1, {})
            p2 = personas.get(id2, {})
            name1 = p1.get("required", {}).get("name", id1)
            name2 = p2.get("required", {}).get("name", id2)
            print(f"{i+1}. {name1} ({id1}) + {name2} ({id2}) - Score: {score}")
        return
    
    # Shuffle scenes to add variety
    scenes = COUPLE_SCENES.copy()
    random.shuffle(scenes)
    
    # Generate images
    generated = 0
    skipped = 0
    failed = 0
    manifest: List[dict] = []
    
    for i, (id1, id2, score) in enumerate(pairs):
        if generated >= args.limit:
            break
        
        output_path = output_dir / f"{id1}_{id2}.jpg"
        
        # Skip existing
        if args.skip_existing and output_path.exists():
            print(f"Skipping {id1}_{id2} (exists)")
            skipped += 1
            manifest.append({
                "id": f"{id1}_{id2}",
                "person1": id1,
                "person2": id2,
                "score": score
            })
            continue
        
        p1 = personas.get(id1)
        p2 = personas.get(id2)
        
        if not p1 or not p2:
            print(f"Skipping {id1}_{id2} - missing persona data")
            continue
        
        img1_path = images_dir / f"{id1}.jpg"
        img2_path = images_dir / f"{id2}.jpg"
        
        if not img1_path.exists() or not img2_path.exists():
            print(f"Skipping {id1}_{id2} - missing profile images")
            continue
        
        name1 = p1.get("required", {}).get("name", id1).split()[0]
        name2 = p2.get("required", {}).get("name", id2).split()[0]
        
        # Pick a scene
        scene = scenes[generated % len(scenes)]
        
        print(f"\n[{generated + 1}/{args.limit}] {id1}_{id2} (score: {score})")
        print(f"  Generating: {name1} + {name2}")
        print(f"  Scene: {scene[:60]}...")
        
        image_bytes = generate_couple_image_gemini(
            img1_path, img2_path, name1, name2, scene, api_key
        )
        
        if image_bytes:
            # Save as PNG (Gemini returns PNG)
            png_path = output_dir / f"{id1}_{id2}.png"
            with open(png_path, "wb") as f:
                f.write(image_bytes)
            print(f"  Saved: {png_path}")
            
            generated += 1
            manifest.append({
                "id": f"{id1}_{id2}",
                "person1": id1,
                "person2": id2,
                "score": score
            })
        else:
            failed += 1
        
        # Delay between calls
        if generated < args.limit:
            time.sleep(args.delay)
    
    # Save manifest
    manifest_path = output_dir / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    
    print(f"\n{'=' * 40}")
    print("Summary:")
    print(f"  Generated: {generated}")
    print(f"  Skipped:   {skipped}")
    print(f"  Failed:    {failed}")
    print(f"\nSaved manifest: {manifest_path}")


if __name__ == "__main__":
    main()
