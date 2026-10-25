"""Keep complete trajectories and duplicate boundaries in the same dataset split."""

from collections import defaultdict
from typing import Any

SUCCESS_SPLITS = ("train", "val", "test")


def isolate_success_splits(
    splits: dict[str, list[dict[str, Any]]], *, val_ratio: float, test_ratio: float
) -> list[dict[str, str]]:
    rows = [row for split in SUCCESS_SPLITS for row in splits[split]]
    parents = list(range(len(rows)))

    def find(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    owners: dict[tuple[str, str], int] = {}
    for index, row in enumerate(rows):
        source = row.get("source") or {}
        metadata = row.get("metadata") or {}
        keys = [("content", metadata.get("contentHash"))]
        keys.extend(
            ("trajectory", str(value))
            for value in metadata.get("splitTrajectoryIds", [])
        )
        trajectory = source.get("trajectoryId")
        if trajectory:
            keys.append(("trajectory", str(trajectory)))
        elif source.get("scenarioId"):
            keys.append(
                (
                    "scenario",
                    str(source.get("dataset")) + ":" + str(source["scenarioId"]),
                )
            )
        for kind, value in keys:
            if value:
                key = (kind, str(value))
                if key in owners:
                    parents[find(index)] = find(owners[key])
                else:
                    owners[key] = index
    groups: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for index, row in enumerate(rows):
        groups[find(index)].append(row)
    assigned: dict[str, list[list[dict[str, Any]]]] = {
        key: [] for key in SUCCESS_SPLITS
    }
    pinned: set[int] = set()
    for group in groups.values():
        requested = {row.get("metadata", {}).get("requestedSplit") for row in group} - {
            None,
            "",
        }
        if requested - set(SUCCESS_SPLITS):
            raise ValueError(f"Invalid explicit success split: {sorted(requested)}")
        if len(requested) > 1:
            raise ValueError(
                "Conflicting explicit splits for duplicate content or the same trajectory"
            )
        if requested:
            split = next(iter(requested))
            pinned.add(id(group))
        else:
            split = min(group, key=lambda row: str(row.get("id", "")))["split"]
        assigned[split].append(group)
    requested_splits = (
        ["train"]
        + (["val"] if val_ratio > 0 else [])
        + (["test"] if test_ratio > 0 else [])
    )
    for target in requested_splits:
        if assigned[target]:
            continue
        donors = [
            key
            for key in SUCCESS_SPLITS
            if len(assigned[key]) > 1
            and any(id(group) not in pinned for group in assigned[key])
        ]
        if not donors:
            continue
        donor = max(donors, key=lambda key: (len(assigned[key]), key))
        movable = [group for group in assigned[donor] if id(group) not in pinned]
        group = max(
            movable, key=lambda group: max(str(row.get("id", "")) for row in group)
        )
        assigned[donor].remove(group)
        assigned[target].append(group)
    moves = []
    for split, groups_for_split in assigned.items():
        splits[split] = []
        for group in groups_for_split:
            for row in group:
                if row["split"] != split:
                    moves.append(
                        {
                            "id": str(row.get("id", "")),
                            "from": row["split"],
                            "to": split,
                        }
                    )
                row["split"] = split
                splits[split].append(row)
    return moves
