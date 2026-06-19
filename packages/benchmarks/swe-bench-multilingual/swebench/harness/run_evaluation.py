from __future__ import annotations

import docker
import json
import platform
import threading
import traceback

if platform.system() == "Linux":
    import resource

from argparse import ArgumentParser, ArgumentDefaultsHelpFormatter
from pathlib import Path, PurePosixPath
from tqdm.auto import tqdm

from swebench.harness.constants import (
    APPLY_PATCH_FAIL,
    APPLY_PATCH_PASS,
    DOCKER_PATCH,
    DOCKER_USER,
    DOCKER_WORKDIR,
    INSTANCE_IMAGE_BUILD_DIR,
    KEY_INSTANCE_ID,
    KEY_MODEL,
    KEY_PREDICTION,
    LOG_REPORT,
    LOG_INSTANCE,
    LOG_TEST_OUTPUT,
    RUN_EVALUATION_LOG_DIR,
    UTF8,
)
from swebench.harness.docker_utils import (
    clean_images,
    cleanup_container,
    copy_to_container,
    exec_run_with_timeout,
    list_images,
    remove_image,
    should_remove,
)
from swebench.harness.docker_build import (
    BuildImageError,
    build_container,
    build_env_images,
    close_logger,
    setup_logger,
)
from swebench.harness.grading import get_eval_report
from swebench.harness.reporting import make_run_report
from swebench.harness.modal_eval import (
    run_instances_modal,
    validate_modal_credentials,
)
from swebench.harness.test_spec.test_spec import make_test_spec, TestSpec
from swebench.harness.utils import (
    EvaluationError,
    load_swebench_dataset,
    get_predictions_from_file,
    run_threadpool,
    str2bool,
    optional_str,
)

GIT_APPLY_CMDS = [
    "git apply --verbose",
    "git apply --verbose --reject",
    "patch --batch --fuzz=5 -p1 -i",
]


