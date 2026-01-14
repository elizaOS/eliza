"""If for some reason the .pred file isn't saved, we can extract it from the .traj file."""

import argparse
import json
from pathlib import Path


def run_from_cli(_args: list[str] | None = None):
    parser = argparse.ArgumentParser()
    parser.add_argument("traj_path", type=Path)
    args = parser.parse_args(_args)
    data = json.loads(args.traj_path.read_text())
    pred_path = args.traj_path.with_suffix(".pred")
    pred_data = {
        "model_name_or_path": args.traj_path.resolve().parent.parent.name,
        "model_patch": data["info"]["submission"],
        "instance_id": args.traj_path.resolve().parent.name,
    }
    pred_path.write_text(json.dumps(pred_data))
