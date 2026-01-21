#!/usr/bin/env python3
"""
Evaluate generated profile images against expected appearance attributes.

This script:
1. Loads generated images and their expected appearance data
2. Uses a vision model (GPT-4V) to analyze each image
3. Compares evaluated attributes with expected attributes
4. Generates an accuracy report

The evaluation prompt mirrors what was used to gather the original data:
- Attractiveness (1-10)
- Build (thin, fit, average, above_average, overweight)
- Hair color, eye color
- Skin tone (1-10)
- Perceived gender (1-10, 1=masculine, 10=feminine)
- Ethnicity

Usage:
    python evaluate_profile_images.py [--persona-id D-NY-026] [--limit 5]

Environment:
    OPENAI_API_KEY: Your OpenAI API key for GPT-4V
"""
from __future__ import annotations

import _bootstrap  # noqa: F401
import argparse
import base64
import json
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, TypedDict

from matcher.types import Appearance, Persona


class EvaluatedAppearance(TypedDict, total=False):
    attractiveness: int
    build: str
    hairColor: str
    eyeColor: str
    skinTone: int
    ethnicity: str
    perceivedGender: int
    description: str
    confidence: float


@dataclass
class EvaluationResult:
    """Result of evaluating a single image."""
    persona_id: str
    persona_name: str
    expected: Appearance
    evaluated: EvaluatedAppearance
    personality_traits: List[str] = field(default_factory=list)
    errors: Dict[str, str] = field(default_factory=dict)
    
    def attractiveness_diff(self) -> int:
        """Absolute difference in attractiveness scores."""
        exp = self.expected.get("attractiveness", 5)
        evl = self.evaluated.get("attractiveness", 5)
        return abs(exp - evl)
    
    def skin_tone_diff(self) -> int:
        """Absolute difference in skin tone scores."""
        exp = self.expected.get("skinTone", 5)
        evl = self.evaluated.get("skinTone", 5)
        return abs(exp - evl)
    
    def gender_diff(self) -> int:
        """Absolute difference in perceived gender scores."""
        exp = self.expected.get("perceivedGender", 5)
        evl = self.evaluated.get("perceivedGender", 5)
        return abs(exp - evl)
    
    def build_matches(self) -> bool:
        """Check if build category matches."""
        exp = self.expected.get("build", "average")
        evl = self.evaluated.get("build", "average")
        return exp == evl
    
    def ethnicity_matches(self) -> bool:
        """Check if ethnicity matches."""
        exp = self.expected.get("ethnicity", "").lower()
        evl = self.evaluated.get("ethnicity", "").lower()
        return exp == evl or exp in evl or evl in exp
    
    def to_dict(self) -> Dict[str, object]:
        """Convert to dictionary for JSON serialization."""
        return {
            "persona_id": self.persona_id,
            "persona_name": self.persona_name,
            "personality_traits": self.personality_traits,
            "expected": dict(self.expected),
            "evaluated": dict(self.evaluated),
            "metrics": {
                "attractiveness_diff": self.attractiveness_diff(),
                "skin_tone_diff": self.skin_tone_diff(),
                "gender_diff": self.gender_diff(),
                "build_matches": self.build_matches(),
                "ethnicity_matches": self.ethnicity_matches(),
            },
            "errors": self.errors,
        }


EVALUATION_PROMPT = """This is an AI-generated profile photo for a fictional dating app mockup. Analyze this synthetic image and provide a structured evaluation.

Please assess the following visual attributes depicted in this AI-generated image:

1. **Attractiveness** (1-10 scale): 1 = very unattractive, 5 = average, 10 = stunningly beautiful/handsome
2. **Build/Weight**: Choose one: thin, fit, average, above_average, overweight
3. **Hair Color**: e.g., black, dark_brown, brown, light_brown, auburn, red, blonde, gray
4. **Eye Color**: e.g., dark_brown, brown, hazel, green, blue, gray
5. **Skin Tone** (1-10 scale): 1 = very light/pale, 10 = very dark
6. **Ethnicity** (perceived): white, black, asian, south_asian, hispanic, middle_eastern, mixed
7. **Perceived Gender** (1-10 scale): 1 = very masculine, 5 = androgynous, 10 = very feminine

Also provide:
- A brief description of the person (2-3 sentences)
- Your confidence level (0.0-1.0)

Respond ONLY with a JSON object in this exact format:
{
    "attractiveness": <1-10>,
    "build": "<thin|fit|average|above_average|overweight>",
    "hairColor": "<color>",
    "eyeColor": "<color>",
    "skinTone": <1-10>,
    "ethnicity": "<ethnicity>",
    "perceivedGender": <1-10>,
    "description": "<brief description>",
    "confidence": <0.0-1.0>
}"""


