import {assets} from "chain-registry";

export const prepareAmbiguityErrorMessage = (
    coinSymbol: string,
    chainName: string
): string => {
    const chainAssets = assets.find((chain) => chain.chain_name === chainName);
    if (!chainAssets) {
        throw new Error(`Chain ${chainName} not found in registry`);
    }

    const ambiguousAssets = chainAssets.assets.filter(
        (asset) => asset.symbol === coinSymbol
    );

    console.log(
        `Ambiguous Assets found: ${JSON.stringify(ambiguousAssets, null, 2)}`
    );

    const assetsText = `${ambiguousAssets.map((a) => `Symbol: ${a.symbol} Desc: ${a.description} Denom: ${a.base}`).join(",\n")}`;

    return `Error occured. Swap was not performed. Please provide denom for coin: ${coinSymbol}, on Chain Name: ${chainName}. It is necessary as the symbol ${coinSymbol} is not unique among coins on chain ${chainName}. \n Select one from found assets:\n${assetsText}`;
};
