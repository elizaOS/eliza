#!/usr/bin/env python3
"""
Generate profile images for dating personas using fal.ai's FLUX model.

This script:
1. Loads dating personas with appearance metadata
2. Builds detailed prompts based on physical attributes
3. Emphasizes attractiveness levels in prompts (e.g., "EXTREMELY ugly" for low scores)
4. Uses fal.ai for fast image generation
5. Saves images to data/dating/images/

Usage:
    python generate_profile_images.py [--dry-run] [--persona-id D-NY-026] [--limit 5]

Environment:
    FAL_KEY: Your fal.ai API key
"""
from __future__ import annotations

import _bootstrap  # noqa: F401
import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path
from typing import Dict, List

from matcher.types import Appearance, Build, Persona


class PromptConfig:
    """Configuration for prompt generation."""
    
    # Attractiveness descriptors (index = attractiveness score - 1)
    # CRITICAL: AI models have extreme beauty bias - must use very strong anti-beauty terms for low scores
    # Use physical descriptors that force non-model appearance
    ATTRACTIVENESS_DESCRIPTORS = (
        # 1 - Very unattractive: use specific physical descriptors
        "VERY UGLY person, extremely unfortunate looking, severely asymmetrical face, very small close-set eyes, very large bulbous nose, weak receding chin, bad skin with acne scars, crooked teeth visible, definitely NOT attractive",
        # 2 - Unattractive
        "UGLY person, unattractive face, asymmetrical features, small squinty eyes, large wide nose, weak chin, bad complexion, crooked teeth, NOT a model, homely looking, unfortunate features",
        # 3 - Below average
        "PLAIN LOOKING person, below average appearance, unremarkable face, small eyes set too close, wide flat nose, recessed chin, dull complexion, ordinary unremarkable features, NOT attractive, forgettable face",
        # 4 - Slightly below average
        "ORDINARY person, slightly below average looking, plain unremarkable features, average to small eyes, average nose slightly too wide, average chin, normal everyday person NOT a model, unremarkable appearance",
        # 5 - Average (most people)
        "AVERAGE ORDINARY person, completely normal everyday appearance, typical unremarkable features, regular person you see on the street, NOT a model or actor, plain normal looking, average in every way, regular Joe/Jane",
        # 6 - Slightly above average
        "NORMAL person, slightly pleasant looking, somewhat nice features but nothing special, regular everyday appearance, NOT a model, typical person, mildly attractive at best",
        # 7 - Above average (minority of people)
        "pleasant looking person, nice features, somewhat attractive but not stunning, good looking but not a model, naturally nice appearance",
        # 8 - Attractive
        "attractive person, good looking, nice facial features, naturally handsome/beautiful, pleasant to look at",
        # 9 - Very attractive
        "very attractive person, beautiful/handsome features, striking good looks, photogenic face",
        # 10 - Extremely attractive (rare)
        "EXTREMELY attractive, stunningly beautiful/handsome, model-quality looks, perfect features, gorgeous",
    )

    # Build to body description - make these VERY explicit
    BUILD_DESCRIPTORS = {
        "thin": "THIN body, very slender build, skinny, lean and narrow frame, visible collarbones",
        "fit": "FIT athletic body, muscular definition, toned physique, gym body, visible muscle tone",
        "average": "average build body, normal body type, typical weight",
        "above_average": "HEAVYSET body, fuller figure, chubby, plump, soft rounded features, double chin",
        "overweight": "OVERWEIGHT body, obese, very heavy set, large body, round face, very full-figured",
    }

    # Ethnicity to appearance hints
    ETHNICITY_DESCRIPTORS = {
        "white": "caucasian, European features",
        "black": "African American, Black, African features",
        "asian": "East Asian, Asian features",
        "south_asian": "South Asian, Indian subcontinent features",
        "hispanic": "Hispanic, Latino/Latina features",
        "middle_eastern": "Middle Eastern, Mediterranean features",
        "mixed": "mixed ethnicity, multicultural features",
    }

    # Skin tone descriptors (1-10)
    SKIN_TONE_DESCRIPTORS = (
        "very fair skin, pale complexion",  # 1
        "fair skin, light complexion",  # 2
        "light skin, fair complexion",  # 3
        "light-medium skin tone",  # 4
        "medium skin tone, olive complexion",  # 5
        "medium-brown skin tone",  # 6
        "brown skin tone",  # 7
        "dark brown skin tone",  # 8
        "very dark brown skin",  # 9
        "deep dark skin, very dark complexion",  # 10
    )

    # Gender presentation (1-10)
    GENDER_DESCRIPTORS = (
        "very masculine presenting, rugged features",  # 1
        "masculine presenting, strong jawline",  # 2
        "masculine features",  # 3
        "slightly masculine features",  # 4
        "androgynous, gender-neutral features",  # 5
        "slightly feminine features",  # 6
        "feminine features",  # 7
        "feminine presenting, soft features",  # 8
        "very feminine presenting, delicate features",  # 9
        "extremely feminine, very delicate features",  # 10
    )

    # Hair color descriptors
    HAIR_DESCRIPTORS = {
        "black": "black hair",
        "dark_brown": "dark brown hair",
        "brown": "brown hair",
        "light_brown": "light brown hair",
        "auburn": "auburn hair, reddish-brown hair",
        "red": "red hair, ginger",
        "blonde": "blonde hair",
        "gray": "gray hair, silver hair",
    }

    # Eye color descriptors
    EYE_DESCRIPTORS = {
        "dark_brown": "dark brown eyes",
        "brown": "brown eyes",
        "hazel": "hazel eyes",
        "green": "green eyes",
        "blue": "blue eyes",
        "gray": "gray eyes",
    }

    # Scene types for variety - weighted by commonality
    # Format: (scene_description, quality_modifier, weight)
    SCENE_TYPES = [
        # Standard portrait shots (most common)
        ("portrait headshot, face clearly visible", "high quality photo", 15),
        ("casual selfie style, looking at camera", "smartphone photo quality", 12),
        
        # Bathroom/mirror selfies (common on dating apps)
        ("bathroom mirror selfie, visible mirror and bathroom background", "smartphone camera, slightly grainy", 8),
        ("gym mirror selfie, workout clothes, gym equipment visible in background", "phone camera, gym lighting", 5),
        
        # Activity shots
        ("holding a large fish they just caught, fishing boat or dock background, proud expression", "outdoor photo, natural lighting", 4),
        ("posing with a sedated tiger at tourist attraction, tropical setting", "tourist photo quality", 2),
        ("playing acoustic guitar, sitting down, focused expression", "candid photo, indoor lighting", 4),
        ("hiking on a mountain trail, scenic nature background, athletic wear", "outdoor adventure photo", 5),
        ("at the gym lifting weights, workout in progress", "gym photo, harsh lighting", 4),
        ("running or jogging outdoors, active pose, athletic wear", "action shot, motion blur okay", 3),
        ("rock climbing on climbing wall, harness visible, athletic", "indoor climbing gym", 3),
        ("playing tennis or holding tennis racket on court", "sports photo", 2),
        ("surfing or holding surfboard at the beach", "beach photo, sunny", 3),
        ("skiing or snowboarding on snowy mountain", "winter sports photo", 2),
        
        # Social/lifestyle shots
        ("at a bar or restaurant, drink in hand, social setting", "dim ambient lighting, candid", 6),
        ("at a party or social event, festive background", "flash photo, slightly overexposed", 4),
        ("cooking in kitchen, casual domestic scene", "home photo, warm lighting", 3),
        ("with a cute dog, pet clearly visible, genuine smile", "casual pet photo", 5),
        ("with a cat, holding or petting the cat", "indoor home photo", 3),
        
        # Travel/vacation shots
        ("vacation photo at famous landmark, tourist pose", "travel photo quality", 5),
        ("on a tropical beach, palm trees or ocean visible", "vacation photo, bright sunlight", 5),
        ("in front of Eiffel Tower or European landmark", "tourist photo", 2),
        ("on a boat or yacht, water in background", "vacation photo, sunny", 3),
        
        # Beach/swimsuit shots (tasteful)
        ("at the beach in swimsuit, standing by the water", "beach photo, bright natural light", 4),
        ("by a pool in swimwear, summer vibes", "pool party photo, sunny", 3),
        
        # Instagram-style shots
        ("instagram-style brunch photo, aesthetic cafe setting", "curated instagram aesthetic", 4),
        ("golden hour outdoor portrait, warm sunlight", "instagram filter aesthetic", 5),
        ("urban street style photo, city background", "fashion photo vibe", 4),
        ("coffee shop setting, cozy atmosphere, holding coffee", "aesthetic lifestyle photo", 4),
        
        # Lower quality/authentic shots
        ("blurry party photo, having fun, candid moment", "low quality, motion blur, authentic", 3),
        ("grainy night photo, bar or club setting", "low light, grainy, flash", 3),
        ("old photo from a few years ago, slightly dated style", "older camera quality, vintage feel", 2),
        ("webcam quality selfie, basic background", "low resolution, webcam aesthetic", 2),
    ]


