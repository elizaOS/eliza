#!/usr/bin/env python3
"""
Generate romantic couple scene images for matched pairs using fal.ai's Seedream model.

This script:
1. Loads top matches from LLM rankings
2. Generates cute couple scenes for top match pairs
3. Uses persona appearance data to describe both people
4. Saves couple images to data/dating/couple_scenes/

Usage:
    python generate_couple_scenes.py [--dry-run] [--limit 10]

Environment:
    FAL_KEY: Your fal.ai API key
"""
from __future__ import annotations

import argparse
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
    "sharing a cozy coffee date at a cute cafe, laughing together, warm atmosphere",
    "having a romantic picnic in a sunny park, sitting on a blanket with wine and cheese",
    "cooking together in a modern kitchen, one person feeding the other a taste",
    "slow dancing in their living room, fairy lights in background, intimate moment",
    
    # Fun activities
    "taking a silly selfie together at a rooftop bar, city lights twinkling behind them",
    "playing video games together on the couch, competitive and laughing",
    "hiking together on a scenic mountain trail, beautiful vista behind them",
    "ice skating together at a winter rink, one helping the other balance",
    "at a farmer's market together, picking out fresh flowers and produce",
    
    # Cozy moments
    "cuddling on a couch watching a movie, bowl of popcorn, cozy blankets",
    "making breakfast together on a lazy Sunday morning, sunshine through windows",
    "reading books together at a charming bookstore cafe",
    "stargazing on a blanket at night, pointing at constellations",
    "enjoying hot chocolate at a ski lodge, fireplace glowing nearby",
    
    # Adventure scenes
    "on a tandem bicycle riding through a colorful autumn park",
    "at an amusement park together, cotton candy, ferris wheel behind them",
    "exploring a beautiful flower garden, surrounded by roses and tulips",
    "paddleboarding together on a calm lake at sunrise",
    "at a wine tasting, clinking glasses together, vineyard background",
    
    # Urban romance
    "sharing an umbrella in the rain on a city street, romantic atmosphere",
    "at a jazz club together, intimate lighting, enjoying live music",
    "window shopping together on a charming European street",
    "sharing pizza at a candlelit Italian restaurant",
    "watching fireworks together, faces illuminated, holding hands",
]


