import docker
import json

from argparse import ArgumentParser

"""
Script for removing containers associated with specified instance IDs.
"""


def main(instance_ids, predictions_path):
    all_ids = set()
    if predictions_path:
        with open(predictions_path, "r") as f:
            predictions = json.loads(f.read())
            for pred in predictions:
                all_ids.add(pred["instance_id"])

    if instance_ids:
        all_ids |= set(instance_ids)

    if not all_ids:
        print("No instance IDs provided, exiting.")
        return

    for instance_id in all_ids:
        try:
            client = docker.from_env()
            container = client.containers.get(f"sweb.eval.{instance_id}")
            container.stop()
            container.remove()
            print(f"Removed container {instance_id}")
        except docker.errors.NotFound:
            print(f"Container {instance_id} not found, skipping.")
        except Exception as e:
            print(f"Error removing container {instance_id}: {e}")
            continue


if __name__ == "__main__":
    parser = ArgumentParser(description=__doc__)
    parser.add_argument(
        "--instance_ids",
        help="Instance IDs to remove containers for",
    )
    parser.add_argument(
        "--predictions_path",
        help="Path to predictions file",
    )
    args = parser.parse_args()
    instance_ids = (
        [i.strip() for i in args.instance_ids.split(",")] if args.instance_ids else []
    )
    main(
        instance_ids=instance_ids,
        predictions_path=args.predictions_path,
    )