def encode_image_base64(image_path: Path) -> str:
    """Encode an image file to base64."""
    with open(image_path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


def evaluate_image_gpt4v(image_path: Path, model: str = "gpt-4o") -> EvaluatedAppearance:
    """
    Evaluate an image using GPT-4V (Vision).
    
    Returns extracted appearance attributes.
    """
    try:
        from openai import OpenAI
    except ImportError:
        raise ImportError("openai package not installed. Run: pip install openai")
    
    client = OpenAI()
    
    # Encode image
    base64_image = encode_image_base64(image_path)
    
    # Determine image type from extension
    ext = image_path.suffix.lower()
    media_type = "image/jpeg" if ext in [".jpg", ".jpeg"] else "image/png"
    
    # Call vision model for image analysis
    # GPT-5+ models use max_completion_tokens, older models use max_tokens
    is_gpt5_plus = model.startswith("gpt-5") or model.startswith("o1") or model.startswith("o3") or model.startswith("o4")
    
    request_params = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": EVALUATION_PROMPT,
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{media_type};base64,{base64_image}",
                            "detail": "high",
                        },
                    },
                ],
            }
        ],
    }
    
    if is_gpt5_plus:
        request_params["max_completion_tokens"] = 500
    else:
        request_params["max_tokens"] = 500
    
    response = client.chat.completions.create(**request_params)
    
    # Parse response
    message = response.choices[0].message
    content = message.content or ""
    
    # Check for refusal first
    raw = message.model_dump()
    if raw.get("refusal"):
        raise ValueError(f"Model refused: {raw['refusal']}")
    
    # Handle different response formats
    if not content.strip():
        # Try alternative fields for reasoning models
        for key in ["reasoning", "text", "output"]:
            if key in raw and raw[key]:
                content = str(raw[key])
                break
    
    if not content.strip():
        # Print more debug info
        print(f"    [DEBUG] Empty response. Full message: {message.model_dump()}")
        raise ValueError("Empty response from model")
    
    # Extract JSON from response (may be wrapped in markdown code block)
    if "```json" in content:
        content = content.split("```json")[1].split("```")[0].strip()
    elif "```" in content:
        parts = content.split("```")
        if len(parts) >= 2:
            content = parts[1].strip()
    
    # Try to find JSON object in content
    if not content.startswith("{"):
        # Look for JSON object in the text
        start = content.find("{")
        end = content.rfind("}") + 1
        if start != -1 and end > start:
            content = content[start:end]
    
    if not content.strip():
        raise ValueError("No JSON content found in response")
    
    result: EvaluatedAppearance = json.loads(content)
    
    # Validate we got actual data
    if not result or "attractiveness" not in result:
        raise ValueError(f"Missing required fields in response: {list(result.keys()) if result else 'empty'}")
    
    return result


def load_personas(data_dir: Path) -> Dict[str, Persona]:
    """Load all dating personas from both SF and NY files, keyed by ID."""
    personas: Dict[str, Persona] = {}
    
    for filename in ["personas_sf.json", "personas_ny.json"]:
        filepath = data_dir / filename
        if filepath.exists():
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
                for persona in data:
                    personas[persona["id"]] = persona
    
    return personas


def find_images(images_dir: Path) -> List[Path]:
    """Find all generated profile images."""
    if not images_dir.exists():
        return []
    
    images: List[Path] = []
    for ext in ["*.jpg", "*.jpeg", "*.png"]:
        images.extend(images_dir.glob(ext))
    
    return sorted(images)


