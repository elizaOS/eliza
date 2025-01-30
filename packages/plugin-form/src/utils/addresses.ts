import type { Address } from "viem";
import formtTestnet from "../chains/form.testnet";
import form from "../chains/form";

export type CurvesType = "QUADRATIC" | "LOGARITHMIC";

const CURVES_ADDRESSES: Record<number, Record<CurvesType, Address>> = {
    [formtTestnet.id]: {
        QUADRATIC: "0x3e4A86563f0a6688378a692e3D2a9651F4b704e9",
        LOGARITHMIC: "0xf2456EaD628da381f5c37e85B4B469B92B433fE8",
    },
    [form.id]: {
        QUADRATIC: "0xEad4138380B508949Ccd48B97AD930bd89aAb719",
        LOGARITHMIC: "0x88c7484d19E49B09233484824698a5214d81f866",
    },
};

export { CURVES_ADDRESSES };
