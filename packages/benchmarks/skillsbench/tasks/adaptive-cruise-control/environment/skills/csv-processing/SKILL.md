---
name: csv-processing
description: Use this skill when reading sensor data from CSV files, writing simulation results to CSV, processing time-series data with pandas, or handling missing values in datasets.
---

# CSV Processing with Pandas

## Reading CSV

```python
import pandas as pd

df = pd.read_csv('data.csv')

# View structure
print(df.head())
print(df.columns.tolist())
print(len(df))
```

## Handling Missing Values

```python
# Read with explicit NA handling
df = pd.read_csv('data.csv', na_values=['', 'NA', 'null'])

# Check for missing values
print(df.isnull().sum())

# Check if specific value is NaN
if pd.isna(row['column']):
    # Handle missing value
```

## Accessing Data

```python
# Single column
values = df['column_name']

# Multiple columns
subset = df[['col1', 'col2']]

# Filter rows
filtered = df[df['column'] > 10]
filtered = df[(df['time'] >= 30) & (df['time'] < 60)]

# Rows where column is not null
valid = df[df['column'].notna()]
```

## Writing CSV

```python
import pandas as pd

# From dictionary
data = {
    'time': [0.0, 0.1, 0.2],
    'value': [1.0, 2.0, 3.0],
    'label': ['a', 'b', 'c']
}
df = pd.DataFrame(data)
df.to_csv('output.csv', index=False)
```

## Building Results Incrementally

```python
results = []

for item in items:
    row = {
        'time': item.time,
        'value': item.value,
        'status': item.status if item.valid else None
    }
    results.append(row)

df = pd.DataFrame(results)
df.to_csv('results.csv', index=False)
```

## Common Operations

```python
# Statistics
mean_val = df['column'].mean()
max_val = df['column'].max()
min_val = df['column'].min()
std_val = df['column'].std()

# Add computed column
df['diff'] = df['col1'] - df['col2']

# Iterate rows
for index, row in df.iterrows():
    process(row['col1'], row['col2'])
```
