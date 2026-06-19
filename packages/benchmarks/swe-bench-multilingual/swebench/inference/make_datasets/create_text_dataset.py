#!/usr/bin/env python3

"""
Create a dataset for text-to-text training from the raw task instance outputs.
"""

import json
import logging
import os
from argparse import ArgumentParser
from pathlib import Path
from datasets import Dataset, DatasetDict, load_dataset, load_from_disk
from tqdm.auto import tqdm

from swebench.inference.make_datasets.create_instance import (
    add_text_inputs,
    PROMPT_FUNCTIONS,
)
from swebench.inference.make_datasets.tokenize_dataset import TOKENIZER_FUNCS

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


def load_jsonl_file(filename):
    if type(filename) == str:
        filename = Path(filename)
    if filename.name.endswith(".jsonl") or filename.name.endswith(".jsonl.all"):
        with open(filename) as f:
            return [json.loads(line) for line in f]
    elif filename.name.endswith(".json"):
        with open(filename) as f:
            return json.load(f)
    else:
        raise ValueError(f"Unknown file type {filename}")


def instances_generator(files):
    all_data = list()
    for file in tqdm(files, desc="Loading instance files"):
        all_data.extend(load_jsonl_file(file))
    return all_data


def get_training_and_eval_instances(raw_files, test_dataset):
    logger.info("Loading instances")
    raw_instances = list(instances_generator(raw_files))
    final_instances = list(test_dataset["test"])
    eval_repos = {x["repo"] for x in final_instances}
    train_instances = [x for x in raw_instances if x["repo"] not in eval_repos]
    train_instances = list(sorted(train_instances, key=lambda x: x["instance_id"]))
    eval_instances = list(sorted(final_instances, key=lambda x: x["instance_id"]))
    logger.info(f"Found {len(train_instances)} training ids")
    logger.info(f"Found {len(eval_instances)} eval ids")
    return train_instances, eval_instances


def extract_fields(instance):
    instance_id = instance["instance_id"]
    if instance["text_inputs"] is None or instance["patch"] is None:
        logger.warning(f"No text for {instance_id}")
        return None
    text_inputs = instance["text_inputs"].strip() + "\n\n"
    if text_inputs is None or instance["patch"] is None:
        logger.warning(f"No inputs for {instance_id}")
        return None
    patch = "\n".join(["<patch>", instance["patch"], "</patch>"])
    return {**instance, "text": text_inputs, "patch": patch}


def validate_arguments(
    push_to_hub_user, output_dir, max_context_len, tokenizer_name, file_source, k
):
    """Validate command line arguments and environment setup."""
    if push_to_hub_user is not None:
        hub_token = os.environ.get("HUGGING_FACE_HUB_TOKEN", None)
        assert hub_token is not None, (
            "Must provide HUGGING_FACE_HUB_TOKEN to push to the Hub"
        )
        assert output_dir is None, "Cannot provide output_dir if pushing to the Hub"
    if max_context_len is not None:
        assert tokenizer_name is not None
    if push_to_hub_user is None and not Path(output_dir).exists():
        Path(output_dir).mkdir(parents=True)
    if max_context_len is not None:
        assert file_source not in {"all", "oracle"}, (
            "Cannot use max_context_len with oracle or all file sources"
        )
        assert tokenizer_name is not None, (
            "Must provide tokenizer_name if max_context_len is not None"
        )
    if k is not None:
        assert file_source not in {"all", "oracle"}, (
            "Cannot use max_context_len with oracle or all file sources"
        )
    return hub_token if push_to_hub_user is not None else None


def construct_output_filename(
    dataset_name, prompt_style, file_source, k, max_context_len, tokenizer_name
):
    """Construct the output filename based on parameters."""
    if dataset_name.startswith("princeton-nlp"):
        dataset_name = dataset_name.split("/")[-1]
    dataset_name = dataset_name.replace("/", "__")
    output_file = f"{dataset_name}__{prompt_style}__fs-{file_source}"
    if k is not None:
        output_file += f"__k-{k}"
    if max_context_len is not None:
        output_file += f"__mcc-{max_context_len}-{tokenizer_name}"
    return output_file


