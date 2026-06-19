import json
import subprocess


def test_collect_smoke_test():
    cmd = ["python", "-m", "swebench.collect.print_pulls", "--help"]
    result = subprocess.run(cmd, capture_output=True)
    print(result.stdout)
    print(result.stderr)
    assert result.returncode == 0


def test_collect_one(tmp_path):
    cmd = [
        "python",
        "-m",
        "swebench.collect.print_pulls",
        "pvlib/pvlib-python",
        str(tmp_path / "out.txt"),
        "--max_pulls",
        "1",
    ]
    print(" ".join(cmd))
    result = subprocess.run(cmd, capture_output=True)
    print(result.stdout)
    print(result.stderr)
    assert result.returncode == 0


def test_collect_ds(tmp_path):
    cmd = [
        "python",
        "-m",
        "swebench.collect.build_dataset",
        "tests/test_data/pvlib.jsonl",
        str(tmp_path / "out.jsonl"),
    ]
    print(" ".join(cmd))
    result = subprocess.run(cmd, capture_output=True)
    print(result.stdout)
    print(result.stderr)
    assert result.returncode == 0


def test_collect_get_issues(tmp_path):
    # python print_pulls.py lowRISC/opentitan output_pr_26371.json --pull_number 26371
    cmd = [
        "python",
        "-m",
        "swebench.collect.print_pulls",
        "lowRISC/opentitan",
        str(tmp_path / "output_pr_26371.json"),
        "--pull_number",
        "26371",
    ]
    print(" ".join(cmd))
    result = subprocess.run(cmd, capture_output=True)
    print(result.stdout)
    print(result.stderr)
    assert result.returncode == 0
    data = json.loads((tmp_path / "output_pr_26371.json").read_text())
    assert len(data["resolved_issues"]) == 2
    assert sorted(data["resolved_issues"]) == ["26194", "26230"]