def _get_scene(persona_id: str, gender_identity: str, build: str, attractiveness: int) -> tuple[str, str]:
    """
    Select a scene type for the persona based on their characteristics.
    Uses persona_id as seed for consistency.
    
    Returns (scene_description, quality_modifier)
    """
    import hashlib
    import random
    
    # Seed RNG with persona_id for consistent results
    seed = int(hashlib.md5(persona_id.encode()).hexdigest()[:8], 16)
    rng = random.Random(seed)
    
    # Build weighted list
    scenes = PromptConfig.SCENE_TYPES.copy()
    
    # Adjust weights based on persona characteristics
    adjusted_scenes = []
    for scene, quality, weight in scenes:
        adjusted_weight = weight
        
        # Fit people more likely to have gym/athletic shots
        if build == "fit" and ("gym" in scene or "athletic" in scene or "hiking" in scene):
            adjusted_weight *= 2.5
        
        # Overweight people less likely to have swimsuit shots
        if build in ("above_average", "overweight") and ("swimsuit" in scene or "swimwear" in scene or "beach" in scene):
            adjusted_weight *= 0.3
        
        # More attractive people more likely to have instagram-style shots
        if attractiveness >= 7 and "instagram" in scene.lower():
            adjusted_weight *= 2
        
        # Less attractive people more likely to have low quality/authentic shots
        if attractiveness <= 4 and ("blurry" in scene or "grainy" in scene or "webcam" in scene):
            adjusted_weight *= 2
        
        adjusted_scenes.append((scene, quality, adjusted_weight))
    
    # Weighted random selection
    total_weight = sum(w for _, _, w in adjusted_scenes)
    r = rng.random() * total_weight
    cumulative = 0
    for scene, quality, weight in adjusted_scenes:
        cumulative += weight
        if r <= cumulative:
            return (scene, quality)
    
    # Fallback
    return ("portrait headshot, face clearly visible", "high quality photo")


