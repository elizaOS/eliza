import BigNumber from "bignumber.js";

BigNumber.config({ ROUNDING_MODE: BigNumber.ROUND_FLOOR });

type PayloadType = {
    amount: string;
    decimals: number;
};

export const denominateAmount = ({ amount, decimals }: PayloadType) => {
    return new BigNumber(amount)
        .shiftedBy(decimals)
        .decimalPlaces(0)
        .toFixed(0);
};

export const getRawAmount = ({ amount, decimals }: PayloadType) => {
    return new BigNumber(amount).shiftedBy(-decimals).toFixed(4);
};
