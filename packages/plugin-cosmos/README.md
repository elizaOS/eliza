# `@elizaos/plugin-cosmos`

This plugin provides actions and utilities for interacting with Cosmos-compatible blockchains.

---

## Development

Prepare Eliza according to [README](../../README.md)
Add variables required for `@elizaos/plugin-cosmos` :

```
COSMOS_RECOVERY_PHRASE=your recovery phrase words
COSMOS_AVAILABLE_CHAINS=chain1,chain2,chain3
```

Ensure the appropriate environment variables are added for the plugin. If they are correctly configured, the project will run with `@elizaos/plugin-cosmos`

Run Eliza

```
pnpm run dev
```

## Configuration

### Default Setup

To start using the plugin, you need to provide your **Cosmos account recovery phrases** and the list of **available chains**. Add the following to your `.env` file:

```env
COSMOS_RECOVERY_PHRASE=your recovery phrase words
COSMOS_AVAILABLE_CHAINS=chain1,chain2,chain3
```

Ensure that the chain names in `COSMOS_AVAILABLE_CHAINS` match the identifiers from the [chain-registry](https://github.com/cosmos/chain-registry) library for compatibility.

### Using the Cosmos Helper Character

The plugin includes a pre-configured character, `cosmosHelper.character.json`, optimized for Cosmos-related operations. This character enhances interaction by:

- Handling repeated prompts effectively.

- Requesting confirmation before executing detected actions.

To use the character, pass it with the `--characters` flag:

```bash
--characters='../characters/cosmosHelper.character.json'
```

---

### Custom chain configuration

Plugin allows you to pass you custom chain config to `createCosmosPlugin` function invoked in `../agent/src/index`.

Your custom configuration fulfills the interfaces from `chain-registry`

```
import  type { assets, chains } from  "chain-registry";

export  interface  ICosmosPluginCustomChainData {
	chainData: (typeof  chains)[number];
	assets: (typeof  assets)[number];
}

export  interface  ICosmosPluginOptions {
	customChainData?: ICosmosPluginCustomChainData[];
}
```

## Actions

### Token Transfer

This plugin supports a token transfer action, which allows users to transfer tokens between addresses on Cosmos-compatible blockchains. The action prompts for confirmation to ensure secure execution.

#### Example Prompts

Below are examples of how the transfer action can be initiated and confirmed:

**Example**

1. User input:

```
Make transfer 0.0001 ATOM to cosmos1nk3uuw6zt5t5aqw5fvujkd54sa4uws9xv465ad on cosmoshubtestnet.
```

2. Plugin response:

```
Do you confirm the transfer action?
```

3. User confirmation:

```
Yes
```

4. Action executed.

### Token IBC Transfer

This plugin supports a token transfer action, which allows users to transfer tokens between addresses on Cosmos-compatible blockchains between different chains.

#### Example Prompts

Below are examples of how the ibc transfer action can be initiated and confirmed:

**Example**

1. User input:

```
Make an IBC transfer 0.0001 OSMO to neutron1nk3uuw6zt5t5aqw5fvujkd54sa4uws9xg2nk82 from osmosistestnet to neutrontestnet
```

2. Plugin response:

```
Before making the IBC transfer, I would like to confirm the details. You would like to transfer 0.0001 OSMO from osmosistestnet to neutrontestnet, specifically to the address neutron1nk3uuw6zt5t5aqw5fvujkd54sa4uws9xg2nk82, is that correct?
```

3. User confirmation:

```
Yes
```

4. Action executed.

---

### Token IBC Swap
This action allows swapping tokens between chains. The implementation of swapping is based on the Skip API and uses the @skip-go/client library.
To place transactions on chains, they must first be added to the env file. Specifically:
```env
COSMOS_AVAILABLE_CHAINS=osmosis,neutron,axelar,cosmoshub,terra2,pryzm
```
Keep in mind that most swaps require intermediate chains. These chains must also be included in the env file.

You can check which chains are supported by the Skip API and this plugin here: [Skip API Documentation](https://docs.skip.build/).

The list below contains all supported chains extracted from the Skip API:
```env
COSMOS_AVAILABLE_CHAINS=terra2,quicksilver,coreum,regen,mars,passage,dhealth,lumnetwork,provenance,chihuahua,pryzm,fetchhub,comdex,kyve,xpla,umee,celestia,osmosis,empowerchain,migaloo,dymension,kujira,self,humans,gitopia,agoric,doravota,int3face,quasar,gravitybridge,kava,sifchain,seda,shentu,decentr,cronos,carbon,stride,haqq,jackal,omniflixhub,noble,sentinel,nolus,odin,assetmantle,dydx,beezee,axelar,nois,mantrachain,elys,crescent,synternet,xion,source,akash,sei,canto,teritori,stargaze,titan,aura,evmos,archway,gateway,cheqd,milkyway,nibiru,cosmoshub,ununifi,nyx,bitsong,cryptoorgchain,neutron,penumbra,terra,shido,sommelier,saga,secretnetwork,chain4energy,juno,andromeda,planq,lava,oraichain,injective,persistence,composable
```

#### Example prompts:

##### Default flow
An example of the default flow of a swap request:

1. User input:
```
    Swap 10 OSMO on osmosis to ATOM on cosmoshub
```
2. Agent asks for confirmation:
```
About to swap 10 OSMO on osmosis to ATAOM on cosmoshub. I would like to confirm the transaction details. Please confirm that you would like to proceed with the swap.
```
3. User confiramation:
```
confirming / yes
```
4. Agent calls action and responds after completing:
```
Successfuly swapped 10 OSMO tokens to ATOM on chain cosmoshub.
Transaction Hash: E84F36D6EEFAA6D7B70827F34EDAB83258BB86EFE33AEA1F4559D00B30CD3B50
```

##### Special case handling
An example of a flow when there is more than one token with the same symbol on the destination chain (e.g., multiple USDC tokens):
1. User input:
```
Swap 10 OSMO on osmosis to ATOM on cosmoshub
```
2. Agent asks for confirmation:
```
About to swap 10 OSMO on osmosis to ATAOM on cosmoshub. I would like to confirm the transaction details. Please confirm that you would like to proceed with the swap.
```
3. User confirmation:
```
confirming / yes
```
4.  Model response:
```
I will now initiate the swap of 10 OSMO on the Osmosis chain to USDC on the Axelar chain. Please wait for the transaction to complete. If you need to swap more assets, feel free to let me know.

Error occured. Swap was not performed. Please provide denom for coin: USDC, on Chain Name: axelar. It is necessary as the symbol USDC is not unique among coins on chain axelar. 
Select one from found assets:
Symbol: USDC Desc: Circle's stablecoin on Axelar Denom: uusdc,
Symbol: USDC Desc: Circle's stablecoin from Polygon on Axelar Denom: polygon-uusdc,
Symbol: USDC Desc: Circle's stablecoin from Avalanche on Axelar Denom: avalanche-uusdc
```
5.  User response:
```
Swap 10 OSMO on osmosis to USDC with denom uusdc on axelar
```
6. Action call and agent response:
```
Successfuly swapped 10 OSMO tokens to USDC uusdc on chain axelar.
Transaction Hash: E84F36D6EEFAA6D7B70827F34EDAB83258BB86EFE33AEA1F4559D00B30CD3B50
```

## Contribution

The plugin includes comprehensive tests. Before submitting any pull requests, ensure all tests pass.

### Running Tests

Navigate to the `plugin-cosmos` directory and execute:

```bash
pnpm  test
```

---

This plugin simplifies Cosmos blockchain interactions and enhances productivity with its tailored features. Happy building!