def run_instance(
    test_spec: TestSpec,
    pred: dict,
    rm_image: bool,
    force_rebuild: bool,
    client: docker.DockerClient,
    run_id: str,
    timeout: int | None = None,
    rewrite_reports: bool = False,
) -> dict:
    """
    Run a single instance with the given prediction.

    Args:
        test_spec (TestSpec): TestSpec instance
        pred (dict): Prediction w/ model_name_or_path, model_patch, instance_id
        rm_image (bool): Whether to remove the image after running
        force_rebuild (bool): Whether to force rebuild the image
        client (docker.DockerClient): Docker client
        run_id (str): Run ID
        timeout (int): Timeout for running tests
        rewrite_reports (bool): True if eval run is just to reformat existing report
    """
    # Set up logging directory
    instance_id = test_spec.instance_id
    model_name_or_path = pred.get(KEY_MODEL, "None").replace("/", "__")
    log_dir = RUN_EVALUATION_LOG_DIR / run_id / model_name_or_path / instance_id

    # Set up report file
    report_path = log_dir / LOG_REPORT
    if rewrite_reports:
        test_output_path = log_dir / LOG_TEST_OUTPUT
        if not test_output_path.exists():
            raise ValueError(f"Test output file {test_output_path} does not exist")
        report = get_eval_report(
            test_spec=test_spec,
            prediction=pred,
            test_log_path=test_output_path,
            include_tests_status=True,
        )
        # Write report to report.json
        with open(report_path, "w") as f:
            f.write(json.dumps(report, indent=4))
        return {
            "completed": True,
            "resolved": report[instance_id]["resolved"],
        }
    if report_path.exists():
        report = json.loads(report_path.read_text())
        return {
            "completed": True,
            "resolved": report[instance_id]["resolved"],
        }

    if not test_spec.is_remote_image:
        # Link the image build dir in the log dir
        build_dir = INSTANCE_IMAGE_BUILD_DIR / test_spec.instance_image_key.replace(
            ":", "__"
        )
        image_build_link = log_dir / "image_build_dir"
        if not image_build_link.exists():
            try:
                # link the image build dir in the log dir
                image_build_link.symlink_to(
                    build_dir.absolute(), target_is_directory=True
                )
            except:
                # some error, idk why
                pass

    # Set up logger
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / LOG_INSTANCE
    logger = setup_logger(instance_id, log_file)

    # Run the instance
    container = None
    eval_completed = False
    report = {}
    try:
        # Build + start instance container (instance image should already be built)
        container = build_container(
            test_spec, client, run_id, logger, rm_image, force_rebuild
        )
        container.start()
        logger.info(f"Container for {instance_id} started: {container.id}")

        # Copy model prediction as patch file to container
        patch_file = Path(log_dir / "patch.diff")
        patch_file.write_text(pred[KEY_PREDICTION] or "")
        logger.info(
            f"Intermediate patch for {instance_id} written to {patch_file}, now applying to container..."
        )
        copy_to_container(container, patch_file, PurePosixPath(DOCKER_PATCH))

        # Attempt to apply patch to container (TODO: FIX THIS)
        applied_patch = False
        for git_apply_cmd in GIT_APPLY_CMDS:
            val = container.exec_run(
                f"{git_apply_cmd} {DOCKER_PATCH}",
                workdir=DOCKER_WORKDIR,
                user=DOCKER_USER,
            )
            if val.exit_code == 0:
                logger.info(f"{APPLY_PATCH_PASS}:\n{val.output.decode(UTF8)}")
                applied_patch = True
                break
            else:
                logger.info(f"Failed to apply patch to container: {git_apply_cmd}")
        if not applied_patch:
            logger.info(f"{APPLY_PATCH_FAIL}:\n{val.output.decode(UTF8)}")
            raise EvaluationError(
                instance_id,
                f"{APPLY_PATCH_FAIL}:\n{val.output.decode(UTF8)}",
                logger,
            )

        # Get git diff before running eval script
        git_diff_output_before = (
            container.exec_run(
                "git -c core.fileMode=false diff", workdir=DOCKER_WORKDIR
            )
            .output.decode(UTF8)
            .strip()
        )
        logger.info(f"Git diff before:\n{git_diff_output_before}")

        eval_file = Path(log_dir / "eval.sh")
        eval_file.write_text(test_spec.eval_script)
        logger.info(
            f"Eval script for {instance_id} written to {eval_file}; copying to container..."
        )
        copy_to_container(container, eval_file, PurePosixPath("/eval.sh"))

        # Run eval script, write output to logs
        test_output, timed_out, total_runtime = exec_run_with_timeout(
            container, "/bin/bash /eval.sh", timeout
        )
        test_output_path = log_dir / LOG_TEST_OUTPUT
        logger.info(f"Test runtime: {total_runtime:_.2f} seconds")
        with open(test_output_path, "w") as f:
            f.write(test_output)
            logger.info(f"Test output for {instance_id} written to {test_output_path}")
            if timed_out:
                f.write(f"\n\nTimeout error: {timeout} seconds exceeded.")
                raise EvaluationError(
                    instance_id,
                    f"Test timed out after {timeout} seconds.",
                    logger,
                )

        # Get git diff after running eval script (ignore permission changes)
        git_diff_output_after = (
            container.exec_run(
                "git -c core.fileMode=false diff", workdir=DOCKER_WORKDIR
            )
            .output.decode(UTF8)
            .strip()
        )

        # Check if git diff changed after running eval script
        logger.info(f"Git diff after:\n{git_diff_output_after}")
        if git_diff_output_after != git_diff_output_before:
            logger.info("Git diff changed after running eval script")

        # Get report from test output
        logger.info(f"Grading answer for {instance_id}...")
        report = get_eval_report(
            test_spec=test_spec,
            prediction=pred,
            test_log_path=test_output_path,
            include_tests_status=True,
        )
        logger.info(
            f"report: {report}\n"
            f"Result for {instance_id}: resolved: {report[instance_id]['resolved']}"
        )

        # Write report to report.json
        with open(report_path, "w") as f:
            f.write(json.dumps(report, indent=4))
        eval_completed = True
    except (EvaluationError, BuildImageError) as e:
        error_msg = traceback.format_exc()
        logger.info(error_msg)
        print(e)
    except Exception as e:
        error_msg = (
            f"Error in evaluating model for {instance_id}: {e}\n"
            f"{traceback.format_exc()}\n"
            f"Check ({logger.log_file}) for more information."
        )
        logger.error(error_msg)
    finally:
        # Remove instance container + image, close logger
        cleanup_container(client, container, logger)
        if rm_image:
            remove_image(client, test_spec.instance_image_key, logger)
        close_logger(logger)
        return {
            "completed": eval_completed,
            "resolved": report.get(instance_id, {}).get("resolved", False),
        }


