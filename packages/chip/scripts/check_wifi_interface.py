#!/usr/bin/env python3
import sys
from pathlib import Path

import yaml

REQUIRED_GROUPS = {
    "sdio": {
        "WIFI_SDIO_CLK",
        "WIFI_SDIO_CMD",
        "WIFI_SDIO_D0",
        "WIFI_SDIO_D1",
        "WIFI_SDIO_D2",
        "WIFI_SDIO_D3",
    },
    "control": {"WIFI_EN", "WIFI_RST_N"},
    "wake_irq": {"WIFI_HOST_WAKE", "WIFI_IRQ"},
    "bluetooth_uart": {"BT_UART_TX", "BT_UART_RX", "BT_UART_CTS_N", "BT_UART_RTS_N"},
}

REQUIRED_INTEGRATION_STATE = {
    "rtl_host_controller": "not_implemented",
    "padframe_bonding": "not_bonded_in_e1_chip",
    "firmware_driver": "not_implemented",
    "rf_certification": "module_and_board_responsibility",
}

REFERENCE_MODULE = "package/wifi/murata-1dx-sdio.yaml"
REFERENCE_SIGNALS = {
    "WIFI_SDIO_CLK",
    "WIFI_SDIO_CMD",
    "WIFI_SDIO_D0",
    "WIFI_SDIO_D1",
    "WIFI_SDIO_D2",
    "WIFI_SDIO_D3",
    "WIFI_EN",
    "WIFI_RST_N",
    "WIFI_HOST_WAKE",
    "WIFI_IRQ",
    "BT_UART_TX",
    "BT_UART_RX",
    "BT_UART_CTS_N",
    "BT_UART_RTS_N",
}

