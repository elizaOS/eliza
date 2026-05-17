# SWE-bench Evaluation
John Yang &bull; November 6, 2023 (Updated Feb. 4, 2025)

In this tutorial, we will explain how to evaluate models and methods using SWE-bench.

## 🤖 Creating Predictions
For each task instance of the SWE-bench dataset, given an issue (`problem_statement`) + codebase (`repo` + `base_commit`), your model should attempt to write a diff patch prediction. For full details on the SWE-bench task, please refer to Section 2 of the main paper.

Each prediction must be formatted as follows:
```json
{
    "instance_id": "<Unique task instance ID>",
    "model_patch": "<.patch file content string>",
    "model_name_or_path": "<Model name here (i.e. SWE-Llama-13b)>",
}
```

Store multiple predictions in a `.json` file formatted as `[<prediction 1>, <prediction 2>,... <prediction n>]`. It is not necessary to generate predictions for every task instance.

If you'd like examples, the [swe-bench/experiments](https://github.com/swe-bench/experiments) GitHub repository contains many examples of well formed patches.

## 🔄 Running Evaluation
Evaluate model predictions on the test split of SWE-bench Lite using the evaluation harness with the following command:
```bash
python -m swebench.harness.run_evaluation \
    --dataset_name princeton-nlp/SWE-bench_Lite \
    --predictions_path <path_to_predictions> \
    --max_workers <num_workers> \
    --run_id <run_id>
    # use --predictions_path 'gold' to verify the gold patches
    # use --run_id to name the run, logs will be written to ./logs/run_evaluation/<run_id>
    # use --split to specify which split to evaluate on, usually `dev` or `test`
    # use --modal true to run on Modal
```

You can run evaluation for the following (`dataset_name`, `split`)
* `princeton-nlp/SWE-bench_Lite`, `test` (300 task instances)
* `princeton-nlp/SWE-bench_Verified`, `test` (500)
* `princeton-nlp/SWE-bench`, `dev` (225)
* `princeton-nlp/SWE-bench`, `test` (2294)
* `princeton-nlp/SWE-bench_Multimodal`, `dev` (102)

You *cannot* run evaluation on the `test` split of `princeton-nlp/SWE-bench_Multimodal` using this repository (517 instances).
To encourage less intentional climbing of the leaderboard, we have intentionally made specifications for evaluating the test split private.
Use [sb-cli](https://github.com/swe-bench/sb-cli/) for SWE-bench Multimodal evaluation.

### 🌩️ Evaluation with Modal
You can also run evaluations entirely on the cloud using [Modal](https://modal.com/) to avoid local setup and resource constraints:
```bash
python -m swebench.harness.run_evaluation \
    --predictions_path gold \
    --run_id validate-gold-modal \
    --instance_ids sympy__sympy-20590 \
    --modal true
```
This will execute the evaluation harness on Modal's cloud infrastructure, eliminating the need for local Docker setup and resource management.

> [!NOTE]
> Modal for SWE-bench Multimodal is currently experimental and may not be fully supported yet.