def run_instances(
    predictions: dict,
    instances: list,
    cache_level: str,
    clean: bool,
    force_rebuild: bool,
    max_workers: int,
    run_id: str,
    timeout: int,
    namespace: str | None = "swebench",
    instance_image_tag: str = "latest",
    env_image_tag: str = "latest",
    rewrite_reports: bool = False,
):
    """
    Run all instances for the given predictions in parallel.

    Args:
        predictions (dict): Predictions dict generated by the model
        instances (list): List of instances
        cache_level (str): Cache level
        clean (bool): Clean images above cache level
        force_rebuild (bool): Force rebuild images
        max_workers (int): Maximum number of workers
        run_id (str): Run ID
        timeout (int): Timeout for running tests
    """
    client = docker.from_env()
    test_specs = list(
        map(
            lambda instance: make_test_spec(
                instance,
                namespace=namespace,
                instance_image_tag=instance_image_tag,
                env_image_tag=env_image_tag,
            ),
            instances,
        )
    )

    # print number of existing instance images
    instance_image_ids = {x.instance_image_key for x in test_specs}
    existing_images = {
        tag
        for i in client.images.list(all=True)
        for tag in i.tags
        if tag in instance_image_ids
    }
    if not force_rebuild and len(existing_images):
        print(
            f"Found {len(existing_images)} existing instance images. Will reuse them."
        )

    # run instances in parallel
    payloads = []
    for test_spec in test_specs:
        payloads.append(
            (
                test_spec,
                predictions[test_spec.instance_id],
                should_remove(
                    test_spec.instance_image_key,
                    cache_level,
                    clean,
                    existing_images,
                ),
                force_rebuild,
                client,
                run_id,
                timeout,
                rewrite_reports,
            )
        )

    # run instances in parallel
    print(f"Running {len(instances)} instances...")
    stats = {"✓": 0, "✖": 0, "error": 0}
    pbar = tqdm(total=len(payloads), desc="Evaluation", postfix=stats)
    lock = threading.Lock()

    def run_evaluation_with_progress(*args):
        result = run_instance(*args)
        with lock:
            if result["completed"]:
                if result["resolved"]:
                    stats["✓"] += 1
                else:
                    stats["✖"] += 1
            else:
                stats["error"] += 1
            pbar.set_postfix(stats)
            pbar.update()
        return result

    run_threadpool(run_evaluation_with_progress, payloads, max_workers)
    print("All instances run.")


