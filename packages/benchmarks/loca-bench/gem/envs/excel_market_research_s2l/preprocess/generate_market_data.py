"""
Market Research Data Generator for Excel Task

This script generates synthetic market sales data with:
- Raw market data (multiple product categories)
- Methodology sheet (conversion relationships)
- Configurable difficulty levels
"""

import random
import json
import csv
from pathlib import Path
from argparse import ArgumentParser
from typing import Dict, List, Tuple
import sys

# Check if openpyxl is available, if not provide helpful error
try:
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
except ImportError:
    print("Error: openpyxl is required. Install it with: pip install openpyxl")
    sys.exit(1)


class MarketDataGenerator:
    """Generate market research data with configurable complexity"""

    def __init__(self,
                 seed: int = 42,
                 start_year: int = 2014,
                 num_years: int = 11,
                 num_raw_categories: int = 10,
                 num_internal_categories: int = 4,
                 difficulty: str = "medium"):
        """
        Initialize the generator

        Args:
            seed: Random seed for reproducibility
            start_year: Starting year for data
            num_years: Number of years of data
            num_raw_categories: Number of raw market categories
            num_internal_categories: Number of internal company categories
            difficulty: Difficulty level (easy/medium/hard/expert)
        """
        random.seed(seed)
        self.seed = seed
        self.start_year = start_year
        self.num_years = num_years
        self.num_raw_categories = num_raw_categories
        self.num_internal_categories = num_internal_categories
        self.difficulty = difficulty

        # Expanded category names for raw data (100+ categories)
        self.raw_category_names = [
            # Consumer Electronics
            "Smartphones", "Tablets", "Laptops", "Desktops", "TVs",
            "Gaming Consoles", "Cameras", "Headphones", "Speakers", "Monitors",
            "Smart Watches", "Fitness Trackers", "E-Readers", "Projectors", "Drones",
            "VR Headsets", "Action Cameras", "Webcams", "Microphones", "Keyboards",
            "Mice", "Routers", "Modems", "Switches", "USB Hubs",
            "External HDDs", "SSDs", "Flash Drives", "Memory Cards", "Power Banks",

            # Home Appliances
            "Refrigerators", "Washing Machines", "Air Conditioners", "Microwaves",
            "Vacuum Cleaners", "Coffee Makers", "Blenders", "Toasters", "Rice Cookers",
            "Air Purifiers", "Humidifiers", "Dehumidifiers", "Fans", "Heaters",
            "Water Heaters", "Dishwashers", "Dryers", "Ovens", "Cooktops",
            "Range Hoods", "Freezers", "Wine Coolers", "Ice Makers", "Garbage Disposals",

            # Smart Home
            "Smart Thermostats", "Smart Locks", "Security Cameras", "Video Doorbells",
            "Smart Lights", "Smart Plugs", "Smart Sensors", "Hub Controllers",
            "Voice Assistants", "Smart Displays", "Smoke Detectors", "CO Detectors",

            # Audio/Video
            "Soundbars", "Home Theater Systems", "Turntables", "CD Players",
            "Blu-ray Players", "Streaming Devices", "Set-Top Boxes", "Amplifiers",
            "Receivers", "Subwoofers", "Portable Speakers", "Wireless Earbuds",

            # Personal Care
            "Hair Dryers", "Electric Shavers", "Electric Toothbrushes", "Curling Irons",
            "Straighteners", "Massagers", "Blood Pressure Monitors", "Thermometers",
            "Scales", "Air Fryers", "Slow Cookers", "Pressure Cookers",

            # Office Equipment
            "Printers", "Scanners", "Copiers", "Fax Machines", "Shredders",
            "Laminators", "Label Makers", "Calculators", "Projectors Office",
            "Whiteboards Electronic", "Conference Systems", "Document Cameras",

            # Photography
            "DSLR Cameras", "Mirrorless Cameras", "Compact Cameras", "Action Cams",
            "Camera Lenses", "Tripods", "Flash Units", "Camera Bags",
            "Filters", "Memory Card Readers", "Photo Printers", "Light Boxes",

            # Gaming
            "Game Controllers", "Racing Wheels", "Flight Sticks", "VR Controllers",
            "Gaming Chairs", "Gaming Desks", "RGB Lighting", "Cooling Pads",
            "Capture Cards", "Gaming Headsets", "Gaming Keyboards", "Gaming Mice",

            # Networking
            "WiFi Extenders", "Mesh Systems", "NAS Devices", "Network Cards",
            "Ethernet Cables", "Powerline Adapters", "Access Points", "Firewalls"
        ]

        # Expanded internal category names (50+ categories)
        self.internal_category_names = [
            # Primary categories
            "Electric", "Construction", "Furniture", "Appliance",
            "Entertainment", "Communication", "Computing", "Home Care",
            "Personal Care", "Office Equipment",

            # Detailed electronics categories
            "Mobile Devices", "Audio Equipment", "Video Equipment", "Gaming",
            "Photography", "Networking", "Storage", "Input Devices",
            "Display Technology", "Smart Home", "Wearables", "Portable Electronics",

            # Home & Living
            "Kitchen Appliances", "Laundry Equipment", "Climate Control",
            "Cleaning Devices", "Food Preparation", "Beverage Equipment",
            "Home Security", "Home Automation", "Lighting Solutions",

            # Professional categories
            "Professional Audio", "Professional Video", "Medical Devices",
            "Fitness Equipment", "Health Monitoring", "Beauty Equipment",
            "Office Technology", "Printing Solutions", "Conference Equipment",

            # Emerging categories
            "IoT Devices", "AI Hardware", "Robotics", "3D Printing",
            "Virtual Reality", "Augmented Reality", "Streaming Equipment",
            "Content Creation", "E-Sports Equipment", "Renewable Energy Devices"
        ]

    def generate_raw_categories(self) -> List[str]:
        """Generate list of raw category names"""
        available = len(self.raw_category_names)
        requested = self.num_raw_categories

        if requested > available:
            print(f"   Warning: Requested {requested} raw categories, but only {available} available.")
            print(f"   Using all {available} categories and generating {requested - available} additional numbered categories.")

            # Use all available + generate numbered ones
            categories = self.raw_category_names.copy()
            for i in range(requested - available):
                categories.append(f"Product Category {i + 1}")
            return categories
        else:
            return random.sample(self.raw_category_names, requested)

    def generate_internal_categories(self) -> List[str]:
        """Generate list of internal category names"""
        available = len(self.internal_category_names)
        requested = self.num_internal_categories

        if requested > available:
            print(f"   Warning: Requested {requested} internal categories, but only {available} available.")
            print(f"   Using all {available} categories and generating {requested - available} additional numbered categories.")

            # Use all available + generate numbered ones
            categories = self.internal_category_names.copy()
            for i in range(requested - available):
                categories.append(f"Internal Category {i + 1}")
            return categories
        else:
            return random.sample(self.internal_category_names, requested)

    def generate_methodology_matrix(self, raw_cats: List[str],
                                   internal_cats: List[str]) -> Dict[str, Dict[str, float]]:
        """
        Generate conversion matrix from raw to internal categories

        Returns: Dict[internal_category][raw_category] = weight
        """
        methodology = {}

        for internal_cat in internal_cats:
            methodology[internal_cat] = {}

            # For each raw category, assign a weight (0.0 to 1.0)
            # Some raw categories don't contribute to certain internal categories
            for raw_cat in raw_cats:
                if random.random() < 0.6:  # 60% chance of contribution
                    # Generate weights that sum to 1.0 for each internal category
                    weight = random.uniform(0.1, 1.0)
                    methodology[internal_cat][raw_cat] = weight
                else:
                    methodology[internal_cat][raw_cat] = 0.0

            # Normalize weights to sum to 1.0
            total_weight = sum(methodology[internal_cat].values())
            if total_weight > 0:
                for raw_cat in raw_cats:
                    methodology[internal_cat][raw_cat] /= total_weight

        return methodology

    def generate_sales_data(self, categories: List[str]) -> Dict[str, List[float]]:
        """
        Generate synthetic sales data for categories over years

        Returns: Dict[category] = [values for each year]
        """
        data = {}

        for category in categories:
            # Start with a base value (in millions USD)
            base_value = random.uniform(5000, 50000)

            # Generate trend
            trend_type = random.choice(['growth', 'stable', 'decline', 'volatile'])

            values = []
            current_value = base_value

            for year_idx in range(self.num_years):
                if trend_type == 'growth':
                    growth_rate = random.uniform(0.03, 0.15)
                    current_value *= (1 + growth_rate)
                elif trend_type == 'decline':
                    decline_rate = random.uniform(0.01, 0.08)
                    current_value *= (1 - decline_rate)
                elif trend_type == 'stable':
                    change_rate = random.uniform(-0.02, 0.05)
                    current_value *= (1 + change_rate)
                else:  # volatile
                    change_rate = random.uniform(-0.15, 0.20)
                    current_value *= (1 + change_rate)

                # Add some noise
                noise = random.uniform(0.95, 1.05)
                values.append(current_value * noise)

            data[category] = values

        return data

    def create_methodology_sheet(self, wb: Workbook, raw_cats: List[str],
                                 internal_cats: List[str],
                                 methodology: Dict[str, Dict[str, float]]) -> None:
        """Create the Methodology sheet with conversion matrix"""
        ws = wb.create_sheet("Methodology", 0)

        # Header style
        header_fill = PatternFill(start_color="4472C4", end_color="4472C4", fill_type="solid")
        header_font = Font(bold=True, color="FFFFFF")

        # Write header row (raw categories)
        ws.cell(1, 1, "Internal / Raw")
        ws.cell(1, 1).fill = header_fill
        ws.cell(1, 1).font = header_font

        for col_idx, raw_cat in enumerate(raw_cats, start=2):
            ws.cell(1, col_idx, raw_cat)
            ws.cell(1, col_idx).fill = header_fill
            ws.cell(1, col_idx).font = header_font

        # Write internal categories and weights
        for row_idx, internal_cat in enumerate(internal_cats, start=2):
            ws.cell(row_idx, 1, internal_cat)
            ws.cell(row_idx, 1).fill = PatternFill(start_color="E7E6E6",
                                                    end_color="E7E6E6", fill_type="solid")
            ws.cell(row_idx, 1).font = Font(bold=True)

            for col_idx, raw_cat in enumerate(raw_cats, start=2):
                weight = methodology[internal_cat][raw_cat]
                ws.cell(row_idx, col_idx, round(weight, 3))

        # Adjust column widths
        ws.column_dimensions['A'].width = 20
        for col_idx in range(2, len(raw_cats) + 2):
            col_letter = self.get_column_letter(col_idx)
            ws.column_dimensions[col_letter].width = 15

    def create_rawdata_sheet(self, wb: Workbook, raw_cats: List[str],
                            sales_data: Dict[str, List[float]]) -> None:
        """Create the RawData sheet with sales figures"""
        ws = wb.create_sheet("RawData", 1)

        # Header style
        header_fill = PatternFill(start_color="70AD47", end_color="70AD47", fill_type="solid")
        header_font = Font(bold=True, color="FFFFFF")

        # Write Year header
        ws.cell(1, 1, "Year")
        ws.cell(1, 1).fill = header_fill
        ws.cell(1, 1).font = header_font

        # Write category headers (starting from column 2)
        for col_idx, cat in enumerate(raw_cats, start=2):
            # Randomly assign units (mn USD or bn USD)
            unit = random.choice(["mn USD", "mn USD", "bn USD"])  # More mn USD
            ws.cell(1, col_idx, f"{cat} ({unit})")
            ws.cell(1, col_idx).fill = header_fill
            ws.cell(1, col_idx).font = header_font

        # Write data rows
        for year_idx in range(self.num_years):
            year = self.start_year + year_idx
            row_idx = year_idx + 2

            # Write year
            ws.cell(row_idx, 1, year)

            # Write sales data
            for col_idx, cat in enumerate(raw_cats, start=2):
                value = sales_data[cat][year_idx]

                # Check if this column is in bn USD
                header_text = ws.cell(1, col_idx).value
                if "bn USD" in header_text:
                    # Convert to billions
                    value = value / 1000

                ws.cell(row_idx, col_idx, round(value, 2))

        # Adjust column widths
        ws.column_dimensions['A'].width = 10
        for col_idx in range(2, len(raw_cats) + 2):
            col_letter = self.get_column_letter(col_idx)
            ws.column_dimensions[col_letter].width = 18

    def get_column_letter(self, col_idx: int) -> str:
        """Convert column index to Excel letter"""
        letter = ""
        while col_idx > 0:
            col_idx, remainder = divmod(col_idx - 1, 26)
            letter = chr(65 + remainder) + letter
        return letter

    def calculate_groundtruth(self, raw_cats: List[str], sales_data: Dict[str, List[float]],
                             methodology: Dict[str, Dict[str, float]],
                             wb: Workbook) -> Tuple[List[Dict], Dict]:
        """
        Calculate groundtruth growth rates for target internal category

        IMPORTANT: Read data from Excel sheet (not from sales_data) to match
        the rounded values that were actually written to the file!

        Returns: (growth_rate_data, metadata)
        """
        # Find the RawData sheet to check units and read actual data
        ws_raw = wb["RawData"]

        # Build column mapping and unit map
        col_map = {}
        unit_map = {}
        # Columns: 1=Year, 2+=Categories
        for col_idx, cat in enumerate(raw_cats, start=2):
            header_text = ws_raw.cell(1, col_idx).value
            col_map[cat] = col_idx
            if "bn USD" in header_text:
                unit_map[cat] = "bn"
            else:
                unit_map[cat] = "mn"

        # Choose target internal category (first one in list)
        target_category = list(methodology.keys())[0]

        # Read actual data from Excel (with rounding) for each year
        # Store both original and converted values
        excel_data = {}
        excel_data_original = {}  # Store original values (for calculating raw category growth)

        for year_idx in range(self.num_years):
            row_idx = year_idx + 2  # Data starts at row 2
            year = self.start_year + year_idx
            excel_data[year] = {}
            excel_data_original[year] = {}

            for raw_cat in raw_cats:
                original_value = ws_raw.cell(row_idx, col_map[raw_cat]).value
                if original_value is not None:
                    excel_data_original[year][raw_cat] = original_value

                    # Convert to mn USD for internal category calculation
                    converted_value = original_value
                    if unit_map[raw_cat] == "bn":
                        converted_value = original_value * 1000
                    excel_data[year][raw_cat] = converted_value

        # Calculate internal category values for each year using Excel data
        internal_values = []

        for year_idx in range(self.num_years):
            year = self.start_year + year_idx
            total = 0
            contributions = {}

            for raw_cat in raw_cats:
                weight = methodology[target_category][raw_cat]
                value = excel_data[year][raw_cat]

                contribution = value * weight
                total += contribution
                contributions[raw_cat] = value  # Store values in mn USD

            internal_values.append({
                'year': year,
                'value': total,
                'raw_values': contributions
            })

        # Calculate growth rates
        growth_data = []

        years = sorted(excel_data.keys())

        for i in range(1, len(years)):
            year = years[i]
            prev_year = years[i - 1]

            # Calculate growth rates for each raw category using ORIGINAL values
            row = {'Year': year}

            for raw_cat in raw_cats:
                prev_value = excel_data_original[prev_year][raw_cat]
                curr_value = excel_data_original[year][raw_cat]

                if prev_value > 0:
                    growth_rate = ((curr_value - prev_value) / prev_value) * 100
                else:
                    growth_rate = 0

                row[f'{raw_cat} %'] = round(growth_rate, 9)

            # Calculate growth rate for target internal category
            # Find corresponding internal_values entries
            prev_internal = None
            curr_internal = None
            for iv in internal_values:
                if iv['year'] == prev_year:
                    prev_internal = iv
                if iv['year'] == year:
                    curr_internal = iv

            if prev_internal and curr_internal:
                prev_total = prev_internal['value']
                curr_total = curr_internal['value']

                if prev_total > 0:
                    total_growth_rate = ((curr_total - prev_total) / prev_total) * 100
                else:
                    total_growth_rate = 0

                row['Growth Rate %'] = round(total_growth_rate, 9)
            else:
                row['Growth Rate %'] = 0

            growth_data.append(row)

        # Prepare metadata
        metadata = {
            'target_category': target_category,
            'raw_categories': raw_cats,
            'internal_categories': list(methodology.keys()),
            'conversion_weights': {target_category: methodology[target_category]},
            'years': list(range(self.start_year, self.start_year + self.num_years)),
            'num_years': self.num_years,
            'num_raw_categories': len(raw_cats),
            'num_internal_categories': len(methodology),
            'difficulty': self.difficulty,
            'seed': self.seed
        }

        return growth_data, metadata

    def generate_format_example(self, wb_format: Workbook, growth_data: List[Dict]) -> None:
        """Generate the format example workbook with placeholder data only"""
        ws = wb_format.active
        ws.title = "GrowthRate"

        # Write header only (no actual groundtruth data!)
        if growth_data:
            headers = list(growth_data[0].keys())
            for col_idx, header in enumerate(headers, start=1):
                ws.cell(1, col_idx, header)
                ws.cell(1, col_idx).font = Font(bold=True)
                ws.cell(1, col_idx).fill = PatternFill(start_color="D9E1F2",
                                                       end_color="D9E1F2", fill_type="solid")

            # Write PLACEHOLDER/EXAMPLE data only (not real groundtruth!)
            # Use a few example rows with clearly placeholder values
            num_example_rows = min(3, len(growth_data))  # Only 3 example rows

            for row_idx in range(2, 2 + num_example_rows):
                for col_idx, header in enumerate(headers, start=1):
                    if header == 'Year':
                        # Use example years that don't match actual data
                        ws.cell(row_idx, col_idx, 2020 + row_idx - 2)
                    else:
                        # Use placeholder percentage values
                        ws.cell(row_idx, col_idx, 5.0 + (row_idx - 2) * 1.5)

        # Adjust column widths
        for col in ws.columns:
            max_length = 0
            column = col[0].column_letter
            for cell in col:
                try:
                    if len(str(cell.value)) > max_length:
                        max_length = len(str(cell.value))
                except:
                    pass
            adjusted_width = (max_length + 2)
            ws.column_dimensions[column].width = adjusted_width

    def generate_task_description(self, task_file: Path, metadata: Dict) -> None:
        """Generate task-specific information (concise version for workspace)"""
        target_category = metadata['target_category']
        start_year = metadata['years'][0]
        end_year = metadata['years'][-1]

        task_content = f"""# Task-Specific Information

**Target Category:** {target_category}

**Time Range:** {start_year + 1} to {end_year}

**Task:** Calculate the annual growth rate of sales for the '{target_category}' category from {start_year + 1} to {end_year}, as well as the growth rate of the corresponding raw data.

**Important:** The output should include growth rates for ALL years in the range [{start_year + 1}, {end_year}], including {start_year + 1} (which is calculated relative to {start_year}).

Please refer to `task.md` in the docs folder for the complete task description.
"""

        with open(task_file, 'w', encoding='utf-8') as f:
            f.write(task_content)

    def generate_task_description_cn(self, task_file: Path, metadata: Dict) -> None:
        """Generate task-specific information (Chinese version, concise for workspace)"""
        target_category = metadata['target_category']
        start_year = metadata['years'][0]
        end_year = metadata['years'][-1]

        task_content = f"""# Task-Specific Information

**Target Category:** {target_category}

**Time Range:** {start_year + 1} to {end_year}

**Task:** Calculate the annual growth rate of sales for the '{target_category}' category from {start_year + 1} to {end_year}, as well as the growth rate of the corresponding raw data.

**Important:** The output should include growth rates for ALL years in the range [{start_year + 1}, {end_year}], including {start_year + 1} (which is calculated relative to {start_year}).

Please refer to `task_cn.md` in the docs folder for the complete task description.
"""

        with open(task_file, 'w', encoding='utf-8') as f:
            f.write(task_content)

    def generate(self, output_dir: Path, save_groundtruth: bool = True) -> bool:
        """Generate all files"""
        try:
            output_dir = Path(output_dir)
            initial_workspace = output_dir / "initial_workspace"
            groundtruth_workspace = output_dir / "groundtruth_workspace"
            docs_dir = output_dir / "docs"

            initial_workspace.mkdir(parents=True, exist_ok=True)
            groundtruth_workspace.mkdir(parents=True, exist_ok=True)
            docs_dir.mkdir(parents=True, exist_ok=True)

            print(f"Generating market research data...")
            print(f"   Difficulty: {self.difficulty}")
            print(f"   Years: {self.start_year} - {self.start_year + self.num_years - 1}")
            print(f"   Raw categories: {self.num_raw_categories}")
            print(f"   Internal categories: {self.num_internal_categories}")
            print(f"   Seed: {self.seed}")

            # Generate categories
            raw_cats = self.generate_raw_categories()
            internal_cats = self.generate_internal_categories()

            print(f"\nCategories:")
            print(f"   Raw: {', '.join(raw_cats[:5])}{'...' if len(raw_cats) > 5 else ''}")
            print(f"   Internal: {', '.join(internal_cats)}")

            # Generate conversion matrix
            methodology = self.generate_methodology_matrix(raw_cats, internal_cats)

            # Generate sales data
            sales_data = self.generate_sales_data(raw_cats)

            # Create Market_Data.xlsx
            print(f"\nCreating Market_Data.xlsx...")
            wb = Workbook()
            wb.remove(wb.active)  # Remove default sheet

            self.create_methodology_sheet(wb, raw_cats, internal_cats, methodology)
            self.create_rawdata_sheet(wb, raw_cats, sales_data)

            market_data_file = initial_workspace / "Market_Data.xlsx"
            wb.save(market_data_file)
            print(f"   Saved: {market_data_file}")

            # Calculate groundtruth
            print(f"\nCalculating groundtruth...")
            growth_data, metadata = self.calculate_groundtruth(raw_cats, sales_data,
                                                              methodology, wb)

            # Create Market_Data_Format.xlsx
            print(f"\nCreating Market_Data_Format.xlsx...")
            wb_format = Workbook()
            self.generate_format_example(wb_format, growth_data)

            format_file = initial_workspace / "Market_Data_Format.xlsx"
            wb_format.save(format_file)
            print(f"   Saved: {format_file}")

            if save_groundtruth:
                # Save groundtruth CSV
                print(f"\nSaving groundtruth...")
                gt_csv_file = groundtruth_workspace / "Market_Data_gt.csv"

                with open(gt_csv_file, 'w', newline='', encoding='utf-8') as f:
                    if growth_data:
                        writer = csv.DictWriter(f, fieldnames=growth_data[0].keys())
                        writer.writeheader()
                        writer.writerows(growth_data)

                print(f"   Saved: {gt_csv_file}")

                # Save metadata
                metadata_file = groundtruth_workspace / "metadata.json"
                with open(metadata_file, 'w', encoding='utf-8') as f:
                    json.dump(metadata, f, indent=2, ensure_ascii=False)
                print(f"   Saved: {metadata_file}")

                # Save README
                readme_file = groundtruth_workspace / "README.md"
                self.generate_readme(readme_file, metadata)
                print(f"   Saved: {readme_file}")

                # Create task-specific descriptions in initial_workspace
                print(f"\nCreating task-specific descriptions...")
                task_specific_file = initial_workspace / "task_specific.md"
                self.generate_task_description(task_specific_file, metadata)
                print(f"   Created: {task_specific_file}")

                task_specific_file_cn = initial_workspace / "task_specific_cn.md"
                self.generate_task_description_cn(task_specific_file_cn, metadata)
                print(f"   Created: {task_specific_file_cn}")

            print(f"\nMarket data generation complete!")
            return True

        except Exception as e:
            print(f"Error generating market data: {e}")
            import traceback
            traceback.print_exc()
            return False

    def generate_readme(self, readme_file: Path, metadata: Dict) -> None:
        """Generate README with groundtruth calculation steps"""
        target_cat = metadata['target_category']
        raw_cats = metadata['raw_categories']
        weights = metadata['conversion_weights'][target_cat]

        with open(readme_file, 'w', encoding='utf-8') as f:
            f.write("## groundtruth calculation:\n\n")
            f.write("Step 1: Extract the Raw Data\n\n")
            f.write(f"- Get years {self.start_year}-{self.start_year + self.num_years - 1} from the RawData sheet\n")

            for cat in raw_cats:
                f.write(f"- Take {cat} values from RawData\n")

            f.write("- **Pay attention to units (mn USD vs bn USD) and convert to mn USD if needed**\n\n")

            f.write(f"Step 2: Calculate {target_cat} Category Totals\n\n")
            f.write("For each year, calculate:\n")

            formula_parts = []
            for cat in raw_cats:
                weight = weights[cat]
                if weight > 0:
                    formula_parts.append(f"{cat} x {weight:.3f}")

            formula = " + ".join(formula_parts)
            f.write(f"{target_cat} = {formula}\n\n")

            f.write("Step 3: Calculate Year-over-Year Growth Rates\n\n")
            f.write(f"For each year from {self.start_year + 1}-{self.start_year + self.num_years - 1}, calculate:\n")

            for cat in raw_cats:
                f.write(f"- {cat} Growth = (This Year {cat} - Last Year {cat}) / Last Year {cat} x 100\n")

            f.write(f"- **{target_cat} Growth = (This Year {target_cat} - Last Year {target_cat}) / Last Year {target_cat} x 100**\n\n")

            f.write("Step 4: Create Output Table\n\n")
            f.write("Make a table with columns:\n")
            f.write(f"- Year ({self.start_year + 1}-{self.start_year + self.num_years - 1})\n")

            for cat in raw_cats:
                f.write(f"- {cat} % (growth rate)\n")

            f.write(f"- Growth Rate ({target_cat} category growth rate)\n")


