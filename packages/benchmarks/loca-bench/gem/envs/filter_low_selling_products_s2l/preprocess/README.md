# Low-Selling Product Filtering Task - Data Generation and Difficulty Control

## Overview

This task supports dynamic generation of product data and subscriber data, and provides difficulty presets to control task complexity.

## Features

### 1. Dynamic Data Generation

- **Low-selling products**: Products that meet the criteria (in stock >90 days, 30-day sales <10)
- **Normal-selling products**: Control group products that do not meet low-selling criteria
- **Subscribers**: List of subscribers who receive promotional emails

### 2. Difficulty Control

Adjust task difficulty by controlling the following parameters:
- Number of low-selling products
- Number of normal-selling products
- Number of subscribers

## Usage

### Basic Usage

```bash
python main.py --agent_workspace /path/to/workspace
```

### Using Difficulty Presets

#### Easy Mode
```bash
python main.py --agent_workspace /path/to/workspace --difficulty easy
```
- Low-selling products: 3
- Normal-selling products: 2
- Subscribers: 2

#### Medium Mode (Default)
```bash
python main.py --agent_workspace /path/to/workspace --difficulty medium
```
- Low-selling products: 5
- Normal-selling products: 5
- Subscribers: 3

#### Hard Mode
```bash
python main.py --agent_workspace /path/to/workspace --difficulty hard
```
- Low-selling products: 10
- Normal-selling products: 15
- Subscribers: 5

#### Expert Mode
```bash
python main.py --agent_workspace /path/to/workspace --difficulty expert
```
- Low-selling products: 20
- Normal-selling products: 30
- Subscribers: 10

#### Extreme Mode
```bash
python main.py --agent_workspace /path/to/workspace --difficulty extreme
```
- Low-selling products: 50
- Normal-selling products: 100
- Subscribers: 25

#### Insane Mode (Highest Difficulty)
```bash
python main.py --agent_workspace /path/to/workspace --difficulty insane
```
- Low-selling products: 100
- Normal-selling products: 200
- Subscribers: 50

### Custom Parameters

```bash
python main.py --agent_workspace /path/to/workspace \
  --num-low-selling 15 \
  --num-normal-selling 20 \
  --num-subscribers 8 \
  --seed 123
```

### Skip Data Generation

Use existing data files without regenerating:

```bash
python main.py --agent_workspace /path/to/workspace --skip-generation
```

## Command Line Parameter Description

### Required Parameters

- `--agent_workspace`: Agent workspace path

### Optional Parameters

#### Difficulty Presets
- `--difficulty`: Difficulty level (easy/medium/hard/expert)
  - Will override other data generation parameters

#### Data Generation Parameters
- `--num-low-selling`: Number of low-selling products (default: 5)
- `--num-normal-selling`: Number of normal-selling products (default: 3)
- `--num-subscribers`: Number of subscribers (default: 3)
- `--seed`: Random seed (default: 42)

#### Others
- `--skip-generation`: Skip data generation, use existing files
- `--launch_time`: Launch time (optional)

## Generated Files

### preprocess/generated_products.json
Contains all generated product data (low-selling + normal-selling)

### initial_workspace/subscriber.json
Contains subscriber list, format:
```json
{
  "subscriber_list": [
    {
      "email": "user@mcpt.com",
      "name": "User Name"
    }
  ]
}
```

### groundtruth_workspace/generation_metadata.json
Contains generation metadata and groundtruth information:
```json
{
  "generation_params": {
    "num_low_selling": 5,
    "num_normal_selling": 3,
    "num_subscribers": 3,
    "seed": 42,
    "total_products": 8
  },
  "low_selling_products": ["Product name list"],
  "normal_selling_products": ["Product name list"],
  "subscribers": ["Email list"],
  "timestamp": "ISO timestamp"
}
```

## Data Characteristics

### Low-Selling Product Characteristics
- Days in stock: 91-365 days
- 30-day sales: 0-9 items
- Price discount: 10%-50%

### Normal-Selling Product Characteristics
Three types:
1. **Short stock duration type**: In stock < 90 days, any sales volume
2. **High sales type**: In stock > 90 days, but sales >= 10
3. **Perfect type**: Short stock duration + high sales

## Difficulty Comparison

| Difficulty | Low-Selling Products | Normal-Selling Products | Subscribers | Total Products | Recommended Scenario |
|------------|---------------------|------------------------|-------------|----------------|---------------------|
| Easy | 3 | 2 | 2 | 5 | Quick testing |
| Medium | 5 | 5 | 3 | 10 | Standard evaluation |
| Hard | 10 | 15 | 5 | 25 | Regular stress test |
| Expert | 20 | 30 | 10 | 50 | Advanced stress test |
| Extreme | 50 | 100 | 25 | 150 | Performance limit |
| Insane | 100 | 200 | 50 | 300 | Ultimate challenge |

## Example Workflow

### 1. Generate New Data and Run (Medium Difficulty)
```bash
python main.py --agent_workspace ./workspace --difficulty medium
```

### 2. Generate Custom Data
```bash
python main.py --agent_workspace ./workspace \
  --num-low-selling 8 \
  --num-normal-selling 12 \
  --num-subscribers 6
```

### 3. Test with Existing Data
```bash
python main.py --agent_workspace ./workspace --skip-generation
```

## Large-Scale Data Support

### Ultra-High Difficulty Levels

The system supports generating hundreds or even thousands of products and subscribers:

```bash
# Extreme difficulty: 150 products, 25 subscribers
python main.py --agent_workspace /path --difficulty extreme

# Insane difficulty: 300 products, 50 subscribers
python main.py --agent_workspace /path --difficulty insane

# Custom ultra-large scale: 500+ products, 100+ subscribers
python main.py --agent_workspace /path \
  --num-low-selling 200 \
  --num-normal-selling 400 \
  --num-subscribers 120
```

### Performance Considerations

| Scale | Products | Generation Time | Database Size | Memory Usage |
|-------|----------|-----------------|---------------|--------------|
| Small | 5-25 | < 5 sec | < 1MB | < 10MB |
| Medium | 25-100 | 5-15 sec | 1-5MB | 10-30MB |
| Large | 100-300 | 15-30 sec | 5-15MB | 30-80MB |
| XLarge | 300-1000 | 30-120 sec | 15-50MB | 80-200MB |

### Optimization Suggestions

1. **Fixed seed**: Use the same `--seed` to avoid repeated generation
2. **Incremental testing**: Start from small scale and gradually increase
3. **Monitor resources**: Pay attention to memory and disk usage with large-scale data
4. **Cache data**: Generate once, use multiple times with `--skip-generation`

## Notes

1. **Random seed**: Using the same seed will generate the same data, convenient for reproducible testing
2. **Database cleanup**: Each run will clear and rebuild the database
3. **File overwrite**: Generated files will overwrite existing files
4. **Difficulty preset priority**: Using `--difficulty` will override individually set quantity parameters
5. **Product quantity limit**: It is recommended not to exceed 1000 products to ensure performance
6. **Subscriber limit**: It is recommended not to exceed 200 subscribers to ensure email checking performance

## Troubleshooting

### Data Generation Failed
Check if the `generate_products_data.py` script exists in the `preprocess/` directory

### Products Not Correctly Inserted into Database
Ensure the `generated_products.json` file format is correct

### Subscriber Data Not Generated
Check if `initial_workspace/subscriber.json` was correctly created

## Related Files

- `main.py`: Main preprocessing script
- `generate_products_data.py`: Data generation script
- `setup_test_products.py`: Legacy product setup (no longer used)