def main(
    dataset_name_or_path,
    splits,
    validation_ratio,
    output_dir,
    retrieval_file,
    prompt_style,
    file_source,
    k,
    max_context_len,
    tokenizer_name,
    push_to_hub_user,
):
    # Validate arguments and setup
    hub_token = validate_arguments(
        push_to_hub_user, output_dir, max_context_len, tokenizer_name, file_source, k
    )
    output_file = construct_output_filename(
        dataset_name_or_path,
        prompt_style,
        file_source,
        k,
        max_context_len,
        tokenizer_name,
    )
    output_file = Path(output_dir, output_file)
    if push_to_hub_user is None:
        if output_file.exists():
            existing_dataset = load_from_disk(output_file)
            # if requested splits are in existing dataset, abort
            for split in splits:
                if split in existing_dataset:
                    logger.info(
                        f"{output_file.absolute().as_posix()} already exists for split {split}. Aborting"
                    )
                    return
            del existing_dataset  # don't store in memory

    # Load dataset
    dataset = (
        load_from_disk(dataset_name_or_path)
        if Path(dataset_name_or_path).exists()
        else load_dataset(dataset_name_or_path)
    )
    logger.info(f"Found {set(dataset.keys())} splits")
    if set(splits) - set(dataset.keys()) != set():
        raise ValueError(f"Unknown splits {set(splits) - set(dataset.keys())}")

    # Define columns for final dataset
    columns = [
        "instance_id",
        "text",
        "repo",
        "base_commit",
        "problem_statement",
        "hints_text",
        "created_at",
        "patch",
        "test_patch",
        "version",
        "FAIL_TO_PASS",
        "PASS_TO_PASS",
        "environment_setup_commit",
    ]

    # Process each split
    split_data = {}
    progress_files = {}
    for split in splits:
        logger.info(f"Processing {split} split")
        split_instances = {x["instance_id"]: x for x in dataset[split]}
        progress_file = f"{output_file}.{split}.progress.jsonl"
        progress_files[split] = progress_file
        # Process instances and save to progress file
        add_text_inputs(
            split_instances,
            retrieval_file=retrieval_file,
            k=k,
            prompt_style=prompt_style,
            file_source=file_source,
            max_context_len=max_context_len,
            tokenizer_name=tokenizer_name,
            progress_file=progress_file,
        )

    logger.info("Creating final dataset")
    # Create final dataset
    if output_file.exists():
        final_dataset = load_from_disk(output_file)
    else:
        final_dataset = DatasetDict()
    for split in splits:
        split_data = {key: [] for key in columns}
        valid_instance_ids = set(dataset[split]["instance_id"])
        invalid_instances = []

        with open(progress_files[split]) as f:
            for line in f:
                datum = extract_fields(json.loads(line))
                if not datum:
                    continue
                if datum["instance_id"] not in valid_instance_ids:
                    invalid_instances.append(datum["instance_id"])
                    continue
                for key in columns:
                    split_data[key].append(datum.get(key, ""))

        if invalid_instances:
            logger.warning(
                f"Found {len(invalid_instances)} instances in progress file that are not in the {split} dataset: {invalid_instances}. These will be removed from the final dataset."
            )

        final_dataset[split] = Dataset.from_dict(split_data)

    # Handle validation split
    if validation_ratio > 0 and "train" in final_dataset:
        train_val = final_dataset["train"].train_test_split(
            test_size=validation_ratio, seed=42
        )
        final_dataset["train"] = train_val["train"]
        final_dataset["validation"] = train_val["test"]

    # Log final dataset sizes
    for split in final_dataset:
        logger.info(f"Found {len(final_dataset[split])} {split} instances")

    # Save dataset
    if push_to_hub_user is not None:
        final_dataset.push_to_hub(
            f"{push_to_hub_user}/{output_file.name}", use_auth_token=hub_token
        )
    else:
        final_dataset.save_to_disk(output_file)

    # Cleanup progress files
    for progress_file in progress_files.values():
        if os.path.exists(progress_file):
            os.remove(progress_file)

    logger.info(f"Finished saving to {output_file}")


if __name__ == "__main__":
    parser = ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dataset_name_or_path",
        type=str,
        default="SWE-bench/SWE-bench",
        help="Dataset to use for test set from HuggingFace Datasets or path to a save_to_disk directory.",
    )
    parser.add_argument(
        "--splits",
        nargs="+",
        default=["train", "test"],
        help="Splits to use from the dataset.",
    )
    parser.add_argument(
        "--validation_ratio",
        type=float,
        default=0.01,
        help="Ratio of the training set to use for validation.",
    )
    parser.add_argument("--output_dir", type=str, help="Path to the output directory.")
    parser.add_argument(
        "--retrieval_file",
        type=str,
        help="Path to the file where the retrieval results are stored.",
    )
    parser.add_argument(
        "--prompt_style",
        type=str,
        default="style-3",
        choices=PROMPT_FUNCTIONS.keys(),
        help="Prompt style to use. See create_instance.PROMPT_FUNCTIONS for details.",
    )
    parser.add_argument(
        "--file_source",
        type=str,
        default="oracle",
        choices=["oracle", "bm25", "all"],
        help="How to select the files to use in context.",
    )
    parser.add_argument(
        "--k",
        type=int,
        default=None,
        help="Maximum number of files to use for retrieval.",
    )
    parser.add_argument(
        "--max_context_len",
        type=int,
        default=None,
        help="Maximum number of tokens to use for context.",
    )
    parser.add_argument(
        "--tokenizer_name",
        type=str,
        default=None,
        choices=TOKENIZER_FUNCS.keys(),
        help="Tokenizer to use for max_context_len. Only needed if max_context_len is specified.",
    )
    parser.add_argument(
        "--push_to_hub_user",
        type=str,
        help="Username to use for pushing to the Hub. If not provided, will save to disk.",
    )
    main(**vars(parser.parse_args()))