def main():
    parser = ArgumentParser(description="Generate market research data for Excel task")

    parser.add_argument("--output-dir", type=str, required=True,
                       help="Output directory (task root)")
    parser.add_argument("--seed", type=int, default=42,
                       help="Random seed (default: 42)")
    parser.add_argument("--start-year", type=int, default=2014,
                       help="Starting year (default: 2014)")
    parser.add_argument("--num-years", type=int, default=11,
                       help="Number of years (default: 11)")
    parser.add_argument("--num-raw-categories", type=int, default=10,
                       help="Number of raw market categories (default: 10)")
    parser.add_argument("--num-internal-categories", type=int, default=4,
                       help="Number of internal categories (default: 4)")
    parser.add_argument("--difficulty", type=str, default="custom",
                       choices=["easy", "medium", "hard", "expert", "custom"],
                       help="Difficulty level (default: custom)")
    parser.add_argument("--save-groundtruth", action="store_true", default=True,
                       help="Save groundtruth files (default: True)")

    args = parser.parse_args()

    # Adjust parameters based on difficulty (only if NOT custom)
    if args.difficulty != "custom":
        if args.difficulty == "easy":
            args.num_raw_categories = 3
            args.num_internal_categories = 2
            args.num_years = 6
        elif args.difficulty == "medium":
            args.num_raw_categories = 5
            args.num_internal_categories = 3
            args.num_years = 11
        elif args.difficulty == "hard":
            args.num_raw_categories = 10
            args.num_internal_categories = 5
            args.num_years = 11
        elif args.difficulty == "expert":
            args.num_raw_categories = 15
            args.num_internal_categories = 7
            args.num_years = 15

    generator = MarketDataGenerator(
        seed=args.seed,
        start_year=args.start_year,
        num_years=args.num_years,
        num_raw_categories=args.num_raw_categories,
        num_internal_categories=args.num_internal_categories,
        difficulty=args.difficulty
    )

    success = generator.generate(
        output_dir=Path(args.output_dir),
        save_groundtruth=args.save_groundtruth
    )

    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
