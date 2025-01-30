import { Plugin } from "@elizaos/core";
import { curvesFormulaProvider } from "./providers/curves";
import { formWalletProvider } from "./providers/wallet";
import { buyCurvesTokenAction } from "./actions/buyCurves";
import { sellCurvesTokenAction } from "./actions/sellCurves";
import { withdrawCurvesTokenAction } from "./actions/withdrawCurves";
import { depositCurvesTokenAction } from "./actions/depositCurves";
import { getCurvesBuyPriceAction } from "./actions/getCurvesBuyPrice";
import { getCurvesSellPriceAction } from "./actions/getCurvesSellPrice";
import { getCurvesBalanceAction } from "./actions/getCurvesBalance";
import { getCurvesAddressAction } from "./actions/getCurvesContract";
import { mintCurvesERC20TokenAction } from "./actions/mintCurvesERC20";
import { getCurvesERC20DetailsAction } from "./actions/getCurvesERC20";

export const formPlugin: Plugin = {
    name: "form",
    description: "Form Plugin for Eliza",
    providers: [curvesFormulaProvider, formWalletProvider],
    actions: [
        buyCurvesTokenAction,
        sellCurvesTokenAction,
        withdrawCurvesTokenAction,
        depositCurvesTokenAction,
        getCurvesBuyPriceAction,
        getCurvesSellPriceAction,
        getCurvesBalanceAction,
        getCurvesAddressAction,
        mintCurvesERC20TokenAction,
        getCurvesERC20DetailsAction,
    ],
    evaluators: [],
};

export default formPlugin;
