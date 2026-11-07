import json

import pytest

from eliza_training.lib.jsonl_transform import transform_jsonl


def test_in_place_preserves_complete_payload_and_order(tmp_path):
    path = tmp_path / "rows.jsonl"
    payload = "complete response " * 10000
    path.write_text(json.dumps({"payload": payload}) + "\n{}\n")
    stats = transform_jsonl(path, path, lambda row, index, _: {**row, "index": index})
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    assert rows == [{"payload": payload, "index": 0}, {"index": 1}]
    assert stats["total"] == 2


@pytest.mark.parametrize("invalid", ["bad json", "[]", '{"format":"eliza_native_v1"}'])
def test_failure_preserves_existing_destination_and_removes_temp(tmp_path, invalid):
    source = tmp_path / "source.jsonl"
    destination = tmp_path / "destination.jsonl"
    source.write_text("{}\n" + invalid + "\n")
    destination.write_text("original\n")
    with pytest.raises(ValueError, match=":2:"):
        transform_jsonl(source, destination, lambda row, *_: row)
    assert destination.read_text() == "original\n"
    assert set(tmp_path.iterdir()) == {source, destination}