def build_prompt(persona: Persona, config: PromptConfig) -> str:
    """
    Build a detailed image generation prompt from persona appearance data.
    
    Emphasizes attractiveness level - ugly people look REALLY ugly,
    attractive people look stunning.
    """
    optional = persona.get("optional", {})
    appearance: Appearance = optional.get("appearance", {})  # type: ignore[assignment]
    
    if not appearance:
        raise ValueError(f"Persona {persona['id']} has no appearance data")
    
    # Extract all appearance attributes
    attractiveness = appearance.get("attractiveness", 5)
    build = appearance.get("build", "average")
    hair_color = appearance.get("hairColor", "brown")
    eye_color = appearance.get("eyeColor", "brown")
    skin_tone = appearance.get("skinTone", 5)
    ethnicity = appearance.get("ethnicity", "mixed")
    perceived_gender = appearance.get("perceivedGender", 5)
    distinctive_features = appearance.get("distinctiveFeatures", [])
    
    # Get explicit gender identity (critical for image generation)
    gender_identity = optional.get("genderIdentity", "person")
    
    # Get age from required
    age = persona["required"]["age"]
    name = persona["required"]["name"]
    
    # Build prompt components
    parts: List[str] = []
    
    # Get scene type for variety
    scene_desc, quality_mod = _get_scene(persona["id"], gender_identity, build, attractiveness)
    
    # Core description: scene + quality modifier
    parts.append(f"Dating app profile photo, {scene_desc}")
    
    # Add quality modifier based on attractiveness AND scene
    if attractiveness <= 3:
        parts.append(f"{quality_mod}, candid snapshot style, realistic imperfect appearance, NOT a model")
    elif attractiveness <= 5:
        parts.append(f"{quality_mod}, everyday normal person, realistic, NOT a model")
    elif attractiveness <= 7:
        parts.append(f"{quality_mod}, realistic photography")
    else:
        parts.append(f"{quality_mod}, flattering lighting")
    
    # EXPLICIT GENDER - most important for correct image generation
    if gender_identity == "man":
        parts.append(f"a MAN, male person, man in his {_age_description(age)}")
    elif gender_identity == "woman":
        parts.append(f"a WOMAN, female person, woman in her {_age_description(age)}")
    elif gender_identity == "nonbinary":
        parts.append(f"a nonbinary person, androgynous, person in their {_age_description(age)}")
    else:
        parts.append(f"person in their {_age_description(age)}")
    
    # Attractiveness (this is the KEY emphasis)
    attractiveness_desc = config.ATTRACTIVENESS_DESCRIPTORS[attractiveness - 1]
    parts.append(attractiveness_desc)
    
    # Gender presentation (secondary to explicit gender)
    gender_desc = config.GENDER_DESCRIPTORS[perceived_gender - 1]
    # Only add if it's notably different from default for gender
    if gender_identity == "man" and perceived_gender >= 6:
        parts.append(gender_desc)  # Feminine-presenting man
    elif gender_identity == "woman" and perceived_gender <= 4:
        parts.append(gender_desc)  # Masculine-presenting woman
    elif gender_identity == "nonbinary":
        parts.append(gender_desc)
    
    # Ethnicity
    ethnicity_desc = config.ETHNICITY_DESCRIPTORS.get(ethnicity, "")
    if ethnicity_desc:
        parts.append(ethnicity_desc)
    
    # Skin tone
    skin_desc = config.SKIN_TONE_DESCRIPTORS[skin_tone - 1]
    parts.append(skin_desc)
    
    # Build/body type
    build_desc = config.BUILD_DESCRIPTORS.get(build, "average build")
    parts.append(build_desc)
    
    # Hair
    hair_desc = config.HAIR_DESCRIPTORS.get(hair_color, "brown hair")
    parts.append(hair_desc)
    
    # Eyes
    eye_desc = config.EYE_DESCRIPTORS.get(eye_color, "brown eyes")
    parts.append(eye_desc)
    
    # Distinctive features from persona data
    if distinctive_features:
        features_str = ", ".join(_humanize_feature(f) for f in distinctive_features)
        parts.append(features_str)
    
    # Add realistic imperfections based on attractiveness level
    # This is CRITICAL for breaking AI's beauty bias
    imperfections = _get_imperfections(attractiveness, persona["id"])
    if imperfections:
        parts.append(", ".join(imperfections))
    
    # Expression/pose based on attractiveness
    if attractiveness <= 2:
        parts.append("awkward forced smile, unflattering angle, NOT photogenic")
    elif attractiveness <= 4:
        parts.append("slightly awkward expression, casual amateur pose")
    elif attractiveness <= 6:
        parts.append("natural casual expression, regular person")
    elif attractiveness >= 8:
        parts.append("confident expression, photogenic")
    else:
        parts.append("natural smile, casual pose")
    
    prompt = ", ".join(parts)
    return prompt