def get_dataset_from_preds(
    dataset_name: str,
    split: str,
    instance_ids: list,
    predictions: dict,
    run_id: str,
    rewrite_reports: bool,
    exclude_completed: bool = True,
):
    """
    Return only instances that have predictions and are in the dataset.
    If instance_ids is provided, only return instances with those IDs.
    If exclude_completed is True, only return instances that have not been run yet.
    """
    # load dataset
    dataset = load_swebench_dataset(dataset_name, split)
    dataset_ids = {i[KEY_INSTANCE_ID] for i in dataset}

    if instance_ids:
        # check that all instance IDs have predictions
        missing_preds = set(instance_ids) - set(predictions.keys())
        if missing_preds:
            print(
                f"Warning: Missing predictions for {len(missing_preds)} instance IDs."
            )

    # check that all prediction IDs are in the dataset
    prediction_ids = set(predictions.keys())
    if prediction_ids - dataset_ids:
        raise ValueError(
            (
                "Some prediction IDs not found in dataset!"
                f"\nMissing IDs:\n{' '.join(prediction_ids - dataset_ids)}"
            )
        )
    if instance_ids:
        dataset = [i for i in dataset if i[KEY_INSTANCE_ID] in instance_ids]

    if rewrite_reports:
        # we only return instances that have existing test outputs
        test_output_ids = set()
        for instance in dataset:
            if instance[KEY_INSTANCE_ID] not in predictions:
                continue
            prediction = predictions[instance[KEY_INSTANCE_ID]]
            test_output_file = (
                RUN_EVALUATION_LOG_DIR
                / run_id
                / prediction["model_name_or_path"].replace("/", "__")
                / prediction[KEY_INSTANCE_ID]
                / "test_output.txt"
            )
            if test_output_file.exists():
                test_output_ids.add(instance[KEY_INSTANCE_ID])
        dataset = [
            i
            for i in dataset
            if i[KEY_INSTANCE_ID] in prediction_ids
            and i[KEY_INSTANCE_ID] in test_output_ids
        ]
        return dataset

    # check which instance IDs have already been run
    completed_ids = set()
    for instance in dataset:
        if instance[KEY_INSTANCE_ID] not in prediction_ids:
            # skip instances without predictions
            continue
        prediction = predictions[instance[KEY_INSTANCE_ID]]
        report_file = (
            RUN_EVALUATION_LOG_DIR
            / run_id
            / prediction[KEY_MODEL].replace("/", "__")
            / prediction[KEY_INSTANCE_ID]
            / LOG_REPORT
        )
        if report_file.exists():
            completed_ids.add(instance[KEY_INSTANCE_ID])

    if completed_ids and exclude_completed:
        # filter dataset to only instances that have not been run
        print(f"{len(completed_ids)} instances already run, skipping...")
        dataset = [i for i in dataset if i[KEY_INSTANCE_ID] not in completed_ids]

    empty_patch_ids = {
        k
        for k, v in predictions.items()
        if v[KEY_PREDICTION] == "" or v[KEY_PREDICTION] is None
    }

    # filter dataset to only instances with predictions
    dataset = [
        i
        for i in dataset
        if i[KEY_INSTANCE_ID] in prediction_ids
        and i[KEY_INSTANCE_ID] not in empty_patch_ids
    ]
    return dataset


def main(
    dataset_name: str,
    split: str,
    instance_ids: list,
    predictions_path: str,
    max_workers: int,
    force_rebuild: bool,
    cache_level: str,
    clean: bool,
    open_file_limit: int,
    run_id: str,
    timeout: int,
    namespace: str | None,
    rewrite_reports: bool,
    modal: bool,
    instance_image_tag: str = "latest",
    env_image_tag: str = "latest",
    report_dir: str = ".",
):
    """
    Run evaluation harness for the given dataset and predictions.
    """
    if dataset_name == "SWE-bench/SWE-bench_Multimodal" and split == "test":
        print(
            "⚠️ Local evaluation for the test split of SWE-bench Multimodal is not supported. "
            "Please check out sb-cli (https://github.com/swe-bench/sb-cli/) for instructions on how to submit predictions."
        )
        return

    # set open file limit
    assert len(run_id) > 0, "Run ID must be provided"
    if report_dir is not None:
        report_dir = Path(report_dir)
        if not report_dir.exists():
            report_dir.mkdir(parents=True)

    if force_rebuild and namespace is not None:
        raise ValueError("Cannot force rebuild and use a namespace at the same time.")

    # load predictions as map of instance_id to prediction
    predictions = get_predictions_from_file(predictions_path, dataset_name, split)
    predictions = {pred[KEY_INSTANCE_ID]: pred for pred in predictions}

    # get dataset from predictions
    dataset = get_dataset_from_preds(
        dataset_name, split, instance_ids, predictions, run_id, rewrite_reports
    )
    full_dataset = load_swebench_dataset(dataset_name, split, instance_ids)

    if modal:
        # run instances on Modal
        if not dataset:
            print("No instances to run.")
        else:
            validate_modal_credentials()
            run_instances_modal(predictions, dataset, full_dataset, run_id, timeout)
        return

    # run instances locally
    if platform.system() == "Linux":
        resource.setrlimit(resource.RLIMIT_NOFILE, (open_file_limit, open_file_limit))
    client = docker.from_env()

    existing_images = list_images(client)
    if not dataset:
        print("No instances to run.")
    else:
        # build environment images + run instances
        if namespace is None and not rewrite_reports:
            build_env_images(
                client,
                dataset,
                force_rebuild,
                max_workers,
                namespace,
                instance_image_tag,
                env_image_tag,
            )
        run_instances(
            predictions,
            dataset,
            cache_level,
            clean,
            force_rebuild,
            max_workers,
            run_id,
            timeout,
            namespace=namespace,
            instance_image_tag=instance_image_tag,
            env_image_tag=env_image_tag,
            rewrite_reports=rewrite_reports,
        )

    # clean images + make final report
    clean_images(client, existing_images, cache_level, clean)
    return make_run_report(
        predictions,
        full_dataset,
        run_id,
        client,
        namespace,
        instance_image_tag,
        env_image_tag,
    )


