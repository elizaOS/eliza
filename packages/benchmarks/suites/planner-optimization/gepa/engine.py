"""Pinned upstream GEPA engine; runtime evaluation/reflection stay with the host."""
import contextlib
import importlib.metadata
import json
import sys
import threading

ARCHIVE_SHA256 = "73c61c6a1793dcfc38fa1f2c0323dd961b575b464facf43161ad5daea9ed0c8d"
metadata = json.loads(importlib.metadata.distribution("gepa").read_text("direct_url.json") or "{}")
if metadata.get("archive_info", {}).get("hashes", {}).get("sha256") != ARCHIVE_SHA256:
    raise RuntimeError("GEPA installation does not match the pinned upstream archive")

from gepa.optimize_anything import OptimizeAnythingConfig, optimize_anything

transport = sys.stdout
lock = threading.Lock()
sequence = 0

def request(method, payload):
    global sequence
    with lock:
        sequence += 1
        transport.write(json.dumps({"id": sequence, "method": method, "payload": payload}, allow_nan=False) + "\n")
        transport.flush()
        line = sys.stdin.readline()
        if not line:
            raise RuntimeError("Optimizer host disconnected")
        response = json.loads(line)
        if response.get("id") != sequence or "error" in response:
            raise RuntimeError(response.get("error", "Optimizer response identity mismatch"))
        return response["result"]

def main():
    config = json.loads(sys.stdin.readline())
    def evaluate(candidate, example):
        result = request("evaluate", {"instruction": candidate["instruction"], "caseId": example["id"]})
        return result["score"], result["diagnostics"]
    def reflect(prompt):
        return request("reflect", {"prompt": prompt})
    with contextlib.redirect_stdout(sys.stderr):
        result = optimize_anything(
            seed_candidate={"instruction": config["baseline"]},
            evaluator=evaluate,
            dataset=config["train"],
            valset=config["validation"],
            test_set=config["test"],
            objective=config["objective"],
            config=OptimizeAnythingConfig(
                engine="gepa", max_evals=config["maxEvals"], max_concurrency=1,
                output_dir=config["outputDir"],
                engine_config={
                    "engine": {"seed": config["seed"], "parallel": False,
                               "use_cloudpickle": False, "raise_on_exception": True,
                               "max_candidate_proposals": config["maxProposals"]},
                    "reflection": {"reflection_lm": reflect, "reflection_minibatch_size": 1},
                },
            ),
        )
    transport.write(json.dumps({"method": "result", "payload": {
        "bestCandidate": result.best_candidate, "bestScore": result.best_score,
        "candidates": result.candidates, "validationScores": result.val_aggregate_scores,
        "bestIndex": result.best_idx, "totalEvaluations": result.total_evals,
        "metadata": result.metadata,
    }}, allow_nan=False) + "\n")
    transport.flush()

if __name__ == "__main__":
    main()