ALLOWED_DIRECTIONS = {"input", "output", "bidirectional"}
ALLOWED_PULLS = {"none", "up", "down"}
ALLOWED_RESETS = {"input", "low", "high"}


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    path = root / "package/wifi-external-interface.yaml"
    contract = yaml.safe_load(path.read_text())
    failures: list[str] = []

    if contract.get("io_voltage") != "1.8V":
        failures.append("WiFi interface must default to 1.8V IO")
    if contract.get("regulatory_boundary") != "module_and_board":
        failures.append("regulatory boundary must stay with module_and_board")
    if contract.get("status") != "product_scaffold_not_bonded_in_e1_chip":
        failures.append(
            "status must stay product_scaffold_not_bonded_in_e1_chip until pins are bonded"
        )

    reference = contract.get("reference_module", {})
    if reference.get("integration_file") != REFERENCE_MODULE:
        failures.append(f"reference_module.integration_file must be {REFERENCE_MODULE}")
    if reference.get("linux_wifi_driver") != "brcmfmac":
        failures.append("reference module must name brcmfmac as the Linux WiFi driver")
    if reference.get("commitment") != "reference_integration_slice_not_committed_bom":
        failures.append("reference module must remain a non-BOM reference slice")

    integration_state = contract.get("integration_state", {})
    for key, expected in REQUIRED_INTEGRATION_STATE.items():
        if integration_state.get(key) != expected:
            failures.append(f"integration_state.{key} must be {expected}")

    groups = contract.get("groups", {})
    for group, required_names in REQUIRED_GROUPS.items():
        signals = groups.get(group, {}).get("signals", [])
        names = {signal.get("name") for signal in signals}
        missing = sorted(required_names - names)
        if missing:
            failures.append(f"{group}: missing signals {', '.join(missing)}")

    all_names: list[str] = []
    for group, data in groups.items():
        if not isinstance(data, dict):
            failures.append(f"{group}: group entry must be a mapping")
            continue
        signals = data.get("signals", [])
        if not isinstance(signals, list):
            failures.append(f"{group}: signals must be a list")
            continue
        for signal in signals:
            if not isinstance(signal, dict):
                failures.append(f"{group}: signal entries must be mappings")
                continue
            name = signal.get("name", "<unnamed>")
            all_names.append(name)
            if signal.get("direction") not in ALLOWED_DIRECTIONS:
                failures.append(f"{name}: invalid direction {signal.get('direction')}")
            if signal.get("pull") not in ALLOWED_PULLS:
                failures.append(f"{name}: invalid pull {signal.get('pull')}")
            if signal.get("reset") not in ALLOWED_RESETS:
                failures.append(f"{name}: invalid reset {signal.get('reset')}")

    duplicates = sorted({name for name in all_names if all_names.count(name) > 1})
    if duplicates:
        failures.append("duplicate signal names: " + ", ".join(duplicates))

    module_path = root / REFERENCE_MODULE
    if not module_path.is_file():
        failures.append(f"{REFERENCE_MODULE} is missing")
    else:
        module = yaml.safe_load(module_path.read_text())
        if module.get("radio_claim") != "external_module_only":
            failures.append("reference module must keep radio_claim external_module_only")
        support = module.get("linux_support", {})
        if support.get("wifi_driver") != "brcmfmac":
            failures.append("reference module must use brcmfmac WiFi support")
        if support.get("bluetooth_driver") != "hci_uart_bcm":
            failures.append("reference module must use hci_uart_bcm Bluetooth support")
        module_text = module_path.read_text()
        missing_reference_signals = sorted(
            name for name in REFERENCE_SIGNALS if name not in module_text
        )
        if missing_reference_signals:
            failures.append(
                "reference module is missing signals: " + ", ".join(missing_reference_signals)
            )

    board_requirements = contract.get("board_requirements", [])
    required_phrases = ["RF", "antenna", "disabled"]
    joined = " ".join(board_requirements)
    for phrase in required_phrases:
        if phrase not in joined:
            failures.append(f"board_requirements must mention {phrase}")

    gates = contract.get("maturity_gates_before_product_claim", [])
    required_gate_terms = ["module", "SDIO host controller", "padframe", "driver"]
    gate_text = " ".join(gates)
    for term in required_gate_terms:
        if term not in gate_text:
            failures.append(f"maturity gates must mention {term}")

    doc = (root / "docs/arch/wifi.md").read_text()
    if "package/wifi-external-interface.yaml" not in doc:
        failures.append("docs/arch/wifi.md must reference the machine-readable WiFi contract")
    for phrase in ("not bonded", "not available", "maturity gates"):
        if phrase not in doc:
            failures.append(f"docs/arch/wifi.md must state {phrase}")
    for phrase in ("Murata Type 1DX", "brcmfmac", "hci_uart_bcm", "external"):
        if phrase not in doc:
            failures.append(f"docs/arch/wifi.md must describe concrete slice term {phrase}")

    dts = (root / "sw/linux/dts/eliza-e1.dts").read_text()
    for phrase in (
        "mmc-pwrseq-simple",
        "brcm,bcm4329-fmac",
        "brcm,bcm43438-bt",
        'status = "disabled"',
    ):
        if phrase not in dts:
            failures.append(f"Linux DTS WiFi/Bluetooth stub must include {phrase}")

    linux_fragment = (root / "sw/buildroot/board/eliza/e1/linux.fragment").read_text()
    for phrase in ("CONFIG_BRCMFMAC", "CONFIG_BRCMFMAC_SDIO", "CONFIG_BT_HCIUART_BCM"):
        if phrase not in linux_fragment:
            failures.append(f"Buildroot Linux fragment must enable {phrase}")

    adapter_path = root / "board/fpga/package/wifi_external_module_adapter.yaml"
    if not adapter_path.is_file():
        failures.append("board/fpga/package/wifi_external_module_adapter.yaml is missing")
    else:
        adapter_text = adapter_path.read_text()
        for phrase in REFERENCE_SIGNALS:
            if phrase not in adapter_text:
                failures.append(f"FPGA WiFi adapter stub must mention {phrase}")

    constraints = (root / "board/fpga/constraints/e1_demo_ulx3s.lpf").read_text()
    for phrase in ("WIFI_SDIO_CLK", "BT_UART_TX", "1.8 V", "Do not assign RF"):
        if phrase not in constraints:
            failures.append(f"FPGA constraints must reserve WiFi term {phrase}")

    if failures:
        print("WiFi interface contract check failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print("WiFi interface contract ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