def load_visual_features(data_dir: Path) -> Dict[str, dict]:
    """Load extracted visual features from file."""
    features_path = data_dir / "visual_features.json"
    if features_path.exists():
        with open(features_path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def get_detailed_appearance(persona_id: str, persona: dict, visual_features: Dict[str, dict]) -> str:
    """Get detailed appearance description using visual features if available."""
    # Check if we have extracted visual features
    if persona_id in visual_features:
        vf = visual_features[persona_id]
        parts = []
        
        # Core identity
        gender = vf.get("apparent_gender", "person")
        age_range = vf.get("apparent_age_range", "20s")
        ethnicity = vf.get("apparent_ethnicity", "")
        
        if gender == "man":
            parts.append(f"a {age_range} {ethnicity} man")
        elif gender == "woman":
            parts.append(f"a {age_range} {ethnicity} woman")
        else:
            parts.append(f"a {age_range} {ethnicity} person")
        
        # Hair (critical for differentiation)
        hair = f"{vf.get('hair_color', '')} {vf.get('hair_length', '')} {vf.get('hair_style', '')} hair"
        parts.append(hair.strip())
        
        # Eyes and skin
        parts.append(f"{vf.get('eye_color', 'brown')} eyes")
        parts.append(f"{vf.get('skin_tone', 'medium')} skin tone")
        
        # Face and nose
        if vf.get("face_shape"):
            parts.append(f"{vf['face_shape']} face shape")
        if vf.get("nose_description"):
            parts.append(f"{vf['nose_description']} nose")
        
        # Build if visible
        if vf.get("build_visible") and vf["build_visible"] != "not visible":
            parts.append(f"{vf['build_visible']} build")
        
        # Distinctive features
        distinctive = vf.get("distinctive_features", [])
        if distinctive:
            parts.extend(distinctive[:3])  # Limit to top 3
        
        return ", ".join(parts)
    
    # Fallback to persona data
    return get_appearance_from_persona(persona)


def get_appearance_from_persona(persona: dict) -> str:
    """Extract a brief appearance description from persona data (fallback)."""
    opt = persona.get("optional", {})
    appearance = opt.get("appearance", {})
    gender = opt.get("genderIdentity", "person")
    age = persona.get("required", {}).get("age", 25)
    
    # Build description
    parts = []
    
    # Gender and age
    if gender == "man":
        parts.append(f"a {age}-year-old man")
    elif gender == "woman":
        parts.append(f"a {age}-year-old woman")
    else:
        parts.append(f"a {age}-year-old person")
    
    # Ethnicity
    ethnicity = appearance.get("ethnicity", "")
    ethnicity_map = {
        "white": "caucasian",
        "black": "African American",
        "asian": "East Asian",
        "south_asian": "South Asian",
        "hispanic": "Latino/Latina",
        "middle_eastern": "Middle Eastern",
    }
    if ethnicity in ethnicity_map:
        parts.append(ethnicity_map[ethnicity])
    
    # Build
    build = appearance.get("build", "average")
    build_map = {
        "thin": "with a slender build",
        "fit": "with an athletic build",
        "average": "with an average build",
        "above_average": "with a fuller build",
        "overweight": "with a heavyset build",
    }
    if build in build_map:
        parts.append(build_map[build])
    
    # Hair
    hair_color = appearance.get("hairColor", "")
    if hair_color:
        parts.append(f"{hair_color} hair")
    
    return ", ".join(parts)


def build_couple_prompt(
    id1: str, persona1: dict, 
    id2: str, persona2: dict, 
    scene: str,
    visual_features: Dict[str, dict]
) -> str:
    """Build a prompt for generating a couple scene image with distinct people."""
    desc1 = get_detailed_appearance(id1, persona1, visual_features)
    desc2 = get_detailed_appearance(id2, persona2, visual_features)
    name1 = persona1.get("required", {}).get("name", "Person 1").split()[0]
    name2 = persona2.get("required", {}).get("name", "Person 2").split()[0]
    
    # Use visual features for more specific differentiation
    vf1 = visual_features.get(id1, {})
    vf2 = visual_features.get(id2, {})
    
    # Get key differentiators
    hair1 = f"{vf1.get('hair_color', 'dark')} {vf1.get('hair_length', 'medium')} hair" if vf1 else "their natural hair"
    hair2 = f"{vf2.get('hair_color', 'dark')} {vf2.get('hair_length', 'medium')} hair" if vf2 else "their natural hair"
    
    skin1 = vf1.get('skin_tone', 'medium') if vf1 else "medium"
    skin2 = vf2.get('skin_tone', 'medium') if vf2 else "medium"
    
    prompt = f"""A romantic photograph of TWO DISTINCTLY DIFFERENT people as a couple in love, {scene}.

CRITICAL: The two people must look COMPLETELY DIFFERENT from each other. They are two unique individuals.

LEFT SIDE - {name1}:
- {desc1}
- Position: Standing/sitting on the LEFT side of the image

RIGHT SIDE - {name2}:
- {desc2}  
- Position: Standing/sitting on the RIGHT side of the image

KEY DIFFERENCES TO EMPHASIZE:
- Left person has {hair1}, Right person has {hair2}
- Left person has {skin1} skin, Right person has {skin2} skin
- They are two separate, distinct individuals with different facial features

Style: Warm romantic photography, natural lighting, genuine affection, both people clearly visible and distinguishable, lifestyle couple photo, emotional connection.

IMPORTANT: 
- Both people must be clearly visible and look like different individuals
- Do NOT blend their features - keep them distinct
- Left person and right person should be obviously different people
- Show authentic couple chemistry while maintaining their individual appearances"""
    
    return prompt


def upload_image_to_fal(image_path: Path) -> str | None:
    """Upload a local image to fal.ai storage and return the URL."""
    try:
        import fal_client
        
        with open(image_path, "rb") as f:
            image_data = f.read()
        
        url = fal_client.upload(image_data, content_type="image/jpeg")
        return url
    except Exception as e:
        print(f"  Error uploading {image_path.name}: {e}")
        return None


def generate_couple_image(
    pair_id: str,
    prompt: str,
    output_path: Path,
    image1_path: Path | None = None,
    image2_path: Path | None = None,
) -> bool:
    """Generate a couple scene image using fal.ai nano-banana with image references."""
    try:
        import fal_client
    except ImportError:
        print("Error: fal-client not installed. Run: pip install fal-client")
        return False
    
    try:
        print(f"  Generating couple image for {pair_id}...")
        print(f"  Scene: {prompt[:80]}...")
        
        # If we have reference images, use nano-banana for face preservation
        if image1_path and image2_path and image1_path.exists() and image2_path.exists():
            print(f"  Uploading reference images for face preservation...")
            url1 = upload_image_to_fal(image1_path)
            url2 = upload_image_to_fal(image2_path)
            
            if url1 and url2:
                print(f"  Using nano-banana with image references...")
                
                # Enhanced prompt for face preservation
                face_prompt = f"""{prompt}

CRITICAL FACE PRESERVATION INSTRUCTIONS:
- The LEFT person must look EXACTLY like the person in the FIRST reference image
- The RIGHT person must look EXACTLY like the person in the SECOND reference image  
- PRESERVE each person's exact face, skin tone, hair color, hair style, and distinctive features
- Do NOT blend or merge the faces - keep them as two completely distinct individuals
- Each person should be clearly recognizable from their reference photo"""
                
                handler = fal_client.submit(
                    "fal-ai/nano-banana/image-to-image",
                    arguments={
                        "prompt": face_prompt,
                        "image_url": url1,
                        "strength": 0.75,
                        "num_images": 1,
                    },
                )
            else:
                print(f"  Upload failed, falling back to text-only...")
                handler = fal_client.submit(
                    "fal-ai/flux/dev",
                    arguments={
                        "prompt": prompt,
                        "image_size": "landscape_16_9",
                        "num_inference_steps": 28,
                        "guidance_scale": 3.5,
                        "num_images": 1,
                        "enable_safety_checker": True,
                    },
                )
        else:
            # Fallback to FLUX for text-only generation
            handler = fal_client.submit(
                "fal-ai/flux/dev",
                arguments={
                    "prompt": prompt,
                    "image_size": "landscape_16_9",
                    "num_inference_steps": 28,
                    "guidance_scale": 3.5,
                    "num_images": 1,
                    "enable_safety_checker": True,
                },
            )
        
        # Wait for result
        result = handler.get()
        
        # Download the image
        if result and "images" in result and len(result["images"]) > 0:
            image_url = result["images"][0]["url"]
            
            # Download image
            output_path.parent.mkdir(parents=True, exist_ok=True)
            urllib.request.urlretrieve(image_url, str(output_path))
            
            print(f"  Saved: {output_path}")
            return True
        else:
            print(f"  Warning: No image generated for {pair_id}")
            return False
            
    except Exception as e:
        print(f"  Error generating image for {pair_id}: {e}")
        return False


def load_personas(data_dir: Path) -> Dict[str, dict]:
    """Load all dating personas indexed by ID."""
    personas: Dict[str, dict] = {}
    
    for filename in ["personas_sf.json", "personas_ny.json"]:
        filepath = data_dir / filename
        if filepath.exists():
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
                for p in data:
                    personas[p["id"]] = p
    
    return personas


def load_top_matches(data_dir: Path) -> List[Tuple[str, str, int]]:
    """Load top match pairs from LLM rankings."""
    rankings_path = data_dir / "llm_rankings.json"
    if not rankings_path.exists():
        print(f"Error: {rankings_path} not found")
        return []
    
    with open(rankings_path, "r", encoding="utf-8") as f:
        rankings_data = json.load(f)
    
    pairs: List[Tuple[str, str, int]] = []
    seen_pairs = set()
    
    rankings = rankings_data.get("rankings", {})
    for person_id, data in rankings.items():
        top_matches = data.get("topMatches", [])
        for match in top_matches[:3]:  # Top 3 matches per person
            match_id = match["id"]
            score = match.get("llmScore0to100", 50)
            
            # Create canonical pair ID (sorted to avoid duplicates)
            pair = tuple(sorted([person_id, match_id]))
            if pair not in seen_pairs and score >= 70:  # Only high-scoring matches
                seen_pairs.add(pair)
                pairs.append((pair[0], pair[1], score))
    
    # Sort by score descending
    pairs.sort(key=lambda x: -x[2])
    return pairs


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate couple scene images for matched pairs using fal.ai"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print prompts without generating images",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=10,
        help="Limit the number of couple images to generate",
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
        help="Skip pairs that already have images",
    )
    
    args = parser.parse_args()
    
    # Check for API key (unless dry run)
    if not args.dry_run and not os.environ.get("FAL_KEY"):
        print("Error: FAL_KEY environment variable not set")
        print("Set your fal.ai API key: export FAL_KEY=your_key_here")
        sys.exit(1)
    
    # Paths
    root = Path(__file__).parent.parent
    data_dir = root / "data" / "dating"
    output_dir = data_dir / "couple_scenes"
    
    # Load data
    print("Loading personas...")
    personas = load_personas(data_dir)
    print(f"Loaded {len(personas)} personas")
    
    print("Loading visual features...")
    visual_features = load_visual_features(data_dir)
    print(f"Loaded visual features for {len(visual_features)} personas")
    
    if len(visual_features) == 0:
        print("\nWARNING: No visual features found!")
        print("Run: python extract_visual_features.py --limit 50")
        print("to extract visual features from profile images first.\n")
    
    print("Loading top matches...")
    pairs = load_top_matches(data_dir)
    print(f"Found {len(pairs)} high-scoring match pairs")
    
    if not pairs:
        print("No match pairs found!")
        return
    
    # Generate couple scenes
    generated = 0
    skipped = 0
    failed = 0
    
    # Shuffle scenes for variety
    scenes = COUPLE_SCENES.copy()
    
    for i, (id1, id2, score) in enumerate(pairs):
        if args.limit > 0 and generated >= args.limit:
            break
        
        pair_id = f"{id1}_{id2}"
        output_path = output_dir / f"{pair_id}.jpg"
        
        # Skip existing if requested
        if args.skip_existing and output_path.exists():
            print(f"Skipping {pair_id} (already exists)")
            skipped += 1
            continue
        
        # Get personas
        p1 = personas.get(id1)
        p2 = personas.get(id2)
        
        if not p1 or not p2:
            print(f"Warning: Missing persona data for {pair_id}")
            continue
        
        # Pick a random scene
        scene = random.choice(scenes)
        
        # Build prompt with visual features
        prompt = build_couple_prompt(id1, p1, id2, p2, scene, visual_features)
        
        print(f"\n[{generated + 1}/{args.limit or len(pairs)}] {pair_id} (score: {score})")
        
        # Get paths to profile images for face reference
        images_dir = data_dir / "images"
        image1_path = images_dir / f"{id1}.jpg"
        image2_path = images_dir / f"{id2}.jpg"
        
        if args.dry_run:
            print(f"  Scene: {scene}")
            print(f"  Prompt:\n{prompt[:300]}...")
            print(f"  Image refs: {image1_path.name}, {image2_path.name}")
            generated += 1
        else:
            success = generate_couple_image(
                pair_id, 
                prompt, 
                output_path,
                image1_path=image1_path,
                image2_path=image2_path,
            )
            if success:
                generated += 1
            else:
                failed += 1
            
            # Delay between calls
            if i < len(pairs) - 1 and not args.dry_run:
                time.sleep(args.delay)
    
    # Summary
    print(f"\n{'=' * 40}")
    print(f"Summary:")
    print(f"  Generated: {generated}")
    print(f"  Skipped:   {skipped}")
    print(f"  Failed:    {failed}")
    
    # Save a manifest of generated couple scenes
    if generated > 0 and not args.dry_run:
        manifest_path = output_dir / "manifest.json"
        manifest: List[dict] = []
        for id1, id2, score in pairs[:generated + skipped]:
            pair_id = f"{id1}_{id2}"
            if (output_dir / f"{pair_id}.jpg").exists():
                manifest.append({
                    "id": pair_id,
                    "person1": id1,
                    "person2": id2,
                    "score": score,
                })
        
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)
        print(f"\nSaved manifest: {manifest_path}")


if __name__ == "__main__":
    main()