def _age_description(age: int) -> str:
    """Convert age to decade description."""
    if age < 25:
        return "early twenties"
    elif age < 30:
        return "late twenties"
    elif age < 35:
        return "early thirties"
    elif age < 40:
        return "late thirties"
    elif age < 45:
        return "early forties"
    else:
        return "mid forties or older"


def _get_imperfections(attractiveness: int, persona_id: str) -> List[str]:
    """
    Generate realistic imperfections based on attractiveness level.
    Uses persona_id as seed for consistency.
    
    Lower attractiveness = more and more noticeable imperfections.
    Even average/above-average people have minor imperfections.
    """
    import hashlib
    import random
    
    # Seed RNG with persona_id for consistent results
    seed = int(hashlib.md5(persona_id.encode()).hexdigest()[:8], 16)
    rng = random.Random(seed)
    
    # Imperfection pools by severity
    severe_imperfections = [
        "severe acne covering face",
        "very large bulbous nose",
        "extremely close-set small eyes",
        "very weak receding chin",
        "significant facial asymmetry",
        "very crooked misaligned teeth",
        "heavy scarring on face",
    ]
    
    moderate_imperfections = [
        "visible acne, several pimples",
        "slightly large nose",
        "wide flat nose",
        "small narrow eyes",
        "close-set eyes",
        "weak chin",
        "crooked teeth visible when smiling",
        "braces on teeth",
        "thick bushy eyebrows",
        "oily shiny skin",
        "uneven blotchy skin tone",
        "visible bags under eyes",
    ]
    
    minor_imperfections = [
        "wearing glasses",
        "a few freckles",
        "slightly crooked nose",
        "one ear slightly larger",
        "minor skin blemishes",
        "slightly uneven eyebrows",
        "thin lips",
        "slightly large forehead",
        "a visible mole",
        "slight redness on cheeks",
    ]
    
    neutral_features = [
        "wearing glasses",
        "light freckles",
        "small birthmark",
        "subtle smile lines",
    ]
    
    imperfections: List[str] = []
    
    if attractiveness <= 2:
        # Very unattractive: 2-3 severe + 1-2 moderate
        imperfections.extend(rng.sample(severe_imperfections, min(rng.randint(2, 3), len(severe_imperfections))))
        imperfections.extend(rng.sample(moderate_imperfections, min(rng.randint(1, 2), len(moderate_imperfections))))
    elif attractiveness <= 4:
        # Below average: 1-2 moderate + 1-2 minor
        imperfections.extend(rng.sample(moderate_imperfections, min(rng.randint(1, 2), len(moderate_imperfections))))
        imperfections.extend(rng.sample(minor_imperfections, min(rng.randint(1, 2), len(minor_imperfections))))
    elif attractiveness <= 6:
        # Average: 1 moderate OR 1-2 minor (50% chance of each)
        if rng.random() < 0.5:
            imperfections.extend(rng.sample(moderate_imperfections, 1))
        else:
            imperfections.extend(rng.sample(minor_imperfections, min(rng.randint(1, 2), len(minor_imperfections))))
    elif attractiveness <= 7:
        # Above average: 0-1 minor imperfection (70% chance)
        if rng.random() < 0.7:
            imperfections.extend(rng.sample(minor_imperfections, 1))
    elif attractiveness <= 8:
        # Attractive: 0-1 neutral feature (50% chance)
        if rng.random() < 0.5:
            imperfections.extend(rng.sample(neutral_features, 1))
    # 9-10: No imperfections added
    
    return imperfections


