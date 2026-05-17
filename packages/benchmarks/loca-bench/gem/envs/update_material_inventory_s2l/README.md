# Update Material Inventory S2L Environment

This environment simulates a material inventory management scenario for e-commerce businesses that manufacture products from raw materials.

## Task Overview

The agent needs to:
1. Read the Bill of Materials (BOM) from Google Sheets to understand product-material relationships
2. Read current material inventory data from Google Sheets
3. Calculate the maximum producible quantity for each product based on available materials
4. Update WooCommerce product stock quantities with the calculated values

## Environment Structure

```
update_material_inventory_s2l/
├── update_material_inventory_s2l.py  # Main environment class
├── __init__.py                        # Package initialization
├── preprocess/                        # Preprocessing scripts
│   ├── main.py                       # Main preprocessing script
│   ├── order_simulator.py            # Order generation utilities
│   ├── sheets_setup.py               # Google Sheets setup utilities
│   ├── woocommerce_client.py         # WooCommerce client utilities
│   └── calculate_expected_results.py # Expected results calculation
├── evaluation/                        # Evaluation scripts
│   ├── main.py                       # Main evaluation script
│   ├── check_sheets.py               # Google Sheets validation
│   └── check_woocommerce.py          # WooCommerce validation
└── initial_workspace/                 # Initial workspace (empty by default)
```

## Configuration Parameters

### Data Generation Parameters
- `num_products`: Number of products to generate (default: 5)
- `num_materials`: Number of raw materials (default: 10)
- `materials_per_product`: Average materials per product in BOM (default: 3)
- `num_orders`: Number of test orders to generate (default: 10)
- `seed`: Random seed for reproducibility (default: 42)

### Difficulty Presets
- `easy`: 2 products, 5 materials, 3 orders
- `medium`: 3 products, 8 materials, 5 orders
- `hard`: 5 products, 12 materials, 10 orders
- `expert`: 8 products, 20 materials, 15 orders
- `extreme`: 12 products, 25 materials, 25 orders

## Usage Example

```python
from gem.envs.update_material_inventory_s2l import UpdateMaterialInventoryS2LEnv

# Create environment with default settings
env = UpdateMaterialInventoryS2LEnv(
    task_dir="/path/to/task",
    num_products=5,
    num_materials=10,
    materials_per_product=3,
    num_orders=10,
    seed=42,
    verbose=True
)

# Reset environment (runs preprocessing)
instructions, info = env.reset()

# Agent performs actions...
# When agent calls claim_done, evaluate results
observation, reward, terminated, truncated, info = env.step("claim_done")
```

## MCP Servers Required

This environment requires the following MCP servers:
- `google-sheet-simplified`: For reading BOM and inventory data
- `woocommerce-simplified`: For updating product stock quantities

## Local Tools Required

- `manage_context`: Context management
- `history`: Command history
- `python_execute`: Python code execution
- `handle_overlong_tool_outputs`: Handle long outputs
- `claim_done`: Signal task completion

## Evaluation Criteria

The evaluation checks:
1. **Google Sheets Integration**: Did the agent read BOM and inventory data correctly?
2. **WooCommerce Sync**: Did the agent update product stock quantities correctly?
3. **Calculation Accuracy**: Are the stock quantities based on correct max producible calculations?

All checks must pass for the task to be considered successful.

## Task Flow

### Preprocessing Phase (reset)
1. Generate random inventory data (products, materials, BOM)
2. Calculate initial max producible quantities
3. Initialize WooCommerce database with products
4. Initialize Google Sheets with BOM and inventory data
5. Generate test orders to simulate some inventory consumption
6. Calculate expected final results after order processing
7. Save groundtruth data for evaluation

### Execution Phase (agent actions)
The agent should:
1. Query Google Sheets to read BOM data
2. Query Google Sheets to read material inventory data
3. Calculate max producible quantity for each product
4. Update WooCommerce product stock quantities

### Evaluation Phase (step)
1. Compare Google Sheets reads with expected accesses
2. Compare WooCommerce updates with expected stock values
3. Verify calculation accuracy

## Technical Details

### Database Directories
- `task_dir/local_db/woocommerce/`: Local WooCommerce database
- `task_dir/local_db/google_sheets/`: Local Google Sheets database

### Generated Files
- `task_dir/groundtruth_workspace/`: Contains expected results and metadata
  - `config.json`: Configuration including spreadsheet ID
  - `generation_metadata.json`: Generation parameters and data
  - `expected_results.json`: Expected final state
  - `test_orders.json`: Generated test orders
- `task_dir/agent_workspace/`: Agent's working directory
- `task_dir/logs/`: Environment logs

### Parallel Execution Support

The environment is designed to support parallel execution:
- Each instance has a unique logger name based on `id(self)`
- Preprocessing modules are loaded with unique names to avoid conflicts
- All generated files are stored in the instance's `task_dir`, not in the code directory
- Database directories are instance-specific

## Example Scenario

A furniture company manufactures products like chairs and tables from raw materials like wood planks, screws, and glue. The BOM defines how many units of each material are needed to produce one unit of each product.

Given:
- BOM: Chair requires 2 sqm oak planks + 10 screws + 0.1L glue
- Inventory: 10 sqm oak planks, 100 screws, 2L glue

Maximum producible quantities:
- Oak planks: 10 / 2 = 5 chairs
- Screws: 100 / 10 = 10 chairs
- Glue: 2 / 0.1 = 20 chairs
- **Final: min(5, 10, 20) = 5 chairs**

The agent needs to update the Chair stock quantity in WooCommerce to 5.


