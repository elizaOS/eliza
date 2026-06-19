from google.cloud import bigquery
import os
import glob
from pathlib import Path

def upload_csvs_to_bigquery(
    project_id: str,
    dataset_id: str,
    csv_folder: str,
    csv_pattern: str = "*.csv",
    skip_header: bool = True,
    write_mode: str = "WRITE_TRUNCATE",
    credentials=None
):
    """
    Upload multiple CSV files to BigQuery dataset
    
    Args:
        project_id: Google Cloud project ID
        dataset_id: BigQuery dataset ID
        csv_folder: Folder containing CSV files
        csv_pattern: Pattern to match CSV files (default: "*.csv")
        skip_header: Whether to skip first row (header)
        write_mode: WRITE_TRUNCATE, WRITE_APPEND, or WRITE_EMPTY
        credentials: Google Cloud credentials
    """

    # Initialize BigQuery client
    client = bigquery.Client(project=project_id, credentials=credentials)

    # Get dataset reference
    dataset_ref = client.dataset(dataset_id)

    # Create dataset if it doesn't exist
    try:
        dataset = client.get_dataset(dataset_ref)
        print(f"Dataset {dataset_id} already exists")
    except Exception:
        dataset = bigquery.Dataset(dataset_ref)
        dataset.location = "US"
        dataset = client.create_dataset(dataset)
        print(f"Created dataset {dataset_id}")

    # Find all CSV files
    csv_files = glob.glob(os.path.join(csv_folder, csv_pattern))

    if not csv_files:
        print(f"No CSV files found matching pattern {csv_pattern} in {csv_folder}")
        return

    print(f"Found {len(csv_files)} CSV files to upload")

    # Upload each CSV file
    for csv_file in csv_files:
        # Extract table name from filename (without extension)
        table_name = Path(csv_file).stem

        # Clean table name (BigQuery table names have restrictions)
        table_name = table_name.replace("-", "_").replace(" ", "_")

        print(f"\nUploading {csv_file} -> {dataset_id}.{table_name}")

        try:
            # Configure job
            job_config = bigquery.LoadJobConfig(
                source_format=bigquery.SourceFormat.CSV,
                skip_leading_rows=1 if skip_header else 0,
                autodetect=True,  # Auto-detect schema
                write_disposition=write_mode
            )

            # Get table reference
            table_ref = dataset_ref.table(table_name)

            # Upload file
            with open(csv_file, "rb") as source_file:
                job = client.load_table_from_file(
                    source_file,
                    table_ref,
                    job_config=job_config
                )

            # Wait for job to complete
            job.result()

            # Get table info
            table = client.get_table(table_ref)
            print(f"✅ Loaded {table.num_rows} rows into {dataset_id}.{table_name}")

        except Exception as e:
            print(f"❌ Error uploading {csv_file}: {e}")