if __name__ == "__main__":
    parser = ArgumentParser(
        description="Run evaluation harness for the given dataset and predictions.",
        formatter_class=ArgumentDefaultsHelpFormatter,
    )

    # Common args
    parser.add_argument(
        "-d",
        "--dataset_name",
        default="SWE-bench/SWE-bench_Lite",
        type=str,
        help="Name of dataset or path to JSON file.",
    )
    parser.add_argument(
        "-s", "--split", type=str, default="test", help="Split of the dataset"
    )
    parser.add_argument(
        "-i",
        "--instance_ids",
        nargs="+",
        type=str,
        help="Instance IDs to run (space separated)",
    )
    parser.add_argument(
        "-p",
        "--predictions_path",
        type=str,
        help="Path to predictions file - if 'gold', uses gold predictions",
        required=True,
    )

    # Local execution args
    parser.add_argument(
        "--max_workers",
        type=int,
        default=4,
        help="Maximum number of workers (should be <= 75%% of CPU cores)",
    )
    parser.add_argument(
        "--open_file_limit", type=int, default=4096, help="Open file limit"
    )
    parser.add_argument(
        "-t",
        "--timeout",
        type=int,
        default=1_800,
        help="Timeout (in seconds) for running tests for each instance",
    )
    parser.add_argument(
        "--force_rebuild",
        type=str2bool,
        default=False,
        help="Force rebuild of all images",
    )
    parser.add_argument(
        "--cache_level",
        type=str,
        choices=["none", "base", "env", "instance"],
        help="Cache level - remove images above this level",
        default="env",
    )
    # if clean is true then we remove all images that are above the cache level
    # if clean is false, we only remove images above the cache level if they don't already exist
    parser.add_argument(
        "--clean", type=str2bool, default=False, help="Clean images above cache level"
    )
    parser.add_argument(
        "-id", "--run_id", type=str, required=True, help="Run ID - identifies the run"
    )
    parser.add_argument(
        "-n",
        "--namespace",
        type=optional_str,
        default="swebench",
        help='Namespace for images. (use "none" to use no namespace)',
    )
    parser.add_argument(
        "--instance_image_tag", type=str, default="latest", help="Instance image tag"
    )
    parser.add_argument(
        "--env_image_tag", type=str, default="latest", help="Environment image tag"
    )
    parser.add_argument(
        "--rewrite_reports",
        type=str2bool,
        default=False,
        help="Doesn't run new instances, only writes reports for instances with existing test outputs",
    )
    parser.add_argument(
        "--report_dir", type=str, default=".", help="Directory to write reports to"
    )

    # Modal execution args
    parser.add_argument("--modal", type=str2bool, default=False, help="Run on Modal")

    args = parser.parse_args()
    main(**vars(args))