def _humanize_feature(feature: str) -> str:
    """Convert feature codes to human-readable descriptions."""
    feature_map = {
        # Standard features
        "glasses": "wearing glasses",
        "thick_glasses": "wearing thick-framed glasses",
        "septum_piercing": "septum piercing",
        "nose_stud": "nose stud",
        "ear_piercings": "ear piercings",
        "tattoos": "visible tattoos",
        "freckles": "freckles",
        "dimples": "dimples",
        "beard": "full beard",
        "stubble": "stubble",
        "mustache": "mustache",
        "curly_hair": "curly hair",
        # Imperfections - realistic features
        "acne": "visible acne, pimples on face",
        "acne_scars": "acne scarring on cheeks",
        "braces": "metal braces on teeth",
        "crooked_teeth": "slightly crooked teeth",
        "gap_teeth": "gap between front teeth",
        "large_nose": "slightly large prominent nose",
        "wide_nose": "wide flat nose",
        "hooked_nose": "hooked nose shape",
        "small_eyes": "small narrow eyes",
        "wide_set_eyes": "wide-set eyes far apart",
        "close_set_eyes": "close-set eyes",
        "bushy_eyebrows": "thick bushy eyebrows",
        "unibrow": "connected eyebrows, unibrow",
        "weak_chin": "recessed weak chin",
        "double_chin": "slight double chin",
        "large_forehead": "prominent high forehead",
        "receding_hairline": "receding hairline",
        "thinning_hair": "thinning hair",
        "bald_spot": "visible bald spot",
        "bags_under_eyes": "dark bags under eyes",
        "wrinkles": "visible wrinkles and lines",
        "moles": "visible facial moles",
        "birthmark": "visible birthmark",
        "oily_skin": "oily shiny skin",
        "dry_skin": "dry patchy skin",
        "rosacea": "redness on cheeks, rosacea",
        "uneven_skin": "uneven skin tone, blotchy",
        "wavy_hair": "wavy hair",
        "straight_hair": "straight hair",
        "short_hair": "short hair",
        "long_hair": "long hair",
        "buzzcut": "buzzcut",
        "dreadlocks": "dreadlocks",
        "braids": "braided hair",
        "undercut": "undercut hairstyle",
        "bangs": "bangs",
    }
    return feature_map.get(feature, feature.replace("_", " "))