def generate_report(results: List[EvaluationResult]) -> Dict[str, object]:
    """Generate a summary report from evaluation results."""
    if not results:
        return {"error": "No results to report"}
    
    # Aggregate metrics
    attractiveness_diffs = [r.attractiveness_diff() for r in results]
    skin_tone_diffs = [r.skin_tone_diff() for r in results]
    gender_diffs = [r.gender_diff() for r in results]
    build_matches = [r.build_matches() for r in results]
    ethnicity_matches = [r.ethnicity_matches() for r in results]
    
    avg_attract_diff = sum(attractiveness_diffs) / len(attractiveness_diffs)
    avg_skin_diff = sum(skin_tone_diffs) / len(skin_tone_diffs)
    avg_gender_diff = sum(gender_diffs) / len(gender_diffs)
    build_accuracy = sum(1 for m in build_matches if m) / len(build_matches)
    ethnicity_accuracy = sum(1 for m in ethnicity_matches if m) / len(ethnicity_matches)
    
    # Attractiveness accuracy buckets
    attract_exact = sum(1 for d in attractiveness_diffs if d == 0)
    attract_close = sum(1 for d in attractiveness_diffs if d <= 1)
    attract_reasonable = sum(1 for d in attractiveness_diffs if d <= 2)
    
    # Skin tone accuracy buckets
    skin_close = sum(1 for d in skin_tone_diffs if d <= 1)
    skin_reasonable = sum(1 for d in skin_tone_diffs if d <= 2)
    
    return {
        "total_evaluated": len(results),
        "attractiveness": {
            "mean_absolute_error": round(avg_attract_diff, 2),
            "exact_matches": attract_exact,
            "within_1_point": attract_close,
            "within_2_points": attract_reasonable,
            "within_1_accuracy": round(attract_close / len(results) * 100, 1),
            "within_2_accuracy": round(attract_reasonable / len(results) * 100, 1),
        },
        "build_weight": {
            "accuracy": round(build_accuracy * 100, 1),
            "matches": sum(1 for m in build_matches if m),
            "total": len(build_matches),
        },
        "skin_tone": {
            "mean_absolute_error": round(avg_skin_diff, 2),
            "within_1_accuracy": round(skin_close / len(results) * 100, 1),
            "within_2_accuracy": round(skin_reasonable / len(results) * 100, 1),
        },
        "perceived_gender": {
            "mean_absolute_error": round(avg_gender_diff, 2),
        },
        "ethnicity": {
            "accuracy": round(ethnicity_accuracy * 100, 1),
            "matches": sum(1 for m in ethnicity_matches if m),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Evaluate generated profile images against expected attributes"
    )
    parser.add_argument(
        "--persona-id",
        type=str,
        help="Evaluate a specific persona ID only",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Limit the number of images to evaluate (0 = all)",
    )
    parser.add_argument(
        "--model",
        type=str,
        default="gpt-4.1-mini",
        help="OpenAI model to use (default: gpt-4.1-mini)",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=1.0,
        help="Delay between API calls in seconds",
    )
    parser.add_argument(
        "--output",
        type=str,
        default="evaluation_results.json",
        help="Output file for detailed results",
    )
    
    args = parser.parse_args()
    
    # Check for API key
    if not os.environ.get("OPENAI_API_KEY"):
        print("Error: OPENAI_API_KEY environment variable not set")
        sys.exit(1)
    
    # Paths
    root = Path(__file__).parent.parent
    data_dir = root / "data" / "dating"
    images_dir = data_dir / "images"
    output_path = data_dir / args.output
    
    # Load personas and find images
    personas = load_personas(data_dir)
    print(f"Loaded {len(personas)} personas")
    
    images = find_images(images_dir)
    print(f"Found {len(images)} images")
    
    if not images:
        print("No images found. Run generate_profile_images.py first.")
        sys.exit(1)
    
    # Filter to specific persona if requested
    if args.persona_id:
        images = [img for img in images if img.stem == args.persona_id]
        if not images:
            print(f"Error: Image for {args.persona_id} not found")
            sys.exit(1)
    
    # Apply limit
    if args.limit > 0:
        images = images[:args.limit]
        print(f"Limited to {len(images)} images")
    
    # Evaluate images
    results: List[EvaluationResult] = []
    
    for i, image_path in enumerate(images):
        persona_id = image_path.stem  # e.g., "D-NY-026"
        
        print(f"\n[{i+1}/{len(images)}] Evaluating {persona_id}")
        
        # Get expected appearance
        persona = personas.get(persona_id)
        if not persona:
            print(f"  Warning: Persona {persona_id} not found, skipping")
            continue
        
        expected: Appearance = persona.get("optional", {}).get("appearance", {})  # type: ignore[assignment]
        if not expected:
            print(f"  Warning: No appearance data for {persona_id}, skipping")
            continue
        
        personality_traits: List[str] = persona.get("optional", {}).get("personalityTraits", [])  # type: ignore[assignment]
        persona_name: str = persona.get("required", {}).get("name", "Unknown")  # type: ignore[assignment]
        
        try:
            # Evaluate image
            evaluated = evaluate_image_gpt4v(image_path, model=args.model)
            
            result = EvaluationResult(
                persona_id=persona_id,
                persona_name=persona_name,
                expected=expected,
                evaluated=evaluated,
                personality_traits=personality_traits,
            )
            results.append(result)
            
            # Print comparison
            print(f"  Name: {persona_name}")
            print(f"  Personality: {', '.join(personality_traits[:4])}...")
            print(f"  Attractiveness: expected={expected.get('attractiveness')}, evaluated={evaluated.get('attractiveness')} (diff={result.attractiveness_diff()})")
            print(f"  Build/Weight: expected={expected.get('build')}, evaluated={evaluated.get('build')} ({'✓' if result.build_matches() else '✗'})")
            print(f"  Skin tone: expected={expected.get('skinTone')}, evaluated={evaluated.get('skinTone')} (diff={result.skin_tone_diff()})")
            print(f"  Ethnicity: expected={expected.get('ethnicity')}, evaluated={evaluated.get('ethnicity')} ({'✓' if result.ethnicity_matches() else '✗'})")
            print(f"  Description: {evaluated.get('description', '')[:80]}...")
            
            # Delay between requests
            if i < len(images) - 1:
                time.sleep(args.delay)
                
        except Exception as e:
            print(f"  Error evaluating {persona_id}: {e}")
            result = EvaluationResult(
                persona_id=persona_id,
                persona_name=persona_name,
                expected=expected,
                evaluated={},
                personality_traits=personality_traits,
                errors={"evaluation": str(e)},
            )
            results.append(result)
    
    # Generate report
    report = generate_report([r for r in results if not r.errors])
    
    print(f"\n{'='*60}")
    print("EVALUATION REPORT")
    print(f"{'='*60}")
    print(f"Total evaluated: {report.get('total_evaluated', 0)}")
    
    if "attractiveness" in report:
        att = report["attractiveness"]
        print(f"\nAttractiveness (1-10):")
        print(f"  Mean Absolute Error: {att['mean_absolute_error']}")  # type: ignore[index]
        print(f"  Within 1 point: {att['within_1_accuracy']}%")  # type: ignore[index]
        print(f"  Within 2 points: {att['within_2_accuracy']}%")  # type: ignore[index]
    
    if "build_weight" in report:
        build = report["build_weight"]
        print(f"\nBuild/Weight Category:")
        print(f"  Accuracy: {build['accuracy']}% ({build['matches']}/{build['total']})")  # type: ignore[index]
    
    if "skin_tone" in report:
        skin = report["skin_tone"]
        print(f"\nSkin Tone (1-10):")
        print(f"  Mean Absolute Error: {skin['mean_absolute_error']}")  # type: ignore[index]
        print(f"  Within 1 point: {skin['within_1_accuracy']}%")  # type: ignore[index]
        print(f"  Within 2 points: {skin['within_2_accuracy']}%")  # type: ignore[index]
    
    if "ethnicity" in report:
        eth = report["ethnicity"]
        print(f"\nEthnicity:")
        print(f"  Accuracy: {eth['accuracy']}% ({eth['matches']}/{report['total_evaluated']})")  # type: ignore[index]
    
    if "perceived_gender" in report:
        gender = report["perceived_gender"]
        print(f"\nPerceived Gender (1-10):")
        print(f"  Mean Absolute Error: {gender['mean_absolute_error']}")  # type: ignore[index]
    
    # Save detailed results
    output_data = {
        "summary": report,
        "results": [r.to_dict() for r in results],
    }
    
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output_data, f, indent=2, ensure_ascii=False)
    
    print(f"\nDetailed results saved to: {output_path}")


if __name__ == "__main__":
    main()
