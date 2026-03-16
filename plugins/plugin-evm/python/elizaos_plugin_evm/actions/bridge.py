import asyncio
import logging
from typing import TypedDict

import httpx

from elizaos_plugin_evm.constants import (
    BRIDGE_POLL_INTERVAL_SECS,
    LIFI_API_URL,
    MAX_BRIDGE_POLL_ATTEMPTS,
)
from elizaos_plugin_evm.error import EVMError
from elizaos_plugin_evm.providers.wallet import EVMWalletProvider
from elizaos_plugin_evm.types import BridgeParams, BridgeStatus, BridgeStatusType

logger = logging.getLogger(__name__)


class LiFiRouteResponse(TypedDict):
    routes: list[dict]


class LiFiStepResponse(TypedDict):
    transactionRequest: dict


async def get_lifi_route(
    params: BridgeParams,
    from_address: str,
) -> dict:
    to_address = params.to_address or from_address

    url = f"{LIFI_API_URL}/advanced/routes"
    body = {
        "fromChainId": params.from_chain.chain_id,
        "toChainId": params.to_chain.chain_id,
        "fromTokenAddress": params.from_token,
        "toTokenAddress": params.to_token,
        "fromAmount": params.amount,
        "fromAddress": from_address,
        "toAddress": to_address,
        "options": {
            "slippage": 0.03,
            "allowSwitchChain": True,
        },
    }

    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(url, json=body, timeout=30.0)
            response.raise_for_status()
            data: LiFiRouteResponse = response.json()
        except httpx.HTTPStatusError as e:
            raise EVMError.network_error(f"LiFi API error: {e}") from e
        except Exception as e:
            raise EVMError.network_error(f"Failed to get route: {e}") from e

    routes = data.get("routes", [])
    if not routes:
        raise EVMError.route_not_found(
            f"No bridge route found from {params.from_chain.value} to {params.to_chain.value}"
        )

    return routes[0]


async def get_step_transaction(step: dict) -> dict:
    url = f"{LIFI_API_URL}/advanced/stepTransaction"

    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(url, json={"step": step}, timeout=30.0)
            response.raise_for_status()
            data: LiFiStepResponse = response.json()
        except Exception as e:
            raise EVMError.network_error(f"Failed to get step transaction: {e}") from e

    return data["transactionRequest"]


async def wait_for_bridge_completion(
    from_chain: int,
    to_chain: int,
    tx_hash: str,
) -> BridgeStatus:
    url = f"{LIFI_API_URL}/status"

    for attempt in range(MAX_BRIDGE_POLL_ATTEMPTS):
        await asyncio.sleep(BRIDGE_POLL_INTERVAL_SECS)

        async with httpx.AsyncClient() as client:
            try:
                response = await client.get(
                    url,
                    params={
                        "txHash": tx_hash,
                        "fromChain": from_chain,
                        "toChain": to_chain,
                    },
                    timeout=30.0,
                )
                response.raise_for_status()
                data = response.json()
            except Exception as e:
                logger.warning("Status check failed (attempt %d): %s", attempt + 1, e)
                continue

        status = data.get("status", "PENDING")

        if status == "DONE":
            return BridgeStatus(
                status=BridgeStatusType.DONE,
                substatus=data.get("substatus"),
                source_tx_hash=tx_hash,
                dest_tx_hash=data.get("receiving", {}).get("txHash"),
            )
        elif status == "FAILED":
            return BridgeStatus(
                status=BridgeStatusType.FAILED,
                substatus=data.get("substatus"),
                source_tx_hash=tx_hash,
            )

        logger.debug("Bridge status: %s (attempt %d)", status, attempt + 1)

    raise EVMError.transaction_failed("Bridge timed out waiting for completion")


async def execute_bridge(
    provider: EVMWalletProvider,
    params: BridgeParams,
) -> BridgeStatus:
    logger.info(
        "Executing bridge: %s %s -> %s (%s -> %s)",
        params.amount,
        params.from_token,
        params.to_token,
        params.from_chain.value,
        params.to_chain.value,
    )

    route = await get_lifi_route(params, provider.address)
    steps = route.get("steps", [])
    if not steps:
        raise EVMError.route_not_found("Route has no steps")

    tx_hash: str | None = None

    for i, step in enumerate(steps):
        logger.info("Executing step %d/%d: %s", i + 1, len(steps), step.get("type"))

        if step.get("type") == "approve":
            tx_request = await get_step_transaction(step)
            approve_tx = await provider.send_transaction(
                chain=params.from_chain,
                to=tx_request["to"],
                value=int(tx_request.get("value", "0"), 16)
                if isinstance(tx_request.get("value"), str)
                else tx_request.get("value", 0),
                data=tx_request["data"],
            )
            await provider.wait_for_transaction(params.from_chain, approve_tx)
            logger.info("Approval confirmed: %s", approve_tx)
            continue

        tx_request = await get_step_transaction(step)
        tx_hash = await provider.send_transaction(
            chain=params.from_chain,
            to=tx_request["to"],
            value=int(tx_request.get("value", "0"), 16)
            if isinstance(tx_request.get("value"), str)
            else tx_request.get("value", 0),
            data=tx_request["data"],
        )

        await provider.wait_for_transaction(params.from_chain, tx_hash)
        logger.info("Step %d confirmed: %s", i + 1, tx_hash)

    if not tx_hash:
        raise EVMError.transaction_failed("No transaction was executed")

    status = await wait_for_bridge_completion(
        from_chain=params.from_chain.chain_id,
        to_chain=params.to_chain.chain_id,
        tx_hash=tx_hash,
    )

    if status.status == BridgeStatusType.FAILED:
        raise EVMError.transaction_failed(f"Bridge failed: {status.substatus}")

    logger.info(
        "Bridge complete: %s -> %s",
        status.source_tx_hash,
        status.dest_tx_hash,
    )

    return status


bridge_action = {
    "name": "BRIDGE_TOKEN",
    "description": "Bridge tokens from one chain to another",
    "similes": [
        "bridge",
        "crosschain",
        "cross-chain",
        "move to chain",
        "transfer across chains",
    ],
    "examples": [
        "Bridge 0.1 ETH from mainnet to base",
        "Move 100 USDC from arbitrum to optimism",
    ],
    "handler": execute_bridge,
}

# TS parity aliases (keep legacy names too)
evm_bridge_tokens_action = {
    **bridge_action,
    "name": "EVM_BRIDGE_TOKENS",
}