def generate_image_fal(prompt: str, output_path: Path, persona_id: str) -> bool:
    """
    Generate an image using fal.ai's FLUX model.
    
    Returns True if successful, False otherwise.
    """
    try:
        import fal_client
    except ImportError:
        print("Error: fal-client not installed. Run: pip install fal-client")
        return False
    
    try:
        print(f"  Generating image for {persona_id}...")
        print(f"  Prompt: {prompt[:100]}...")
        
        # Submit generation request
        handler = fal_client.submit(
            "fal-ai/flux/dev",
            arguments={
                "prompt": prompt,
                "image_size": "portrait_4_3",  # Good for profile photos
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
            print(f"  Warning: No image generated for {persona_id}")
            return False
            
    except Exception as e:
        print(f"  Error generating image for {persona_id}: {e}")
        return False


def load_personas(data_dir: Path) -> List[Persona]:
    """Load all dating personas from both SF and NY files."""
    personas: List[Persona] = []
    
    for filename in ["personas_sf.json", "personas_ny.json"]:
        filepath = data_dir / filename
        if filepath.exists():
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
                personas.extend(data)
    
    return personas


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate profile images for dating personas using fal.ai"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print prompts without generating images",
    )
    parser.add_argument(
        "--persona-id",
        type=str,
        help="Generate image for a specific persona ID only",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Limit the number of images to generate (0 = all)",
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
        help="Skip personas that already have images",
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
    images_dir = data_dir / "images"
    
    # Load personas
    personas = load_personas(data_dir)
    print(f"Loaded {len(personas)} dating personas")
    
    # Filter to specific persona if requested
    if args.persona_id:
        personas = [p for p in personas if p["id"] == args.persona_id]
        if not personas:
            print(f"Error: Persona {args.persona_id} not found")
            sys.exit(1)
    
    # Filter to only those with appearance data
    personas = [p for p in personas if p.get("optional", {}).get("appearance")]
    print(f"Found {len(personas)} personas with appearance data")
    
    # Apply limit
    if args.limit > 0:
        personas = personas[:args.limit]
        print(f"Limited to {len(personas)} personas")
    
    # Initialize prompt config
    config = PromptConfig()
    
    # Generate images
    success_count = 0
    skip_count = 0
    fail_count = 0
    
    for i, persona in enumerate(personas):
        persona_id = persona["id"]
        output_path = images_dir / f"{persona_id}.jpg"
        
        # Skip existing if requested
        if args.skip_existing and output_path.exists():
            print(f"[{i+1}/{len(personas)}] Skipping {persona_id} (already exists)")
            skip_count += 1
            continue
        
        print(f"\n[{i+1}/{len(personas)}] Processing {persona_id}")
        
        try:
            prompt = build_prompt(persona, config)
            
            if args.dry_run:
                print(f"  Prompt: {prompt}")
                success_count += 1
            else:
                if generate_image_fal(prompt, output_path, persona_id):
                    success_count += 1
                else:
                    fail_count += 1
                
                # Delay between requests to avoid rate limiting
                if i < len(personas) - 1:
                    time.sleep(args.delay)
                    
        except Exception as e:
            print(f"  Error: {e}")
            fail_count += 1
    
    # Summary
    print(f"\n{'='*50}")
    print(f"Summary:")
    print(f"  Success: {success_count}")
    print(f"  Skipped: {skip_count}")
    print(f"  Failed: {fail_count}")
    
    if not args.dry_run:
        print(f"\nImages saved to: {images_dir}")


if __name__ == "__main__":
    main()
