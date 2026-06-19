#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
A/B Testing Data Generator
Dynamically generate A/B test datasets with different difficulty levels
"""

import csv
import random
import argparse
from pathlib import Path
from typing import List, Dict, Tuple
from datetime import datetime, timedelta


class ABTestingDataGenerator:
    """A/B Testing Data Generator"""

    # Scenario name library (extended to support 100+ scenarios)
    SCENARIO_NAMES = [
        # E-commerce categories (20)
        "Appliances", "Automotive", "Baby", "Beauty", "Books", 
        "Clothing", "Education", "Electronics", "Food", "FreshFood",
        "Gaming", "Health", "Home", "Hospitality", "Music",
        "Office", "Outdoor", "Pets", "Sports", "Travel",
        
        # More product categories (30)
        "Toys", "Garden", "Jewelry", "Furniture", "Art",
        "Crafts", "Industrial", "Software", "Movies", "VideoGames",
        "Fashion", "Shoes", "Bags", "Watches", "Eyewear",
        "Cosmetics", "Skincare", "Fragrance", "HairCare", "PersonalCare",
        "Kitchenware", "Bedding", "Bath", "Decor", "Lighting",
        "Tools", "Hardware", "Paint", "Plumbing", "Electrical",
        
        # Professional categories (30)
        "Photography", "Audio", "Cameras", "Drones", "SmartHome",
        "Wearables", "Tablets", "Laptops", "Desktops", "Monitors",
        "Networking", "Storage", "Printers", "Scanners", "Projectors",
        "Musical", "Instruments", "RecordingEquipment", "DJEquipment", "ProAudio",
        "Fitness", "Yoga", "Cycling", "Running", "Swimming",
        "Camping", "Hiking", "Fishing", "Hunting", "Climbing",
        
        # Lifestyle categories (30)
        "Nutrition", "Supplements", "Vitamins", "Protein", "OrganicFood",
        "BabyFood", "BabyClothing", "BabyToys", "Diapers", "BabyCare",
        "PetFood", "PetToys", "PetCare", "PetGrooming", "PetTraining",
        "Wedding", "Party", "Gifts", "Flowers", "Cards",
        "Stationery", "SchoolSupplies", "OfficeSupplies", "ArtSupplies", "CraftSupplies",
        "Magazines", "Comics", "Audiobooks", "eBooks", "Textbooks",
        
        # Extended categories (25)
        "Antiques", "Collectibles", "Memorabilia", "VintageFashion", "VintageJewelry",
        "LuxuryGoods", "DesignerFashion", "HighEndElectronics", "PremiumBeauty", "GourmetFood",
        "Organic", "EcoFriendly", "Sustainable", "FairTrade", "LocalProducts",
        "HandmadeItems", "CustomProducts", "PersonalizedGifts", "BespokeServices", "ArtisanGoods",
        "DigitalProducts", "OnlineCourses", "Subscriptions", "Memberships", "VirtualGoods",
        
        # Additional product categories (30)
        "Snacks", "Beverages", "Coffee", "Tea", "Wine",
        "Beer", "Spirits", "Cheese", "Chocolate", "Bakery",
        "Seafood", "Meat", "Produce", "Dairy", "Frozen",
        "Canned", "Condiments", "Spices", "Pasta", "Rice",
        "Cereal", "Candy", "Desserts", "IceCream", "Pizza",
        "Sandwiches", "Salads", "Soups", "Sauces", "Dips",
        
        # More service and entertainment categories (30)
        "Streaming", "CloudServices", "WebHosting", "Security", "Insurance",
        "Banking", "Investment", "RealEstate", "Consulting", "Marketing",
        "Advertising", "Design", "Development", "Writing", "Translation",
        "Photography", "Videography", "Animation", "VoiceOver", "Podcast",
        "Events", "Catering", "Cleaning", "Maintenance", "Repair",
        "Installation", "Delivery", "Shipping", "Storage", "Moving",
        
        # Professional service categories (30)
        "Legal", "Accounting", "Tax", "Audit", "Compliance",
        "HR", "Recruitment", "Training", "Coaching", "Mentoring",
        "Therapy", "Counseling", "Nutrition", "Dietitian", "Fitness",
        "PersonalTraining", "Massage", "Spa", "Salon", "Barbershop",
        "Veterinary", "Grooming", "DayCare", "Tutoring", "MusicLessons",
        "DanceLessons", "ArtClasses", "LanguageLessons", "Workshops", "Seminars",
        
        # Hobby categories (20)
        "Knitting", "Sewing", "Quilting", "Embroidery", "Crochet",
        "Woodworking", "Metalworking", "Pottery", "Painting", "Drawing",
        "Sculpting", "Photography", "Birdwatching", "Astronomy", "Gardening",
        "Aquariums", "Terrariums", "ModelBuilding", "Origami", "Calligraphy"
    ]
    
    def __init__(self, seed: int = 42):
        """Initialize the generator"""
        random.seed(seed)
    
    def generate_time_windows(self,
                             num_days: int = 15,
                             start_date: str = "7/29") -> List[str]:
        """Generate time window list

        Args:
            num_days: Number of days
            start_date: Start date (format: "M/D")

        Returns:
            Time window list, format: ["7/29 00:00-00:59", ...]
        """
        time_windows = []

        # Parse start date
        month, day = map(int, start_date.split('/'))
        current_date = datetime(2024, month, day)
        
        for _ in range(num_days):
            date_str = f"{current_date.month}/{current_date.day}"
            for hour in range(24):
                time_window = f"{date_str} {hour:02d}:00-{hour:02d}:59"
                time_windows.append(time_window)
            current_date += timedelta(days=1)
        
        return time_windows
    
    def generate_ab_data(self,
                        time_windows: List[str],
                        base_conversion_rate: float = 0.74,
                        conversion_diff: float = 0.01,
                        click_range: Tuple[int, int] = (0, 200),
                        noise_level: float = 0.1,
                        zero_probability: float = 0.05) -> List[Dict]:
        """Generate A/B test data

        Args:
            time_windows: Time window list
            base_conversion_rate: Base conversion rate
            conversion_diff: A/B conversion rate difference (B - A)
            click_range: Click count range
            noise_level: Noise level (random fluctuation in conversion rate)
            zero_probability: Probability of a value being zero

        Returns:
            List of data rows
        """
        data_rows = []

        # Target conversion rates for A and B
        a_conversion = base_conversion_rate - conversion_diff / 2
        b_conversion = base_conversion_rate + conversion_diff / 2
        
        for time_window in time_windows:
            # Generate group A data
            if random.random() < zero_probability:
                a_clicks = 0
                a_store_views = 0
            else:
                a_clicks = random.randint(click_range[0], click_range[1])
                # Add noise to conversion rate
                actual_a_conversion = a_conversion + random.gauss(0, noise_level * a_conversion)
                actual_a_conversion = max(0.3, min(0.95, actual_a_conversion))  # Limit range
                a_store_views = int(a_clicks * actual_a_conversion)

            # Generate group B data
            if random.random() < zero_probability:
                b_clicks = 0
                b_store_views = 0
            else:
                b_clicks = random.randint(click_range[0], click_range[1])
                # Add noise to conversion rate
                actual_b_conversion = b_conversion + random.gauss(0, noise_level * b_conversion)
                actual_b_conversion = max(0.3, min(0.95, actual_b_conversion))  # Limit range
                b_store_views = int(b_clicks * actual_b_conversion)
            
            data_rows.append({
                "time_window": time_window,
                "A_clicks": a_clicks,
                "A_store_views": a_store_views,
                "B_clicks": b_clicks,
                "B_store_views": b_store_views
            })
        
        return data_rows
    
    def calculate_conversion_rate(self, data_rows: List[Dict]) -> Tuple[float, float]:
        """Calculate actual conversion rate

        Args:
            data_rows: List of data rows

        Returns:
            (A conversion rate, B conversion rate)
        """
        total_a_clicks = sum(row["A_clicks"] for row in data_rows)
        total_a_views = sum(row["A_store_views"] for row in data_rows)
        total_b_clicks = sum(row["B_clicks"] for row in data_rows)
        total_b_views = sum(row["B_store_views"] for row in data_rows)
        
        a_rate = total_a_views / total_a_clicks if total_a_clicks > 0 else 0
        b_rate = total_b_views / total_b_clicks if total_b_clicks > 0 else 0
        
        return a_rate, b_rate
    
    def save_csv(self, data_rows: List[Dict], output_file: Path):
        """Save data to CSV file

        Args:
            data_rows: List of data rows
            output_file: Output file path
        """
        with open(output_file, 'w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=[
                "time_window", "A_clicks", "A_store_views", "B_clicks", "B_store_views"
            ])
            writer.writeheader()
            writer.writerows(data_rows)
    
    def generate_scenarios(self,
                          num_scenarios: int = 20,
                          num_days: int = 15,
                          base_conversion_range: Tuple[float, float] = (0.70, 0.78),
                          conversion_diff_range: Tuple[float, float] = (-0.03, 0.03),
                          click_range: Tuple[int, int] = (0, 200),
                          noise_level: float = 0.1,
                          zero_probability: float = 0.05,
                          difficulty: str = "medium") -> Dict:
        """Generate data for multiple scenarios

        Args:
            num_scenarios: Number of scenarios (supports 1-1000+)
            num_days: Number of days per scenario
            base_conversion_range: Base conversion rate range
            conversion_diff_range: A/B conversion rate difference range
            click_range: Click count range
            noise_level: Noise level
            zero_probability: Probability of zero values
            difficulty: Difficulty level (easy/medium/hard)

        Returns:
            Dictionary containing scenario data and statistics
        """
        # Adjust parameters based on difficulty
        if difficulty == "easy":
            # Easy: obvious conversion rate difference, less noise, fewer scenarios
            conversion_diff_range = (0.02, 0.05)
            noise_level = 0.05
            num_scenarios = min(num_scenarios, 5)
            click_range = (50, 150)
            zero_probability = 0.02
        elif difficulty == "hard":
            # Hard: subtle conversion rate difference, more noise, more scenarios
            conversion_diff_range = (-0.01, 0.01)
            noise_level = 0.15
            click_range = (0, 250)
            zero_probability = 0.1
        # medium uses default parameters
        
        scenarios = []
        time_windows = self.generate_time_windows(num_days)

        # Select scenario names - supports more scenarios than predefined names
        if num_scenarios <= len(self.SCENARIO_NAMES):
            # If requested scenario count doesn't exceed predefined names, randomly select
            selected_names = random.sample(self.SCENARIO_NAMES, num_scenarios)
        else:
            # If exceeds predefined name count, use all names and generate additional numbered names
            selected_names = list(self.SCENARIO_NAMES)
            # Generate additional scenario names (using Scenario_N format)
            extra_count = num_scenarios - len(self.SCENARIO_NAMES)
            for i in range(extra_count):
                selected_names.append(f"Scenario_{len(self.SCENARIO_NAMES) + i + 1}")
            print(f"   Generated {extra_count} additional scenario names (Scenario_N format)")
        
        for scenario_name in selected_names:
            # Generate random parameters for each scenario
            base_conversion = random.uniform(*base_conversion_range)
            conversion_diff = random.uniform(*conversion_diff_range)

            # Generate data
            data_rows = self.generate_ab_data(
                time_windows=time_windows,
                base_conversion_rate=base_conversion,
                conversion_diff=conversion_diff,
                click_range=click_range,
                noise_level=noise_level,
                zero_probability=zero_probability
            )

            # Calculate actual conversion rate
            a_rate, b_rate = self.calculate_conversion_rate(data_rows)
            
            scenarios.append({
                "name": scenario_name,
                "data_rows": data_rows,
                "a_conversion_rate": a_rate,
                "b_conversion_rate": b_rate,
                "num_rows": len(data_rows)
            })
        
        return {
            "scenarios": scenarios,
            "num_scenarios": len(scenarios),
            "num_days": num_days,
            "difficulty": difficulty,
            "parameters": {
                "base_conversion_range": base_conversion_range,
                "conversion_diff_range": conversion_diff_range,
                "click_range": click_range,
                "noise_level": noise_level,
                "zero_probability": zero_probability
            }
        }
    
    def save_expected_ratio(self, scenarios: List[Dict], output_file: Path):
        """Save expected conversion rate file (ground truth)

        Args:
            scenarios: List of scenarios
            output_file: Output file path
        """
        # Calculate overall conversion rate
        total_a_clicks = sum(
            sum(row["A_clicks"] for row in s["data_rows"]) 
            for s in scenarios
        )
        total_a_views = sum(
            sum(row["A_store_views"] for row in s["data_rows"]) 
            for s in scenarios
        )
        total_b_clicks = sum(
            sum(row["B_clicks"] for row in s["data_rows"]) 
            for s in scenarios
        )
        total_b_views = sum(
            sum(row["B_store_views"] for row in s["data_rows"]) 
            for s in scenarios
        )
        
        overall_a_rate = total_a_views / total_a_clicks if total_a_clicks > 0 else 0
        overall_b_rate = total_b_views / total_b_clicks if total_b_clicks > 0 else 0
        
        with open(output_file, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerow(["scenario", "A_conversion %", "B_conversion %"])
            
            for scenario in scenarios:
                writer.writerow([
                    scenario["name"],
                    f"{scenario['a_conversion_rate'] * 100:.3f}%",
                    f"{scenario['b_conversion_rate'] * 100:.3f}%"
                ])
            
            writer.writerow([
                "overall (total_store_views/total_clicks)",
                f"{overall_a_rate * 100:.3f}%",
                f"{overall_b_rate * 100:.3f}%"
            ])


def main():
    """Main function"""
    parser = argparse.ArgumentParser(description='Generate A/B test data')

    # Basic parameters
    parser.add_argument('--num-scenarios', type=int, default=20,
                       help='Number of scenarios, supports 1-1000+ (default: 20)')
    parser.add_argument('--num-days', type=int, default=15,
                       help='Number of days per scenario (default: 15)')
    parser.add_argument('--seed', type=int, default=42,
                       help='Random seed (default: 42)')
    parser.add_argument('--output-dir', type=str, default='files',
                       help='Output directory (default: files)')

    # Difficulty control
    parser.add_argument('--difficulty', type=str, default='medium',
                       choices=['easy', 'medium', 'hard'],
                       help='Difficulty level (default: medium)')

    # Advanced parameters
    parser.add_argument('--base-conversion-min', type=float, default=0.70,
                       help='Minimum base conversion rate (default: 0.70)')
    parser.add_argument('--base-conversion-max', type=float, default=0.78,
                       help='Maximum base conversion rate (default: 0.78)')
    parser.add_argument('--conversion-diff-min', type=float, default=-0.03,
                       help='Minimum conversion rate difference (default: -0.03)')
    parser.add_argument('--conversion-diff-max', type=float, default=0.03,
                       help='Maximum conversion rate difference (default: 0.03)')
    parser.add_argument('--click-min', type=int, default=0,
                       help='Minimum click count (default: 0)')
    parser.add_argument('--click-max', type=int, default=200,
                       help='Maximum click count (default: 200)')
    parser.add_argument('--noise-level', type=float, default=0.1,
                       help='Noise level (default: 0.1)')
    parser.add_argument('--zero-probability', type=float, default=0.05,
                       help='Probability of zero values (default: 0.05)')

    # Output control
    parser.add_argument('--save-groundtruth', action='store_true',
                       help='Also save ground truth to groundtruth_workspace')
    parser.add_argument('--groundtruth-dir', type=str, default='groundtruth_workspace',
                       help='Ground truth output directory (default: groundtruth_workspace)')
    
    args = parser.parse_args()
    
    print("=" * 60)
    print("A/B Test Data Generator")
    print("=" * 60)
    print(f"Number of scenarios: {args.num_scenarios}")
    print(f"Days per scenario: {args.num_days}")
    print(f"Rows per scenario: {args.num_days * 24}")
    print(f"Difficulty level: {args.difficulty}")
    print(f"Random seed: {args.seed}")
    print(f"Output directory: {args.output_dir}")
    print("=" * 60)

    # Create generator
    generator = ABTestingDataGenerator(seed=args.seed)

    # Generate data
    result = generator.generate_scenarios(
        num_scenarios=args.num_scenarios,
        num_days=args.num_days,
        base_conversion_range=(args.base_conversion_min, args.base_conversion_max),
        conversion_diff_range=(args.conversion_diff_min, args.conversion_diff_max),
        click_range=(args.click_min, args.click_max),
        noise_level=args.noise_level,
        zero_probability=args.zero_probability,
        difficulty=args.difficulty
    )
    
    # Create output directory
    output_dir = Path(args.output_dir)

    # Clean old CSV files in output directory
    if output_dir.exists():
        old_csv_files = list(output_dir.glob("ab_*.csv"))
        if old_csv_files:
            print(f"\nCleaning output directory...")
            for old_file in old_csv_files:
                old_file.unlink()
                print(f"   Deleted old file: {old_file.name}")
            print(f"   Deleted {len(old_csv_files)} old CSV files")
    
    output_dir.mkdir(exist_ok=True, parents=True)

    # Save CSV file for each scenario
    print(f"\nGenerating scenario data...")
    for scenario in result["scenarios"]:
        filename = f"ab_{scenario['name']}.csv"
        output_file = output_dir / filename
        generator.save_csv(scenario["data_rows"], output_file)
        print(f"   {filename}: {scenario['num_rows']} rows, "
              f"A conversion={scenario['a_conversion_rate']*100:.3f}%, "
              f"B conversion={scenario['b_conversion_rate']*100:.3f}%")

    # Save ground truth
    if args.save_groundtruth:
        groundtruth_dir = Path(args.groundtruth_dir)
        groundtruth_dir.mkdir(exist_ok=True, parents=True)
        expected_ratio_file = groundtruth_dir / "expected_ratio.csv"
        generator.save_expected_ratio(result["scenarios"], expected_ratio_file)
        print(f"\nGenerated Ground Truth: {expected_ratio_file}")

    print("\n" + "=" * 60)
    print("Data generation complete!")
    print("=" * 60)
    print(f"Generated {result['num_scenarios']} scenarios")
    print(f"Each scenario contains {result['num_days']} days of data")
    print(f"Total {result['num_scenarios'] * result['num_days'] * 24} rows of data")

    print(f"\nGeneration parameters:")
    print(f"   Difficulty: {result['difficulty']}")
    print(f"   Base conversion rate range: {result['parameters']['base_conversion_range']}")
    print(f"   Conversion rate difference range: {result['parameters']['conversion_diff_range']}")
    print(f"   Click count range: {result['parameters']['click_range']}")
    print(f"   Noise level: {result['parameters']['noise_level']}")
    print(f"   Zero value probability: {result['parameters']['zero_probability']}")

    print(f"\nConversion rate statistics:")
    a_rates = [s['a_conversion_rate'] for s in result['scenarios']]
    b_rates = [s['b_conversion_rate'] for s in result['scenarios']]
    print(f"   Group A average conversion rate: {sum(a_rates)/len(a_rates)*100:.3f}%")
    print(f"   Group B average conversion rate: {sum(b_rates)/len(b_rates)*100:.3f}%")
    print(f"   Average difference: {(sum(b_rates)/len(b_rates) - sum(a_rates)/len(a_rates))*100:.3f}%")


if __name__ == "__main__":
    main()

