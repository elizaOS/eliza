# Manual Examination Script for OSWorld Tasks
# This script is used to manually verify and examine specific benchmark tasks

# Example task IDs for different domains:
# libreoffice_impress
# - 358aa0a7-6677-453f-ae35-e440f004c31e
# - a669ef01-ded5-4099-9ea9-25e99b569840

# multi_apps
# - 9219480b-3aed-47fc-8bac-d2cffc5849f7

# chrome
# - bb5e4c0d-f964-439c-97b6-bdb9747de3f4
# - 2ad9387a-65d8-4e33-ad5b-7580065a27ca (needs to be improved)
# - 2ae9ba84-3a0d-4d4c-8338-3a1478dc5fe3 (needs to be improved)
# - 7a5a7856-f1b6-42a4-ade9-1ca81ca0f263 (needs to be improved)
# - e1e75309-3ddb-4d09-92ec-de869c928143
# - b4f95342-463e-4179-8c3f-193cd7241fb2
# - b7895e80-f4d1-4648-bee0-4eb45a6f1fa8

# libreoffice_calc
# - 8b1ce5f2-59d2-4dcc-b0b0-666a714b9a14
# - 4e6fcf72-daf3-439f-a232-c434ce416af6
# - 357ef137-7eeb-4c80-a3bb-0951f26a8aff

# chrome
# - c1fa57f3-c3db-4596-8f09-020701085416
# - 06fe7178-4491-4589-810f-2e2bc9502122 (slow setup)

# gimp
# - 06ca5602-62ca-47f6-ad4f-da151cde54cc

# multi_apps
# - 02ce9a50-7af2-47ed-8596-af0c230501f8

# Example usage:
python scripts/python/manual_examine.py \
    --headless \
    --observation_type screenshot \
    --result_dir ./results_human_examine \
    --test_all_meta_path evaluation_examples/test_all.json \
    --domain libreoffice_impress \
    --example_id a669ef01-ded5-4099-9ea9-25e99b569840 \
    --max_steps 3
