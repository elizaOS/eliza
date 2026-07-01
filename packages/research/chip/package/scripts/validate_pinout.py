import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text()
try:
    import yaml

    data = yaml.safe_load(text)
except ModuleNotFoundError:
    import ast
    import re

    pins = []
    for line in text.splitlines():
        match = re.match(r"\s*-\s*(\{.*\})\s*$", line)
        if not match:
            continue
        item = match.group(1)
        item = re.sub(r"([,{]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)", r'\1"\2"\3', item)
        item = re.sub(r":\s*([^,\}][^,\}]*)", lambda m: ": " + repr(m.group(1).strip()), item)
        pins.append(ast.literal_eval(item))
    data = {"pins": pins}
pins = data.get("pins", [])

required = {
    "pin",
    "name",
    "direction",
    "pad_type",
    "voltage_domain",
    "reset",
    "pull",
    "drive",
    "board_net",
}
seen_nums = set()
seen_names = set()

for entry in pins:
    missing = required - set(entry)
    if missing:
        raise SystemExit(f"{entry} missing {sorted(missing)}")
    if entry["pin"] in seen_nums:
        raise SystemExit(f"duplicate pin number {entry['pin']}")
    if entry["name"] in seen_names:
        raise SystemExit(f"duplicate pin name {entry['name']}")
    seen_nums.add(entry["pin"])
    seen_names.add(entry["name"])

if len(pins) != 64:
    raise SystemExit(f"expected 64 pins, found {len(pins)}")

required_names = {"CLK_IN", "RST_N", "DBG_VALID", "DBG_WRITE", "DBG_READY", "GPIO0", "IRQ_NPU"}
missing_names = required_names - seen_names
if missing_names:
    raise SystemExit(f"missing required signal names {sorted(missing_names)}")

print(f"pinout ok: {path}")
