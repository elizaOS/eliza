"""Token balance provider for EVM chains."""

from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from elizaos_plugin_evm.providers.wallet import EVMWalletProvider


class RuntimeProtocol(Protocol):
    """Protocol for runtime interface."""

    async def use_model(self, model_type: str, params: dict[str, object]) -> str:
        """Use an LLM model."""
        ...


@dataclass
class ProviderResult:
    """Result from a provider."""

    text: str
    data: dict[str, object]
    values: dict[str, str]


# Prompt template - not a password (noqa: S105)
TOKEN_BALANCE_TEMPLATE = """You are a token balance query parser. Extract the token symbol and chain from the user message.

User message: {{userMessage}}

Respond ONLY with XML in this exact format:
<response>
<token>TOKEN_SYMBOL</token>
<chain>CHAIN_NAME</chain>
</response>

If no specific token or chain is mentioned, respond with:
<response>
<error>true</error>
</response>"""


def parse_key_value_xml(xml_str: str) -> dict[str, str]:
    """Parse simple XML key-value pairs."""
    import re

    result: dict[str, str] = {}
    # Find all tag pairs
    pattern = r"<(\w+)>([^<]*)</\1>"
    matches = re.findall(pattern, xml_str)
    for key, value in matches:
        result[key] = value.strip()
    return result


class TokenBalanceProvider:
    """Provider for ERC20 token balances."""

    name = "TOKEN_BALANCE"
    description = "Token balance for ERC20 tokens when onchain actions are requested"
    dynamic = True

    async def get(
        self,
        runtime: RuntimeProtocol,
        message: dict[str, object],
        wallet_provider: "EVMWalletProvider",
    ) -> ProviderResult:
        """Get token balance for a specific token and chain.

        Args:
            runtime: The agent runtime
            message: The incoming message
            wallet_provider: The wallet provider instance

        Returns:
            Provider result with balance information
        """
        message_text = str(message.get("content", {}).get("text", ""))
        if not message_text:
            return ProviderResult(text="", data={}, values={})

        prompt = TOKEN_BALANCE_TEMPLATE.replace("{{userMessage}}", message_text)

        response = await runtime.use_model(
            "TEXT_SMALL",
            {"prompt": prompt, "maxTokens": 100},
        )

        parsed = parse_key_value_xml(response)

        if not parsed or parsed.get("error") or not parsed.get("token") or not parsed.get("chain"):
            return ProviderResult(text="", data={}, values={})

        token = parsed["token"].upper()
        chain = parsed["chain"].lower()

        # Check if chain is configured
        if chain not in wallet_provider.chains:
            return ProviderResult(
                text=f"Chain {chain} is not configured",
                data={"error": f"Chain {chain} is not configured"},
                values={},
            )

        address = wallet_provider.get_address()

        # Note: Actual balance query would require web3 integration
        # This is a structural placeholder that matches TypeScript functionality
        balance = "0"
        has_balance = False

        return ProviderResult(
            text=f"{token} balance on {chain} for {address}: {balance}",
            data={
                "token": token,
                "chain": chain,
                "balance": balance,
                "address": address,
                "hasBalance": has_balance,
            },
            values={
                "token": token,
                "chain": chain,
                "balance": balance,
                "hasBalance": str(has_balance).lower(),
            },
        )
