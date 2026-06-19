# csv-reader

## Description

Converts CSV files to structured JSON output. Handles common CSV dialects including comma-separated, tab-separated, and pipe-delimited formats. Automatically detects headers and data types.

## Version

1.0.0

## Author

team-data

## Runtime

python3

## Dependencies

- pandas

## Usage

```bash
python convert_csv.py input.csv
```

## Inputs

- A single CSV file path passed as a command-line argument. The file must be UTF-8 encoded.

## Outputs

- A JSON file written to the same directory as the input, with the `.json` extension replacing `.csv`. Each row becomes a JSON object with column headers as keys.
